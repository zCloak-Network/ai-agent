/**
 * VetKey CLI Module — VetKey IBE encryption/decryption and daemon management
 *
 * Provides three encryption modes:
 *   1. IBE mode: Per-operation Identity-Based Encryption for Kind5 PrivatePost
 *   2. Daemon mode: Long-running AES-256-GCM daemon for fast file encryption
 *   3. Mail mode: IBE-based encrypted messaging between agents
 *
 * Sub-commands:
 *   encrypt-sign    Encrypt + sign Kind5 PrivatePost in one step
 *   decrypt         Decrypt Kind5 PrivatePost by event ID
 *   encrypt-only    Encrypt locally without canister sign
 *   pubkey          Get IBE public key from canister
 *   serve           Start daemon (Unix Domain Socket)
 *   stop            Stop a running daemon
 *   status          Query daemon status
 *   grant           Grant Kind5 decryption access to another user
 *   revoke          Revoke an access grant
 *   grants-out      List grants issued by the caller (as grantor)
 *   grants-in       List grants received by the caller (as grantee)
 *   send-msg        Encrypt a message for a recipient (IBE Mail)
 *   recv-msg        Decrypt a received message via Mail daemon
 *
 * Usage: zcloak-ai vetkey <sub-command> [options]
 */

import { readFileSync, statSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'fs';
import { basename, dirname } from 'path';
import { createConnection } from 'net';
import { spawn } from 'child_process';
import { daemonLogPath } from './paths.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { Principal } from '@dfinity/principal';
import { schnorr } from '@noble/curves/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import type { Session } from './session.js';
import * as cryptoOps from './crypto.js';
import { KeyStore } from './key-store.js';
import { runDaemonUds } from './serve.js';
import { isDaemonAlive, socketPath } from './daemon.js';
import { ToolError, canisterCallError } from './error.js';
import * as log from './log.js';

/**
 * Absolute path to cli.js (the CLI entry script).
 * Used by spawnDaemonBackground() to spawn daemon child processes via
 * `process.execPath` (the current Node binary) + this script path, so that
 * daemon spawning works regardless of how the CLI was invoked (global install,
 * npx, node dist/cli.js, etc.).
 */
const CLI_ENTRY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');

// ============================================================================
// Module Entry Point
// ============================================================================

/**
 * Run the vetkey sub-command.
 * Follows the same pattern as other CLI modules (sign.ts, verify.ts, etc.).
 *
 * @param session - CLI session with parsed args and canister access
 */
export async function run(session: Session): Promise<void> {
  const command = session.args._args[0];

  switch (command) {
    case 'encrypt-sign':
      await cmdEncryptSign(session);
      break;
    case 'decrypt':
      await cmdDecrypt(session);
      break;
    case 'encrypt-only':
      await cmdEncryptOnly(session);
      break;
    case 'pubkey':
      await cmdGetPubkey(session);
      break;
    case 'serve':
      await cmdServe(session);
      break;
    case 'stop':
      await cmdStop(session);
      break;
    case 'status':
      await cmdStatus(session);
      break;
    case 'grant':
      await cmdGrant(session);
      break;
    case 'revoke':
      await cmdRevoke(session);
      break;
    case 'grants-out':
      await cmdGrantsOut(session);
      break;
    case 'grants-in':
      await cmdGrantsIn(session);
      break;
    case 'send-msg':
      await cmdSendMsg(session);
      break;
    case 'recv-msg':
      await cmdRecvMsg(session);
      break;
    default:
      showHelp();
      process.exit(command ? 1 : 0);
  }
}

function showHelp(): void {
  console.log('zCloak.ai VetKey Tool');
  console.log('');
  console.log('Usage: zcloak-ai vetkey <command> [options]');
  console.log('');
  console.log('IBE Commands (Kind5 PrivatePost):');
  console.log('  encrypt-sign    Encrypt content and sign as Kind5 PrivatePost');
  console.log('  decrypt         Decrypt Kind5 by event ID');
  console.log('  encrypt-only    Encrypt locally without canister sign');
  console.log('  pubkey          Get IBE public key from canister');
  console.log('');
  console.log('Kind5 Access Control:');
  console.log('  grant           Grant decryption access to another user');
  console.log('  revoke          Revoke an access grant');
  console.log('  grants-out      List grants you issued (as grantor)');
  console.log('  grants-in       List grants you received (as grantee)');
  console.log('');
  console.log('Encrypted Messaging:');
  console.log('  send-msg        Encrypt + auto-deliver via zMail (IBE)');
  console.log('  recv-msg        Decrypt a received message via Mail daemon');
  console.log('');
  console.log('Options:');
  console.log('  --text=<content>        Plaintext to encrypt');
  console.log('  --file=<path>           File to encrypt');
  console.log('  --event-id=<id>         Event ID for decryption');
  console.log('  --output=<path>         Output file path');
  // --key-name is an internal daemon option, not shown to users
  console.log('  --public-key=<hex>      IBE public key for offline encryption');
  console.log('  --ibe-identity=<id>     IBE identity for offline encryption');
  console.log('  --tags=<json>           Tags as JSON array');
  console.log('  --json                  Output in JSON format');
  console.log('  --grantee=<principal>   Grantee principal (for grant)');
  console.log('  --event-ids=<id1,id2>   Event IDs to authorize (for grant, empty=all)');
  console.log('  --duration=<dur>        Grant duration: 30d, 1y, permanent (for grant)');
  console.log('  --grant-id=<id>         Grant ID (for revoke)');
  console.log('  --to=<AI-ID|principal>  Recipient AI-ID or principal (for send-msg)');
  console.log('  --reply=<msg_id>        Reply to a parent message (for send-msg)');
  console.log('  --data=<json>           Encrypted message JSON envelope (for recv-msg)');
  console.log('  --no-zmail              Skip auto-POST to zMail (send-msg only)');
  console.log('  --zmail-url=<url>       Override zMail server URL');
}

// ============================================================================
// Command Implementations
// ============================================================================

/**
 * encrypt-sign: Encrypt plaintext with IBE and sign as Kind5 in one step.
 *
 * Flow:
 *   1. Get IBE public key from canister
 *   2. Generate IBE identity string
 *   3. IBE-encrypt the plaintext
 *   4. Call canister sign(Kind5PrivatePost{...})
 *   5. Output SignEvent result
 */
async function cmdEncryptSign(session: Session): Promise<void> {
  const args = session.args;
  const text = args['text'] as string | undefined;
  const file = args['file'] as string | undefined;
  const output = args['output'] as string | undefined;
  const tagsJson = args['tags'] as string | undefined;
  const jsonOutput = !!args['json'];

  const plaintext = readInput(text, file);

  // Parse optional tags
  let tags: string[][] | undefined;
  if (tagsJson) {
    try {
      tags = JSON.parse(tagsJson);
    } catch {
      throw new Error("Invalid tags JSON (expected array of string arrays)");
    }
  }

  const actor = await session.getSignActor();
  const principal = session.getPrincipal();

  // Step 1: Get IBE public key
  let dpkBytes: Uint8Array;
  try {
    const result = await (actor as any).get_ibe_public_key() as Uint8Array;
    dpkBytes = new Uint8Array(result);
  } catch (e) {
    throw canisterCallError(
      `get_ibe_public_key failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  // Step 2: Generate IBE identity
  const ibeIdentity = cryptoOps.makeIbeIdentity(principal, plaintext);

  // Step 3: IBE-encrypt
  const ciphertext = cryptoOps.ibeEncrypt(dpkBytes, ibeIdentity, plaintext);

  // Step 4: Sign and store on canister (direct sign, no PoW for Kind5)
  let signEvent: any;
  try {
    signEvent = await (actor as any).sign({
      Kind5PrivatePost: {
        encrypted_content: Array.from(ciphertext),
        ibe_identity: ibeIdentity,
        tags: tags ? [tags] : [],
      },
    });
  } catch (e) {
    throw canisterCallError(
      `sign Kind5PrivatePost failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  // Step 5: Write ciphertext to local file
  const outputPath = output ?? defaultEncryptedPath(file);
  writeFileSync(outputPath, ciphertext);

  // Step 6: Output
  if (jsonOutput) {
    console.log(JSON.stringify({
      event_id: signEvent.id,
      ibe_identity: ibeIdentity,
      kind: signEvent.kind,
      content_hash: signEvent.content_hash,
      created_at: signEvent.created_at.toString(),
      principal,
      output_file: outputPath,
      ciphertext_size: ciphertext.length,
    }));
  } else {
    console.log("Kind5 PrivatePost signed successfully!");
    console.log(`  Event ID:     ${signEvent.id}`);
    console.log(`  IBE Identity: ${ibeIdentity}`);
    console.log(`  Content Hash: ${signEvent.content_hash}`);
    console.log(`  Principal:    ${principal}`);
    console.log(`  Output File:  ${outputPath}`);
    console.log(`  Ciphertext:   ${ciphertext.length} bytes`);
  }
}

/**
 * decrypt: Decrypt a Kind5 PrivatePost by event ID.
 */
async function cmdDecrypt(session: Session): Promise<void> {
  const args = session.args;
  const eventId = args['event-id'] as string | undefined;
  const output = args['output'] as string | undefined;
  const jsonOutput = !!args['json'];

  if (!eventId) {
    throw new Error('--event-id is required for decryption');
  }

  const actor = await session.getSignActor();

  // Generate ephemeral transport key pair
  const [transportSecret, transportPublic] = cryptoOps.generateTransportKeypair();

  // Get IBE public key
  let dpkBytes: Uint8Array;
  try {
    const result = await (actor as any).get_ibe_public_key() as Uint8Array;
    dpkBytes = new Uint8Array(result);
  } catch (e) {
    throw canisterCallError(
      `get_ibe_public_key failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  // Request decryption package from canister
  let pkg: { encrypted_key: Uint8Array; ciphertext: Uint8Array; ibe_identity: string };
  try {
    const result = await (actor as any).get_kind5_decryption_key(
      eventId,
      Array.from(transportPublic),
    );
    pkg = {
      encrypted_key: new Uint8Array(result.encrypted_key),
      ciphertext: new Uint8Array(result.ciphertext),
      ibe_identity: result.ibe_identity,
    };
  } catch (e) {
    throw canisterCallError(
      `get_kind5_decryption_key failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  // Full decrypt
  const plaintext = cryptoOps.ibeDecrypt(
    pkg.encrypted_key,
    dpkBytes,
    pkg.ibe_identity,
    pkg.ciphertext,
    transportSecret,
  );

  // Output
  if (output) {
    writeFileSync(output, plaintext);

    if (jsonOutput) {
      console.log(JSON.stringify({
        event_id: eventId,
        ibe_identity: pkg.ibe_identity,
        output_file: output,
        size_bytes: plaintext.length,
      }));
    } else {
      console.log(`Decrypted content written to: ${output}`);
    }
  } else {
    const textContent = new TextDecoder().decode(plaintext);
    if (jsonOutput) {
      console.log(JSON.stringify({
        event_id: eventId,
        ibe_identity: pkg.ibe_identity,
        plaintext: textContent,
      }));
    } else {
      console.log("Decrypted Kind5 PrivatePost:");
      console.log(`  Event ID:     ${eventId}`);
      console.log(`  IBE Identity: ${pkg.ibe_identity}`);
      console.log(`  Content:`);
      console.log(textContent);
    }
  }
}

/**
 * encrypt-only: Encrypt content locally without canister interaction.
 */
async function cmdEncryptOnly(session: Session): Promise<void> {
  const args = session.args;
  const text = args['text'] as string | boolean | undefined;
  const file = args['file'] as string | boolean | undefined;
  const output = args['output'] as string | undefined;
  const rawIbeIdentity = args['ibe-identity'];
  const rawPublicKey = args['public-key'];
  const jsonOutput = !!args['json'];

  // Guard against boolean flags for string-valued options
  if (rawIbeIdentity === true) throw new Error("--ibe-identity requires a value");
  if (rawPublicKey === true) throw new Error("--public-key requires a hex value");
  const ibeIdentityOverride = rawIbeIdentity as string | undefined;
  const publicKeyHex = rawPublicKey as string | undefined;

  const plaintext = readInput(text, file);

  let dpkBytes: Uint8Array;
  let principalText: string;

  if (publicKeyHex) {
    // Fully offline mode — use provided public key
    dpkBytes = Buffer.from(publicKeyHex, "hex");
    principalText = ibeIdentityOverride ? "offline" : session.getPrincipal();
  } else {
    // Semi-online mode — fetch public key from canister
    const actor = await session.getSignActor();
    principalText = session.getPrincipal();

    try {
      const result = await (actor as any).get_ibe_public_key() as Uint8Array;
      dpkBytes = new Uint8Array(result);
    } catch (e) {
      throw canisterCallError(
        `get_ibe_public_key failed: ${e instanceof Error ? e.message : String(e)}`, e,
      );
    }
  }

  const ibeIdentity = ibeIdentityOverride ?? cryptoOps.makeIbeIdentity(principalText, plaintext);
  const ciphertext = cryptoOps.ibeEncrypt(dpkBytes, ibeIdentity, plaintext);

  // Write ciphertext to local file
  const outputPath = output ?? defaultEncryptedPath(typeof file === 'string' ? file : undefined);
  writeFileSync(outputPath, ciphertext);

  if (jsonOutput) {
    console.log(JSON.stringify({
      ibe_identity: ibeIdentity,
      output_file: outputPath,
      ciphertext_size: ciphertext.length,
      plaintext_size: plaintext.length,
      offline: !!publicKeyHex,
    }));
  } else {
    const mode = publicKeyHex ? "fully offline" : "semi-online";
    console.log(`IBE encryption completed (${mode}, not signed on canister)`);
    console.log(`  IBE Identity:    ${ibeIdentity}`);
    console.log(`  Output File:     ${outputPath}`);
    console.log(`  Ciphertext size: ${ciphertext.length} bytes`);
  }
}

/**
 * pubkey: Fetch and display the IBE derived public key.
 */
async function cmdGetPubkey(session: Session): Promise<void> {
  const jsonOutput = !!session.args['json'];

  const actor = await session.getSignActor();

  let dpkBytes: Uint8Array;
  try {
    const result = await (actor as any).get_ibe_public_key() as Uint8Array;
    dpkBytes = new Uint8Array(result);
  } catch (e) {
    throw canisterCallError(
      `get_ibe_public_key failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      public_key: Buffer.from(dpkBytes).toString("hex"),
      size_bytes: dpkBytes.length,
    }));
  } else {
    console.log("IBE Derived Public Key:");
    console.log(`  Hex:  ${Buffer.from(dpkBytes).toString("hex")}`);
    console.log(`  Size: ${dpkBytes.length} bytes (compressed G2 point)`);
  }
}

/**
 * serve: Start daemon over Unix Domain Socket.
 *
 * Creates its own long-lived actor for the daemon lifecycle,
 * using the Session's identity for authentication.
 */
async function cmdServe(session: Session): Promise<void> {
  const args = session.args;

  // --stdio mode has been removed; reject explicitly so old callers fail fast
  if (args['stdio']) {
    throw new Error("--stdio mode is no longer supported. The daemon now uses Unix Domain Socket (UDS) exclusively.");
  }

  const rawKeyName = args['key-name'];
  // Guard against boolean flag (e.g. --key-name without value parses as true)
  if (rawKeyName === true) throw new Error("--key-name requires a value (e.g. --key-name=mykey)");
  const keyName = (rawKeyName as string) || 'default';

  // Validate key_name
  if (keyName.includes(":")) throw new Error("key_name must not contain ':' (reserved as separator)");

  const actor = await session.getSignActor();
  const principal = session.getPrincipal();

  // Construct derivation ID
  const derivationId = `${principal}:${keyName}`;
  if (derivationId.length > 256) {
    throw new Error(`derivation_id exceeds 256 bytes (${derivationId.length}); use a shorter key_name`);
  }

  // Derive AES-256 key from VetKey via the sign actor
  log.info(`Deriving AES-256 key from VetKey (derivation_id: ${derivationId})...`);
  const keyStore = await KeyStore.deriveFromActor(actor, derivationId);
  log.info("Key derived successfully. Starting JSON-RPC daemon...");

  await runDaemonUds(keyStore, principal, derivationId);
}

/**
 * stop: Send shutdown to a running daemon.
 */
async function cmdStop(session: Session): Promise<void> {
  const args = session.args;
  if (args['key-name'] === true) throw new Error("--key-name requires a value (e.g. --key-name=mykey)");
  const keyName = (args['key-name'] as string) || 'default';
  const jsonOutput = !!args['json'];

  const principal = session.getPrincipal();
  const derivationId = `${principal}:${keyName}`;
  const sockPath = socketPath(derivationId);

  // Try to stop via socket if:
  //   1. isDaemonAlive() says yes (PID + socket both present), OR
  //   2. PID file is missing/corrupt but socket file still exists — the daemon
  //      process may be alive with an orphaned socket. Attempt a shutdown via
  //      the socket so we don't leave an unmanageable orphan process.
  const alive = isDaemonAlive(derivationId);
  const socketExists = existsSync(sockPath);

  if (!alive && !socketExists) {
    if (jsonOutput) {
      console.log(JSON.stringify({ status: "not_running", key_name: keyName }));
    } else {
      console.log(`Daemon '${keyName}' is not running. Nothing to stop.`);
    }
    return;
  }

  try {
    const response = await sendRpcToSocket(sockPath, {
      id: 1,
      method: "shutdown",
    });

    if (jsonOutput) {
      console.log(JSON.stringify(response));
    } else {
      console.log("Daemon stopped successfully.");
    }
  } catch (e) {
    // Socket file exists but connection failed — stale socket, clean it up
    if (socketExists && !alive) {
      safeUnlinkPath(sockPath);
      if (jsonOutput) {
        console.log(JSON.stringify({ status: "not_running", key_name: keyName, note: "cleaned up stale socket" }));
      } else {
        console.log(`Daemon '${keyName}' is not running (cleaned up stale socket).`);
      }
    } else {
      throw e;
    }
  }
}

/**
 * status: Query daemon status.
 *
 * For standard daemons (default, Mail): auto-starts if not running, so users
 * never need to manually launch a daemon before querying its status.
 *
 * For custom key names: only reports the current state — does NOT auto-start,
 * since custom daemons require explicit `vetkey serve` to start. This keeps
 * `status` side-effect-free for non-standard daemons.
 */
async function cmdStatus(session: Session): Promise<void> {
  const args = session.args;
  if (args['key-name'] === true) throw new Error("--key-name requires a value (e.g. --key-name=mykey)");
  const keyName = (args['key-name'] as string) || 'default';
  const jsonOutput = !!args['json'];

  const isStandard = (STANDARD_DAEMON_KEY_NAMES as readonly string[]).includes(keyName);
  let sockPath: string;

  if (isStandard) {
    // Standard daemon: auto-start if needed
    sockPath = await ensureDaemon(session, keyName);
  } else {
    // Custom daemon: report-only, no auto-start
    const principal = session.getPrincipal();
    const derivationId = `${principal}:${keyName}`;

    if (!isDaemonAlive(derivationId)) {
      if (jsonOutput) {
        console.log(JSON.stringify({ status: "not_running", key_name: keyName }));
      } else {
        console.log(`Daemon '${keyName}' is not running. Use 'zcloak-ai vetkey serve --key-name=${keyName}' to start it.`);
      }
      return;
    }

    sockPath = socketPath(derivationId);
  }

  // Connect to socket and send status
  const response = await sendRpcToSocket(sockPath, {
    id: 1,
    method: "status",
  });

  if (jsonOutput) {
    console.log(JSON.stringify(response));
  } else {
    const result = response.result as Record<string, unknown> | undefined;
    if (result) {
      console.log("Daemon Status:");
      console.log(`  Status:        ${result.status}`);
      console.log(`  Derivation ID: ${result.derivation_id}`);
      console.log(`  Principal:     ${result.principal}`);
      console.log(`  Started At:    ${result.started_at}`);
      console.log(`  Socket:        ${result.socket_path}`);
    } else if (response.error) {
      log.error(`Error: ${response.error}`);
    }
  }
}

// ============================================================================
// Daemon Auto-Start
// ============================================================================

/** Maximum time to wait for the daemon to become ready (ms) */
const DAEMON_READY_TIMEOUT_MS = 30_000;

/** Polling interval when waiting for daemon socket to appear (ms) */
const DAEMON_POLL_INTERVAL_MS = 500;

/** Key names for the two standard daemons that should always be kept alive */
export const STANDARD_DAEMON_KEY_NAMES = ['default', 'Mail'] as const;

/**
 * Spawn a daemon process in the background for the given key name.
 *
 * The child process is fully detached (survives parent exit) with stderr
 * redirected to a log file under ~/.config/zcloak/run/.
 *
 * @param pemPath - Path to the identity PEM file
 * @param keyName - Daemon key name (e.g. "default", "Mail")
 * @returns The child process PID (or undefined if spawn failed)
 */
export function spawnDaemonBackground(pemPath: string, keyName: string): number | undefined {
  const logPath = daemonLogPath(keyName);
  const logDir = dirname(logPath);

  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // Best effort — directory may already exist
  }

  let logFd: number;
  try {
    logFd = openSync(logPath, 'a');
  } catch {
    return undefined;
  }

  try {
    // Use process.execPath (current Node binary) + CLI_ENTRY_SCRIPT (absolute
    // path to cli.js) instead of 'zcloak-ai'. This ensures daemon spawning
    // works regardless of how the CLI was invoked (global install, npx, or
    // direct `node dist/cli.js`), avoiding ENOENT when 'zcloak-ai' is not on PATH.
    const child = spawn(process.execPath, [
      CLI_ENTRY_SCRIPT,
      'vetkey', 'serve', `--key-name=${keyName}`, `--identity=${pemPath}`,
    ], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
    });

    // Must listen for 'error' to prevent unhandled exceptions from crashing
    // the parent process.
    child.on('error', () => { /* swallow — best effort spawn */ });

    child.unref();
    closeSync(logFd);

    return child.pid;
  } catch {
    closeSync(logFd);
    return undefined;
  }
}

/**
 * Ensure a daemon with the given key name is running for the session's principal.
 *
 * If the daemon is already alive, returns the socket path immediately.
 * Otherwise spawns a background `zcloak-ai vetkey serve` process and
 * polls until the socket file appears or the timeout is reached.
 *
 * @param session  - CLI session (provides identity / PEM path)
 * @param keyName  - Daemon key name (e.g. "default", "Mail")
 * @returns Socket path of the running daemon
 * @throws Error if the daemon fails to start within the timeout
 */
async function ensureDaemon(session: Session, keyName: string): Promise<string> {
  const principal = session.getPrincipal();
  const derivationId = `${principal}:${keyName}`;

  // Already running? Return immediately.
  if (isDaemonAlive(derivationId)) {
    return socketPath(derivationId);
  }

  log.info(`${keyName} daemon is not running. Starting it automatically...`);

  const pid = spawnDaemonBackground(session.getPemPath(), keyName);
  log.info(`${keyName} daemon spawned (PID: ${pid ?? 'unknown'}). Waiting for ready...`);

  // Poll for the socket file to appear (daemon writes PID + creates socket on ready)
  const sock = socketPath(derivationId);
  const logPath = daemonLogPath(keyName);
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DAEMON_POLL_INTERVAL_MS));

    if (isDaemonAlive(derivationId) && existsSync(sock)) {
      log.info(`${keyName} daemon is ready. Socket: ${sock}`);
      return sock;
    }
  }

  throw new Error(
    `${keyName} daemon failed to start within ${DAEMON_READY_TIMEOUT_MS / 1000}s. ` +
    `Check the log at ${logPath} for details.`,
  );
}


// ============================================================================
// Helper Functions
// ============================================================================

/** Safely delete a file, ignoring errors if it doesn't exist */
function safeUnlinkPath(filePath: string): void {
  try { unlinkSync(filePath); } catch { /* ignore */ }
}

/**
 * Generate default output path for encrypted files.
 * - If an input file was provided, appends ".enc" suffix (e.g. "data.txt" → "data.txt.enc")
 * - If no input file (e.g. --text mode), generates a timestamped file in the current directory
 */
function defaultEncryptedPath(inputFile?: string): string {
  if (inputFile) {
    return `${inputFile}.enc`;
  }
  return `encrypted_${Date.now()}.enc`;
}

/**
 * Read input content from --text or --file as Uint8Array.
 * Supports both text and binary files.
 */
function readInput(text: string | boolean | undefined, file: string | boolean | undefined): Uint8Array {
  if (text && file) throw new Error("Cannot specify both --text and --file");
  // Guard against boolean flags (e.g. --text --other-flag parses --text as true)
  if (text === true) throw new Error("--text requires a value (e.g. --text='hello')");
  if (file === true) throw new Error("--file requires a path (e.g. --file=./data.txt)");
  if (text) return new TextEncoder().encode(text);
  if (file) return readFileSync(file);
  throw new Error("Either --text or --file must be provided");
}

/**
 * Send a single JSON-RPC request to a Unix socket and return the response.
 * Connects, sends the request, reads one response line, then disconnects.
 */
function sendRpcToSocket(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let responded = false;

    conn.on("connect", () => {
      conn.write(JSON.stringify(request) + "\n");
    });

    const rl = createInterface({ input: conn });

    rl.on("line", (line: string) => {
      if (!responded) {
        responded = true;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`Invalid response: ${line}`));
        }
        conn.end();
      }
    });

    conn.on("error", (err) => {
      if (!responded) {
        responded = true;
        clearTimeout(timer);
        reject(new Error(`Failed to connect to daemon: ${err.message}`));
      }
    });

    conn.on("close", () => {
      if (!responded) {
        responded = true;
        clearTimeout(timer);
        reject(new Error("Connection closed without response"));
      }
    });

    // Timeout after 10 seconds — clear on success/error to avoid blocking process exit
    const timer = setTimeout(() => {
      if (!responded) {
        responded = true;
        conn.destroy();
        reject(new Error("Timeout waiting for daemon response"));
      }
    }, 10000);
  });
}

/**
 * Parse a human-readable duration string into nanoseconds.
 *
 * Supported formats:
 *   - "permanent" or "perm" → undefined (no expiration)
 *   - "<number>d" → days
 *   - "<number>h" → hours
 *   - "<number>y" → years (365 days)
 *   - "<number>m" → months (30 days)
 *   - plain number → treated as seconds
 *
 * @returns bigint nanoseconds, or undefined for permanent
 */
function parseDuration(input: string): bigint | undefined {
  const s = input.trim().toLowerCase();
  if (s === 'permanent' || s === 'perm') return undefined;

  const NS_PER_SEC = 1_000_000_000n;
  const match = s.match(/^(\d+)\s*([dhmy]?)$/);
  if (!match) throw new Error(`Invalid duration format: "${input}". Use e.g. 30d, 24h, 1y, permanent`);

  const num = BigInt(match[1]!);
  const unit = match[2] || 's';

  switch (unit) {
    case 'h': return num * 3600n * NS_PER_SEC;
    case 'd': return num * 86400n * NS_PER_SEC;
    case 'm': return num * 30n * 86400n * NS_PER_SEC;
    case 'y': return num * 365n * 86400n * NS_PER_SEC;
    case 's': return num * NS_PER_SEC;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Format a nanosecond timestamp to a human-readable date string.
 * Returns "permanent" for u64::MAX.
 */
function formatNsTimestamp(ns: bigint): string {
  // u64::MAX = 18446744073709551615
  if (ns >= 18446744073709551615n) return 'permanent';
  const ms = Number(ns / 1_000_000n);
  return new Date(ms).toISOString();
}

// ============================================================================
// Kind5 Access Control Commands
// ============================================================================

/**
 * grant: Authorize another user to decrypt your Kind5 encrypted posts.
 *
 * Options:
 *   --grantee=<principal>   (required) Recipient's principal ID
 *   --event-ids=<id1,id2>   (optional) Specific event IDs to authorize; empty = all Kind5 posts
 *   --duration=<dur>        (optional) Duration: 30d, 1y, permanent (default: permanent)
 *   --json                  Output in JSON format
 */
async function cmdGrant(session: Session): Promise<void> {
  const args = session.args;
  const granteePrincipal = args['grantee'] as string | undefined;
  const eventIdsStr = args['event-ids'] as string | undefined;
  const durationStr = args['duration'] as string | undefined;
  const jsonOutput = !!args['json'];

  if (!granteePrincipal) {
    throw new Error('--grantee=<principal> is required');
  }

  // Validate grantee is a valid principal
  let grantee: Principal;
  try {
    grantee = Principal.fromText(granteePrincipal);
  } catch {
    throw new Error(`Invalid grantee principal: "${granteePrincipal}"`);
  }

  // Parse event IDs (comma-separated, empty list = all Kind5 posts)
  const eventIds: string[] = eventIdsStr
    ? eventIdsStr.split(',').map(id => id.trim()).filter(Boolean)
    : [];

  // Parse duration (default: permanent)
  const durationNs = durationStr ? parseDuration(durationStr) : undefined;
  // Candid opt: [bigint] when present, [] when None (permanent)
  const durationOpt: [] | [bigint] = durationNs !== undefined ? [durationNs] : [];

  const actor = await session.getSignActor();

  let result: { Ok: bigint } | { Err: string };
  try {
    result = await (actor as any).grant_kind5_access({
      grantee,
      event_ids: eventIds,
      duration_ns: durationOpt,
    });
  } catch (e) {
    throw canisterCallError(
      `grant_kind5_access failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  if ('Err' in result) {
    throw new Error(`Grant failed: ${result.Err}`);
  }

  const grantId = result.Ok;
  if (jsonOutput) {
    console.log(JSON.stringify({
      grant_id: grantId.toString(),
      grantee: granteePrincipal,
      event_ids: eventIds,
      scope: eventIds.length === 0 ? 'all_kind5_posts' : 'specific_events',
      duration: durationStr || 'permanent',
    }));
  } else {
    console.log('Kind5 access granted successfully!');
    console.log(`  Grant ID:  ${grantId}`);
    console.log(`  Grantee:   ${granteePrincipal}`);
    console.log(`  Scope:     ${eventIds.length === 0 ? 'All Kind5 posts' : `${eventIds.length} specific event(s)`}`);
    console.log(`  Duration:  ${durationStr || 'permanent'}`);
    if (eventIds.length > 0) {
      console.log(`  Event IDs: ${eventIds.join(', ')}`);
    }
  }
}

/**
 * revoke: Revoke an access grant by grant ID.
 *
 * Options:
 *   --grant-id=<id>   (required) The grant ID to revoke
 *   --json            Output in JSON format
 */
async function cmdRevoke(session: Session): Promise<void> {
  const args = session.args;
  const grantIdStr = args['grant-id'] as string | undefined;
  const jsonOutput = !!args['json'];

  if (!grantIdStr) {
    throw new Error('--grant-id=<id> is required');
  }

  let grantId: bigint;
  try {
    grantId = BigInt(grantIdStr);
  } catch {
    throw new Error(`Invalid grant ID: "${grantIdStr}" (must be a number)`);
  }

  const actor = await session.getSignActor();

  let result: { Ok: null } | { Err: string };
  try {
    result = await (actor as any).revoke_kind5_access(grantId);
  } catch (e) {
    throw canisterCallError(
      `revoke_kind5_access failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  if ('Err' in result) {
    throw new Error(`Revoke failed: ${result.Err}`);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ grant_id: grantIdStr, revoked: true }));
  } else {
    console.log(`Grant ${grantIdStr} revoked successfully.`);
  }
}

/**
 * grants-out: List all active grants issued by the caller (as grantor).
 */
async function cmdGrantsOut(session: Session): Promise<void> {
  const jsonOutput = !!session.args['json'];
  const actor = await session.getSignActor();

  let grants: any[];
  try {
    grants = await (actor as any).get_kind5_grants_by_grantor();
  } catch (e) {
    throw canisterCallError(
      `get_kind5_grants_by_grantor failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  if (jsonOutput) {
    console.log(JSON.stringify(formatGrantsForJson(grants)));
  } else {
    printGrants(grants, 'issued');
  }
}

/**
 * grants-in: List all active grants received by the caller (as grantee).
 */
async function cmdGrantsIn(session: Session): Promise<void> {
  const jsonOutput = !!session.args['json'];
  const actor = await session.getSignActor();

  let grants: any[];
  try {
    grants = await (actor as any).get_kind5_grants_by_grantee();
  } catch (e) {
    throw canisterCallError(
      `get_kind5_grants_by_grantee failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  if (jsonOutput) {
    console.log(JSON.stringify(formatGrantsForJson(grants)));
  } else {
    printGrants(grants, 'received');
  }
}

/**
 * Format grant records for JSON output.
 * Converts bigint fields to strings for JSON serialization.
 */
function formatGrantsForJson(grants: any[]): object[] {
  return grants.map(g => ({
    grant_id: g.grant_id.toString(),
    grantor: g.grantor.toText(),
    grantee: g.grantee.toText(),
    event_ids: g.event_ids,
    scope: g.event_ids.length === 0 ? 'all_kind5_posts' : 'specific_events',
    created_at: g.created_at.toString(),
    expires_at: g.expires_at.toString(),
    expires_at_human: formatNsTimestamp(g.expires_at),
    status: 'Active' in g.status ? 'Active' : 'Revoked',
  }));
}

/**
 * Print grant records in human-readable table format.
 * @param grants - Array of AccessGrant records from canister
 * @param direction - "issued" (grants-out) or "received" (grants-in)
 */
function printGrants(grants: any[], direction: 'issued' | 'received'): void {
  if (grants.length === 0) {
    console.log(`No Kind5 access grants ${direction}.`);
    return;
  }

  console.log(`Kind5 access grants ${direction} (${grants.length} total):`);
  console.log('');
  for (const g of grants) {
    const scope = g.event_ids.length === 0
      ? 'All Kind5 posts'
      : `${g.event_ids.length} event(s)`;
    const peer = direction === 'issued'
      ? `Grantee: ${g.grantee.toText()}`
      : `Grantor: ${g.grantor.toText()}`;

    console.log(`  [Grant #${g.grant_id}]`);
    console.log(`    ${peer}`);
    console.log(`    Scope:      ${scope}`);
    console.log(`    Expires:    ${formatNsTimestamp(g.expires_at)}`);
    console.log(`    Created:    ${formatNsTimestamp(g.created_at)}`);
    if (g.event_ids.length > 0 && g.event_ids.length <= 5) {
      console.log(`    Event IDs:  ${g.event_ids.join(', ')}`);
    } else if (g.event_ids.length > 5) {
      console.log(`    Event IDs:  ${g.event_ids.slice(0, 5).join(', ')} ... (+${g.event_ids.length - 5} more)`);
    }
    console.log('');
  }
}

// ============================================================================
// Encrypted Messaging Commands (send-msg / recv-msg)
// ============================================================================

/** Maximum plaintext payload for encrypted messages (64 KB) */
const MAX_MSG_PAYLOAD = 64 * 1024;

/** Payload type indicator for encrypted messages */
type MessagePayloadType = 'text' | 'file';

/** Tag entry in a Kind17 envelope: ["to", principal], ["payload_type", "text"], etc. */
export type EnvelopeTag = [string, ...string[]];

/**
 * Kind 17 envelope for encrypted messages — compatible with zMail protocol.
 *
 * The sender IBE-encrypts the message and wraps the ciphertext as `content`.
 * Metadata like recipient, payload type, and IBE identity are carried in `tags`.
 * The envelope ID is a SHA-256 hash of the canonical serialization.
 * Signature uses BIP-340 Schnorr over the ID hash.
 */
export interface Kind17Envelope {
  /** SHA-256 hash of canonical serialization [0, ai_id, created_at, 17, tags, content] */
  id: string;
  /** Fixed event kind: 17 */
  kind: 17;
  /** Sender's ICP principal (ai_id) */
  ai_id: string;
  /** Unix timestamp in seconds */
  created_at: number;
  /** Tags carrying recipient and optional metadata */
  tags: EnvelopeTag[];
  /** Encrypted content: JSON string per zmail-skill spec {"v":1,"type":"text"|"file","ct":"<base64>"} */
  content: string;
  /** BIP-340 Schnorr signature over the envelope ID */
  sig: string;
}

// ── Kind17 Envelope Helpers ──────────────────────────────────────────────────

/**
 * NFC-normalize text and convert Windows line endings to Unix.
 * Matches zMail's canonicalization.
 */
function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

/**
 * Deep-canonicalize a value: sort object keys alphabetically, NFC-normalize strings.
 * Produces deterministic JSON for ID computation.
 */
function canonicalize(value: unknown): unknown {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      out[normalizeText(key)] = canonicalize(nested);
    }
    return out;
  }
  return value;
}

/**
 * Compute the Kind17 envelope ID: SHA-256 of canonical serialization.
 * Format: [0, ai_id, created_at, 17, tags, content]
 */
function computeEnvelopeId(envelope: Omit<Kind17Envelope, 'id' | 'sig'>): string {
  const payload = [
    0,
    normalizeText(envelope.ai_id),
    envelope.created_at,
    17,
    canonicalize(envelope.tags),
    canonicalize(envelope.content),
  ];
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

/**
 * Extract the raw 32-byte secp256k1 private key from the session identity.
 * The Secp256k1KeyIdentity.toJSON() returns [publicKeyHex, privateKeyHex].
 */
export function extractPrivateKeyHex(session: Session): string {
  const identity = session.getIdentity();
  const json = (identity as any).toJSON() as [string, string];
  return json[1];
}

/**
 * DER prefix for an uncompressed secp256k1 SPKI public key (23 bytes).
 * SPKI layout: prefix(23) || 04(1) || x(32) || y(32) = 88 bytes total.
 * Hex offset of x-coordinate: 48 (23*2 + 2), length: 64 (32*2).
 */
const SPKI_X_OFFSET = 48;
const SPKI_X_LENGTH = 64;

/**
 * Extract the BIP-340 Schnorr public key (x-only, 32 bytes hex) from an SPKI hex string.
 * The x-coordinate sits at a fixed offset in the uncompressed secp256k1 SPKI DER structure.
 */
export function schnorrPubkeyFromSpki(spkiHex: string): string {
  return spkiHex.slice(SPKI_X_OFFSET, SPKI_X_OFFSET + SPKI_X_LENGTH);
}

/**
 * Build, sign, and return a complete Kind17 envelope.
 *
 * The sender's SPKI public key is included as a ["from_pubkey", spkiHex] tag
 * to enable self-contained sender verification: receivers can derive both the
 * ICP principal (to bind ai_id) and the Schnorr pubkey (to verify sig) from it.
 *
 * @param session  - CLI session (provides identity for Schnorr signing)
 * @param tags     - Envelope tags (must include at least one ["to", ...])
 * @param content  - Encrypted content JSON string: {"v":1,"type":"text"|"file","ct":"<base64>"}
 * @returns Signed Kind17Envelope ready for JSON serialization
 */
function buildSignedEnvelope(
  session: Session,
  tags: EnvelopeTag[],
  content: string,
): Kind17Envelope {
  const senderPrincipal = session.getPrincipal();
  const createdAt = Math.floor(Date.now() / 1000);

  // Include the sender's SPKI public key for receiver-side verification.
  // This enables binding ai_id ↔ pubkey ↔ sig without registry lookups.
  const senderIdentity = session.getIdentity();
  const senderSpkiHex = Buffer.from(senderIdentity.getPublicKey().toDer()).toString('hex');
  const allTags: EnvelopeTag[] = [...tags, ['from_pubkey', senderSpkiHex]];

  // Compute the envelope ID from canonical serialization
  const partial = { kind: 17 as const, ai_id: senderPrincipal, created_at: createdAt, tags: allTags, content };
  const id = computeEnvelopeId(partial);

  // BIP-340 Schnorr sign the ID hash
  const privateKeyHex = extractPrivateKeyHex(session);
  const sig = bytesToHex(schnorr.sign(id, privateKeyHex));

  return { id, kind: 17, ai_id: senderPrincipal, created_at: createdAt, tags: allTags, content, sig };
}

/**
 * send-msg: Encrypt a message for a recipient using IBE and output a Kind17 envelope.
 *
 * The recipient's Mail identity is "{recipient_principal}:Mail".
 * The sender fetches the IBE public key from canister, encrypts locally,
 * builds a Kind17 envelope with BIP-340 Schnorr signature, and outputs JSON.
 *
 * Options:
 *   --to=<AI-ID or principal>   (required) Recipient identifier
 *   --text=<content>            Text message to encrypt
 *   --file=<path>               File to encrypt
 *   --reply=<msg_id>            Parent message ID (for reply threads)
 *   --json                      Output in JSON format (default: true for send-msg)
 */
async function cmdSendMsg(session: Session): Promise<void> {
  const args = session.args;
  const rawTo = args['to'];
  if (rawTo === true) throw new Error('--to requires a value (e.g. --to=runner#8939.agent)');
  const to = rawTo as string | undefined;
  const text = args['text'] as string | boolean | undefined;
  const file = args['file'] as string | boolean | undefined;
  const rawReply = args['reply'];
  if (rawReply === true) throw new Error('--reply requires a message ID value');
  if (typeof rawReply === 'string' && rawReply.length === 0) {
    throw new Error('--reply requires a non-empty message ID');
  }
  const replyMsgId = rawReply as string | undefined;

  if (!to) {
    throw new Error('--to=<AI-ID or principal> is required');
  }

  const { plaintext, payloadType, filename } = readMessageInput(text, file);

  // Resolve recipient: if it looks like an agent name (contains # and .agent),
  // resolve to principal via registry; otherwise treat as raw principal.
  let recipientPrincipal: string;

  if (to.includes('#') && to.includes('.agent')) {
    const registryActor = await session.getAnonymousRegistryActor();
    const result = await registryActor.get_user_principal(to);
    if (!result || result.length === 0) {
      throw new Error(`Cannot resolve AI-ID "${to}" — agent not found in registry`);
    }
    recipientPrincipal = result[0]!.toText();
  } else {
    try {
      recipientPrincipal = Principal.fromText(to).toText();
    } catch {
      throw new Error(`Invalid recipient principal: "${to}"`);
    }
  }

  // IBE identity for recipient's mailbox
  const ibeIdentity = `${recipientPrincipal}:Mail`;

  // Get IBE public key from canister
  const actor = await session.getSignActor();
  let dpkBytes: Uint8Array;
  try {
    const result = await (actor as any).get_ibe_public_key() as Uint8Array;
    dpkBytes = new Uint8Array(result);
  } catch (e) {
    throw canisterCallError(
      `get_ibe_public_key failed: ${e instanceof Error ? e.message : String(e)}`, e,
    );
  }

  // IBE-encrypt the plaintext for the recipient's Mail identity
  const ciphertext = cryptoOps.ibeEncrypt(dpkBytes, ibeIdentity, plaintext);
  const contentBase64 = Buffer.from(ciphertext).toString('base64');

  // Wrap ciphertext in the standardized message composition format per zmail-skill spec.
  // Shape: {"v":1,"type":"text"|"file","ct":"<base64-ciphertext>"}
  // The outer Kind17 envelope carries routing metadata; only the body is encrypted.
  const content = JSON.stringify({ v: 1, type: payloadType, ct: contentBase64 });

  // Build tags: recipient + metadata
  const tags: EnvelopeTag[] = [
    ['to', recipientPrincipal],
    ['payload_type', payloadType],
    ['ibe_id', ibeIdentity],
  ];
  if (filename) {
    tags.push(['filename', filename]);
  }
  // Include reply tag when responding to an existing message
  if (replyMsgId) {
    tags.push(['reply', replyMsgId]);
  }

  // Build and sign the Kind17 envelope
  const envelope = buildSignedEnvelope(session, tags, content);

  // Output the envelope as JSON (always JSON for machine consumption)
  console.log(JSON.stringify(envelope));

  // Auto-POST to zMail if not explicitly disabled with --no-zmail.
  // Failure only warns via stderr — the envelope is already output to stdout.
  if (session.args['no-zmail'] !== true) {
    try {
      const zmailUrlFlag = session.args['zmail-url'];
      const zmailUrlEnv = process.env['ZMAIL_URL'];
      const zmailUrl = (typeof zmailUrlFlag === 'string' && zmailUrlFlag.length > 0)
        ? zmailUrlFlag.replace(/\/+$/, '')
        : (zmailUrlEnv && zmailUrlEnv.length > 0)
          ? zmailUrlEnv.replace(/\/+$/, '')
          : (await import('./config.js')).default.zmail_url;

      const { postEnvelopeToZmail } = await import('./zmail.js');
      const result = await postEnvelopeToZmail(zmailUrl, envelope);
      log.info(`zMail: delivered (msg_id=${result.msg_id}, to=${result.delivered_to})`);
    } catch (err) {
      log.error(`zMail: delivery failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * recv-msg: Decrypt a received Kind17 encrypted message via the Mail daemon.
 *
 * The recipient must have a running daemon with key-name="Mail".
 * The daemon holds the VetKey for "{recipient_principal}:Mail" and
 * performs IBE decryption via the "ibe-decrypt" RPC method.
 *
 * Options:
 *   --data=<json>     (required) Kind17 envelope JSON
 *   --output=<path>   Write decrypted file payload to this path
 *   --json            Output in JSON format
 */
async function cmdRecvMsg(session: Session): Promise<void> {
  const args = session.args;
  const rawData = args['data'];
  if (rawData === true) throw new Error('--data requires a JSON value');
  const dataStr = rawData as string | undefined;
  const rawOutput = args['output'];
  if (rawOutput === true) throw new Error('--output requires a path');
  const output = rawOutput as string | undefined;
  const jsonOutput = !!args['json'];

  if (!dataStr) {
    throw new Error('--data=<json_envelope> is required');
  }

  // Parse and validate the Kind17 envelope
  const envelope = parseKind17Envelope(dataStr);
  const principal = session.getPrincipal();
  const derivationId = `${principal}:Mail`;

  // Extract metadata from tags
  const ibeId = getTagValue(envelope.tags, 'ibe_id') ?? derivationId;
  const payloadType = (getTagValue(envelope.tags, 'payload_type') ?? 'text') as MessagePayloadType;
  const filename = getTagValue(envelope.tags, 'filename');

  // Verify this envelope is addressed to us
  const recipients = envelope.tags.filter(t => t[0] === 'to').map(t => t[1]);
  if (!recipients.includes(principal)) {
    throw new Error(
      `Envelope is not addressed to "${principal}" — recipients: ${recipients.join(', ')}`,
    );
  }

  // Verify envelope integrity and sender authentication.
  // Returns true only if full Schnorr signature + principal binding was verified.
  const verifiedSender = verifyKind17Signature(envelope);

  // Extract the IBE ciphertext from the content field.
  // Content follows the zmail-skill message composition spec:
  // {"v":1,"type":"text"|"file","ct":"<base64-ciphertext>"}
  let ciphertextBase64: string;
  try {
    const parsed = JSON.parse(envelope.content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1 || typeof parsed.ct !== 'string') {
      throw new Error('Invalid message composition format: missing v=1 or ct field');
    }
    // Validate type field exists and matches one of the allowed payload types
    if (parsed.type !== 'text' && parsed.type !== 'file') {
      throw new Error(
        `Invalid message composition format: type must be "text" or "file", got "${String(parsed.type)}"`,
      );
    }
    // Verify consistency between the composition type and the envelope payload_type tag
    if (parsed.type !== payloadType) {
      throw new Error(
        `Message composition type "${parsed.type}" does not match envelope payload_type tag "${payloadType}"`,
      );
    }
    ciphertextBase64 = parsed.ct;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error('Invalid message composition format: content is not valid JSON');
    }
    throw e;
  }

  // Ensure Mail daemon is running (auto-start if needed, wait for ready), then decrypt
  const sockPath = await ensureDaemon(session, 'Mail');
  const response = await sendRpcToSocket(sockPath, {
    id: 1,
    method: 'ibe-decrypt',
    params: {
      ibe_identity: ibeId,
      ciphertext_base64: ciphertextBase64,
    },
  });

  if (response.error) {
    throw new Error(`Daemon decryption failed: ${response.error}`);
  }

  const result = response.result as { data_base64: string; plaintext_size: number };
  if (!result || typeof result.data_base64 !== 'string' || typeof result.plaintext_size !== 'number') {
    throw new Error('Daemon returned an invalid decrypt result');
  }
  const plaintextBytes = decodeBase64Strict(result.data_base64, 'daemon data_base64');
  if (plaintextBytes.length !== result.plaintext_size) {
    throw new Error(
      `Daemon returned mismatched plaintext size: expected ${result.plaintext_size}, got ${plaintextBytes.length}`,
    );
  }

  // Determine output target
  const shouldWriteFile = payloadType === 'file' || !!output;
  const resolvedOutput = shouldWriteFile
    ? (output ?? defaultReceivedPath(payloadType, filename, envelope.created_at))
    : undefined;

  if (resolvedOutput) {
    writeFileSync(resolvedOutput, plaintextBytes);
  }

  // Format output
  if (jsonOutput) {
    const base = {
      from: envelope.ai_id,
      to: recipients,
      payload_type: payloadType,
      filename,
      verified_sender: verifiedSender,
      plaintext_size: result.plaintext_size,
      timestamp: envelope.created_at,
    };
    if (resolvedOutput) {
      console.log(JSON.stringify({ ...base, output_file: resolvedOutput }));
    } else {
      console.log(JSON.stringify({ ...base, plaintext: plaintextBytes.toString('utf-8') }));
    }
  } else if (resolvedOutput) {
    console.log('Decrypted message:');
    console.log(`  From:         ${envelope.ai_id}`);
    console.log(`  To:           ${recipients.join(', ')}`);
    console.log(`  Verified:     ${verifiedSender ? 'yes' : 'id-only'}`);
    console.log(`  Payload Type: ${payloadType}`);
    if (filename) console.log(`  File Name:    ${filename}`);
    console.log(`  Time:         ${new Date(envelope.created_at * 1000).toISOString()}`);
    console.log(`  Size:         ${result.plaintext_size} bytes`);
    console.log(`  Output File:  ${resolvedOutput}`);
  } else {
    console.log('Decrypted message:');
    console.log(`  From:         ${envelope.ai_id}`);
    console.log(`  To:           ${recipients.join(', ')}`);
    console.log(`  Verified:     ${verifiedSender ? 'yes' : 'id-only'}`);
    console.log(`  Payload Type: ${payloadType}`);
    console.log(`  Time:         ${new Date(envelope.created_at * 1000).toISOString()}`);
    console.log(`  Size:         ${result.plaintext_size} bytes`);
    console.log('  Content:');
    console.log(plaintextBytes.toString('utf-8'));
  }
}

// ── Message Input Parsing ────────────────────────────────────────────────────

function readMessageInput(
  text: string | boolean | undefined,
  file: string | boolean | undefined,
): { plaintext: Uint8Array; payloadType: MessagePayloadType; filename?: string } {
  if (text && file) throw new Error('Cannot specify both --text and --file');
  if (text === true) throw new Error("--text requires a value (e.g. --text='hello')");
  if (file === true) throw new Error('--file requires a path (e.g. --file=./data.txt)');

  if (typeof text === 'string') {
    const plaintext = new TextEncoder().encode(text);
    if (plaintext.length > MAX_MSG_PAYLOAD) {
      throw new Error(`Message too large: ${plaintext.length} bytes (max ${MAX_MSG_PAYLOAD} bytes)`);
    }
    return { plaintext, payloadType: 'text' };
  }

  if (typeof file === 'string') {
    const stat = statSync(file);
    if (!stat.isFile()) {
      throw new Error(`'${file}' is not a regular file`);
    }
    if (stat.size > MAX_MSG_PAYLOAD) {
      throw new Error(`Message too large: ${stat.size} bytes (max ${MAX_MSG_PAYLOAD} bytes)`);
    }
    return {
      plaintext: readFileSync(file),
      payloadType: 'file',
      filename: sanitizeFilename(file),
    };
  }

  throw new Error('Either --text or --file must be provided');
}

// ── Kind17 Envelope Parsing & Verification ───────────────────────────────────

/**
 * Parse a JSON string into a Kind17Envelope, validating all required fields.
 */
function parseKind17Envelope(dataStr: string): Kind17Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(dataStr);
  } catch {
    throw new Error('Invalid Kind17 envelope (expected JSON)');
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid Kind17 envelope: expected an object');
  }

  const e = raw as Record<string, unknown>;

  if (typeof e.id !== 'string' || e.id.length === 0) {
    throw new Error('Invalid envelope: id must be a non-empty string');
  }
  if (e.kind !== 17) {
    throw new Error('Invalid envelope: kind must be 17');
  }
  if (typeof e.ai_id !== 'string' || e.ai_id.length === 0) {
    throw new Error('Invalid envelope: ai_id must be a non-empty string');
  }
  if (typeof e.created_at !== 'number' || !Number.isInteger(e.created_at) || e.created_at <= 0) {
    throw new Error('Invalid envelope: created_at must be a positive integer (unix seconds)');
  }
  if (!Array.isArray(e.tags)) {
    throw new Error('Invalid envelope: tags must be an array');
  }
  if (typeof e.content !== 'string' || e.content.length === 0) {
    throw new Error('Invalid envelope: content must be a non-empty string');
  }
  if (typeof e.sig !== 'string' || e.sig.length === 0) {
    throw new Error('Invalid envelope: sig must be a non-empty string');
  }

  // Validate that there is at least one ["to", ...] tag
  const hasRecipient = (e.tags as unknown[][]).some(
    (tag) => Array.isArray(tag) && tag[0] === 'to' && typeof tag[1] === 'string' && tag[1].length > 0,
  );
  if (!hasRecipient) {
    throw new Error('Invalid envelope: must have at least one ["to", principal] tag');
  }

  return {
    id: e.id,
    kind: 17,
    ai_id: e.ai_id,
    created_at: e.created_at,
    tags: e.tags as EnvelopeTag[],
    content: e.content,
    sig: e.sig,
  };
}

/**
 * Verify the Schnorr signature on a Kind17 envelope.
 *
 * Three-step verification:
 *   1. Re-compute envelope ID from canonical serialization → must match `id`
 *   2. Derive ICP principal from SPKI in ["from_pubkey"] tag → must match `ai_id`
 *   3. Derive Schnorr pubkey from the same SPKI → verify BIP-340 signature over `id`
 *
 * If the envelope lacks a ["from_pubkey"] tag, only step 1 (ID integrity) is performed
 * and the function returns false to indicate that the sender is NOT authenticated.
 *
 * @returns true if full sender authentication succeeded, false if only ID integrity was checked
 */
function verifyKind17Signature(envelope: Kind17Envelope): boolean {
  // Step 1: verify the ID matches the canonical serialization
  const computedId = computeEnvelopeId({
    kind: 17,
    ai_id: envelope.ai_id,
    created_at: envelope.created_at,
    tags: envelope.tags,
    content: envelope.content,
  });
  if (computedId !== envelope.id) {
    throw new Error(
      `Envelope ID mismatch: computed "${computedId}" but envelope has "${envelope.id}"`,
    );
  }

  // Step 2 + 3: verify sender identity binding and Schnorr signature
  const senderSpki = getTagValue(envelope.tags, 'from_pubkey');
  if (!senderSpki) {
    // No public key available — ID integrity is verified but sender is not authenticated.
    return false;
  }

  // Derive ICP principal from SPKI and verify it matches the claimed ai_id.
  // This prevents an attacker from signing with their own key while claiming someone else's ai_id.
  const derivedPrincipal = Principal.selfAuthenticating(Buffer.from(senderSpki, 'hex')).toText();
  if (derivedPrincipal !== envelope.ai_id) {
    throw new Error(
      `Sender identity mismatch: from_pubkey derives principal "${derivedPrincipal}" but ai_id is "${envelope.ai_id}"`,
    );
  }

  // Derive Schnorr pubkey (x-coordinate) from the same SPKI and verify the signature
  const schnorrPubkeyHex = schnorrPubkeyFromSpki(senderSpki);
  const valid = schnorr.verify(
    hexToBytes(envelope.sig),
    hexToBytes(envelope.id),
    hexToBytes(schnorrPubkeyHex),
  );
  if (!valid) {
    throw new Error('Envelope Schnorr signature verification failed');
  }

  return true;
}

/**
 * Get the first value for a given tag key from the tags array.
 */
function getTagValue(tags: EnvelopeTag[], key: string): string | undefined {
  const tag = tags.find((t) => t[0] === key);
  return tag ? tag[1] : undefined;
}

/**
 * Generate a default output path for received file/text payloads.
 */
function defaultReceivedPath(
  payloadType: MessagePayloadType,
  filename: string | undefined,
  createdAt: number,
): string {
  const safeName = payloadType === 'file'
    ? (sanitizeFilename(filename) ?? 'message.bin')
    : `message-${createdAt}.txt`;
  return `received_${Date.now()}_${safeName}`;
}

function sanitizeFilename(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const name = basename(filePath);
  if (!name || name === '.' || name === '..') {
    return undefined;
  }
  return name;
}

function decodeBase64Strict(value: string, fieldName: string): Buffer {
  if (value.length === 0) {
    return Buffer.alloc(0);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected base64`);
  }
  return Buffer.from(value, 'base64');
}

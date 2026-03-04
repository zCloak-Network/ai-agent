/**
 * VetKey CLI Module — VetKey IBE encryption/decryption and daemon management
 *
 * Provides two encryption modes:
 *   1. IBE mode: Per-operation Identity-Based Encryption for Kind5 PrivatePost
 *   2. Daemon mode: Long-running AES-256-GCM daemon for fast file encryption
 *
 * Sub-commands:
 *   encrypt-sign    Encrypt + sign Kind5 PrivatePost in one step
 *   decrypt         Decrypt Kind5 PrivatePost by event ID
 *   encrypt-only    Encrypt locally without canister sign
 *   pubkey          Get IBE public key from canister
 *   serve           Start daemon (UDS or stdio mode)
 *   stop            Stop a running daemon
 *   status          Query daemon status
 *
 * Usage: zcloak-ai vetkey <sub-command> [options]
 */

import { readFileSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { createInterface } from 'readline';
import type { Session } from './session.js';
import * as cryptoOps from './crypto.js';
import { KeyStore } from './key-store.js';
import { runDaemonUds, runDaemonStdio } from './serve.js';
import { findRunningDaemon } from './daemon.js';
import { ToolError, canisterCallError } from './error.js';

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
  console.log('Daemon Commands (AES-256-GCM):');
  console.log('  serve           Start encryption daemon');
  console.log('  stop            Stop a running daemon');
  console.log('  status          Query daemon status');
  console.log('');
  console.log('Options:');
  console.log('  --text=<content>     Plaintext to encrypt');
  console.log('  --file=<path>        File to encrypt');
  console.log('  --event-id=<id>      Event ID for decryption');
  console.log('  --output=<path>      Output file path');
  console.log('  --key-name=<name>    Daemon key name (default: "default")');
  console.log('  --stdio              Use stdin/stdout mode for daemon');
  console.log('  --public-key=<hex>   IBE public key for offline encryption');
  console.log('  --ibe-identity=<id>  IBE identity for offline encryption');
  console.log('  --tags=<json>        Tags as JSON array');
  console.log('  --json               Output in JSON format');
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

  // Step 5: Output
  if (jsonOutput) {
    console.log(JSON.stringify({
      event_id: signEvent.id,
      ibe_identity: ibeIdentity,
      kind: signEvent.kind,
      content_hash: signEvent.content_hash,
      created_at: signEvent.created_at.toString(),
      principal,
    }));
  } else {
    console.log("Kind5 PrivatePost signed successfully!");
    console.log(`  Event ID:     ${signEvent.id}`);
    console.log(`  IBE Identity: ${ibeIdentity}`);
    console.log(`  Content Hash: ${signEvent.content_hash}`);
    console.log(`  Principal:    ${principal}`);
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
  const text = args['text'] as string | undefined;
  const file = args['file'] as string | undefined;
  const ibeIdentityOverride = args['ibe-identity'] as string | undefined;
  const publicKeyHex = args['public-key'] as string | undefined;
  const jsonOutput = !!args['json'];

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

  if (jsonOutput) {
    console.log(JSON.stringify({
      ibe_identity: ibeIdentity,
      ciphertext_hex: Buffer.from(ciphertext).toString("hex"),
      ciphertext_size: ciphertext.length,
      plaintext_size: plaintext.length,
      offline: !!publicKeyHex,
    }));
  } else {
    const mode = publicKeyHex ? "fully offline" : "semi-online";
    console.log(`IBE encryption completed (${mode}, not signed on canister)`);
    console.log(`  IBE Identity:    ${ibeIdentity}`);
    console.log(`  Ciphertext size: ${ciphertext.length} bytes`);
    console.log(`  Ciphertext (hex): ${Buffer.from(ciphertext).toString("hex")}`);
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
 * serve: Start daemon in UDS or stdio mode.
 *
 * Creates its own long-lived actor for the daemon lifecycle,
 * using the Session's identity for authentication.
 */
async function cmdServe(session: Session): Promise<void> {
  const args = session.args;
  const keyName = (args['key-name'] as string) || 'default';
  const stdio = !!args['stdio'];

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
  console.error(`Deriving AES-256 key from VetKey (derivation_id: ${derivationId})...`);
  const keyStore = await KeyStore.deriveFromActor(actor, derivationId);
  console.error("Key derived successfully. Starting JSON-RPC daemon...");

  if (stdio) {
    await runDaemonStdio(keyStore, principal, derivationId);
  } else {
    await runDaemonUds(keyStore, principal, derivationId);
  }
}

/**
 * stop: Send shutdown to a running daemon.
 */
async function cmdStop(session: Session): Promise<void> {
  const args = session.args;
  const keyName = (args['key-name'] as string) || 'default';
  const jsonOutput = !!args['json'];

  const principal = session.getPrincipal();
  const derivationId = `${principal}:${keyName}`;
  const sockPath = findRunningDaemon(derivationId);

  // Connect to socket and send shutdown
  const response = await sendRpcToSocket(sockPath, {
    id: 1,
    method: "shutdown",
  });

  if (jsonOutput) {
    console.log(JSON.stringify(response));
  } else {
    console.log("Daemon stopped successfully.");
  }
}

/**
 * status: Query a running daemon.
 */
async function cmdStatus(session: Session): Promise<void> {
  const args = session.args;
  const keyName = (args['key-name'] as string) || 'default';
  const jsonOutput = !!args['json'];

  const principal = session.getPrincipal();
  const derivationId = `${principal}:${keyName}`;
  const sockPath = findRunningDaemon(derivationId);

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
      console.log(`  Mode:          ${result.mode}`);
      if (result.socket_path) {
        console.log(`  Socket:        ${result.socket_path}`);
      }
    } else if (response.error) {
      console.error(`Error: ${response.error}`);
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Read input content from --text or --file as Uint8Array.
 * Supports both text and binary files.
 */
function readInput(text: string | undefined, file: string | undefined): Uint8Array {
  if (text && file) throw new Error("Cannot specify both --text and --file");
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

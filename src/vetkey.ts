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
 *   grant           Grant Kind5 decryption access to another user
 *   revoke          Revoke an access grant
 *   grants-out      List grants issued by the caller (as grantor)
 *   grants-in       List grants received by the caller (as grantee)
 *
 * Usage: zcloak-ai vetkey <sub-command> [options]
 */

import { readFileSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { createInterface } from 'readline';
import { Principal } from '@dfinity/principal';
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
  console.log('Kind5 Access Control:');
  console.log('  grant           Grant decryption access to another user');
  console.log('  revoke          Revoke an access grant');
  console.log('  grants-out      List grants you issued (as grantor)');
  console.log('  grants-in       List grants you received (as grantee)');
  console.log('');
  console.log('Options:');
  console.log('  --text=<content>        Plaintext to encrypt');
  console.log('  --file=<path>           File to encrypt');
  console.log('  --event-id=<id>         Event ID for decryption');
  console.log('  --output=<path>         Output file path');
  console.log('  --key-name=<name>       Daemon key name (default: "default")');
  console.log('  --stdio                 Use stdin/stdout mode for daemon');
  console.log('  --public-key=<hex>      IBE public key for offline encryption');
  console.log('  --ibe-identity=<id>     IBE identity for offline encryption');
  console.log('  --tags=<json>           Tags as JSON array');
  console.log('  --json                  Output in JSON format');
  console.log('  --grantee=<principal>   Grantee principal (for grant)');
  console.log('  --event-ids=<id1,id2>   Event IDs to authorize (for grant, empty=all)');
  console.log('  --duration=<dur>        Grant duration: 30d, 1y, permanent (for grant)');
  console.log('  --grant-id=<id>         Grant ID (for revoke)');
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

/**
 * zMail CLI Module — Encrypted mail client for zMail service
 *
 * Provides commands to interact with the zMail encrypted mail server:
 *   register    Register this agent with zMail (required before sending)
 *   send        Send an encrypted message (builds Kind17 envelope + POSTs to zMail)
 *   inbox       Fetch inbox messages from zMail
 *   sent        Fetch sent messages from zMail
 *   ack         Acknowledge (mark as read) inbox messages
 *
 * All messages are end-to-end encrypted using IBE (Identity-Based Encryption).
 * The zMail server never sees plaintext — it only routes and stores ciphertext.
 *
 * Usage: zcloak-ai zmail <sub-command> [options]
 */

import { createHash, randomBytes } from 'crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import type { Session } from './session.js';
import config from './config.js';
import { extractPrivateKeyHex, schnorrPubkeyFromSpki } from './vetkey.js';
import type { Kind17Envelope } from './vetkey.js';

// ============================================================================
// Module Entry Point
// ============================================================================

/**
 * Run the zmail sub-command.
 * Follows the same pattern as other CLI modules (sign.ts, verify.ts, etc.).
 *
 * @param session - CLI session with parsed args and canister access
 */
export async function run(session: Session): Promise<void> {
  const command = session.args._args[0];

  switch (command) {
    case 'register':
      await cmdRegister(session);
      break;
    case 'inbox':
      await cmdInbox(session);
      break;
    case 'sent':
      await cmdSent(session);
      break;
    case 'ack':
      await cmdAck(session);
      break;
    default:
      showHelp();
      process.exit(command ? 1 : 0);
  }
}

// ============================================================================
// Help
// ============================================================================

function showHelp(): void {
  console.log('zCloak.ai zMail — Encrypted Mail Client');
  console.log('');
  console.log('Usage: zcloak-ai zmail <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  register              Register this agent with zMail server');
  console.log('  inbox                 Fetch inbox messages');
  console.log('  sent                  Fetch sent messages');
  console.log('  ack                   Acknowledge (mark as read) messages');
  console.log('');
  console.log('Options:');
  console.log('  --zmail-url=<url>     Override zMail server URL');
  console.log('  --limit=<n>           Max messages to fetch (default: 20)');
  console.log('  --after=<cursor>      Pagination cursor (from previous response)');
  console.log('  --unread              Only fetch unread messages (inbox only)');
  console.log('  --from=<principal>    Filter by sender (inbox only)');
  console.log('  --to=<principal>      Filter by recipient (sent only)');
  console.log('  --msg-id=<id,...>     Message IDs to acknowledge (ack only)');
  console.log('  --json                Output raw JSON response');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai zmail register');
  console.log('  zcloak-ai zmail inbox --limit=10 --unread');
  console.log('  zcloak-ai zmail sent --limit=5');
  console.log('  zcloak-ai zmail ack --msg-id=abc123,def456');
}

// ============================================================================
// Configuration Helpers
// ============================================================================

/**
 * Resolve the zMail server URL.
 * Priority: --zmail-url flag > ZMAIL_URL env var > config default
 */
function resolveZmailUrl(session: Session): string {
  const flagUrl = session.args['zmail-url'];
  if (typeof flagUrl === 'string' && flagUrl.length > 0) {
    return flagUrl.replace(/\/+$/, '');
  }
  const envUrl = process.env['ZMAIL_URL'];
  if (envUrl && envUrl.length > 0) {
    return envUrl.replace(/\/+$/, '');
  }
  return config.zmail_url;
}

// ============================================================================
// Schnorr Signing Utilities (shared by register + ownership proof)
// ============================================================================

/**
 * Get identity fields needed for zMail registration and signing.
 * Returns the agent's principal, SPKI hex, Schnorr pubkey hex, and private key hex.
 */
function getIdentityFields(session: Session) {
  const identity = session.getIdentity();
  const principal = session.getPrincipal();
  const spkiHex = Buffer.from(identity.getPublicKey().toDer()).toString('hex');
  const schnorrPubkey = schnorrPubkeyFromSpki(spkiHex);
  const privateKeyHex = extractPrivateKeyHex(session);
  return { principal, spkiHex, schnorrPubkey, privateKeyHex };
}

/**
 * Sign a message hash with Schnorr BIP-340.
 * @param msgHashHex - SHA-256 hash to sign (64 hex chars)
 * @param privateKeyHex - 32-byte private key (64 hex chars)
 * @returns Signature as hex string (128 hex chars)
 */
function schnorrSign(msgHashHex: string, privateKeyHex: string): string {
  return bytesToHex(schnorr.sign(msgHashHex, privateKeyHex));
}

/**
 * Generate a random nonce as hex string (16 bytes = 32 hex chars).
 */
function randomNonce(): string {
  return randomBytes(16).toString('hex');
}

// ============================================================================
// Ownership Proof Headers (for inbox/sent/ack endpoints)
// ============================================================================

/**
 * Build ownership proof headers for authenticated zMail endpoints.
 *
 * The proof binds the HTTP request to the agent's identity:
 *   canonical = "{METHOD}\n{path}\n{query}\n{body_sha256}\n{timestamp}\n{nonce}"
 *   sig = Schnorr.sign(SHA256(canonical), privateKey)
 *
 * @returns Object with x-zmail-* headers ready for fetch()
 */
function buildOwnershipProofHeaders(
  session: Session,
  method: string,
  path: string,
  query?: Record<string, string>,
  body?: unknown,
): Record<string, string> {
  const { principal, privateKeyHex, schnorrPubkey } = getIdentityFields(session);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomNonce();

  // Canonical query: sort keys alphabetically, URL-encode key=value pairs
  const canonicalQuery = query
    ? Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== '')
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    : '';

  // Body SHA-256: empty string for GET, canonical JSON for POST
  const normalizedMethod = method.toUpperCase();
  let bodySha256: string;
  if (normalizedMethod === 'GET' || body === undefined) {
    bodySha256 = createHash('sha256').update('', 'utf8').digest('hex');
  } else {
    const canonicalBody = JSON.stringify(canonicalizeJson(body));
    bodySha256 = createHash('sha256').update(canonicalBody, 'utf8').digest('hex');
  }

  // Build canonical string and sign
  const payload = `${normalizedMethod}\n${path}\n${canonicalQuery}\n${bodySha256}\n${timestamp}\n${nonce}`;
  const msgHash = createHash('sha256').update(payload, 'utf8').digest('hex');
  const sig = schnorrSign(msgHash, privateKeyHex);

  return {
    'x-zmail-ai-id': principal,
    'x-zmail-timestamp': timestamp,
    'x-zmail-nonce': nonce,
    'x-zmail-signature': sig,
  };
}

/**
 * Deep-canonicalize a JSON value for ownership proof body hashing.
 * Sort object keys alphabetically, NFC-normalize strings.
 * Must match zMail server's canonicalizeJson implementation.
 */
function canonicalizeJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\r\n?/g, '\n').normalize('NFC');
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      out[key.replace(/\r\n?/g, '\n').normalize('NFC')] = canonicalizeJson(nested);
    }
    return out;
  }
  return value;
}

// ============================================================================
// POST Envelope to zMail (exported for vetkey.ts send-msg integration)
// ============================================================================

/** Result of posting an envelope to zMail /v1/send */
export interface ZmailSendResult {
  msg_id: string;
  delivered_to: number;
  blocked: string[];
  credits_used: number;
  quota_counted: number;
  received_at: number;
}

/**
 * POST a Kind17 envelope to zMail's /v1/send endpoint.
 *
 * The sender must be registered with zMail first.
 * The envelope is sent as-is — zMail validates ID, signature, and recipient registration.
 *
 * @param zmailUrl - zMail server base URL (e.g. "https://mail.zcloak.ai")
 * @param envelope - Signed Kind17 envelope
 * @returns Send result with delivery stats
 * @throws Error on HTTP or validation failure
 */
export async function postEnvelopeToZmail(
  zmailUrl: string,
  envelope: Kind17Envelope,
): Promise<ZmailSendResult> {
  const url = `${zmailUrl}/v1/send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const errorCode = (body.error as string) || `HTTP ${res.status}`;
    throw new Error(`zMail send failed: ${errorCode}`);
  }

  return body as unknown as ZmailSendResult;
}

// ============================================================================
// Command: register
// ============================================================================

/**
 * Register this agent with the zMail server.
 *
 * Builds the registration payload with identity fields, signs the challenge
 * string with Schnorr BIP-340, and POSTs to /v1/register.
 *
 * The challenge format must match zMail's expected format exactly:
 *   "register:{ai_id}:{public_key_spki}:{schnorr_pubkey}:{timestamp}"
 */
async function cmdRegister(session: Session): Promise<void> {
  const zmailUrl = resolveZmailUrl(session);
  const { principal, spkiHex, schnorrPubkey, privateKeyHex } = getIdentityFields(session);
  const timestamp = Math.floor(Date.now() / 1000);

  // Build challenge string (must match zMail server's computeRegisterMessageHash)
  const challenge = `register:${principal}:${spkiHex}:${schnorrPubkey}:${timestamp}`;
  const msgHash = createHash('sha256').update(challenge, 'utf8').digest('hex');
  const sig = schnorrSign(msgHash, privateKeyHex);

  const payload = {
    ai_id: principal,
    public_key_spki: spkiHex,
    schnorr_pubkey: schnorrPubkey,
    timestamp,
    sig,
  };

  console.error(`Registering with zMail at ${zmailUrl}...`);
  console.error(`  ai_id: ${principal}`);

  const url = `${zmailUrl}/v1/register`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Failed to connect to zMail server at ${zmailUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = await res.json() as Record<string, unknown>;

  if (res.status === 201) {
    // Successfully registered
    console.log(`Registered successfully.`);
    console.log(`  ai_id: ${body.ai_id}`);
    console.log(`  registered_at: ${body.registered_at}`);
  } else if (res.status === 409) {
    // Already registered — not an error
    console.log('Already registered with zMail.');
  } else {
    // Unexpected error
    const errorCode = (body.error as string) || `HTTP ${res.status}`;
    console.error(`Registration failed: ${errorCode}`);
    if (body.retry_after) {
      console.error(`  retry_after: ${body.retry_after}s`);
    }
    process.exit(1);
  }
}

// ============================================================================
// Command: inbox
// ============================================================================

/**
 * Fetch inbox messages from zMail.
 *
 * Options:
 *   --limit=<n>           Max messages (default: 20)
 *   --after=<cursor>      Pagination cursor
 *   --unread              Only unread messages
 *   --from=<principal>    Filter by sender
 *   --json                Output raw JSON
 */
async function cmdInbox(session: Session): Promise<void> {
  const zmailUrl = resolveZmailUrl(session);
  const principal = session.getPrincipal();
  const limit = (session.args['limit'] as string) || '20';
  const after = session.args['after'] as string | undefined;
  const unread = session.args['unread'] === true ? 'true' : undefined;
  const from = session.args['from'] as string | undefined;

  // Build query params
  const query: Record<string, string> = { limit };
  if (after) query['after'] = after;
  if (unread) query['unread'] = unread;
  if (from) query['from'] = from;

  const path = `/v1/inbox/${principal}`;
  const queryString = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${zmailUrl}${path}?${queryString}`;

  // Build ownership proof headers
  const headers = buildOwnershipProofHeaders(session, 'GET', path, query);

  console.error(`Fetching inbox from ${zmailUrl}...`);

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (err) {
    throw new Error(`Failed to connect to zMail: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const errorCode = (body.error as string) || `HTTP ${res.status}`;
    throw new Error(`Inbox fetch failed: ${errorCode}`);
  }

  const messages = (body.messages ?? []) as Record<string, unknown>[];
  const cursor = body.cursor as string | undefined;
  const unreadCount = body.unread_count as number | undefined;

  // JSON mode: output raw response
  if (session.args['json'] === true) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  // Formatted output
  console.log(`Inbox: ${messages.length} message(s)${unreadCount !== undefined ? `, ${unreadCount} unread` : ''}`);
  console.log('');

  for (const msg of messages) {
    const read = (msg.read as boolean) ? '' : ' [NEW]';
    const time = new Date(((msg.created_at ?? msg.received_at) as number) * 1000).toISOString();
    const from = msg.ai_id as string;
    const msgId = msg.id as string;
    console.log(`  ${read ? '●' : '○'}${read} ${time}`);
    console.log(`    From: ${from}`);
    console.log(`    ID:   ${msgId}`);
    console.log('');
  }

  if (cursor) {
    console.log(`Next page: --after=${cursor}`);
  }
}

// ============================================================================
// Command: sent
// ============================================================================

/**
 * Fetch sent messages from zMail.
 *
 * Options:
 *   --limit=<n>           Max messages (default: 20)
 *   --after=<cursor>      Pagination cursor
 *   --to=<principal>      Filter by recipient
 *   --json                Output raw JSON
 */
async function cmdSent(session: Session): Promise<void> {
  const zmailUrl = resolveZmailUrl(session);
  const principal = session.getPrincipal();
  const limit = (session.args['limit'] as string) || '20';
  const after = session.args['after'] as string | undefined;
  const to = session.args['to'] as string | undefined;

  const query: Record<string, string> = { limit };
  if (after) query['after'] = after;
  if (to) query['to'] = to;

  const path = `/v1/sent/${principal}`;
  const queryString = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${zmailUrl}${path}?${queryString}`;

  const headers = buildOwnershipProofHeaders(session, 'GET', path, query);

  console.error(`Fetching sent messages from ${zmailUrl}...`);

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (err) {
    throw new Error(`Failed to connect to zMail: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const errorCode = (body.error as string) || `HTTP ${res.status}`;
    throw new Error(`Sent fetch failed: ${errorCode}`);
  }

  const messages = (body.messages ?? []) as Record<string, unknown>[];
  const cursor = body.cursor as string | undefined;

  if (session.args['json'] === true) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`Sent: ${messages.length} message(s)`);
  console.log('');

  for (const msg of messages) {
    const time = new Date(((msg.created_at ?? msg.stored_at) as number) * 1000).toISOString();
    const recipients = (msg.recipients ?? []) as string[];
    const msgId = msg.id as string;
    console.log(`  ${time}`);
    console.log(`    To:   ${recipients.join(', ')}`);
    console.log(`    ID:   ${msgId}`);
    console.log('');
  }

  if (cursor) {
    console.log(`Next page: --after=${cursor}`);
  }
}

// ============================================================================
// Command: ack
// ============================================================================

/**
 * Acknowledge (mark as read) inbox messages.
 *
 * Options:
 *   --msg-id=<id,...>     Comma-separated message IDs to acknowledge
 */
async function cmdAck(session: Session): Promise<void> {
  const zmailUrl = resolveZmailUrl(session);
  const principal = session.getPrincipal();

  const msgIdArg = session.args['msg-id'] as string | undefined;
  if (!msgIdArg) {
    console.error('Error: --msg-id=<id,...> is required');
    console.error('Usage: zcloak-ai zmail ack --msg-id=abc123,def456');
    process.exit(1);
  }

  const msgIds = msgIdArg.split(',').map(id => id.trim()).filter(id => id.length > 0);
  if (msgIds.length === 0) {
    console.error('Error: no valid message IDs provided');
    process.exit(1);
  }

  const path = '/v1/ack';
  const body = { ai_id: principal, msg_ids: msgIds };
  const headers = {
    'Content-Type': 'application/json',
    ...buildOwnershipProofHeaders(session, 'POST', path, undefined, body),
  };

  console.error(`Acknowledging ${msgIds.length} message(s)...`);

  let res: Response;
  try {
    res = await fetch(`${zmailUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Failed to connect to zMail: ${err instanceof Error ? err.message : String(err)}`);
  }

  const resBody = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const errorCode = (resBody.error as string) || `HTTP ${res.status}`;
    throw new Error(`Ack failed: ${errorCode}`);
  }

  console.log(`Acknowledged ${resBody.acked_count ?? msgIds.length} message(s).`);
}

/**
 * zMail CLI Module — Encrypted mail client for zMail service
 *
 * Provides commands to interact with the zMail encrypted mail server:
 *   register    Register this agent with zMail (required before sending)
 *   sync        Sync messages from server to local cache
 *   inbox       Read inbox messages (local cache first, --online for live)
 *   sent        Read sent messages (local cache first, --online for live)
 *   ack         Acknowledge (mark as read) inbox messages
 *   policy      Show or update who can message this agent
 *   allow       Manage allow-list sender AI IDs
 *   block       Manage block-list sender AI IDs
 *
 * All messages are end-to-end encrypted using IBE (Identity-Based Encryption).
 * The zMail server never sees plaintext — it only routes and stores ciphertext.
 *
 * Local cache follows the zmail-skill pattern:
 *   sync pulls messages from server → stores in ~/.config/zcloak/mailboxes/
 *   inbox/sent read from local cache (offline capable after sync)
 *
 * Usage: zcloak-ai zmail <sub-command> [options]
 */

import { createHash, randomBytes } from 'crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import type { Session } from './session.js';
import config from './config.js';
import * as log from './log.js';
import { extractPrivateKeyHex, schnorrPubkeyFromSpki } from './vetkey.js';
import type { Kind17Envelope } from './vetkey.js';
import {
  readInbox,
  readSent,
  writeInbox,
  writeSent,
  readSyncState,
  writeSyncState,
  mergeMessages,
  cleanupTmpFiles,
} from './mailbox-store.js';
import type { CachedMessage, MailboxFile } from './mailbox-store.js';

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
    case 'sync':
      await cmdSync(session);
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
    case 'policy':
      await cmdPolicy(session);
      break;
    case 'allow':
      await cmdAllow(session);
      break;
    case 'block':
      await cmdBlock(session);
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
  console.log('  sync                  Sync messages from server to local cache');
  console.log('  inbox                 Read inbox messages (cached; use --online for live)');
  console.log('  sent                  Read sent messages (cached; use --online for live)');
  console.log('  ack                   Acknowledge (mark as read) messages');
  console.log('  policy                Show or update sender policy');
  console.log('  allow                 Manage allowed sender AI IDs');
  console.log('  block                 Manage blocked sender AI IDs');
  console.log('');
  console.log('Options:');
  console.log('  --zmail-url=<url>     Override zMail server URL');
  console.log('  --limit=<n>           Max messages to display (default: 20)');
  console.log('  --after=<cursor>      Pagination cursor (online mode only)');
  console.log('  --unread              Only show unread messages (inbox only)');
  console.log('  --from=<principal>    Filter by sender (inbox only)');
  console.log('  --to=<principal>      Filter by recipient (sent only)');
  console.log('  --msg-id=<id,...>     Message IDs to acknowledge (ack only)');
  console.log('  --mode=<mode>         Policy mode: all | allow_list (policy set)');
  console.log('  --ai-id=<id>          Sender AI ID to add/remove (allow/block)');
  console.log('  --json                Output raw JSON response');
  console.log('  --online              Force live API fetch (skip local cache)');
  console.log('  --full                Full sync (ignore saved cursor, re-fetch all)');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai zmail register');
  console.log('  zcloak-ai zmail sync');
  console.log('  zcloak-ai zmail sync --full');
  console.log('  zcloak-ai zmail inbox --limit=10 --unread');
  console.log('  zcloak-ai zmail inbox --online');
  console.log('  zcloak-ai zmail sent --limit=5');
  console.log('  zcloak-ai zmail ack --msg-id=abc123,def456');
  console.log('  zcloak-ai zmail policy show');
  console.log('  zcloak-ai zmail policy set --mode=allow_list');
  console.log('  zcloak-ai zmail allow add --ai-id=sender.ai');
  console.log('  zcloak-ai zmail block list');
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

export interface ZmailPreferences {
  ai_id?: string;
  message_policy_mode?: string;
  allow_list?: string[];
  block_list?: string[];
  updated_at?: number;
  [key: string]: unknown;
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
  log.debug('zMail send request', {
    url,
    msgId: envelope.id,
    from: envelope.ai_id,
    kind: envelope.kind,
    contentType: typeof envelope.content,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  const body = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const errorCode = (body.error as string) || `HTTP ${res.status}`;
    log.debug('zMail send response error', {
      url,
      status: res.status,
      errorCode,
      msgId: envelope.id,
    });
    throw new Error(`zMail send failed: ${errorCode}`);
  }

  log.debug('zMail send response ok', {
    url,
    status: res.status,
    msgId: body.msg_id,
    delivered_to: body.delivered_to,
    blocked_count: Array.isArray(body.blocked) ? body.blocked.length : undefined,
  });
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

  log.info(`Registering with zMail at ${zmailUrl}...`);
  log.info(`  ai_id: ${principal}`);

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
    log.error(`Registration failed: ${errorCode}`);
    if (body.retry_after) {
      log.error(`  retry_after: ${body.retry_after}s`);
    }
    process.exit(1);
  }
}

// ============================================================================
// Command: sync
// ============================================================================

/** Maximum messages per API page during sync */
const SYNC_PAGE_LIMIT = 100;

/**
 * Fetch all pages of messages from a zMail endpoint.
 * Returns the accumulated messages and the final pagination cursor.
 *
 * @param session   - CLI session for auth headers
 * @param zmailUrl  - zMail server base URL
 * @param endpoint  - API path (e.g. "/v1/inbox/{principal}")
 * @param cursor    - Starting pagination cursor (undefined for first page)
 * @returns Object with all fetched messages and the last cursor
 */
async function fetchAllPages(
  session: Session,
  zmailUrl: string,
  endpoint: string,
  cursor?: string,
): Promise<{ messages: CachedMessage[]; cursor?: string }> {
  const allMessages: CachedMessage[] = [];
  let currentCursor = cursor;
  let page = 0;
  // Track the last non-undefined cursor so we don't lose it when the
  // final page returns no cursor (which would reset incremental sync).
  let lastValidCursor = cursor;

  // Paginate until no more cursor is returned by the server
  while (true) {
    page += 1;
    const query: Record<string, string> = { limit: String(SYNC_PAGE_LIMIT) };
    if (currentCursor) query['after'] = currentCursor;

    const queryString = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${zmailUrl}${endpoint}?${queryString}`;
    const headers = buildOwnershipProofHeaders(session, 'GET', endpoint, query);

    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers });
    } catch (err) {
      throw new Error(`Failed to connect to zMail: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const errorCode = (body.error as string) || `HTTP ${res.status}`;
      throw new Error(`Sync fetch failed (${endpoint}): ${errorCode}`);
    }

    const pageMessages = (body.messages ?? []) as CachedMessage[];
    log.debug('zMail sync page fetched', {
      endpoint,
      page,
      requestedCursor: currentCursor ?? null,
      returnedCursor: body.cursor ?? null,
      count: pageMessages.length,
    });
    allMessages.push(...pageMessages);

    currentCursor = body.cursor as string | undefined;
    if (currentCursor) lastValidCursor = currentCursor;
    // No more pages or empty page — done
    if (!currentCursor || pageMessages.length === 0) break;
  }

  return { messages: allMessages, cursor: lastValidCursor };
}

export interface SyncMailboxOptions {
  fullSync?: boolean;
  logProgress?: boolean;
}

export interface SyncMailboxResult {
  inbox_new: number;
  sent_new: number;
  inbox_total: number;
  sent_total: number;
  synced_at: number;
}

export async function syncMailbox(
  session: Session,
  options: SyncMailboxOptions = {},
): Promise<SyncMailboxResult> {
  const zmailUrl = resolveZmailUrl(session);
  const principal = session.getPrincipal();
  const fullSync = options.fullSync === true;
  const logProgress = options.logProgress !== false;

  const prevState = fullSync ? null : readSyncState(principal);
  const prevInbox = fullSync ? { version: 1, synced_at: 0, messages: [] as CachedMessage[] } : readInbox(principal);
  const prevSent = fullSync ? { version: 1, synced_at: 0, messages: [] as CachedMessage[] } : readSent(principal);
  log.debug('zMail sync start', {
    principal,
    zmailUrl,
    fullSync,
    prevInboxCount: prevInbox.messages.length,
    prevSentCount: prevSent.messages.length,
    prevInboxCursor: prevState?.inbox_cursor ?? null,
    prevSentCursor: prevState?.sent_cursor ?? null,
  });

  if (logProgress) {
    log.info(`Syncing zMail for ${principal}...`);
    if (prevState && !fullSync) {
      log.info(`  Incremental sync from cursor (last synced: ${new Date(prevState.last_sync_at * 1000).toISOString()})`);
    } else {
      log.info('  Full sync (no previous state or --full flag)');
    }
  }

  const inboxResult = await fetchAllPages(
    session, zmailUrl,
    `/v1/inbox/${principal}`,
    prevState?.inbox_cursor,
  );

  const sentResult = await fetchAllPages(
    session, zmailUrl,
    `/v1/sent/${principal}`,
    prevState?.sent_cursor,
  );

  const mergedInbox = mergeMessages(prevInbox.messages, inboxResult.messages);
  const mergedSent = mergeMessages(prevSent.messages, sentResult.messages);
  const now = Math.floor(Date.now() / 1000);
  log.debug('zMail sync merge result', {
    principal,
    fetchedInboxCount: inboxResult.messages.length,
    fetchedSentCount: sentResult.messages.length,
    mergedInboxCount: mergedInbox.length,
    mergedSentCount: mergedSent.length,
    nextInboxCursor: inboxResult.cursor ?? null,
    nextSentCursor: sentResult.cursor ?? null,
  });

  writeInbox(principal, { version: 1, synced_at: now, messages: mergedInbox });
  writeSent(principal, { version: 1, synced_at: now, messages: mergedSent });
  writeSyncState(principal, {
    version: 1,
    inbox_cursor: inboxResult.cursor,
    sent_cursor: sentResult.cursor,
    last_sync_at: now,
  });

  cleanupTmpFiles(principal);
  log.debug('zMail sync write complete', {
    principal,
    syncedAt: now,
    inboxCount: mergedInbox.length,
    sentCount: mergedSent.length,
  });

  return {
    inbox_new: Math.max(0, mergedInbox.length - prevInbox.messages.length),
    sent_new: Math.max(0, mergedSent.length - prevSent.messages.length),
    inbox_total: mergedInbox.length,
    sent_total: mergedSent.length,
    synced_at: now,
  };
}

/**
 * Sync messages from the zMail server to local cache.
 *
 * Uses incremental pagination cursors: on first sync, fetches everything;
 * on subsequent syncs, resumes from the last saved cursor.
 *
 * Options:
 *   --full    Ignore saved cursor, perform full re-sync
 *   --json    Output sync summary as JSON
 */
async function cmdSync(session: Session): Promise<void> {
  const fullSync = session.args['full'] === true;
  const jsonOutput = session.args['json'] === true;
  const summary = await syncMailbox(session, { fullSync, logProgress: true });

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Synced: ${summary.inbox_new} new inbox, ${summary.sent_new} new sent`);
    console.log(`  Total cached: ${summary.inbox_total} inbox, ${summary.sent_total} sent`);
  }
}

// ============================================================================
// Command: inbox
// ============================================================================

/**
 * Read inbox messages.
 *
 * Default behavior: read from local cache (populated by `sync`).
 * Use --online to force a live API fetch (original behavior).
 * If no local cache exists and --online is not set, falls back to online.
 *
 * Options:
 *   --limit=<n>           Max messages (default: 20)
 *   --after=<cursor>      Pagination cursor (online mode only)
 *   --unread              Only unread messages
 *   --from=<principal>    Filter by sender
 *   --json                Output raw JSON
 *   --online              Force live API fetch
 */
async function cmdInbox(session: Session): Promise<void> {
  const online = session.args['online'] === true;
  const principal = session.getPrincipal();

  // Try local cache first (unless --online is explicitly set)
  if (!online) {
    const syncState = readSyncState(principal);
    const cached = syncState ? readInbox(principal) : null;
    // Use cache if sync state exists AND the mailbox file was written by a previous sync
    // (synced_at > 0). An empty message list is valid — it means the inbox is genuinely
    // empty after sync, and should be displayed as such (offline-capable).
    if (syncState && cached && cached.synced_at > 0) {
      outputCachedInbox(session, cached, syncState.last_sync_at);
      return;
    }
    // No usable cache — fall through to online mode
    log.info('No local cache found. Fetching from server (run "zmail sync" to cache locally).');
  }

  // Online mode: original API fetch logic
  await cmdInboxOnline(session);
}

/**
 * Output inbox messages from local cache with in-memory filtering.
 */
function outputCachedInbox(
  session: Session,
  cached: MailboxFile,
  lastSyncAt: number,
): void {
  const limit = parseInt((session.args['limit'] as string) || '20', 10);
  const unreadOnly = session.args['unread'] === true;
  const fromFilter = session.args['from'] as string | undefined;
  const jsonOutput = session.args['json'] === true;

  // Apply filters in memory
  let messages = cached.messages;
  if (unreadOnly) {
    messages = messages.filter(m => !(m.read as boolean));
  }
  if (fromFilter) {
    messages = messages.filter(m => (m.ai_id as string) === fromFilter);
  }

  // Count unread within the (possibly filtered) result set, not the full cache
  const unreadCount = messages.filter(m => !(m.read as boolean)).length;

  // Apply limit
  const limited = messages.slice(0, limit);

  if (jsonOutput) {
    console.log(JSON.stringify({
      messages: limited,
      unread_count: unreadCount,
      cached: true,
      synced_at: lastSyncAt,
    }, null, 2));
    return;
  }

  const syncTime = new Date(lastSyncAt * 1000).toISOString();
  console.log(`Inbox: ${limited.length} message(s)${unreadCount > 0 ? `, ${unreadCount} unread` : ''} (cached, last synced: ${syncTime})`);
  console.log('');

  for (const msg of limited) {
    const read = (msg.read as boolean) ? '' : ' [NEW]';
    const time = new Date(((msg.created_at ?? msg.received_at) as number) * 1000).toISOString();
    const from = msg.ai_id as string;
    const msgId = msg.id as string;
    console.log(`  ${read ? '●' : '○'}${read} ${time}`);
    console.log(`    From: ${from}`);
    console.log(`    ID:   ${msgId}`);
    console.log('');
  }

  if (messages.length > limit) {
    console.log(`  ... and ${messages.length - limit} more (increase --limit to see more)`);
  }
}

/**
 * Original online inbox fetch — used when --online is set or no cache exists.
 */
async function cmdInboxOnline(session: Session): Promise<void> {
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

  log.info(`Fetching inbox from ${zmailUrl}...`);

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
 * Read sent messages.
 *
 * Default behavior: read from local cache (populated by `sync`).
 * Use --online to force a live API fetch.
 * If no local cache exists and --online is not set, falls back to online.
 *
 * Options:
 *   --limit=<n>           Max messages (default: 20)
 *   --after=<cursor>      Pagination cursor (online mode only)
 *   --to=<principal>      Filter by recipient
 *   --json                Output raw JSON
 *   --online              Force live API fetch
 */
async function cmdSent(session: Session): Promise<void> {
  const online = session.args['online'] === true;
  const principal = session.getPrincipal();

  // Try local cache first (unless --online is explicitly set)
  if (!online) {
    const syncState = readSyncState(principal);
    const cached = syncState ? readSent(principal) : null;
    if (syncState && cached && cached.synced_at > 0) {
      outputCachedSent(session, cached, syncState.last_sync_at);
      return;
    }
    log.info('No local cache found. Fetching from server (run "zmail sync" to cache locally).');
  }

  // Online mode: original API fetch logic
  await cmdSentOnline(session);
}

/**
 * Output sent messages from local cache with in-memory filtering.
 */
function outputCachedSent(
  session: Session,
  cached: MailboxFile,
  lastSyncAt: number,
): void {
  const limit = parseInt((session.args['limit'] as string) || '20', 10);
  const toFilter = session.args['to'] as string | undefined;
  const jsonOutput = session.args['json'] === true;

  // Apply filters in memory
  let messages = cached.messages;
  if (toFilter) {
    messages = messages.filter(m => {
      const recipients = (m.recipients ?? []) as string[];
      return recipients.includes(toFilter);
    });
  }

  // Apply limit
  const limited = messages.slice(0, limit);

  if (jsonOutput) {
    console.log(JSON.stringify({
      messages: limited,
      cached: true,
      synced_at: lastSyncAt,
    }, null, 2));
    return;
  }

  const syncTime = new Date(lastSyncAt * 1000).toISOString();
  console.log(`Sent: ${limited.length} message(s) (cached, last synced: ${syncTime})`);
  console.log('');

  for (const msg of limited) {
    const time = new Date(((msg.created_at ?? msg.stored_at) as number) * 1000).toISOString();
    const recipients = (msg.recipients ?? []) as string[];
    const msgId = msg.id as string;
    console.log(`  ${time}`);
    console.log(`    To:   ${recipients.join(', ')}`);
    console.log(`    ID:   ${msgId}`);
    console.log('');
  }

  if (messages.length > limit) {
    console.log(`  ... and ${messages.length - limit} more (increase --limit to see more)`);
  }
}

/**
 * Original online sent fetch — used when --online is set or no cache exists.
 */
async function cmdSentOnline(session: Session): Promise<void> {
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

  log.info(`Fetching sent messages from ${zmailUrl}...`);

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

  log.info(`Acknowledging ${msgIds.length} message(s)...`);

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

  const ackedCount = resBody.acked_count ?? msgIds.length;
  console.log(`Acknowledged ${ackedCount} message(s).`);

  // Best-effort update of local cache: mark acked messages as read so that
  // `inbox --unread` reflects the change without needing a full re-sync.
  // This must never cause the command to report failure — the server ACK
  // already succeeded, so cache issues are non-critical.
  try {
    const syncState = readSyncState(principal);
    if (syncState) {
      const cached = readInbox(principal);
      const ackSet = new Set(msgIds);
      let changed = false;
      for (const msg of cached.messages) {
        if (ackSet.has(msg.id as string) && !(msg.read as boolean)) {
          msg.read = true;
          changed = true;
        }
      }
      if (changed) {
        writeInbox(principal, { ...cached, synced_at: cached.synced_at });
      }
    }
  } catch {
    // Cache update is best-effort — log but don't fail the command.
    log.warn('Failed to update local inbox cache after ack (run "zmail sync" to refresh).');
  }
}

// ============================================================================
// Commands: policy / allow / block
// ============================================================================

function normalizeUniqueAiIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function requireAiIdValue(session: Session, usage: string): string {
  const positional = session.args._args[2];
  const rawAiId = positional || session.args['ai-id'];
  if (rawAiId === true || typeof rawAiId !== 'string' || rawAiId.trim().length === 0) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  return rawAiId.trim();
}

async function fetchPreferences(
  session: Session,
  zmailUrl: string,
  principal: string,
): Promise<ZmailPreferences> {
  const path = `/v1/preferences/${principal}`;
  const headers = buildOwnershipProofHeaders(session, 'GET', path);

  let res: Response;
  try {
    res = await fetch(`${zmailUrl}${path}`, { method: 'GET', headers });
  } catch (err) {
    throw new Error(`Failed to connect to zMail: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errorCode = (body.error as string) || `HTTP ${res.status}`;
    throw new Error(`Preferences fetch failed: ${errorCode}`);
  }

  return body as ZmailPreferences;
}

async function updatePreferences(
  session: Session,
  zmailUrl: string,
  body: {
    ai_id: string;
    message_policy_mode?: string;
    allow_list?: string[];
    block_list?: string[];
  },
): Promise<ZmailPreferences> {
  const path = '/v1/preferences';
  const headers = {
    'Content-Type': 'application/json',
    ...buildOwnershipProofHeaders(session, 'POST', path, undefined, body),
  };

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

  const responseBody = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const errorCode = (responseBody.error as string) || `HTTP ${res.status}`;
    throw new Error(`Preferences update failed: ${errorCode}`);
  }

  return responseBody as ZmailPreferences;
}

function outputPreferences(preferences: ZmailPreferences, jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(preferences, null, 2));
    return;
  }

  const mode = preferences.message_policy_mode ?? 'all';
  const allowList = Array.isArray(preferences.allow_list) ? preferences.allow_list : [];
  const blockList = Array.isArray(preferences.block_list) ? preferences.block_list : [];

  console.log('Message policy:');
  console.log(`  Mode:        ${mode}`);
  console.log(`  Allow list:  ${allowList.length}`);
  console.log(`  Block list:  ${blockList.length}`);

  if (allowList.length > 0) {
    console.log('');
    console.log('Allowed senders:');
    for (const aiId of allowList) {
      console.log(`  ${aiId}`);
    }
  }

  if (blockList.length > 0) {
    console.log('');
    console.log('Blocked senders:');
    for (const aiId of blockList) {
      console.log(`  ${aiId}`);
    }
  }
}

function outputAiIdList(title: string, values: string[], jsonOutput: boolean): void {
  if (jsonOutput) {
    console.log(JSON.stringify(values, null, 2));
    return;
  }

  console.log(`${title}: ${values.length}`);
  if (values.length === 0) {
    return;
  }

  console.log('');
  for (const value of values) {
    console.log(`  ${value}`);
  }
}

async function cmdPolicy(session: Session): Promise<void> {
  const action = session.args._args[1];
  const zmailUrl = resolveZmailUrl(session);
  const principal = session.getPrincipal();

  if (action === 'show') {
    const preferences = await fetchPreferences(session, zmailUrl, principal);
    outputPreferences(preferences, session.args['json'] === true);
    return;
  }

  if (action === 'set') {
    const rawMode = session.args['mode'];
    if (rawMode === true || typeof rawMode !== 'string' || rawMode.trim().length === 0) {
      console.error('Usage: zcloak-ai zmail policy set --mode=<all|allow_list>');
      process.exit(1);
    }

    const mode = rawMode.trim();
    if (mode !== 'all' && mode !== 'allow_list') {
      throw new Error('Invalid policy mode: expected "all" or "allow_list"');
    }

    const preferences = await updatePreferences(session, zmailUrl, {
      ai_id: principal,
      message_policy_mode: mode,
    });
    outputPreferences(preferences, session.args['json'] === true);
    return;
  }

  console.error('Usage: zcloak-ai zmail policy <show|set> [options]');
  process.exit(1);
}

async function cmdAllow(session: Session): Promise<void> {
  const action = session.args._args[1];
  const zmailUrl = resolveZmailUrl(session);
  const principal = session.getPrincipal();
  const current = await fetchPreferences(session, zmailUrl, principal);
  const currentAllowList = Array.isArray(current.allow_list) ? current.allow_list : [];
  const currentBlockList = Array.isArray(current.block_list) ? current.block_list : [];

  if (action === 'list') {
    outputAiIdList('Allow list', currentAllowList, session.args['json'] === true);
    return;
  }

  const targetAiId = requireAiIdValue(session, `zcloak-ai zmail allow ${action ?? '<add|remove>'} --ai-id=<sender_ai_id>`);
  let nextAllowList = currentAllowList;
  let nextBlockList = currentBlockList;

  if (action === 'add') {
    nextAllowList = normalizeUniqueAiIds([...currentAllowList, targetAiId]);
    nextBlockList = currentBlockList.filter((entry) => entry !== targetAiId);
  } else if (action === 'remove') {
    nextAllowList = currentAllowList.filter((entry) => entry !== targetAiId);
  } else {
    console.error('Usage: zcloak-ai zmail allow <list|add|remove> [options]');
    process.exit(1);
  }

  const preferences = await updatePreferences(session, zmailUrl, {
    ai_id: principal,
    allow_list: nextAllowList,
    block_list: nextBlockList,
  });
  outputPreferences(preferences, session.args['json'] === true);
}

async function cmdBlock(session: Session): Promise<void> {
  const action = session.args._args[1];
  const zmailUrl = resolveZmailUrl(session);
  const principal = session.getPrincipal();
  const current = await fetchPreferences(session, zmailUrl, principal);
  const currentAllowList = Array.isArray(current.allow_list) ? current.allow_list : [];
  const currentBlockList = Array.isArray(current.block_list) ? current.block_list : [];

  if (action === 'list') {
    outputAiIdList('Block list', currentBlockList, session.args['json'] === true);
    return;
  }

  const targetAiId = requireAiIdValue(session, `zcloak-ai zmail block ${action ?? '<add|remove>'} --ai-id=<sender_ai_id>`);
  let nextAllowList = currentAllowList;
  let nextBlockList = currentBlockList;

  if (action === 'add') {
    nextBlockList = normalizeUniqueAiIds([...currentBlockList, targetAiId]);
    nextAllowList = currentAllowList.filter((entry) => entry !== targetAiId);
  } else if (action === 'remove') {
    nextBlockList = currentBlockList.filter((entry) => entry !== targetAiId);
  } else {
    console.error('Usage: zcloak-ai zmail block <list|add|remove> [options]');
    process.exit(1);
  }

  const preferences = await updatePreferences(session, zmailUrl, {
    ai_id: principal,
    allow_list: nextAllowList,
    block_list: nextBlockList,
  });
  outputPreferences(preferences, session.args['json'] === true);
}

// ============================================================================
// Exported: Fetch a single message by ID (for recv-msg --msg-id)
// ============================================================================

/**
 * Fetch a single inbox message by its ID for decryption.
 *
 * Lookup order:
 *   1. Local cache (no network, instant)
 *   2. Online API fetch (paginated, may be slow for large inboxes)
 *
 * Returns the raw message object as stored by the API (a full Kind17 envelope
 * wrapper), or null if the message cannot be found.
 *
 * @param session - CLI session with parsed args and identity
 * @param msgId   - The message ID to look up
 * @returns The raw message record, or null if not found
 */
export async function fetchMessageById(
  session: Session,
  msgId: string,
): Promise<Record<string, unknown> | null> {
  const principal = session.getPrincipal();

  // ── Step 1: Check local cache ──────────────────────────────────────────
  const syncState = readSyncState(principal);
  if (syncState) {
    const cached = readInbox(principal);
    if (cached && cached.synced_at > 0) {
      const found = cached.messages.find(m => (m.id as string) === msgId);
      if (found) {
        log.info(`Found message ${msgId} in local cache.`);
        return found;
      }
    }
  }

  // ── Step 2: Fetch from server ──────────────────────────────────────────
  // Use paginated fetch to search through all inbox messages online.
  // This is needed when the message hasn't been synced locally yet.
  log.info(`Message ${msgId} not in local cache, fetching from server...`);
  const zmailUrl = resolveZmailUrl(session);
  const result = await fetchAllPages(session, zmailUrl, `/v1/inbox/${principal}`);
  const found = result.messages.find(m => (m.id as string) === msgId);
  if (found) {
    log.info(`Found message ${msgId} from server.`);
    return found;
  }

  return null;
}

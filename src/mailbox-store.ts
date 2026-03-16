/**
 * Local mailbox storage layer for zMail.
 *
 * Follows the zmail-skill pattern: messages are synced from the server and
 * cached locally so that `inbox` and `sent` can read from disk without
 * network access.
 *
 * Storage layout:
 *   ~/.config/zcloak/mailboxes/{principal}/
 *     inbox.json          Cached inbox messages
 *     sent.json           Cached sent messages
 *     sync-state.json     Incremental sync cursors
 *
 * Directory permissions: 0o700 (owner only)
 * File permissions:      0o600 (owner read/write)
 *
 * All writes use an atomic .tmp → rename pattern to prevent data corruption
 * if the process is interrupted mid-write.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ============================================================================
// Types
// ============================================================================

/** A single cached message — stored as the raw API response object. */
export type CachedMessage = Record<string, unknown>;

/**
 * On-disk format for inbox.json and sent.json.
 * Messages are stored as-is from the API (still ciphertext, never decrypted here).
 */
export interface MailboxFile {
  /** Schema version (currently 1) */
  version: number;
  /** Unix timestamp (seconds) of when this file was last written */
  synced_at: number;
  /** Ordered array of message objects */
  messages: CachedMessage[];
}

/**
 * Incremental sync state — tracks the server-side pagination cursor
 * so that subsequent syncs only fetch new messages.
 */
export interface SyncState {
  /** Schema version (currently 1) */
  version: number;
  /** Last inbox pagination cursor from the server */
  inbox_cursor?: string;
  /** Last sent pagination cursor from the server */
  sent_cursor?: string;
  /** Unix timestamp (seconds) of the most recent sync */
  last_sync_at: number;
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Return the root directory for all local mailbox caches.
 * Evaluated lazily so that os.homedir() can be mocked in tests.
 */
function mailboxesRoot(): string {
  return join(homedir(), '.config', 'zcloak', 'mailboxes');
}

/**
 * Return the mailbox directory path for a given principal.
 * Does NOT create the directory — call {@link ensureMailboxDir} for that.
 */
export function mailboxDir(principal: string): string {
  return join(mailboxesRoot(), principal);
}

/**
 * Ensure the principal's mailbox directory exists.
 * Creates it (and parents) with 0o700 permissions if missing.
 *
 * @returns The absolute path to the mailbox directory
 */
export function ensureMailboxDir(principal: string): string {
  const dir = mailboxDir(principal);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

// ============================================================================
// Read Helpers
// ============================================================================

/** Default empty mailbox file returned when no local cache exists. */
function emptyMailboxFile(): MailboxFile {
  return { version: 1, synced_at: 0, messages: [] };
}

/**
 * Read a JSON mailbox file from disk.
 * Returns a default empty structure if the file does not exist.
 *
 * @throws Error if the file exists but contains invalid JSON
 */
function readMailboxFile(filePath: string): MailboxFile {
  if (!existsSync(filePath)) return emptyMailboxFile();
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as MailboxFile;
  if (typeof parsed.version !== 'number' || !Array.isArray(parsed.messages)) {
    throw new Error(`Invalid mailbox file format: ${filePath}`);
  }
  return parsed;
}

/** Read the local inbox cache for a principal. */
export function readInbox(principal: string): MailboxFile {
  return readMailboxFile(join(mailboxDir(principal), 'inbox.json'));
}

/** Read the local sent cache for a principal. */
export function readSent(principal: string): MailboxFile {
  return readMailboxFile(join(mailboxDir(principal), 'sent.json'));
}

/**
 * Read the sync state for a principal.
 * Returns null if no sync has been performed yet.
 */
export function readSyncState(principal: string): SyncState | null {
  const filePath = join(mailboxDir(principal), 'sync-state.json');
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as SyncState;
}

// ============================================================================
// Write Helpers (atomic: write .tmp then rename)
// ============================================================================

/**
 * Atomically write a JSON file: write to a .tmp sibling, then rename.
 * This prevents data corruption if the process is killed mid-write.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  const content = JSON.stringify(data, null, 2);
  writeFileSync(tmpPath, content, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/** Write the inbox cache for a principal. */
export function writeInbox(principal: string, data: MailboxFile): void {
  ensureMailboxDir(principal);
  atomicWriteJson(join(mailboxDir(principal), 'inbox.json'), data);
}

/** Write the sent cache for a principal. */
export function writeSent(principal: string, data: MailboxFile): void {
  ensureMailboxDir(principal);
  atomicWriteJson(join(mailboxDir(principal), 'sent.json'), data);
}

/** Write the sync state for a principal. */
export function writeSyncState(principal: string, state: SyncState): void {
  ensureMailboxDir(principal);
  atomicWriteJson(join(mailboxDir(principal), 'sync-state.json'), state);
}

// ============================================================================
// Message Merging
// ============================================================================

/**
 * Merge incoming messages into an existing message list.
 *
 * - De-duplicates by message `id`
 * - For duplicate IDs, incoming data wins (e.g. updated `read` status)
 * - Result is sorted by `created_at` descending (newest first)
 *
 * @param existing  - Previously cached messages
 * @param incoming  - Newly fetched messages from the server
 * @returns Merged, de-duplicated, sorted message array
 */
export function mergeMessages(
  existing: CachedMessage[],
  incoming: CachedMessage[],
): CachedMessage[] {
  // Build a map keyed by message id; incoming overwrites existing
  const map = new Map<string, CachedMessage>();
  for (const msg of existing) {
    const id = msg.id as string;
    if (id) map.set(id, msg);
  }
  for (const msg of incoming) {
    const id = msg.id as string;
    if (id) map.set(id, msg);
  }

  // Sort by timestamp descending (newest first).
  // Messages may carry created_at, received_at, or stored_at depending on
  // whether they are inbox or sent records — fall through in priority order.
  return Array.from(map.values()).sort((a, b) => {
    const ta = (a.created_at ?? a.received_at ?? a.stored_at ?? 0) as number;
    const tb = (b.created_at ?? b.received_at ?? b.stored_at ?? 0) as number;
    return tb - ta;
  });
}

/**
 * Clean up leftover .tmp files in a principal's mailbox directory.
 * Called defensively after sync in case a previous run was interrupted.
 */
export function cleanupTmpFiles(principal: string): void {
  const dir = mailboxDir(principal);
  for (const name of ['inbox.json.tmp', 'sent.json.tmp', 'sync-state.json.tmp']) {
    const tmpPath = join(dir, name);
    try { unlinkSync(tmpPath); } catch { /* file may not exist */ }
  }
}

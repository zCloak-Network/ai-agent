/**
 * Tests for mailbox-store.ts — local mailbox storage layer.
 *
 * Uses real temporary directories (os.tmpdir) for integration-style tests
 * that verify actual file I/O, permissions, and atomic write behavior.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock os.homedir() so that mailbox files are written to a temp directory
// instead of the real ~/.config/zcloak/mailboxes/
const { mockHomedir } = vi.hoisted(() => ({
  mockHomedir: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: mockHomedir };
});

import {
  mailboxDir,
  ensureMailboxDir,
  readInbox,
  readSent,
  writeInbox,
  writeSent,
  readSyncState,
  writeSyncState,
  mergeMessages,
  cleanupTmpFiles,
} from '../mailbox-store.js';
import type { MailboxFile, SyncState, CachedMessage } from '../mailbox-store.js';

describe('mailbox-store', () => {
  let tmpDir: string;
  const testPrincipal = 'rnk7r-h5pex-bqbjr-x42yi-76bsl-c4mzs-jtcux-zhwvu-tikt7-ezkn3-hae';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-mailbox-test-'));
    mockHomedir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Path Helpers ──────────────────────────────────────────────────────────

  describe('mailboxDir', () => {
    it('returns path under ~/.config/zcloak/mailboxes/{principal}', () => {
      const dir = mailboxDir(testPrincipal);
      expect(dir).toBe(path.join(tmpDir, '.config', 'zcloak', 'mailboxes', testPrincipal));
    });
  });

  describe('ensureMailboxDir', () => {
    it('creates the directory with recursive parents', () => {
      const dir = ensureMailboxDir(testPrincipal);
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('is idempotent — calling twice does not throw', () => {
      ensureMailboxDir(testPrincipal);
      expect(() => ensureMailboxDir(testPrincipal)).not.toThrow();
    });
  });

  // ── Read/Write Inbox ──────────────────────────────────────────────────────

  describe('readInbox / writeInbox', () => {
    it('returns empty mailbox when file does not exist', () => {
      const result = readInbox(testPrincipal);
      expect(result.version).toBe(1);
      expect(result.synced_at).toBe(0);
      expect(result.messages).toEqual([]);
    });

    it('round-trips: write then read returns same data', () => {
      const data: MailboxFile = {
        version: 1,
        synced_at: 1710000000,
        messages: [
          { id: 'msg1', ai_id: 'sender-a', created_at: 1710000000, read: false, content: 'encrypted...' },
          { id: 'msg2', ai_id: 'sender-b', created_at: 1710000100, read: true, content: 'encrypted2' },
        ],
      };

      writeInbox(testPrincipal, data);
      const result = readInbox(testPrincipal);

      expect(result.version).toBe(1);
      expect(result.synced_at).toBe(1710000000);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]!.id).toBe('msg1');
      expect(result.messages[1]!.id).toBe('msg2');
    });

    it('throws on invalid JSON file format', () => {
      ensureMailboxDir(testPrincipal);
      const filePath = path.join(mailboxDir(testPrincipal), 'inbox.json');
      fs.writeFileSync(filePath, '{"not_valid": true}');

      expect(() => readInbox(testPrincipal)).toThrow('Invalid mailbox file format');
    });
  });

  // ── Read/Write Sent ───────────────────────────────────────────────────────

  describe('readSent / writeSent', () => {
    it('returns empty mailbox when file does not exist', () => {
      const result = readSent(testPrincipal);
      expect(result.messages).toEqual([]);
    });

    it('round-trips correctly', () => {
      const data: MailboxFile = {
        version: 1,
        synced_at: 1710000000,
        messages: [{ id: 'sent1', recipients: ['r1'], created_at: 1710000000 }],
      };

      writeSent(testPrincipal, data);
      const result = readSent(testPrincipal);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.id).toBe('sent1');
    });
  });

  // ── Sync State ────────────────────────────────────────────────────────────

  describe('readSyncState / writeSyncState', () => {
    it('returns null when no sync has been performed', () => {
      expect(readSyncState(testPrincipal)).toBeNull();
    });

    it('round-trips correctly', () => {
      const state: SyncState = {
        version: 1,
        inbox_cursor: 'cursor-inbox-abc',
        sent_cursor: 'cursor-sent-xyz',
        last_sync_at: 1710000000,
      };

      writeSyncState(testPrincipal, state);
      const result = readSyncState(testPrincipal);

      expect(result).toEqual(state);
    });

    it('persists state without optional cursors', () => {
      const state: SyncState = {
        version: 1,
        last_sync_at: 1710000000,
      };

      writeSyncState(testPrincipal, state);
      const result = readSyncState(testPrincipal);

      expect(result!.inbox_cursor).toBeUndefined();
      expect(result!.sent_cursor).toBeUndefined();
      expect(result!.last_sync_at).toBe(1710000000);
    });
  });

  // ── Atomic Write ──────────────────────────────────────────────────────────

  describe('atomic write behavior', () => {
    it('does not leave .tmp files after successful write', () => {
      writeInbox(testPrincipal, { version: 1, synced_at: 0, messages: [] });
      const dir = mailboxDir(testPrincipal);
      const tmpPath = path.join(dir, 'inbox.json.tmp');
      expect(fs.existsSync(tmpPath)).toBe(false);
    });
  });

  // ── cleanupTmpFiles ───────────────────────────────────────────────────────

  describe('cleanupTmpFiles', () => {
    it('removes leftover .tmp files', () => {
      ensureMailboxDir(testPrincipal);
      const dir = mailboxDir(testPrincipal);

      // Simulate leftover .tmp files from an interrupted write
      fs.writeFileSync(path.join(dir, 'inbox.json.tmp'), 'partial');
      fs.writeFileSync(path.join(dir, 'sent.json.tmp'), 'partial');

      cleanupTmpFiles(testPrincipal);

      expect(fs.existsSync(path.join(dir, 'inbox.json.tmp'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'sent.json.tmp'))).toBe(false);
    });

    it('does not throw when no .tmp files exist', () => {
      ensureMailboxDir(testPrincipal);
      expect(() => cleanupTmpFiles(testPrincipal)).not.toThrow();
    });
  });

  // ── mergeMessages ─────────────────────────────────────────────────────────

  describe('mergeMessages', () => {
    it('appends new messages', () => {
      const existing: CachedMessage[] = [{ id: 'a', created_at: 100 }];
      const incoming: CachedMessage[] = [{ id: 'b', created_at: 200 }];
      const result = mergeMessages(existing, incoming);
      expect(result).toHaveLength(2);
      // Newest first
      expect(result[0]!.id).toBe('b');
      expect(result[1]!.id).toBe('a');
    });

    it('de-duplicates by id — incoming wins', () => {
      const existing: CachedMessage[] = [{ id: 'a', created_at: 100, read: false }];
      const incoming: CachedMessage[] = [{ id: 'a', created_at: 100, read: true }];
      const result = mergeMessages(existing, incoming);
      expect(result).toHaveLength(1);
      expect(result[0]!.read).toBe(true);
    });

    it('sorts by created_at descending', () => {
      const existing: CachedMessage[] = [];
      const incoming: CachedMessage[] = [
        { id: 'c', created_at: 300 },
        { id: 'a', created_at: 100 },
        { id: 'b', created_at: 200 },
      ];
      const result = mergeMessages(existing, incoming);
      expect(result.map(m => m.id)).toEqual(['c', 'b', 'a']);
    });

    it('uses received_at as fallback for sorting', () => {
      const existing: CachedMessage[] = [];
      const incoming: CachedMessage[] = [
        { id: 'a', received_at: 50 },
        { id: 'b', received_at: 150 },
      ];
      const result = mergeMessages(existing, incoming);
      expect(result[0]!.id).toBe('b');
      expect(result[1]!.id).toBe('a');
    });

    it('uses stored_at as fallback for sorting (sent messages)', () => {
      const existing: CachedMessage[] = [];
      const incoming: CachedMessage[] = [
        { id: 'a', stored_at: 50 },
        { id: 'b', stored_at: 150 },
        { id: 'c', created_at: 100 },
      ];
      const result = mergeMessages(existing, incoming);
      // c (created_at=100) sorts between b (stored_at=150) and a (stored_at=50)
      expect(result.map(m => m.id)).toEqual(['b', 'c', 'a']);
    });

    it('handles empty arrays', () => {
      expect(mergeMessages([], [])).toEqual([]);
      expect(mergeMessages([{ id: 'a', created_at: 1 }], [])).toHaveLength(1);
      expect(mergeMessages([], [{ id: 'b', created_at: 2 }])).toHaveLength(1);
    });

    it('skips messages without id', () => {
      const result = mergeMessages([], [{ created_at: 100 }, { id: 'a', created_at: 200 }]);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('a');
    });
  });
});

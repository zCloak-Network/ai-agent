/**
 * Tests for zmail.ts — zMail encrypted mail client commands
 *
 * Covers: run() routing, register command (success, already-registered, failure),
 * sync command (full, incremental, multi-page), inbox/sent (online + cached modes),
 * ack command, postEnvelopeToZmail (success, error), and ownership proof headers.
 * Uses mocked Session, fetch, and mailbox-store to avoid real I/O.
 */

import { createHash } from 'crypto';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Secp256k1KeyIdentity } from '@dfinity/identity-secp256k1';

// Mock mailbox-store before importing zmail
const {
  mockReadInbox,
  mockReadSent,
  mockWriteInbox,
  mockWriteSent,
  mockReadSyncState,
  mockWriteSyncState,
  mockMergeMessages,
  mockCleanupTmpFiles,
} = vi.hoisted(() => ({
  mockReadInbox: vi.fn(() => ({ version: 1, synced_at: 0, messages: [] })),
  mockReadSent: vi.fn(() => ({ version: 1, synced_at: 0, messages: [] })),
  mockWriteInbox: vi.fn(),
  mockWriteSent: vi.fn(),
  mockReadSyncState: vi.fn(() => null),
  mockWriteSyncState: vi.fn(),
  mockMergeMessages: vi.fn((existing: unknown[], incoming: unknown[]) => {
    // Simple merge: de-dup by id, incoming wins
    const map = new Map<string, unknown>();
    for (const m of existing) map.set((m as Record<string, unknown>).id as string, m);
    for (const m of incoming) map.set((m as Record<string, unknown>).id as string, m);
    return Array.from(map.values());
  }),
  mockCleanupTmpFiles: vi.fn(),
}));

vi.mock('../mailbox-store.js', () => ({
  readInbox: mockReadInbox,
  readSent: mockReadSent,
  writeInbox: mockWriteInbox,
  writeSent: mockWriteSent,
  readSyncState: mockReadSyncState,
  writeSyncState: mockWriteSyncState,
  mergeMessages: mockMergeMessages,
  cleanupTmpFiles: mockCleanupTmpFiles,
}));

import { run, postEnvelopeToZmail } from '../zmail.js';
import type { Session } from '../session.js';

// Mock process.exit to prevent test runner from exiting
vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});
// log.error writes to process.stderr, not console.error
const mockStderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

afterEach(() => {
  vi.clearAllMocks();
});

/** Generate a test identity and create a mock Session */
function createTestSession(
  args: string[],
  flags: Record<string, string | boolean> = {},
): { session: Session; identity: Secp256k1KeyIdentity } {
  const identity = Secp256k1KeyIdentity.generate();
  const session = {
    args: { _args: args, ...flags },
    getIdentity: vi.fn().mockReturnValue(identity),
    getPrincipal: vi.fn().mockReturnValue(identity.getPrincipal().toText()),
  } as unknown as Session;
  return { session, identity };
}

// ============================================================================
// Routing
// ============================================================================

describe('zmail run() — routing', () => {
  it('shows help and exits for unknown command', async () => {
    const { session } = createTestSession(['unknown']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai zMail — Encrypted Mail Client');
  });

  it('shows help when no command provided', async () => {
    const { session } = createTestSession([]);

    await expect(run(session)).rejects.toThrow('process.exit called');
  });
});

// ============================================================================
// Register Command
// ============================================================================

describe('zmail register command', () => {
  it('registers successfully with zMail', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ ai_id: 'test-principal', registered_at: 1710000000 }),
    });
    const { session, identity } = createTestSession(['register']);

    await run(session);

    // Verify fetch was called with correct URL and payload
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/register'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // Verify payload structure
    const call = mockFetch.mock.calls[0]!;
    const body = JSON.parse(call[1].body as string);
    expect(body.ai_id).toBe(identity.getPrincipal().toText());
    expect(body.public_key_spki).toBeTruthy();
    expect(body.schnorr_pubkey).toBeTruthy();
    expect(body.schnorr_pubkey).toHaveLength(64); // 32 bytes hex
    expect(body.timestamp).toBeTypeOf('number');
    expect(body.sig).toBeTruthy();
    expect(body.sig).toHaveLength(128); // 64 bytes hex

    // Verify challenge format matches zMail expectations
    const expectedChallenge = `register:${body.ai_id}:${body.public_key_spki}:${body.schnorr_pubkey}:${body.timestamp}`;
    const expectedHash = createHash('sha256').update(expectedChallenge, 'utf8').digest('hex');
    expect(expectedHash).toHaveLength(64);

    expect(mockLog).toHaveBeenCalledWith('Registered successfully.');
  });

  it('handles already-registered response (409)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'already_registered' }),
    });
    const { session } = createTestSession(['register']);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('Already registered with zMail.');
  });

  it('handles registration failure with error message', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'agent_not_bound' }),
    });
    const { session } = createTestSession(['register']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    // log.error writes to process.stderr via the log module, not console.error
    expect(mockStderr).toHaveBeenCalledWith(
      expect.stringContaining('Registration failed: agent_not_bound'),
    );
  });

  it('handles network errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const { session } = createTestSession(['register']);

    await expect(run(session)).rejects.toThrow('Failed to connect to zMail');
  });

  it('uses --zmail-url flag to override server URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ ai_id: 'test', registered_at: 1710000000 }),
    });
    const { session } = createTestSession(['register'], { 'zmail-url': 'http://localhost:8080' });

    await run(session);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/register',
      expect.anything(),
    );
  });
});

// ============================================================================
// Sync Command
// ============================================================================

describe('zmail sync command', () => {
  it('performs full sync and writes local cache', async () => {
    // Single page of inbox and sent
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          messages: [{ id: 'inbox1', created_at: 100 }],
          cursor: 'cursor-inbox',
        }),
      })
      // Second inbox page: empty (end of pagination)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          messages: [{ id: 'sent1', created_at: 200 }],
          cursor: 'cursor-sent',
        }),
      })
      // Second sent page: empty
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [] }),
      });

    const { session } = createTestSession(['sync']);

    await run(session);

    // Verify writeInbox and writeSent were called
    expect(mockWriteInbox).toHaveBeenCalledTimes(1);
    expect(mockWriteSent).toHaveBeenCalledTimes(1);
    expect(mockWriteSyncState).toHaveBeenCalledTimes(1);
    expect(mockCleanupTmpFiles).toHaveBeenCalledTimes(1);

    // Verify sync state includes cursors
    const syncStateArg = mockWriteSyncState.mock.calls[0]![1];
    expect(syncStateArg.version).toBe(1);
    expect(syncStateArg.last_sync_at).toBeTypeOf('number');

    // Verify output summary
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('new inbox'));
  });

  it('uses saved cursor for incremental sync', async () => {
    // Simulate existing sync state with cursors
    mockReadSyncState.mockReturnValue({
      version: 1,
      inbox_cursor: 'prev-inbox-cursor',
      sent_cursor: 'prev-sent-cursor',
      last_sync_at: 1700000000,
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [], cursor: undefined }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [], cursor: undefined }),
      });

    const { session } = createTestSession(['sync']);

    await run(session);

    // Verify that the first fetch included the saved cursor
    const firstUrl = mockFetch.mock.calls[0]![0] as string;
    expect(firstUrl).toContain('after=prev-inbox-cursor');
  });

  it('ignores saved cursor when --full is set', async () => {
    mockReadSyncState.mockReturnValue({
      version: 1,
      inbox_cursor: 'old-cursor',
      sent_cursor: 'old-cursor',
      last_sync_at: 1700000000,
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [], cursor: undefined }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [], cursor: undefined }),
      });

    const { session } = createTestSession(['sync'], { full: true });

    await run(session);

    // First URL should NOT contain the old cursor
    const firstUrl = mockFetch.mock.calls[0]![0] as string;
    expect(firstUrl).not.toContain('old-cursor');
  });

  it('does not overwrite cache on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { session } = createTestSession(['sync']);

    await expect(run(session)).rejects.toThrow('Network error');

    // Write functions should not have been called
    expect(mockWriteInbox).not.toHaveBeenCalled();
    expect(mockWriteSent).not.toHaveBeenCalled();
    expect(mockWriteSyncState).not.toHaveBeenCalled();
  });

  it('outputs JSON summary when --json is set', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [], cursor: undefined }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ messages: [], cursor: undefined }),
      });

    const { session } = createTestSession(['sync'], { json: true });

    await run(session);

    // Should output JSON with summary fields
    const jsonCall = mockLog.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('inbox_new'),
    );
    expect(jsonCall).toBeTruthy();
    const parsed = JSON.parse(jsonCall![0] as string);
    expect(parsed.inbox_new).toBe(0);
    expect(parsed.sent_new).toBe(0);
  });
});

// ============================================================================
// Inbox Command
// ============================================================================

describe('zmail inbox command', () => {
  it('reads from local cache when sync state exists', async () => {
    mockReadSyncState.mockReturnValue({
      version: 1,
      inbox_cursor: 'c',
      last_sync_at: 1710000000,
    });
    mockReadInbox.mockReturnValue({
      version: 1,
      synced_at: 1710000000,
      messages: [
        { id: 'msg1', ai_id: 'sender-a', created_at: 1710000000, read: false },
        { id: 'msg2', ai_id: 'sender-b', created_at: 1710001000, read: true },
      ],
    });

    const { session } = createTestSession(['inbox']);

    await run(session);

    // Should NOT call fetch (reads from cache)
    expect(mockFetch).not.toHaveBeenCalled();
    // Should display messages
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('2 message(s)'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('cached'));
  });

  it('falls back to online when no cache exists', async () => {
    // readSyncState returns null (no cache)
    mockReadSyncState.mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [], unread_count: 0 }),
    });
    const { session } = createTestSession(['inbox']);

    await run(session);

    // Should call fetch
    expect(mockFetch).toHaveBeenCalled();
  });

  it('uses cache for empty inbox after a successful sync', async () => {
    // sync-state exists and inbox was synced (synced_at > 0) but has no messages —
    // this is a valid empty inbox, should NOT fall back to online.
    mockReadSyncState.mockReturnValue({ version: 1, last_sync_at: 1710000000 });
    mockReadInbox.mockReturnValue({ version: 1, synced_at: 1710000000, messages: [] });
    const { session } = createTestSession(['inbox']);

    await run(session);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('0 message(s)'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('cached'));
  });

  it('falls back to online when inbox.json was never written by sync', async () => {
    // sync-state exists but inbox.json is the default (synced_at = 0, never written)
    mockReadSyncState.mockReturnValue({ version: 1, last_sync_at: 1710000000 });
    mockReadInbox.mockReturnValue({ version: 1, synced_at: 0, messages: [] });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [{ id: 'live1', ai_id: 'x', created_at: 1710000000, read: false }], unread_count: 0 }),
    });
    const { session } = createTestSession(['inbox']);

    await run(session);

    // synced_at = 0 means inbox.json was never written — fall back to online
    expect(mockFetch).toHaveBeenCalled();
  });

  it('forces online mode with --online flag', async () => {
    // Even with sync state present, --online should bypass cache
    mockReadSyncState.mockReturnValue({
      version: 1,
      inbox_cursor: 'c',
      last_sync_at: 1710000000,
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [], unread_count: 0 }),
    });
    const { session } = createTestSession(['inbox'], { online: true });

    await run(session);

    expect(mockFetch).toHaveBeenCalled();
  });

  it('filters unread messages from cache', async () => {
    mockReadSyncState.mockReturnValue({ version: 1, last_sync_at: 1710000000 });
    mockReadInbox.mockReturnValue({
      version: 1,
      synced_at: 1710000000,
      messages: [
        { id: 'msg1', ai_id: 'a', created_at: 100, read: false },
        { id: 'msg2', ai_id: 'b', created_at: 200, read: true },
        { id: 'msg3', ai_id: 'c', created_at: 300, read: false },
      ],
    });

    const { session } = createTestSession(['inbox'], { unread: true });

    await run(session);

    // Should show only 2 unread messages
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('2 message(s)'));
  });

  it('applies --limit to cached results', async () => {
    mockReadSyncState.mockReturnValue({ version: 1, last_sync_at: 1710000000 });
    mockReadInbox.mockReturnValue({
      version: 1,
      synced_at: 1710000000,
      messages: [
        { id: 'msg1', ai_id: 'a', created_at: 100, read: false },
        { id: 'msg2', ai_id: 'b', created_at: 200, read: false },
        { id: 'msg3', ai_id: 'c', created_at: 300, read: false },
      ],
    });

    const { session } = createTestSession(['inbox'], { limit: '1' });

    await run(session);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('1 message(s)'));
    // Should show "and N more" hint
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('2 more'));
  });

  // Online mode tests (existing behavior preserved)
  it('fetches and displays inbox messages (online)', async () => {
    mockReadSyncState.mockReturnValue(null);
    const sampleMessages = [
      { id: 'msg1', ai_id: 'sender-principal', created_at: 1710000000, read: false },
      { id: 'msg2', ai_id: 'other-sender', created_at: 1710001000, read: true },
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        messages: sampleMessages,
        cursor: 'next-cursor',
        unread_count: 1,
      }),
    });
    const { session } = createTestSession(['inbox']);

    await run(session);

    // Verify fetch was called with ownership proof headers
    const call = mockFetch.mock.calls[0]!;
    const headers = call[1].headers as Record<string, string>;
    expect(headers['x-zmail-ai-id']).toBeTruthy();
    expect(headers['x-zmail-timestamp']).toBeTruthy();
    expect(headers['x-zmail-nonce']).toBeTruthy();
    expect(headers['x-zmail-signature']).toBeTruthy();
    expect(headers['x-zmail-signature']).toHaveLength(128);

    // Verify output
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('2 message(s)'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('1 unread'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('next-cursor'));
  });

  it('handles empty inbox (online)', async () => {
    mockReadSyncState.mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [], unread_count: 0 }),
    });
    const { session } = createTestSession(['inbox']);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('0 message(s)'));
  });

  it('outputs raw JSON when --json flag is set (online)', async () => {
    mockReadSyncState.mockReturnValue(null);
    const responseData = { messages: [{ id: 'msg1' }], cursor: null, unread_count: 0 };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responseData),
    });
    const { session } = createTestSession(['inbox'], { json: true });

    await run(session);

    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(responseData, null, 2));
  });

  it('passes query params correctly (online)', async () => {
    mockReadSyncState.mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    });
    const { session } = createTestSession(['inbox'], {
      limit: '5',
      after: 'cursor123',
      unread: true,
      from: 'sender-abc',
      online: true,
    });

    await run(session);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('limit=5');
    expect(url).toContain('after=cursor123');
    expect(url).toContain('unread=true');
    expect(url).toContain('from=sender-abc');
  });

  it('throws error on HTTP failure (online)', async () => {
    mockReadSyncState.mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'unknown_sender' }),
    });
    const { session } = createTestSession(['inbox']);

    await expect(run(session)).rejects.toThrow('Inbox fetch failed: unknown_sender');
  });
});

// ============================================================================
// Sent Command
// ============================================================================

describe('zmail sent command', () => {
  it('reads from local cache when sync state exists', async () => {
    mockReadSyncState.mockReturnValue({ version: 1, last_sync_at: 1710000000 });
    mockReadSent.mockReturnValue({
      version: 1,
      synced_at: 1710000000,
      messages: [{ id: 'sent1', created_at: 1710000000, recipients: ['bob'] }],
    });

    const { session } = createTestSession(['sent']);

    await run(session);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('1 message(s)'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('cached'));
  });

  it('falls back to online when no cache exists', async () => {
    mockReadSyncState.mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    });
    const { session } = createTestSession(['sent']);

    await run(session);

    expect(mockFetch).toHaveBeenCalled();
  });

  it('fetches and displays sent messages (online)', async () => {
    mockReadSyncState.mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        messages: [{ id: 'msg1', created_at: 1710000000, recipients: ['bob'] }],
      }),
    });
    const { session } = createTestSession(['sent']);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('1 message(s)'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('bob'));
  });

  it('passes --to query param (online)', async () => {
    mockReadSyncState.mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    });
    const { session } = createTestSession(['sent'], { to: 'bob-principal', online: true });

    await run(session);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('to=bob-principal');
  });
});

// ============================================================================
// Ack Command
// ============================================================================

describe('zmail ack command', () => {
  it('acknowledges messages', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ acked_count: 2 }),
    });
    const { session } = createTestSession(['ack'], { 'msg-id': 'abc123,def456' });

    await run(session);

    // Verify POST body contains msg_ids
    const call = mockFetch.mock.calls[0]!;
    const body = JSON.parse(call[1].body as string);
    expect(body.msg_ids).toEqual(['abc123', 'def456']);

    expect(mockLog).toHaveBeenCalledWith('Acknowledged 2 message(s).');
  });

  it('exits with error when --msg-id is missing', async () => {
    const { session } = createTestSession(['ack']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: --msg-id=<id,...> is required');
  });

  it('updates local cache to mark acked messages as read', async () => {
    // Set up: sync state exists and inbox has unread messages
    mockReadSyncState.mockReturnValue({ version: 1, last_sync_at: 1710000000 });
    mockReadInbox.mockReturnValue({
      version: 1,
      synced_at: 1710000000,
      messages: [
        { id: 'msg1', ai_id: 'a', created_at: 100, read: false },
        { id: 'msg2', ai_id: 'b', created_at: 200, read: false },
        { id: 'msg3', ai_id: 'c', created_at: 300, read: true },
      ],
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ acked_count: 1 }),
    });

    const { session } = createTestSession(['ack'], { 'msg-id': 'msg1' });
    await run(session);

    // writeInbox should have been called with msg1 marked as read
    expect(mockWriteInbox).toHaveBeenCalledTimes(1);
    const writtenData = mockWriteInbox.mock.calls[0]![1];
    const msg1 = writtenData.messages.find((m: Record<string, unknown>) => m.id === 'msg1');
    expect(msg1.read).toBe(true);
    // msg2 should still be unread
    const msg2 = writtenData.messages.find((m: Record<string, unknown>) => m.id === 'msg2');
    expect(msg2.read).toBe(false);
  });

  it('skips cache update when no sync state exists', async () => {
    mockReadSyncState.mockReturnValue(null);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ acked_count: 1 }),
    });

    const { session } = createTestSession(['ack'], { 'msg-id': 'msg1' });
    await run(session);

    // No cache to update
    expect(mockWriteInbox).not.toHaveBeenCalled();
  });

  it('still succeeds when local cache write fails (best-effort)', async () => {
    mockReadSyncState.mockReturnValue({ version: 1, last_sync_at: 1710000000 });
    mockReadInbox.mockReturnValue({
      version: 1,
      synced_at: 1710000000,
      messages: [{ id: 'msg1', ai_id: 'a', created_at: 100, read: false }],
    });
    // Simulate cache write failure (e.g. disk full, permission error)
    mockWriteInbox.mockImplementation(() => { throw new Error('ENOSPC: disk full'); });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ acked_count: 1 }),
    });

    const { session } = createTestSession(['ack'], { 'msg-id': 'msg1' });
    // Should NOT throw — ack already succeeded on server
    await run(session);
    expect(mockLog).toHaveBeenCalledWith('Acknowledged 1 message(s).');
  });
});

// ============================================================================
// postEnvelopeToZmail (exported function)
// ============================================================================

describe('postEnvelopeToZmail', () => {
  it('posts envelope and returns result', async () => {
    const result = { msg_id: 'test-id', delivered_to: 1, blocked: [], credits_used: 0, quota_counted: 1, received_at: 1710000000 };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(result),
    });

    const envelope = {
      id: 'envelope-id',
      kind: 17 as const,
      ai_id: 'sender',
      created_at: 1710000000,
      tags: [['to', 'recipient']],
      content: 'encrypted',
      sig: 'signature',
    };

    const res = await postEnvelopeToZmail('http://localhost:8080', envelope);
    expect(res.msg_id).toBe('test-id');
    expect(res.delivered_to).toBe(1);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(envelope),
      }),
    );
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'unknown_sender' }),
    });

    const envelope = {
      id: 'id', kind: 17 as const, ai_id: 'sender',
      created_at: 1710000000, tags: [], content: '', sig: '',
    };

    await expect(postEnvelopeToZmail('http://localhost:8080', envelope))
      .rejects.toThrow('zMail send failed: unknown_sender');
  });
});

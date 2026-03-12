/**
 * Tests for zmail.ts — zMail encrypted mail client commands
 *
 * Covers: run() routing, register command (success, already-registered, failure),
 * inbox command (messages, empty, pagination, JSON mode), sent command,
 * ack command, postEnvelopeToZmail (success, error), and ownership proof headers.
 * Uses mocked Session and fetch to avoid real network calls.
 */

import { createHash } from 'crypto';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Secp256k1KeyIdentity } from '@dfinity/identity-secp256k1';
import { run, postEnvelopeToZmail } from '../zmail.js';
import type { Session } from '../session.js';

// Mock process.exit to prevent test runner from exiting
vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

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
    expect(mockError).toHaveBeenCalledWith('Registration failed: agent_not_bound');
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
// Inbox Command
// ============================================================================

describe('zmail inbox command', () => {
  it('fetches and displays inbox messages', async () => {
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

  it('handles empty inbox', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [], unread_count: 0 }),
    });
    const { session } = createTestSession(['inbox']);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('0 message(s)'));
  });

  it('outputs raw JSON when --json flag is set', async () => {
    const responseData = { messages: [{ id: 'msg1' }], cursor: null, unread_count: 0 };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responseData),
    });
    const { session } = createTestSession(['inbox'], { json: true });

    await run(session);

    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(responseData, null, 2));
  });

  it('passes query params correctly', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    });
    const { session } = createTestSession(['inbox'], {
      limit: '5',
      after: 'cursor123',
      unread: true,
      from: 'sender-abc',
    });

    await run(session);

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain('limit=5');
    expect(url).toContain('after=cursor123');
    expect(url).toContain('unread=true');
    expect(url).toContain('from=sender-abc');
  });

  it('throws error on HTTP failure', async () => {
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
  it('fetches and displays sent messages', async () => {
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

  it('passes --to query param', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    });
    const { session } = createTestSession(['sent'], { to: 'bob-principal' });

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

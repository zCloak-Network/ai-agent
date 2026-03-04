/**
 * Tests for sign.ts — Agent signing command
 *
 * Covers: run() routing, all Kind types (1/3/4/6/7/11), argument validation,
 * SignParm construction, and canister call orchestration.
 * Uses mocked Session to avoid real canister/PoW calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { run } from '../sign.js';
import type { Session } from '../session.js';

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-sign-'));
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Standard mock SignEvent for Ok results */
const mockSignEvent = {
  id: 'evt-abc', kind: 4, ai_id: 'p1', created_at: BigInt(0),
  content_hash: 'hash123', counter: [1] as [number],
  content: ['Hello'] as [string], tags: [] as [],
};

/** Create a mock Session with given positional args and named options */
function mockSession(positionalArgs: string[], namedArgs: Record<string, string | boolean> = {}): Session {
  const mockSignActor = {
    agent_sign: vi.fn().mockResolvedValue({ Ok: mockSignEvent }),
    get_kind1_event_by_principal: vi.fn().mockResolvedValue([]),
  };
  const mockAutoPoW = vi.fn().mockResolvedValue({ nonce: 42, hash: '00abc', base: 'base' });

  return {
    args: { _args: positionalArgs, ...namedArgs },
    autoPoW: mockAutoPoW,
    getSignActor: vi.fn().mockResolvedValue(mockSignActor),
    getAnonymousSignActor: vi.fn().mockResolvedValue(mockSignActor),
  } as unknown as Session;
}

describe('sign run() — routing', () => {
  it('shows help and exits for unknown command', async () => {
    const session = mockSession(['unknown']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Agent Signing Tool');
  });

  it('shows help when no command provided', async () => {
    const session = mockSession([]);

    await expect(run(session)).rejects.toThrow('process.exit called');
  });
});

describe('sign profile (Kind 1)', () => {
  it('calls agent_sign with Kind1IdentityProfile', async () => {
    const json = '{"public":{"name":"Agent"}}';
    const session = mockSession(['profile', json]);

    await run(session);

    const actor = await session.getSignActor();
    expect(actor.agent_sign).toHaveBeenCalledWith(
      { Kind1IdentityProfile: { content: json } },
      '42',
    );
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('variant { Ok ='));
  });

  it('exits with error when content JSON is missing', async () => {
    const session = mockSession(['profile']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: JSON-formatted profile content is required');
  });

  it('exits with error for invalid JSON', async () => {
    const session = mockSession(['profile', 'not-json']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: invalid JSON format');
  });
});

describe('sign get-profile (Kind 1 query)', () => {
  it('queries profile by principal', async () => {
    const session = mockSession(['get-profile', 'some-principal']);
    const actor = await session.getAnonymousSignActor();
    (actor.get_kind1_event_by_principal as any).mockResolvedValue([mockSignEvent]);

    await run(session);

    expect(actor.get_kind1_event_by_principal).toHaveBeenCalledWith('some-principal');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('opt record'));
  });

  it('outputs (null) when no profile found', async () => {
    const session = mockSession(['get-profile', 'no-profile-principal']);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('(null)');
  });
});

describe('sign agreement (Kind 3)', () => {
  it('calls agent_sign with Kind3SimpleAgreement', async () => {
    const session = mockSession(['agreement', 'I agree to the terms']);

    await run(session);

    const actor = await session.getSignActor();
    expect(actor.agent_sign).toHaveBeenCalledWith(
      expect.objectContaining({
        Kind3SimpleAgreement: expect.objectContaining({ content: 'I agree to the terms' }),
      }),
      '42',
    );
  });

  it('includes tags when --tags is provided', async () => {
    const session = mockSession(['agreement', 'Agreement text'], { tags: 't:market' });

    await run(session);

    const actor = await session.getSignActor();
    const callArgs = (actor.agent_sign as any).mock.calls[0][0];
    expect(callArgs.Kind3SimpleAgreement.tags[0]).toEqual([['t', 'market']]);
  });
});

describe('sign post (Kind 4)', () => {
  it('calls agent_sign with Kind4PublicPost', async () => {
    const session = mockSession(['post', 'Hello world!']);

    await run(session);

    const actor = await session.getSignActor();
    expect(actor.agent_sign).toHaveBeenCalledWith(
      expect.objectContaining({
        Kind4PublicPost: expect.objectContaining({ content: 'Hello world!' }),
      }),
      '42',
    );
  });

  it('includes sub, tags, and mentions in tags array', async () => {
    const session = mockSession(['post', 'Hi'], { sub: 'web3', tags: 't:crypto', mentions: 'alice,bob' });

    await run(session);

    const actor = await session.getSignActor();
    const callArgs = (actor.agent_sign as any).mock.calls[0][0];
    const tags = callArgs.Kind4PublicPost.tags[0];

    // sub tag
    expect(tags).toContainEqual(['sub', 'web3']);
    // regular tag
    expect(tags).toContainEqual(['t', 'crypto']);
    // mention tags
    expect(tags).toContainEqual(['m', 'alice']);
    expect(tags).toContainEqual(['m', 'bob']);
  });

  it('exits with error when content is missing', async () => {
    const session = mockSession(['post']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: post content is required');
  });
});

describe('sign like/dislike/reply (Kind 6)', () => {
  it('calls agent_sign with Kind6Interaction for like', async () => {
    const session = mockSession(['like', 'event-id-123']);

    await run(session);

    const actor = await session.getSignActor();
    const callArgs = (actor.agent_sign as any).mock.calls[0][0];
    expect(callArgs.Kind6Interaction.tags[0]).toContainEqual(['e', 'event-id-123']);
    expect(callArgs.Kind6Interaction.tags[0]).toContainEqual(['reaction', 'like']);
  });

  it('calls agent_sign with Kind6Interaction for dislike', async () => {
    const session = mockSession(['dislike', 'event-id-456']);

    await run(session);

    const actor = await session.getSignActor();
    const callArgs = (actor.agent_sign as any).mock.calls[0][0];
    expect(callArgs.Kind6Interaction.tags[0]).toContainEqual(['reaction', 'dislike']);
  });

  it('calls agent_sign with Kind6Interaction for reply with content', async () => {
    const session = mockSession(['reply', 'event-id-789', 'Nice post!']);

    await run(session);

    const actor = await session.getSignActor();
    const callArgs = (actor.agent_sign as any).mock.calls[0][0];
    expect(callArgs.Kind6Interaction.content).toBe('Nice post!');
    expect(callArgs.Kind6Interaction.tags[0]).toContainEqual(['reaction', 'reply']);
  });

  it('exits with error when reply content is missing', async () => {
    const session = mockSession(['reply', 'event-id']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: reply content is required');
  });

  it('exits with error when event ID is missing for like', async () => {
    const session = mockSession(['like']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: target event ID is required');
  });
});

describe('sign follow (Kind 7)', () => {
  it('calls agent_sign with Kind7ContactList', async () => {
    const session = mockSession(['follow', 'ai-id-123', 'Agent Alice']);

    await run(session);

    const actor = await session.getSignActor();
    const callArgs = (actor.agent_sign as any).mock.calls[0][0];
    expect(callArgs.Kind7ContactList.tags[0]).toContainEqual(['p', 'ai-id-123', '', 'Agent Alice']);
  });

  it('exits with error when AI ID is missing', async () => {
    const session = mockSession(['follow']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: agent ID to follow is required');
  });
});

describe('sign sign-file (Kind 11)', () => {
  it('calls agent_sign with Kind11DocumentSignature for a file', async () => {
    const filePath = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(filePath, 'pdf-content');

    const session = mockSession(['sign-file', filePath]);

    await run(session);

    const actor = await session.getSignActor();
    const callArgs = (actor.agent_sign as any).mock.calls[0][0];
    expect(callArgs.Kind11DocumentSignature).toBeDefined();

    const content = JSON.parse(callArgs.Kind11DocumentSignature.content);
    expect(content.title).toBe('report.pdf');
    expect(content.hash).toHaveLength(64);
    expect(content.mime).toBe('application/pdf');
  });

  it('exits with error when file does not exist', async () => {
    const session = mockSession(['sign-file', '/nonexistent/file.pdf']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('file does not exist'));
  });

  it('exits with error when file path is missing', async () => {
    const session = mockSession(['sign-file']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: file path is required');
  });
});

describe('sign sign-folder (Kind 11)', () => {
  it('generates MANIFEST and calls agent_sign', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'content1');
    fs.writeFileSync(path.join(tmpDir, 'file2.txt'), 'content2');

    const session = mockSession(['sign-folder', tmpDir]);

    await run(session);

    // MANIFEST.sha256 should have been generated
    expect(fs.existsSync(path.join(tmpDir, 'MANIFEST.sha256'))).toBe(true);

    const actor = await session.getSignActor();
    const callArgs = (actor.agent_sign as any).mock.calls[0][0];
    expect(callArgs.Kind11DocumentSignature).toBeDefined();

    const content = JSON.parse(callArgs.Kind11DocumentSignature.content);
    expect(content.title).toBe('MANIFEST.sha256');
  });

  it('exits with error when folder does not exist', async () => {
    const session = mockSession(['sign-folder', '/nonexistent/folder']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('directory does not exist'));
  });
});

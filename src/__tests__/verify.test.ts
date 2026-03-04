/**
 * Tests for verify.ts — Verification command
 *
 * Covers: run() routing, message/file/folder/profile commands,
 * signer resolution, argument validation.
 * Uses mocked Session to avoid real canister calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { run } from '../verify.js';
import type { Session } from '../session.js';

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-verify-'));
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Standard mock SignEvent */
const mockEvent = {
  id: 'evt1', kind: 4, ai_id: 'signer-principal',
  created_at: BigInt(0), content_hash: 'h1',
  counter: [1] as [number], content: ['Hello'] as [string], tags: [] as [],
};

/** Create a mock Session for verify commands */
function mockSession(args: string[]): Session {
  const signActor = {
    verify_message: vi.fn().mockResolvedValue([]),
    verify_file_hash: vi.fn().mockResolvedValue([]),
    get_kind1_event_by_principal: vi.fn().mockResolvedValue([]),
  };
  const registryActor = {
    get_username_by_principal: vi.fn().mockResolvedValue([]),
  };

  return {
    args: { _args: args },
    getAnonymousSignActor: vi.fn().mockResolvedValue(signActor),
    getAnonymousRegistryActor: vi.fn().mockResolvedValue(registryActor),
    getProfileUrl: vi.fn().mockReturnValue('https://id.zcloak.xyz/profile/'),
  } as unknown as Session;
}

describe('verify run() — routing', () => {
  it('shows help and exits for unknown command', async () => {
    const session = mockSession(['unknown']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Verification Tool');
  });
});

describe('verify message command', () => {
  it('calls verify_message on canister', async () => {
    const session = mockSession(['message', 'Hello world!']);
    const actor = await session.getAnonymousSignActor();
    (actor.verify_message as any).mockResolvedValue([mockEvent]);

    await run(session);

    expect(actor.verify_message).toHaveBeenCalledWith('Hello world!');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('id = "evt1"'));
  });

  it('exits with error when content is missing', async () => {
    const session = mockSession(['message']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: message content is required');
  });

  it('resolves signer agent name when events have ai_id', async () => {
    const session = mockSession(['message', 'content']);
    const signActor = await session.getAnonymousSignActor();
    (signActor.verify_message as any).mockResolvedValue([mockEvent]);

    const registryActor = await session.getAnonymousRegistryActor();
    (registryActor.get_username_by_principal as any).mockResolvedValue(['runner#8939.agent']);

    await run(session);

    expect(registryActor.get_username_by_principal).toHaveBeenCalledWith('signer-principal');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Agent Name: runner#8939.agent'));
  });
});

describe('verify file command', () => {
  it('computes file hash and calls verify_file_hash', async () => {
    const content = 'file content';
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, content);

    const session = mockSession(['file', filePath]);
    const actor = await session.getAnonymousSignActor();

    await run(session);

    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    expect(actor.verify_file_hash).toHaveBeenCalledWith(expectedHash);
  });

  it('exits with error when file does not exist', async () => {
    const session = mockSession(['file', '/nonexistent/file.txt']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('file does not exist'));
  });

  it('exits with error when file path is missing', async () => {
    const session = mockSession(['file']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: file path is required');
  });
});

describe('verify folder command', () => {
  it('exits with error when MANIFEST.sha256 is missing', async () => {
    const session = mockSession(['folder', tmpDir]);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('MANIFEST.sha256 not found'));
  });

  it('exits with error when folder does not exist', async () => {
    const session = mockSession(['folder', '/nonexistent/folder']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('directory does not exist'));
  });

  it('verifies MANIFEST integrity and queries on-chain', async () => {
    // Create files
    const fileContent = 'hello manifest';
    const filePath = path.join(tmpDir, 'data.txt');
    fs.writeFileSync(filePath, fileContent);

    // Create valid MANIFEST.sha256
    const fileHash = crypto.createHash('sha256').update(fileContent).digest('hex');
    const manifestContent = `# skill: test\n${fileHash}  ./data.txt\n`;
    fs.writeFileSync(path.join(tmpDir, 'MANIFEST.sha256'), manifestContent);

    const session = mockSession(['folder', tmpDir]);

    await run(session);

    // Should show local verification passed
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('OK: data.txt'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Local verification passed'));

    // Should query on-chain with MANIFEST hash
    const actor = await session.getAnonymousSignActor();
    expect(actor.verify_file_hash).toHaveBeenCalled();
  });

  it('exits when local verification fails (modified file)', async () => {
    // Create file but use wrong hash in MANIFEST
    fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'content');
    const wrongHash = 'a'.repeat(64);
    const manifestContent = `${wrongHash}  ./data.txt\n`;
    fs.writeFileSync(path.join(tmpDir, 'MANIFEST.sha256'), manifestContent);

    const session = mockSession(['folder', tmpDir]);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('FAILED: data.txt'));
  });
});

describe('verify profile command', () => {
  it('queries Kind 1 profile by principal', async () => {
    const session = mockSession(['profile', 'some-principal']);
    const actor = await session.getAnonymousSignActor();
    (actor.get_kind1_event_by_principal as any).mockResolvedValue([mockEvent]);

    await run(session);

    expect(actor.get_kind1_event_by_principal).toHaveBeenCalledWith('some-principal');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('opt record'));
  });

  it('outputs (null) when no profile found', async () => {
    const session = mockSession(['profile', 'unknown-principal']);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('(null)');
  });

  it('exits with error when principal is missing', async () => {
    const session = mockSession(['profile']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: principal ID is required');
  });
});

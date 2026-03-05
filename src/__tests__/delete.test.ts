/**
 * Tests for delete.ts — File deletion with 2FA verification command
 *
 * Covers: run() routing, prepare/check/confirm commands, argument validation,
 * file existence checks, 2FA flow, and actual file deletion.
 * Uses mocked Session for canister calls and real filesystem for file ops.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { run } from '../delete.js';
import config from '../config.js';
import type { Session } from '../session.js';

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-delete-'));
});

afterEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** Create a mock registry actor for 2FA operations */
function mockRegistryActor(overrides: Record<string, unknown> = {}) {
  return {
    prepare_2fa_info: vi.fn().mockResolvedValue({
      Ok: JSON.stringify({ publicKey: { challenge: 'test-challenge-abc' } }),
    }),
    query_2fa_result_by_challenge: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** Create a mock Session for delete commands */
function mockSession(args: string[], actor?: any): Session {
  const registryActor = actor || mockRegistryActor();

  return {
    args: { _args: args },
    getRegistryActor: vi.fn().mockResolvedValue(registryActor),
    getAnonymousRegistryActor: vi.fn().mockResolvedValue(registryActor),
    getTwoFAUrl: vi.fn().mockReturnValue(config.twofa_url),
  } as unknown as Session;
}

describe('delete run() — routing', () => {
  it('shows help and exits for unknown command', async () => {
    const session = mockSession(['unknown']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai File Deletion with 2FA Verification Tool');
  });

  it('shows help when no command provided', async () => {
    const session = mockSession([]);

    await expect(run(session)).rejects.toThrow('process.exit called');
  });
});

describe('delete prepare command', () => {
  it('calls prepare_2fa_info and outputs challenge + URL', async () => {
    const filePath = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(filePath, 'pdf-content');

    const session = mockSession(['prepare', filePath]);

    await run(session);

    const actor = await session.getRegistryActor();
    expect(actor.prepare_2fa_info).toHaveBeenCalled();

    // Should output challenge
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('=== 2FA Challenge ==='));
    expect(mockLog).toHaveBeenCalledWith('test-challenge-abc');

    // Should output URL
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('=== 2FA Authentication URL ==='));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining(`${config.twofa_url}?auth_content=`));
  });

  it('exits with error when file path is missing', async () => {
    const session = mockSession(['prepare']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: file path is required');
  });

  it('exits with error when file does not exist', async () => {
    const session = mockSession(['prepare', '/nonexistent/file.txt']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('file not found'));
  });

  it('handles canister Err result', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'content');

    const actor = mockRegistryActor({
      prepare_2fa_info: vi.fn().mockResolvedValue({ Err: 'Not authorized' }),
    });
    const session = mockSession(['prepare', filePath], actor);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('2FA preparation failed:');
  });
});

describe('delete check command', () => {
  it('outputs "confirmed" status when 2FA is confirmed', async () => {
    const record = {
      caller: 'agent-principal',
      owner_list: ['owner1'],
      confirm_timestamp: [BigInt(1700000000)],
      confirm_owner: ['owner1'],
    };
    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([record]),
    });
    const session = mockSession(['check', 'test-challenge'], actor);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('Status: confirmed');
  });

  it('outputs "pending" status when 2FA is not yet confirmed', async () => {
    const record = {
      caller: 'agent-principal',
      owner_list: ['owner1'],
      confirm_timestamp: [],
      confirm_owner: [],
    };
    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([record]),
    });
    const session = mockSession(['check', 'test-challenge'], actor);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('Status: pending');
  });

  it('outputs "not found" when no record exists', async () => {
    const session = mockSession(['check', 'nonexistent-challenge']);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('Status: not found');
  });

  it('exits with error when challenge is missing', async () => {
    const session = mockSession(['check']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: challenge string is required');
  });
});

describe('delete confirm command', () => {
  it('deletes file after 2FA confirmation', async () => {
    const filePath = path.join(tmpDir, 'to-delete.txt');
    fs.writeFileSync(filePath, 'will be deleted');

    const record = {
      caller: 'agent-principal',
      owner_list: ['owner1'],
      confirm_timestamp: [BigInt(1700000000)],
      confirm_owner: ['owner1'],
    };
    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([record]),
    });
    const session = mockSession(['confirm', 'test-challenge', filePath], actor);

    await run(session);

    // File should be deleted
    expect(fs.existsSync(filePath)).toBe(false);
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('deleted successfully'));
  });

  it('exits with error when 2FA is not confirmed yet', async () => {
    const filePath = path.join(tmpDir, 'keep.txt');
    fs.writeFileSync(filePath, 'should not be deleted');

    const record = {
      caller: 'agent-principal',
      owner_list: ['owner1'],
      confirm_timestamp: [],
      confirm_owner: [],
    };
    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([record]),
    });
    const session = mockSession(['confirm', 'test-challenge', filePath], actor);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: 2FA has not been confirmed yet.');

    // File should NOT be deleted
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('exits with error when no 2FA record found', async () => {
    const filePath = path.join(tmpDir, 'keep.txt');
    fs.writeFileSync(filePath, 'content');

    const session = mockSession(['confirm', 'bad-challenge', filePath]);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: no 2FA record found for this challenge.');
  });

  it('exits with error when challenge or file path is missing', async () => {
    const session = mockSession(['confirm']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: both challenge and file path are required');
  });

  it('exits with error when file does not exist', async () => {
    const record = {
      caller: 'agent-principal',
      owner_list: ['owner1'],
      confirm_timestamp: [BigInt(1700000000)],
      confirm_owner: ['owner1'],
    };
    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([record]),
    });
    const session = mockSession(['confirm', 'challenge', '/nonexistent/file.txt'], actor);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('file not found'));
  });
});

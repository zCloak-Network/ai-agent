/**
 * Tests for twofa-gate.ts — 2FA Gate keyword detection and state machine
 *
 * Covers: keyword matching (English + Chinese), negative keyword cases,
 * state machine transitions (IDLE → PENDING → confirmed), PENDING TTL expiry,
 * session isolation, error handling, fail-closed on canister/write failure,
 * and corrupt state file recovery.
 *
 * Uses mocked Session for canister calls and a temp directory for state files.
 * Follows the same mock patterns established in delete.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { matchKeywords, readState, writeState, clearState, run } from '../twofa-gate.js';
import type { GateDecision } from '../twofa-gate.js';
import { twofaStatePath } from '../paths.js';
import type { Session } from '../session.js';

// ── Hermetic test isolation ──────────────────────────────────────────
// Mock twofaStatePath to use a temporary directory so tests never touch
// the real ~/.config/zcloak/ and work in restricted environments.
let tmpDir: string;

vi.mock('../paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../paths.js')>();
  return {
    ...original,
    twofaStatePath: (sessionId?: string) => {
      if (!sessionId) {
        return path.join(tmpDir, 'twofa-state.json');
      }
      // Mirror the same sanitization as the real implementation
      const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
      return path.join(tmpDir, `twofa-state-${safe}.json`);
    },
  };
});

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

/** Helper: parse the JSON output that cmdCheck writes to stdout */
function getJsonOutput(): GateDecision | null {
  const lastCall = mockLog.mock.calls.find(call => {
    try {
      JSON.parse(call[0] as string);
      return true;
    } catch {
      return false;
    }
  });
  return lastCall ? JSON.parse(lastCall[0] as string) as GateDecision : null;
}

/** Helper: create a mock registry actor for 2FA operations */
function mockRegistryActor(overrides: Record<string, unknown> = {}) {
  return {
    prepare_2fa_info: vi.fn().mockResolvedValue({
      Ok: 'test-challenge-xyz',
    }),
    query_2fa_result_by_challenge: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/**
 * Helper: create a mock Session for twofa-gate commands.
 *
 * @param args - Positional args for _args (e.g. ['check', 'delete my file'])
 * @param actor - Optional mock registry actor
 * @param namedArgs - Optional named args (e.g. { session: 'session-b' })
 */
function mockSession(
  args: string[],
  actor?: ReturnType<typeof mockRegistryActor>,
  namedArgs?: Record<string, unknown>,
): Session {
  const registryActor = actor || mockRegistryActor();

  return {
    args: { _args: args, ...namedArgs },
    getRegistryActor: vi.fn().mockResolvedValue(registryActor),
    getAnonymousRegistryActor: vi.fn().mockResolvedValue(registryActor),
  } as unknown as Session;
}

// Create a fresh temp dir for each test and clean up after
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-twofa-test-'));
  clearState();
});

afterEach(() => {
  vi.clearAllMocks();
  clearState();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ========== Keyword Matching Tests ==========

describe('matchKeywords — positive matches', () => {
  it.each([
    ['delete',   'please delete this file',    'delete'],
    ['remove',   'can you remove the report?', 'delete'],
    ['删除',     '帮我删除这个文件',             'delete'],
    ['移除',     '请移除旧数据',                 'delete'],
    ['bind',     'bind this agent to alice.ai', 'bind'],
    ['binding',  'start the binding process',   'bind'],
    ['绑定',     '帮我绑定 Owner',               'bind'],
  ])('matches "%s" → rule "%s"', (_keyword, message, expectedId) => {
    const result = matchKeywords(message);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(expectedId);
  });
});

describe('matchKeywords — negative matches (should NOT trigger)', () => {
  it('returns null for irrelevant messages', () => {
    expect(matchKeywords('what is the weather today')).toBeNull();
    expect(matchKeywords('今天天气怎么样')).toBeNull();
    expect(matchKeywords('show me the feed')).toBeNull();
    expect(matchKeywords('查看我的身份信息')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(matchKeywords('')).toBeNull();
  });

  it('does not trigger on non-2FA operations', () => {
    // These used to be 2FA-gated but are no longer sensitive operations
    expect(matchKeywords('register a new AI name')).toBeNull();
    expect(matchKeywords('sign a post for me')).toBeNull();
    expect(matchKeywords('encrypt this document')).toBeNull();
    expect(matchKeywords('send a zmail to bob')).toBeNull();
    expect(matchKeywords('post a message on-chain')).toBeNull();
    expect(matchKeywords('like that event')).toBeNull();
    expect(matchKeywords('follow alice.ai')).toBeNull();
    expect(matchKeywords('注册一个新的 Agent 名字')).toBeNull();
    expect(matchKeywords('签名一个帖子')).toBeNull();
    expect(matchKeywords('加密这份文件')).toBeNull();
    expect(matchKeywords('给 alice 发邮件')).toBeNull();
  });
});

// ========== State File I/O Tests ==========

describe('state file operations', () => {
  it('readState returns null when file does not exist', () => {
    expect(readState()).toBeNull();
  });

  it('writeState and readState round-trip correctly', () => {
    const state = {
      challenge: 'test-abc',
      operation: 'bind',
      created_at: Date.now(),
    };
    writeState(state);
    const loaded = readState();
    expect(loaded).toEqual(state);
  });

  it('clearState removes the file', () => {
    writeState({ challenge: 'tmp', operation: 'delete', created_at: Date.now() });
    expect(readState()).not.toBeNull();
    clearState();
    expect(readState()).toBeNull();
  });

  it('readState returns null for corrupt JSON', () => {
    fs.writeFileSync(twofaStatePath(), '{invalid json!!!}');
    expect(readState()).toBeNull();
  });

  it('readState returns null for JSON without required fields', () => {
    fs.writeFileSync(twofaStatePath(), JSON.stringify({ foo: 'bar' }));
    expect(readState()).toBeNull();
  });

  it('clearState is safe to call when file does not exist', () => {
    expect(() => clearState()).not.toThrow();
  });
});

// ========== State Machine Tests ==========

describe('IDLE → PENDING (keyword match, create challenge)', () => {
  it('blocks and returns challenge when keyword detected', async () => {
    const session = mockSession(['check', '帮我删除文件']);

    await run(session);

    const output = getJsonOutput();
    expect(output).not.toBeNull();
    expect(output!.action).toBe('block');
    expect(output!.challenge).toBe('test-challenge-xyz');
    expect(output!.url).toContain('test-challenge-xyz');
    expect(output!.operation).toBe('delete');

    // State file should be written
    const state = readState();
    expect(state).not.toBeNull();
    expect(state!.challenge).toBe('test-challenge-xyz');
  });
});

describe('PENDING → confirmed', () => {
  it('passes through when confirmed and current message has no keywords', async () => {
    writeState({ challenge: 'pending-challenge', operation: 'delete', created_at: Date.now() });

    const confirmedRecord = {
      caller: 'agent-principal',
      owner_list: ['owner1'],
      confirm_timestamp: [BigInt(1700000000)],
      confirm_owner: ['owner1'],
      content: '',
      request_timestamp: BigInt(1700000000),
    };
    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([confirmedRecord]),
    });
    // "done" has no sensitive keywords → pass
    const session = mockSession(['check', 'done'], actor);

    await run(session);

    const output = getJsonOutput();
    expect(output!.action).toBe('pass');
    expect(readState()).toBeNull();
  });

  it('blocks again when confirmed but current message contains a new sensitive keyword', async () => {
    writeState({ challenge: 'old-challenge', operation: 'delete', created_at: Date.now() });

    const confirmedRecord = {
      caller: 'agent-principal',
      owner_list: ['owner1'],
      confirm_timestamp: [BigInt(1700000000)],
      confirm_owner: ['owner1'],
      content: '',
      request_timestamp: BigInt(1700000000),
    };
    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([confirmedRecord]),
    });
    // "bind my agent" contains keyword "bind" → should trigger new 2FA
    const session = mockSession(['check', 'bind my agent'], actor);

    await run(session);

    const output = getJsonOutput();
    // Must NOT be "pass" — must create a new challenge for the new operation
    expect(output!.action).toBe('block');
    expect(output!.operation).toBe('bind');
    expect(output!.challenge).toBe('test-challenge-xyz');
    expect(actor.prepare_2fa_info).toHaveBeenCalled();
  });
});

describe('PENDING → expired on canister (recover to IDLE)', () => {
  it('clears state and re-evaluates keywords when canister has no record', async () => {
    writeState({ challenge: 'expired-challenge', operation: 'bind', created_at: Date.now() });

    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([]),
    });
    const session = mockSession(['check', '帮我删除文件'], actor);

    await run(session);

    const output = getJsonOutput();
    // Should fall through to IDLE and match "delete"
    expect(output!.action).toBe('block');
    expect(output!.operation).toBe('delete');
  });

  it('passes through when canister has no record and no keywords match', async () => {
    writeState({ challenge: 'expired-challenge', operation: 'bind', created_at: Date.now() });

    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([]),
    });
    const session = mockSession(['check', 'what time is it'], actor);

    await run(session);

    const output = getJsonOutput();
    expect(output!.action).toBe('pass');
    expect(readState()).toBeNull();
  });
});

describe('PENDING → TTL expired (auto-recover to IDLE)', () => {
  it('clears state and re-scans keywords when PENDING exceeds TTL', async () => {
    // Write state with created_at 15 minutes ago (exceeds 10-min TTL)
    const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
    writeState({ challenge: 'stale-challenge', operation: 'bind', created_at: fifteenMinAgo });

    const actor = mockRegistryActor();
    const session = mockSession(['check', 'delete my file'], actor);

    await run(session);

    const output = getJsonOutput();
    // TTL expired → cleared → fell through to IDLE → keyword "delete" detected → block
    expect(output!.action).toBe('block');
    expect(output!.operation).toBe('delete');
    // Should NOT have queried the canister for the old challenge
    expect(actor.query_2fa_result_by_challenge).not.toHaveBeenCalled();
  });

  it('passes through when TTL expired and no keywords match', async () => {
    const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
    writeState({ challenge: 'stale-challenge', operation: 'bind', created_at: fifteenMinAgo });

    const actor = mockRegistryActor();
    const session = mockSession(['check', 'what is the weather'], actor);

    await run(session);

    const output = getJsonOutput();
    expect(output!.action).toBe('pass');
    expect(readState()).toBeNull();
  });

  it('does NOT expire state within TTL window', async () => {
    // Write state with created_at 5 minutes ago (within 10-min TTL)
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    writeState({ challenge: 'fresh-challenge', operation: 'bind', created_at: fiveMinAgo });

    const pendingRecord = {
      caller: 'agent-principal',
      owner_list: ['owner1'],
      confirm_timestamp: [],
      confirm_owner: [],
      content: '',
      request_timestamp: BigInt(1700000000),
    };
    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([pendingRecord]),
    });
    const session = mockSession(['check', 'hello'], actor);

    await run(session);

    const output = getJsonOutput();
    // Still within TTL → should query canister → pending
    expect(output!.action).toBe('pending');
    expect(actor.query_2fa_result_by_challenge).toHaveBeenCalled();
  });
});

describe('PENDING → still pending (remind)', () => {
  it('returns pending action when challenge is not yet confirmed', async () => {
    writeState({ challenge: 'waiting-challenge', operation: 'delete', created_at: Date.now() });

    const pendingRecord = {
      caller: 'agent-principal',
      owner_list: ['owner1'],
      confirm_timestamp: [],
      confirm_owner: [],
      content: '',
      request_timestamp: BigInt(1700000000),
    };
    const actor = mockRegistryActor({
      query_2fa_result_by_challenge: vi.fn().mockResolvedValue([pendingRecord]),
    });
    const session = mockSession(['check', 'is it done?'], actor);

    await run(session);

    const output = getJsonOutput();
    expect(output!.action).toBe('pending');
    expect(output!.challenge).toBe('waiting-challenge');
    expect(output!.url).toContain('waiting-challenge');
  });
});

describe('no keyword match (pass)', () => {
  it('passes through when no sensitive keywords found', async () => {
    const actor = mockRegistryActor();
    const session = mockSession(['check', 'what is the weather today'], actor);

    await run(session);

    const output = getJsonOutput();
    expect(output!.action).toBe('pass');
    expect(actor.prepare_2fa_info).not.toHaveBeenCalled();
  });
});

describe('canister error (fail-closed)', () => {
  it('blocks when prepare_2fa_info returns Err', async () => {
    const actor = mockRegistryActor({
      prepare_2fa_info: vi.fn().mockResolvedValue({ Err: 'No owner bound' }),
    });
    const session = mockSession(['check', 'delete the file'], actor);

    await run(session);

    const output = getJsonOutput();
    // Fail-closed: sensitive keyword detected but canister rejected → block (no URL)
    expect(output!.action).toBe('block');
    expect(output!.operation).toBe('delete');
    expect(output!.url).toBeUndefined();
  });

  it('blocks when canister call throws', async () => {
    const actor = mockRegistryActor({
      prepare_2fa_info: vi.fn().mockRejectedValue(new Error('Network timeout')),
    });
    const session = mockSession(['check', 'bind my agent'], actor);

    await run(session);

    const output = getJsonOutput();
    // Fail-closed: sensitive keyword detected but network error → block (no URL)
    expect(output!.action).toBe('block');
    expect(output!.operation).toBe('bind');
    expect(output!.url).toBeUndefined();
  });

  it('blocks when getRegistryActor throws', async () => {
    const session = mockSession(['check', 'delete a document']);
    // Override getRegistryActor to throw
    (session.getRegistryActor as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('PEM file not found'),
    );

    await run(session);

    const output = getJsonOutput();
    expect(output!.action).toBe('block');
    expect(output!.operation).toBe('delete');
    expect(output!.url).toBeUndefined();
  });
});

describe('corrupt state file recovery', () => {
  it('treats corrupt state as IDLE and proceeds normally', async () => {
    fs.writeFileSync(twofaStatePath(), 'not valid json at all!!!');

    const actor = mockRegistryActor();
    const session = mockSession(['check', 'bind my agent'], actor);

    await run(session);

    const output = getJsonOutput();
    expect(output!.action).toBe('block');
    expect(output!.operation).toBe('bind');
  });
});

// ========== Session Isolation Tests ==========

describe('session isolation', () => {
  it('different sessions have independent state', () => {
    writeState({ challenge: 'a-challenge', operation: 'bind', created_at: Date.now() }, 'session-a');
    writeState({ challenge: 'b-challenge', operation: 'delete', created_at: Date.now() }, 'session-b');

    expect(readState('session-a')!.challenge).toBe('a-challenge');
    expect(readState('session-b')!.challenge).toBe('b-challenge');
  });

  it('clearing one session does not affect another', () => {
    writeState({ challenge: 'keep', operation: 'bind', created_at: Date.now() }, 'session-keep');
    writeState({ challenge: 'clear', operation: 'delete', created_at: Date.now() }, 'session-clear');

    clearState('session-clear');

    expect(readState('session-keep')).not.toBeNull();
    expect(readState('session-clear')).toBeNull();
  });

  it('session-scoped check does not see other session state', async () => {
    writeState({ challenge: 'a-pending', operation: 'bind', created_at: Date.now() }, 'session-a');

    const actor = mockRegistryActor();
    // Pass session as a named arg so run() reads it from session.args.session
    const session = mockSession(['check', 'what is the weather'], actor, { session: 'session-b' });

    await run(session);

    const output = getJsonOutput();
    expect(output!.action).toBe('pass');
    // session-a's state should remain untouched
    expect(readState('session-a')).not.toBeNull();
  });

  it('sanitizes sessionId to prevent path traversal', () => {
    // A malicious sessionId with "../" should be sanitized to underscores
    writeState({ challenge: 'safe', operation: 'bind', created_at: Date.now() }, '../../etc/pwn');

    // The file should end up inside tmpDir, not escape to a parent directory
    const state = readState('../../etc/pwn');
    expect(state).not.toBeNull();
    expect(state!.challenge).toBe('safe');

    // Verify the file is actually inside tmpDir (sanitized name)
    const expectedPath = twofaStatePath('../../etc/pwn');
    expect(expectedPath.startsWith(tmpDir)).toBe(true);
    expect(expectedPath).toContain('twofa-state-______etc_pwn.json');
  });
});

// ========== writeState failure (fail-closed) Tests ==========

describe('writeState failure outputs block, not pass', () => {
  it('still outputs block when state write fails after challenge creation', async () => {
    // Make a directory where the state file should be, causing EISDIR on write
    const stateFilePath = twofaStatePath();
    fs.mkdirSync(stateFilePath, { recursive: true });

    const actor = mockRegistryActor();
    const session = mockSession(['check', 'delete my file'], actor);

    await run(session);

    const output = getJsonOutput();
    // CRITICAL: must be "block", NOT "pass"
    expect(output!.action).toBe('block');
    expect(output!.challenge).toBe('test-challenge-xyz');
    expect(output!.operation).toBe('delete');

    fs.rmdirSync(stateFilePath);
  });
});

// ========== CLI Routing Tests ==========

describe('run() — routing', () => {
  it('shows help and exits for unknown command', async () => {
    const session = mockSession(['unknown']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('2FA Gate'));
  });

  it('shows help when no command provided', async () => {
    const session = mockSession([]);

    await expect(run(session)).rejects.toThrow('process.exit called');
  });

  it('exits with error when check is called without message', async () => {
    const session = mockSession(['check']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: message text is required');
  });

  it('status command outputs "idle" when no state file', async () => {
    const session = mockSession(['status']);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('idle');
  });

  it('status command outputs state JSON when state file exists', async () => {
    writeState({ challenge: 'status-test', operation: 'delete', created_at: 1700000000000 });

    const session = mockSession(['status']);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('"status-test"'));
  });
});

/**
 * Tests for register.ts — Agent registration management command
 *
 * Covers: run() routing, get-principal, lookup, lookup-by-name, lookup-by-principal,
 * register, get-owner commands. Uses mocked Session to avoid real canister calls.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { run } from '../register.js';
import type { Session } from '../session.js';

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  vi.clearAllMocks();
});

/** Create a mock Session with args and optional method overrides */
function mockSession(args: string[], overrides: Record<string, unknown> = {}): Session {
  return {
    args: { _args: args },
    getPrincipal: vi.fn().mockReturnValue('abc-def-principal'),
    getAnonymousRegistryActor: vi.fn(),
    getRegistryActor: vi.fn(),
    ...overrides,
  } as unknown as Session;
}

/** Create a mock registry actor */
function mockRegistryActor(overrides: Record<string, unknown> = {}) {
  return {
    get_username_by_principal: vi.fn().mockResolvedValue([]),
    get_user_principal: vi.fn().mockResolvedValue([]),
    register_agent: vi.fn().mockResolvedValue({ Ok: { username: 'test#1234.agent' } }),
    user_profile_get: vi.fn().mockResolvedValue([]),
    user_profile_get_by_principal: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('register run() — routing', () => {
  it('shows help and exits for unknown command', async () => {
    const session = mockSession(['unknown']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Agent Registration Management');
  });

  it('shows help when no command provided', async () => {
    const session = mockSession([]);

    await expect(run(session)).rejects.toThrow('process.exit called');
  });
});

describe('register get-principal command', () => {
  it('outputs the principal from session', async () => {
    const session = mockSession(['get-principal']);

    await run(session);

    expect(session.getPrincipal).toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('abc-def-principal');
  });
});

describe('register lookup command', () => {
  it('queries agent name for current principal', async () => {
    const actor = mockRegistryActor({
      user_profile_get_by_principal: vi.fn().mockResolvedValue([{
        ai_profile: [{ ai_name: [{ id: 'runner', index: [8939n], domain: [{ AGENT: null }] }], default_name: [] }],
      }]),
    });
    const session = mockSession(['lookup'], {
      getAnonymousRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await run(session);

    expect(actor.user_profile_get_by_principal).toHaveBeenCalledWith('abc-def-principal');
    expect(mockLog).toHaveBeenCalledWith('(opt "runner#8939.agent")');
    // Should also show the profile URL when agent name is found
    expect(mockLog).toHaveBeenCalledWith('View profile: https://id.zcloak.ai/profile/runner%238939.agent');
  });

  it('outputs (null) when no agent name found', async () => {
    const actor = mockRegistryActor();
    const session = mockSession(['lookup'], {
      getAnonymousRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('(null)');
  });
});

describe('register lookup-by-name command', () => {
  it('looks up principal by agent name', async () => {
    const fakePrincipal = { toText: () => 'found-principal-id' };
    const actor = mockRegistryActor({
      get_user_principal: vi.fn().mockResolvedValue([fakePrincipal]),
    });
    const session = mockSession(['lookup-by-name', 'runner#8939.agent'], {
      getAnonymousRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await run(session);

    expect(actor.get_user_principal).toHaveBeenCalledWith('runner#8939.agent');
    expect(mockLog).toHaveBeenCalledWith('(opt principal "found-principal-id")');
  });

  it('exits with error when agent name is missing', async () => {
    const session = mockSession(['lookup-by-name']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: name is required');
  });
});

describe('register lookup-by-principal command', () => {
  it('exits with error when principal is missing', async () => {
    const session = mockSession(['lookup-by-principal']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: principal ID is required');
  });
});

describe('register register command', () => {
  it('registers agent name and outputs Ok result', async () => {
    const actor = mockRegistryActor({
      register_agent: vi.fn().mockResolvedValue({ Ok: { username: 'my-agent#5678.agent' } }),
    });
    const session = mockSession(['register', 'my-agent'], {
      getRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await run(session);

    expect(actor.register_agent).toHaveBeenCalledWith('my-agent');
    expect(mockLog).toHaveBeenCalledWith('(variant { Ok = record { username = "my-agent#5678.agent" } })');
  });

  it('outputs Err result on registration failure', async () => {
    const actor = mockRegistryActor({
      register_agent: vi.fn().mockResolvedValue({ Err: 'Name already taken' }),
    });
    const session = mockSession(['register', 'taken-name'], {
      getRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('(variant { Err = "Name already taken" })');
  });

  it('exits with error when base name is missing', async () => {
    const session = mockSession(['register']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: base name is required');
  });
});

describe('register get-owner command', () => {
  it('exits with error when principal/name is missing', async () => {
    const session = mockSession(['get-owner']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: principal or agent name is required');
  });

  it('queries by agent name when input contains # and .agent', async () => {
    const actor = mockRegistryActor({
      user_profile_get: vi.fn().mockResolvedValue([{
        username: 'runner#8939.agent',
        principal_id: ['some-principal'],
        ai_profile: [],
        passkey_name: [],
      }]),
    });
    const session = mockSession(['get-owner', 'runner#8939.agent'], {
      getAnonymousRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await run(session);

    expect(actor.user_profile_get).toHaveBeenCalledWith('runner#8939.agent');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('username = "runner#8939.agent"'));
  });

  it('queries by principal when input is a plain principal', async () => {
    const actor = mockRegistryActor({
      user_profile_get_by_principal: vi.fn().mockResolvedValue([]),
    });
    const session = mockSession(['get-owner', 'abc-def-ghi'], {
      getAnonymousRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await run(session);

    expect(actor.user_profile_get_by_principal).toHaveBeenCalledWith('abc-def-ghi');
    expect(mockLog).toHaveBeenCalledWith('(null)');
  });
});

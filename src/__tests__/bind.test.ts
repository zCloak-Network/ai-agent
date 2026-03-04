/**
 * Tests for bind.ts — Agent-owner binding command
 *
 * Covers: run() routing, check-passkey command, prepare command (with passkey pre-check),
 * argument validation, URL generation.
 * Uses mocked Session to avoid real canister calls.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { run } from '../bind.js';
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

/** Create a mock registry actor with passkey profile */
function mockRegistryActor(hasPasskey: boolean, profileFound: boolean = true) {
  return {
    user_profile_get_by_principal: vi.fn().mockResolvedValue(
      profileFound
        ? [{
            username: 'test#1234.agent',
            principal_id: ['user-principal'],
            ai_profile: [],
            passkey_name: hasPasskey ? ['my-passkey'] : [],
          }]
        : [],
    ),
    agent_prepare_bond: vi.fn().mockResolvedValue({ Ok: '{"publicKey":{"challenge":"abc123"}}' }),
  };
}

/** Create a mock Session for bind commands */
function mockSession(args: string[], registryActor: any): Session {
  return {
    args: { _args: args },
    getAnonymousRegistryActor: vi.fn().mockResolvedValue(registryActor),
    getRegistryActor: vi.fn().mockResolvedValue(registryActor),
    getBindUrl: vi.fn().mockReturnValue('https://id.zcloak.xyz/agent/bind'),
  } as unknown as Session;
}

describe('bind run() — routing', () => {
  it('shows help and exits for unknown command', async () => {
    const actor = mockRegistryActor(true);
    const session = mockSession(['unknown'], actor);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Agent-Owner Binding Tool');
  });

  it('shows help when no command provided', async () => {
    const actor = mockRegistryActor(true);
    const session = mockSession([], actor);

    await expect(run(session)).rejects.toThrow('process.exit called');
  });
});

describe('bind check-passkey command', () => {
  it('outputs "yes" when principal has a passkey', async () => {
    const actor = mockRegistryActor(true);
    const session = mockSession(['check-passkey', 'user-principal'], actor);

    await run(session);

    expect(actor.user_profile_get_by_principal).toHaveBeenCalledWith('user-principal');
    expect(mockLog).toHaveBeenCalledWith('Passkey registered: yes');
    expect(mockLog).toHaveBeenCalledWith('This principal is ready for agent binding.');
  });

  it('outputs "no" when principal has no passkey', async () => {
    const actor = mockRegistryActor(false);
    const session = mockSession(['check-passkey', 'user-principal'], actor);

    await run(session);

    expect(mockLog).toHaveBeenCalledWith('Passkey registered: no');
  });

  it('exits with error when principal is missing', async () => {
    const actor = mockRegistryActor(true);
    const session = mockSession(['check-passkey'], actor);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: user principal ID is required');
  });

  it('exits with error when profile is not found', async () => {
    const actor = mockRegistryActor(false, false);
    const session = mockSession(['check-passkey', 'unknown-principal'], actor);

    // hasPasskey throws, which is caught by run()'s catch block → process.exit(1)
    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('No user profile found'));
  });
});

describe('bind prepare command', () => {
  it('generates authentication URL when passkey exists', async () => {
    const actor = mockRegistryActor(true);
    const session = mockSession(['prepare', 'user-principal'], actor);

    await run(session);

    expect(actor.agent_prepare_bond).toHaveBeenCalledWith('user-principal');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('=== Binding Authentication URL ==='));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('https://id.zcloak.xyz/agent/bind?auth_content='));
  });

  it('exits with error when passkey pre-check fails', async () => {
    const actor = mockRegistryActor(false); // No passkey
    const session = mockSession(['prepare', 'user-principal'], actor);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: target principal has no passkey registered.');
  });

  it('exits with error when principal is missing', async () => {
    const actor = mockRegistryActor(true);
    const session = mockSession(['prepare'], actor);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: user principal ID is required');
  });

  it('handles canister Err result', async () => {
    const actor = mockRegistryActor(true);
    actor.agent_prepare_bond = vi.fn().mockResolvedValue({ Err: 'Agent not registered' });
    const session = mockSession(['prepare', 'user-principal'], actor);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Binding preparation failed:');
    expect(mockLog).toHaveBeenCalledWith('(variant { Err = "Agent not registered" })');
  });
});

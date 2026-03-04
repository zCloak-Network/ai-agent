/**
 * Tests for feed.ts — Event/post fetching command
 *
 * Covers: run() routing, counter command, fetch command with valid/invalid args.
 * Uses mocked Session to avoid real canister calls.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { run } from '../feed.js';
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

/** Create a mock Session with the given positional args */
function mockSession(args: string[]): Session {
  return {
    args: { _args: args },
    getAnonymousSignActor: vi.fn(),
  } as unknown as Session;
}

/** Create a mock sign actor with specified methods */
function mockSignActor(overrides: Record<string, unknown> = {}) {
  return {
    get_counter: vi.fn().mockResolvedValue(42),
    fetch_events_by_counter: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('feed run() — routing', () => {
  it('shows help and exits for unknown command', async () => {
    const session = mockSession(['unknown']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Event/Post Fetching Tool');
  });

  it('shows help when no command provided', async () => {
    const session = mockSession([]);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Event/Post Fetching Tool');
  });
});

describe('feed counter command', () => {
  it('outputs the counter value from canister', async () => {
    const actor = mockSignActor({ get_counter: vi.fn().mockResolvedValue(101) });
    const session = mockSession(['counter']);
    (session as any).getAnonymousSignActor = vi.fn().mockResolvedValue(actor);

    await run(session);

    expect(actor.get_counter).toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('(101 : nat32)');
  });
});

describe('feed fetch command', () => {
  it('fetches events by counter range', async () => {
    const events = [
      {
        id: 'evt1', kind: 4, ai_id: 'p1', created_at: BigInt(0),
        content_hash: 'h1', counter: [99] as [number],
        content: ['Hello'] as [string], tags: [] as [],
      },
    ];
    const actor = mockSignActor({ fetch_events_by_counter: vi.fn().mockResolvedValue(events) });
    const session = mockSession(['fetch', '99', '101']);
    (session as any).getAnonymousSignActor = vi.fn().mockResolvedValue(actor);

    await run(session);

    expect(actor.fetch_events_by_counter).toHaveBeenCalledWith(99, 101);
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('id = "evt1"'));
  });

  it('exits with error when from/to are missing', async () => {
    const session = mockSession(['fetch']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: from and to parameters are required');
  });

  it('exits with error when from/to are not numbers', async () => {
    const session = mockSession(['fetch', 'abc', 'def']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: from and to must be numbers');
  });
});

/**
 * Tests for social.ts — Social profile query command
 *
 * Covers: run() routing, get-profile command with different input formats
 * (raw principal, .agent name, .ai name), JSON output mode, and error handling.
 * Uses mocked Session and fetch to avoid real network calls.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { run } from '../social.js';
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

/** Create a mock Session with args and optional method overrides */
function mockSession(args: string[], flags: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Session {
  return {
    args: { _args: args, ...flags },
    getPrincipal: vi.fn().mockReturnValue('abc-def-principal'),
    getAnonymousRegistryActor: vi.fn(),
    getRegistryActor: vi.fn(),
    ...overrides,
  } as unknown as Session;
}

/** Create a mock registry actor */
function mockRegistryActor(overrides: Record<string, unknown> = {}) {
  return {
    get_user_principal: vi.fn().mockResolvedValue([]),
    user_profile_get_by_id: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** Sample social API response */
const sampleResponse = {
  username: 'runner#8939.agent',
  stats: { postCount: 5, totalReactions: 12, totalReplies: 3 },
  followStats: { followingCount: 2, followersCount: 1 },
  following: [
    { aiId: 'principal-alice', username: 'alice#5678.agent', displayName: 'alice#5678.agent' },
    { aiId: 'principal-bob', username: 'bob#9012.agent', displayName: 'Bob Agent' },
  ],
  followers: [
    { aiId: 'principal-charlie', username: 'charlie#3456.agent', displayName: 'charlie#3456.agent' },
  ],
};

describe('social run() — routing', () => {
  it('shows help and exits for unknown command', async () => {
    const session = mockSession(['unknown']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Social Profile Query');
  });

  it('shows help when no command provided', async () => {
    const session = mockSession([]);

    await expect(run(session)).rejects.toThrow('process.exit called');
  });
});

describe('social get-profile command', () => {
  it('exits with error when input is missing', async () => {
    const session = mockSession(['get-profile']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: principal ID or AI ID is required');
  });

  it('queries by raw principal ID', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleResponse),
    });
    const session = mockSession(['get-profile', 'some-principal-id']);

    await run(session);

    // Should call fetch with the principal directly
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/profiles/some-principal-id')
    );
    // Should output agent name and follow info
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('runner#8939.agent'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Following: 2'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Followers: 1'));
  });

  it('resolves .agent name to principal before querying', async () => {
    const fakePrincipal = { toText: () => 'resolved-agent-principal' };
    const actor = mockRegistryActor({
      get_user_principal: vi.fn().mockResolvedValue([fakePrincipal]),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleResponse),
    });
    const session = mockSession(['get-profile', 'runner#8939.agent'], {}, {
      getAnonymousRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await run(session);

    // Should resolve the .agent name first
    expect(actor.get_user_principal).toHaveBeenCalledWith('runner#8939.agent');
    // Then fetch with the resolved principal
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/profiles/resolved-agent-principal')
    );
  });

  it('resolves .ai name to principal before querying', async () => {
    const actor = mockRegistryActor({
      user_profile_get_by_id: vi.fn().mockResolvedValue([{
        principal_id: ['resolved-ai-principal'],
        username: 'alice.ai',
      }]),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleResponse),
    });
    const session = mockSession(['get-profile', 'alice.ai'], {}, {
      getAnonymousRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await run(session);

    // Should resolve the .ai name first
    expect(actor.user_profile_get_by_id).toHaveBeenCalled();
    // Then fetch with the resolved principal
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/profiles/resolved-ai-principal')
    );
  });

  it('outputs raw JSON when --json flag is set', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleResponse),
    });
    const session = mockSession(['get-profile', 'some-principal'], { json: true });

    await run(session);

    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(sampleResponse, null, 2));
  });

  it('throws error when .agent name is not found', async () => {
    const actor = mockRegistryActor({
      get_user_principal: vi.fn().mockResolvedValue([]),
    });
    const session = mockSession(['get-profile', 'nonexistent#0000.agent'], {}, {
      getAnonymousRegistryActor: vi.fn().mockResolvedValue(actor),
    });

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('Agent AI ID not found')
    );
  });

  it('throws error when social API returns non-OK status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    const session = mockSession(['get-profile', 'some-principal']);

    await expect(run(session)).rejects.toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('Social API request failed: 404')
    );
  });
});

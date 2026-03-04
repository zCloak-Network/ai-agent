/**
 * Tests for config.ts — Application configuration
 */

import { describe, it, expect } from 'vitest';
import { getCanisterIds } from '../config';
import config from '../config';

// ========== getCanisterIds ==========

describe('getCanisterIds', () => {
  it('returns the configured canister IDs', () => {
    const ids = getCanisterIds();
    expect(ids).toEqual(config.canisterIds);
    expect(ids.registry).toBe('3spie-caaaa-aaaam-ae3sa-cai');
    expect(ids.signatures).toBe('zpbbm-piaaa-aaaaj-a3dsq-cai');
  });
});

// ========== config object structure ==========

describe('config object', () => {
  it('has canister IDs', () => {
    expect(config.canisterIds).toBeDefined();
    expect(config.canisterIds.registry).toBeTruthy();
    expect(config.canisterIds.signatures).toBeTruthy();
  });

  it('has pow_zeros as a positive number', () => {
    expect(config.pow_zeros).toBeGreaterThan(0);
  });

  it('has bind_url, profile_url, twofa_url, and event_url', () => {
    expect(config.bind_url).toContain('https://');
    expect(config.profile_url).toContain('https://');
    expect(config.twofa_url).toContain('https://');
    expect(config.event_url).toContain('https://');
  });
});

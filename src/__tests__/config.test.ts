/**
 * Tests for config.ts — Application configuration
 */

import { describe, it, expect } from 'vitest';
import { getCanisterIds } from '../config.js';
import config from '../config.js';

// ========== getCanisterIds ==========

describe('getCanisterIds', () => {
  it('returns the configured canister IDs', () => {
    const ids = getCanisterIds();
    expect(ids).toEqual(config.canisterIds);
    expect(ids.registry).toBe('ytmuz-nyaaa-aaaah-qqoja-cai');     // prod
    expect(ids.signatures).toBe('jayj5-xyaaa-aaaam-qfinq-cai');
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

  it('has bind_url, profile_url, twofa_url, event_url, and setting_url', () => {
    expect(config.bind_url).toContain('https://');
    expect(config.profile_url).toContain('https://');
    expect(config.twofa_url).toContain('https://');
    expect(config.event_url).toContain('https://');
    expect(config.setting_url).toContain('https://');
  });
});

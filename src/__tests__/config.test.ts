/**
 * Tests for config.ts — Environment configuration functions
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEnv, getCanisterIds, getEnvLabel } from '../config';
import config from '../config';

afterEach(() => {
  vi.unstubAllEnvs();
});

// ========== getEnv ==========

describe('getEnv', () => {
  it('returns "prod" by default when no --env arg or ZCLOAK_ENV', () => {
    expect(getEnv(['node', 'script.js'])).toBe('prod');
  });

  it('returns "prod" with --env=prod', () => {
    expect(getEnv(['node', 'script.js', '--env=prod'])).toBe('prod');
  });

  it('returns "dev" with --env=dev', () => {
    expect(getEnv(['node', 'script.js', '--env=dev'])).toBe('dev');
  });

  it('throws on unknown --env value', () => {
    expect(() => getEnv(['node', 'script.js', '--env=staging'])).toThrow(
      'Unknown environment "staging"'
    );
  });

  it('reads ZCLOAK_ENV env var when no --env arg', () => {
    vi.stubEnv('ZCLOAK_ENV', 'dev');
    expect(getEnv(['node', 'script.js'])).toBe('dev');
  });

  it('throws on unknown ZCLOAK_ENV value', () => {
    vi.stubEnv('ZCLOAK_ENV', 'staging');
    expect(() => getEnv(['node', 'script.js'])).toThrow(
      'Unknown ZCLOAK_ENV value "staging"'
    );
  });

  it('--env arg takes precedence over ZCLOAK_ENV', () => {
    vi.stubEnv('ZCLOAK_ENV', 'dev');
    expect(getEnv(['node', 'script.js', '--env=prod'])).toBe('prod');
  });

  it('finds --env anywhere in argv (not just position 2)', () => {
    expect(getEnv(['node', 'script.js', 'command', '--env=dev', 'arg2'])).toBe('dev');
  });
});

// ========== getCanisterIds ==========

describe('getCanisterIds', () => {
  it('returns prod canister IDs by default', () => {
    const ids = getCanisterIds(['node', 'script.js']);
    expect(ids).toEqual(config.prod);
    expect(ids.registry).toBe('ytmuz-nyaaa-aaaah-qqoja-cai');
    expect(ids.signatures).toBe('jayj5-xyaaa-aaaam-qfinq-cai');
  });

  it('returns dev canister IDs with --env=dev', () => {
    const ids = getCanisterIds(['node', 'script.js', '--env=dev']);
    expect(ids).toEqual(config.dev);
    expect(ids.registry).toBe('3spie-caaaa-aaaam-ae3sa-cai');
    expect(ids.signatures).toBe('zpbbm-piaaa-aaaaj-a3dsq-cai');
  });
});

// ========== getEnvLabel ==========

describe('getEnvLabel', () => {
  it('returns "PROD" by default', () => {
    expect(getEnvLabel(['node', 'script.js'])).toBe('PROD');
  });

  it('returns "DEV" with --env=dev', () => {
    expect(getEnvLabel(['node', 'script.js', '--env=dev'])).toBe('DEV');
  });
});

// ========== config object structure ==========

describe('config object', () => {
  it('has prod and dev canister IDs', () => {
    expect(config.prod).toBeDefined();
    expect(config.dev).toBeDefined();
    expect(config.prod.registry).toBeTruthy();
    expect(config.prod.signatures).toBeTruthy();
    expect(config.dev.registry).toBeTruthy();
    expect(config.dev.signatures).toBeTruthy();
  });

  it('has pow_zeros as a positive number', () => {
    expect(config.pow_zeros).toBeGreaterThan(0);
  });

  it('has bind_url and profile_url for both environments', () => {
    expect(config.bind_url.prod).toContain('https://');
    expect(config.bind_url.dev).toContain('https://');
    expect(config.profile_url.prod).toContain('https://');
    expect(config.profile_url.dev).toContain('https://');
  });
});

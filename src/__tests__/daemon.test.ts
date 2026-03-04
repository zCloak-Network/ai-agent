/**
 * Tests for daemon.ts — PID file management, socket path resolution, runtime directory
 *
 * These tests verify:
 * 1. Derivation ID sanitization (colon/slash replacement, long ID hashing)
 * 2. Socket and PID path format
 * 3. PID file creation and cleanup
 * 4. Stale PID detection and recovery
 * 5. Duplicate instance prevention
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import crypto from 'crypto';
import {
  sanitizeDerivationId,
  socketPath,
  pidPath,
  runtimeDir,
  DaemonRuntime,
} from '../daemon.js';

describe('sanitizeDerivationId', () => {
  it('should replace colons with underscores', () => {
    expect(sanitizeDerivationId('abc-def:default')).toBe('abc-def_default');
  });

  it('should replace forward slashes', () => {
    expect(sanitizeDerivationId('abc/def')).toBe('abc_def');
  });

  it('should handle simple IDs without changes (except colon)', () => {
    expect(sanitizeDerivationId('simple')).toBe('simple');
  });

  it('should use SHA-256 hash for very long IDs', () => {
    const longId = 'a'.repeat(200) + ':default';
    const result = sanitizeDerivationId(longId);
    expect(result).toMatch(/^vk_[0-9a-f]{16}$/);
    // Should be short enough for socket path
    expect(result.length).toBeLessThan(30);
  });

  it('should produce deterministic hash for same long ID', () => {
    const longId = 'x'.repeat(200);
    const r1 = sanitizeDerivationId(longId);
    const r2 = sanitizeDerivationId(longId);
    expect(r1).toBe(r2);
  });
});

describe('socketPath / pidPath', () => {
  it('should use .sock extension for socket', () => {
    const path = socketPath('test_id');
    expect(path).toMatch(/\.sock$/);
  });

  it('should use .pid extension for PID file', () => {
    const path = pidPath('test_id');
    expect(path).toMatch(/\.pid$/);
  });

  it('should be in the runtime directory', () => {
    const dir = runtimeDir();
    expect(socketPath('test')).toMatch(new RegExp(`^${dir.replace(/[/\\]/g, '[/\\\\]')}`));
    expect(pidPath('test')).toMatch(new RegExp(`^${dir.replace(/[/\\]/g, '[/\\\\]')}`));
  });
});

describe('DaemonRuntime', () => {
  const testId = `test-${crypto.randomBytes(4).toString('hex')}`;
  let runtime: DaemonRuntime | null = null;

  afterEach(() => {
    // Clean up after each test
    if (runtime) {
      runtime.destroy();
      runtime = null;
    }
  });

  it('should create PID file on creation', () => {
    runtime = DaemonRuntime.create(testId);
    expect(existsSync(runtime.pidFilePath)).toBe(true);

    // PID file should contain the current process ID
    const pid = readFileSync(runtime.pidFilePath, 'utf-8').trim();
    expect(parseInt(pid, 10)).toBe(process.pid);
  });

  it('should clean up files on destroy', () => {
    runtime = DaemonRuntime.create(testId);
    const pidFile = runtime.pidFilePath;

    runtime.destroy();
    runtime = null;

    expect(existsSync(pidFile)).toBe(false);
  });

  it('should detect stale PID and clean up', () => {
    // Write a PID file with a non-existent PID (99999999)
    const dir = runtimeDir();
    mkdirSync(dir, { recursive: true });
    const stalePidPath = pidPath(testId);
    writeFileSync(stalePidPath, '99999999\n');

    // Should succeed (stale PID is cleaned up)
    runtime = DaemonRuntime.create(testId);
    expect(existsSync(runtime.pidFilePath)).toBe(true);
    const pid = readFileSync(runtime.pidFilePath, 'utf-8').trim();
    expect(parseInt(pid, 10)).toBe(process.pid);
  });

  it('should reject duplicate daemon for same derivation ID', () => {
    runtime = DaemonRuntime.create(testId);

    // Try to create another runtime with the same ID
    expect(() => DaemonRuntime.create(testId)).toThrow('already running');
  });

  it('should allow re-creation after destroy', () => {
    runtime = DaemonRuntime.create(testId);
    runtime.destroy();

    // Should succeed now
    runtime = DaemonRuntime.create(testId);
    expect(existsSync(runtime.pidFilePath)).toBe(true);
  });
});

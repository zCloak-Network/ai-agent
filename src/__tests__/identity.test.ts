/**
 * Tests for identity.ts — PEM path resolution
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getPemPath, DEFAULT_PEM_PATH } from '../identity';

afterEach(() => {
  vi.unstubAllEnvs();
});

// ========== DEFAULT_PEM_PATH ==========

describe('DEFAULT_PEM_PATH', () => {
  it('is an absolute path', () => {
    expect(path.isAbsolute(DEFAULT_PEM_PATH)).toBe(true);
  });

  it('ends with identity.pem', () => {
    expect(DEFAULT_PEM_PATH).toMatch(/identity\.pem$/);
  });

  it('contains dfx identity directory structure', () => {
    expect(DEFAULT_PEM_PATH).toContain('.config/dfx/identity/default');
  });
});

// ========== getPemPath ==========

describe('getPemPath', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns path from --identity argument when file exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-pem-'));
    const pemPath = path.join(tmpDir, 'test.pem');
    fs.writeFileSync(pemPath, 'dummy-pem-content');

    const result = getPemPath(['node', 'script.js', `--identity=${pemPath}`]);
    expect(result).toBe(pemPath);
  });

  it('throws when --identity file does not exist', () => {
    expect(() =>
      getPemPath(['node', 'script.js', '--identity=/nonexistent/path.pem'])
    ).toThrow('does not exist');
  });

  it('reads ZCLOAK_IDENTITY env var when no --identity arg', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-pem-'));
    const pemPath = path.join(tmpDir, 'env.pem');
    fs.writeFileSync(pemPath, 'dummy-pem-content');

    vi.stubEnv('ZCLOAK_IDENTITY', pemPath);
    const result = getPemPath(['node', 'script.js']);
    expect(result).toBe(pemPath);
  });

  it('--identity takes precedence over ZCLOAK_IDENTITY', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-pem-'));
    const argPath = path.join(tmpDir, 'arg.pem');
    const envPath = path.join(tmpDir, 'env.pem');
    fs.writeFileSync(argPath, 'arg-pem');
    fs.writeFileSync(envPath, 'env-pem');

    vi.stubEnv('ZCLOAK_IDENTITY', envPath);
    const result = getPemPath(['node', 'script.js', `--identity=${argPath}`]);
    expect(result).toBe(argPath);
  });

  it('throws when no PEM file found anywhere', () => {
    // Ensure ZCLOAK_IDENTITY is not set and dfx default doesn't exist
    vi.stubEnv('ZCLOAK_IDENTITY', '');
    // Pass argv without --identity and assume no dfx default on CI
    // This test only works when DEFAULT_PEM_PATH doesn't exist on the machine
    if (!fs.existsSync(DEFAULT_PEM_PATH)) {
      expect(() => getPemPath(['node', 'script.js'])).toThrow('Identity PEM file not found');
    }
  });

  it('handles --identity with path containing equals sign', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-pem-'));
    const pemPath = path.join(tmpDir, 'a=b.pem');
    fs.writeFileSync(pemPath, 'dummy');

    const result = getPemPath(['node', 'script.js', `--identity=${pemPath}`]);
    expect(result).toBe(pemPath);
  });
});

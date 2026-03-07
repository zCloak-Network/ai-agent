/**
 * Tests for identity.ts — PEM path resolution
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getPemPath, DEFAULT_PEM_PATH, ensureIdentityFile, resolveCliPath } from '../identity.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// ========== DEFAULT_PEM_PATH ==========

describe('DEFAULT_PEM_PATH', () => {
  it('is an absolute path', () => {
    expect(path.isAbsolute(DEFAULT_PEM_PATH)).toBe(true);
  });

  it('ends with identity.pem', () => {
    expect(DEFAULT_PEM_PATH).toMatch(/ai-id\.pem$/);
  });

  it('contains zcloak identity directory structure', () => {
    expect(DEFAULT_PEM_PATH).toContain('.config/zcloak');
  });
});

// ========== resolveCliPath ==========

describe('resolveCliPath', () => {
  it('expands ~ to the current home directory', () => {
    expect(resolveCliPath('~/test.pem')).toBe(path.join(os.homedir(), 'test.pem'));
  });
});

// ========== ensureIdentityFile / getPemPath ==========

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

  it('creates and returns the zcloak default PEM path when missing', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-pem-'));
    const defaultPath = path.join(tmpDir, 'ai-id.pem');

    const result = getPemPath(['node', 'script.js'], defaultPath);
    expect(result).toBe(defaultPath);
    expect(fs.existsSync(defaultPath)).toBe(true);
  });

  it('creates the zcloak default PEM when explicitly requested via --identity', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-pem-'));
    const defaultPath = path.join(tmpDir, 'ai-id.pem');

    const result = getPemPath(['node', 'script.js', `--identity=${defaultPath}`], defaultPath);
    expect(result).toBe(defaultPath);
    expect(fs.existsSync(defaultPath)).toBe(true);
  });

  it('handles --identity with path containing equals sign', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-pem-'));
    const pemPath = path.join(tmpDir, 'a=b.pem');
    fs.writeFileSync(pemPath, 'dummy');

    const result = getPemPath(['node', 'script.js', `--identity=${pemPath}`]);
    expect(result).toBe(pemPath);
  });

  it('creates a valid PEM file via ensureIdentityFile', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-pem-'));
    const pemPath = path.join(tmpDir, 'created.pem');

    const result = ensureIdentityFile(pemPath);

    expect(result.created).toBe(true);
    expect(result.path).toBe(pemPath);
    const content = fs.readFileSync(pemPath, 'utf-8');
    expect(content).toContain('-----BEGIN EC PRIVATE KEY-----');
  });
});

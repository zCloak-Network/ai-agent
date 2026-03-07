/**
 * Tests for identity_cmd.ts — Identity key management command
 *
 * Covers: generate (new PEM, --output, --identity alias, --force, overwrite protection),
 * show (print PEM path + principal), command routing, help output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Session } from '../session.js';
import { run } from '../identity_cmd.js';

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-idcmd-'));
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('identity_cmd run() — routing', () => {
  it('shows help when no command provided', () => {
    const session = new Session(['node', 'identity_cmd.js']);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Identity Key Management');
  });

  it('shows help with --help flag', () => {
    const session = new Session(['node', 'identity_cmd.js', '--help']);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('errors on unknown command', () => {
    const session = new Session(['node', 'identity_cmd.js', 'unknown']);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Unknown command: unknown'));
  });
});

describe('identity generate command', () => {
  it('generates a valid PEM file at --output path', () => {
    const outputPath = path.join(tmpDir, 'new-identity.pem');
    const session = new Session(['node', 'identity_cmd.js', 'generate', `--output=${outputPath}`]);

    run(session);

    // Verify file exists
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify PEM format
    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('-----BEGIN EC PRIVATE KEY-----');
    expect(content).toContain('-----END EC PRIVATE KEY-----');

    // Verify output messages
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Identity PEM generated'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Principal ID'));
  });

  it('treats --identity as an alias for the generate output path', () => {
    const outputPath = path.join(tmpDir, 'alias-identity.pem');
    const session = new Session(['node', 'identity_cmd.js', 'generate', `--identity=${outputPath}`]);

    run(session);

    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('-----BEGIN EC PRIVATE KEY-----');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining(`Identity PEM generated: ${outputPath}`));
  });

  it('reuses existing valid PEM file without --force', () => {
    const outputPath = path.join(tmpDir, 'existing.pem');

    // First generate a valid PEM
    const genSession = new Session(['node', 'identity_cmd.js', 'generate', `--output=${outputPath}`]);
    run(genSession);
    const originalPem = fs.readFileSync(outputPath, 'utf-8');
    vi.clearAllMocks();

    // Run generate again without --force — should reuse existing key
    const session = new Session(['node', 'identity_cmd.js', 'generate', `--output=${outputPath}`]);
    run(session);

    // Original PEM file should be unchanged (not overwritten)
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe(originalPem);
    // Should indicate reuse, not generation
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Existing identity found'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Principal ID'));
  });

  it('errors when existing file is not a valid PEM', () => {
    const outputPath = path.join(tmpDir, 'bad-pem.pem');
    fs.writeFileSync(outputPath, 'not-a-valid-pem');

    const session = new Session(['node', 'identity_cmd.js', 'generate', `--output=${outputPath}`]);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('not a valid PEM'));

    // Original file should be unchanged
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('not-a-valid-pem');
  });

  it('overwrites existing file with --force', () => {
    const outputPath = path.join(tmpDir, 'existing.pem');
    fs.writeFileSync(outputPath, 'old-content');

    const session = new Session([
      'node', 'identity_cmd.js', 'generate',
      `--output=${outputPath}`, '--force',
    ]);

    run(session);

    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('-----BEGIN EC PRIVATE KEY-----');
    expect(content).not.toBe('old-content');
  });

  it('creates parent directories if they do not exist', () => {
    const nestedPath = path.join(tmpDir, 'deep', 'nested', 'dir', 'identity.pem');
    const session = new Session(['node', 'identity_cmd.js', 'generate', `--output=${nestedPath}`]);

    run(session);

    expect(fs.existsSync(nestedPath)).toBe(true);
  });
});

describe('identity show command', () => {
  it('shows PEM path and principal for a valid identity', () => {
    // First generate a PEM file
    const pemPath = path.join(tmpDir, 'show-test.pem');
    const genSession = new Session(['node', 'identity_cmd.js', 'generate', `--output=${pemPath}`]);
    run(genSession);
    vi.clearAllMocks();

    // Now show it
    const showSession = new Session(['node', 'identity_cmd.js', 'show', `--identity=${pemPath}`]);
    run(showSession);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('PEM file:'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Principal ID:'));
  });
});

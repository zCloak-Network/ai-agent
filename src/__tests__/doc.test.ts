/**
 * Tests for doc.ts — Document tools command
 *
 * Covers: run() routing, manifest generation, verify-manifest, hash, info commands.
 * Uses real filesystem operations since doc commands are pure local operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { Session } from '../session.js';
import { run } from '../doc.js';

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as never);

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-doc-'));
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('doc run() — routing', () => {
  it('shows help and exits for unknown command', () => {
    const session = new Session(['node', 'doc.js', 'unknown-cmd']);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Document Tool');
  });

  it('shows help when no command provided', () => {
    const session = new Session(['node', 'doc.js']);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith('zCloak.ai Document Tool');
  });
});

describe('doc hash command', () => {
  it('outputs correct SHA256 hash for a file', () => {
    const content = 'hello doc hash';
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, content);

    const session = new Session(['node', 'doc.js', 'hash', filePath]);
    run(session);

    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    expect(mockLog).toHaveBeenCalledWith(expectedHash);
  });

  it('exits with error when file path is missing', () => {
    const session = new Session(['node', 'doc.js', 'hash']);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith('Error: file path is required');
  });

  it('exits with error when file does not exist', () => {
    const session = new Session(['node', 'doc.js', 'hash', '/nonexistent/file.txt']);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('file does not exist'));
  });
});

describe('doc info command', () => {
  it('outputs filename, SHA256, size, and MIME type', () => {
    const content = 'test data';
    const filePath = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(filePath, content);

    const session = new Session(['node', 'doc.js', 'info', filePath]);
    run(session);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Filename: report.pdf'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('SHA256:'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining(`Size: ${content.length} bytes`));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('MIME: application/pdf'));
  });

  it('includes JSON output for signing', () => {
    const filePath = path.join(tmpDir, 'data.json');
    fs.writeFileSync(filePath, '{}');

    const session = new Session(['node', 'doc.js', 'info', filePath]);
    run(session);

    // Should output JSON block
    const jsonCall = mockLog.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('JSON (for signing)')
    );
    expect(jsonCall).toBeDefined();
  });
});

describe('doc manifest command', () => {
  it('generates MANIFEST.sha256 and outputs stats', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'bbb');

    const session = new Session(['node', 'doc.js', 'manifest', tmpDir]);
    run(session);

    // Verify MANIFEST.sha256 was created
    expect(fs.existsSync(path.join(tmpDir, 'MANIFEST.sha256'))).toBe(true);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('MANIFEST.sha256 generated'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('File count: 2'));
  });

  it('supports --version option', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'data');

    const session = new Session(['node', 'doc.js', 'manifest', tmpDir, '--version=3.0.0']);
    run(session);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Version: 3.0.0'));
  });
});

describe('doc verify-manifest command', () => {
  it('verifies all files pass for a valid manifest', () => {
    // Create files and generate manifest
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'bbb');

    // Generate manifest first
    const genSession = new Session(['node', 'doc.js', 'manifest', tmpDir]);
    run(genSession);
    vi.clearAllMocks();

    // Now verify
    const verifySession = new Session(['node', 'doc.js', 'verify-manifest', tmpDir]);
    run(verifySession);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('OK: a.txt'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('OK: b.txt'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('All files verified successfully'));
  });

  it('fails when a file has been modified after manifest generation', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'original');

    // Generate manifest
    const genSession = new Session(['node', 'doc.js', 'manifest', tmpDir]);
    run(genSession);
    vi.clearAllMocks();

    // Modify file after manifest was generated
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'modified');

    // Verify should fail
    const verifySession = new Session(['node', 'doc.js', 'verify-manifest', tmpDir]);
    expect(() => run(verifySession)).toThrow('process.exit called');
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('FAILED: test.txt'));
  });

  it('exits with error when MANIFEST.sha256 is missing', () => {
    const session = new Session(['node', 'doc.js', 'verify-manifest', tmpDir]);

    expect(() => run(session)).toThrow('process.exit called');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('MANIFEST.sha256 not found'));
  });
});

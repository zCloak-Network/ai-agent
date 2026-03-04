/**
 * Tests for utils.ts generateManifest() — MANIFEST.sha256 file generation
 *
 * Covers: file listing, hash computation, metadata header, version, fileCount
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { generateManifest } from '../utils.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-manifest-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateManifest', () => {
  it('creates MANIFEST.sha256 file in the target folder', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello');

    const result = generateManifest(tmpDir);
    const manifestPath = path.join(tmpDir, 'MANIFEST.sha256');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(result.manifestPath).toBe(manifestPath);
  });

  it('returns correct fileCount', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'c');

    const result = generateManifest(tmpDir);
    expect(result.fileCount).toBe(3);
  });

  it('includes metadata header with # comment lines', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'data');

    generateManifest(tmpDir, { version: '2.0.0' });
    const content = fs.readFileSync(path.join(tmpDir, 'MANIFEST.sha256'), 'utf-8');

    expect(content).toContain('# skill:');
    expect(content).toContain('# date:');
    expect(content).toContain('# version: 2.0.0');
    expect(content).toContain('# author:');
  });

  it('uses default version 1.0.0 when not specified', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'data');

    generateManifest(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'MANIFEST.sha256'), 'utf-8');

    expect(content).toContain('# version: 1.0.0');
  });

  it('contains correct hash lines matching sha256sum format', () => {
    const fileContent = 'hello world';
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), fileContent);

    generateManifest(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'MANIFEST.sha256'), 'utf-8');

    const expectedHash = crypto.createHash('sha256').update(fileContent).digest('hex');
    expect(content).toContain(`${expectedHash}  ./test.txt`);
  });

  it('returns valid manifestHash and manifestSize', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'data');

    const result = generateManifest(tmpDir);

    // Verify the returned hash matches an independent computation
    const actualHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(result.manifestPath))
      .digest('hex');
    expect(result.manifestHash).toBe(actualHash);

    const actualSize = fs.statSync(result.manifestPath).size;
    expect(result.manifestSize).toBe(actualSize);
  });

  it('includes files from nested directories', () => {
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(tmpDir, 'root.txt'), 'r');
    fs.writeFileSync(path.join(subDir, 'nested.txt'), 'n');

    const result = generateManifest(tmpDir);
    expect(result.fileCount).toBe(2);

    const content = fs.readFileSync(result.manifestPath, 'utf-8');
    expect(content).toContain('./root.txt');
    expect(content).toContain('./sub/nested.txt');
  });

  it('excludes MANIFEST.sha256, .git, and node_modules', () => {
    fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'k');
    // Pre-existing MANIFEST should be excluded from listing
    fs.writeFileSync(path.join(tmpDir, 'MANIFEST.sha256'), 'old');
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), 'git');
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), 'pkg');

    const result = generateManifest(tmpDir);
    expect(result.fileCount).toBe(1);

    const content = fs.readFileSync(result.manifestPath, 'utf-8');
    expect(content).not.toContain('.git');
    expect(content).not.toContain('node_modules');
  });
});

/**
 * Tests for utils.ts — Pure utility functions
 *
 * Covers: parseArgs, parseTags, computePow, hashFile, getFileSize, getMimeType,
 * listFiles, parseManifestEntries, verifyManifestEntries, format functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseArgs,
  parseTags,
  computePow,
  hashFile,
  getFileSize,
  getMimeType,
  listFiles,
  parseManifestEntries,
  verifyManifestEntries,
  formatSignEvent,
  formatSignEvents,
  formatSignResult,
  formatOptText,
} from '../utils';

// ========== Temp directory helpers ==========

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========== parseArgs ==========

describe('parseArgs', () => {
  it('returns empty _args for empty argv (only node + script)', () => {
    const result = parseArgs(['node', 'script.js']);
    expect(result._args).toEqual([]);
  });

  it('parses --key=value pairs', () => {
    const result = parseArgs(['node', 'script.js', '--env=dev', '--identity=/path/to/pem']);
    expect(result.env).toBe('dev');
    expect(result.identity).toBe('/path/to/pem');
  });

  it('parses --flag (boolean flag without value)', () => {
    const result = parseArgs(['node', 'script.js', '--force', '--verbose']);
    expect(result.force).toBe(true);
    expect(result.verbose).toBe(true);
  });

  it('puts positional arguments in _args in order', () => {
    const result = parseArgs(['node', 'script.js', 'post', 'hello world', '--sub=web3']);
    expect(result._args).toEqual(['post', 'hello world']);
    expect(result.sub).toBe('web3');
  });

  it('handles --key=value with embedded equals', () => {
    const result = parseArgs(['node', 'script.js', '--identity=/path/a=b.pem']);
    expect(result.identity).toBe('/path/a=b.pem');
  });

  it('skips first 2 elements of argv (node + script path)', () => {
    const result = parseArgs(['node', 'script.js', 'command']);
    expect(result._args).toEqual(['command']);
    // 'node' and 'script.js' should NOT appear anywhere
    expect(result._args).not.toContain('node');
    expect(result._args).not.toContain('script.js');
  });

  it('defaults to process.argv when no argv given', () => {
    // Just verify it doesn't throw
    const result = parseArgs();
    expect(result).toBeDefined();
    expect(result._args).toBeDefined();
  });
});

// ========== parseTags ==========

describe('parseTags', () => {
  it('parses comma-separated key:value tags', () => {
    expect(parseTags('t:crypto,sub:web3')).toEqual([
      ['t', 'crypto'],
      ['sub', 'web3'],
    ]);
  });

  it('parses single tag', () => {
    expect(parseTags('t:crypto')).toEqual([['t', 'crypto']]);
  });

  it('handles tag value containing colons', () => {
    expect(parseTags('m:alice:bob')).toEqual([['m', 'alice:bob']]);
  });

  it('returns empty array for undefined input', () => {
    expect(parseTags(undefined)).toEqual([]);
  });

  it('returns empty array for boolean input', () => {
    expect(parseTags(true)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseTags('')).toEqual([]);
  });

  it('throws on invalid format (no colon)', () => {
    expect(() => parseTags('invalidtag')).toThrow('Invalid tag format');
  });
});

// ========== computePow ==========

describe('computePow', () => {
  it('finds a valid nonce with zeros=1', () => {
    const result = computePow('test-base', 1);
    expect(result.hash.startsWith('0')).toBe(true);
    expect(result.nonce).toBeGreaterThanOrEqual(0);
    expect(result.timeMs).toBeGreaterThanOrEqual(0);
  });

  it('produces a verifiable hash', () => {
    const base = 'hello';
    const result = computePow(base, 1);
    // Verify: sha256(base + nonce) === result.hash
    const candidate = base + result.nonce.toString();
    const expected = crypto.createHash('sha256').update(candidate).digest('hex');
    expect(result.hash).toBe(expected);
  });

  it('hash starts with correct number of zeros', () => {
    const result = computePow('abc', 2);
    expect(result.hash.startsWith('00')).toBe(true);
  });
});

// ========== hashFile ==========

describe('hashFile', () => {
  it('computes correct SHA256 hash', () => {
    const content = 'hello world\n';
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, content);

    const result = hashFile(filePath);
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    expect(result).toBe(expected);
  });

  it('throws for non-existent file', () => {
    expect(() => hashFile('/nonexistent/path/file.txt')).toThrow('Failed to compute file hash');
  });
});

// ========== getFileSize ==========

describe('getFileSize', () => {
  it('returns correct file size', () => {
    const content = 'abcdefgh'; // 8 bytes
    const filePath = path.join(tmpDir, 'size-test.txt');
    fs.writeFileSync(filePath, content);

    expect(getFileSize(filePath)).toBe(8);
  });

  it('throws for non-existent file', () => {
    expect(() => getFileSize('/nonexistent/path/file.txt')).toThrow('Failed to get file size');
  });
});

// ========== getMimeType ==========

describe('getMimeType', () => {
  it('returns correct MIME for known extensions', () => {
    expect(getMimeType('report.pdf')).toBe('application/pdf');
    expect(getMimeType('photo.png')).toBe('image/png');
    expect(getMimeType('data.json')).toBe('application/json');
    expect(getMimeType('readme.md')).toBe('text/markdown');
    expect(getMimeType('app.ts')).toBe('text/typescript');
    expect(getMimeType('module.wasm')).toBe('application/wasm');
  });

  it('returns application/octet-stream for unknown extension', () => {
    expect(getMimeType('file.xyz')).toBe('application/octet-stream');
    expect(getMimeType('file')).toBe('application/octet-stream');
  });

  it('is case-insensitive for extensions', () => {
    expect(getMimeType('REPORT.PDF')).toBe('application/pdf');
    expect(getMimeType('photo.PNG')).toBe('image/png');
  });
});

// ========== listFiles ==========

describe('listFiles', () => {
  it('lists files in sorted order', () => {
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'c');

    const files = listFiles(tmpDir);
    expect(files).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('includes nested directory files with correct relative paths', () => {
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(tmpDir, 'root.txt'), 'r');
    fs.writeFileSync(path.join(subDir, 'nested.txt'), 'n');

    const files = listFiles(tmpDir);
    expect(files).toContain('root.txt');
    expect(files).toContain('sub/nested.txt');
  });

  it('excludes MANIFEST.sha256, .git, and node_modules', () => {
    fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'k');
    fs.writeFileSync(path.join(tmpDir, 'MANIFEST.sha256'), 'manifest');
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), 'git');
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), 'pkg');

    const files = listFiles(tmpDir);
    expect(files).toEqual(['keep.txt']);
  });
});

// ========== parseManifestEntries ==========

describe('parseManifestEntries', () => {
  it('parses valid MANIFEST content', () => {
    const content = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  ./src/main.ts\n';
    const entries = parseManifestEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.expectedHash).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
    expect(entries[0]!.relativePath).toBe('src/main.ts');
  });

  it('skips comment lines', () => {
    const content = [
      '# skill: my-skill',
      '# date: 2024-01-01T00:00:00Z',
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  ./file.txt',
    ].join('\n');
    const entries = parseManifestEntries(content);
    expect(entries).toHaveLength(1);
  });

  it('skips empty lines', () => {
    const content = '\n\na1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  ./file.txt\n\n';
    const entries = parseManifestEntries(content);
    expect(entries).toHaveLength(1);
  });

  it('handles Windows CRLF line endings', () => {
    const content = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  ./file.txt\r\n';
    const entries = parseManifestEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.relativePath).toBe('file.txt');
  });

  it('strips leading ./ from paths', () => {
    const content = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  ./sub/file.txt\n';
    const entries = parseManifestEntries(content);
    expect(entries[0]!.relativePath).toBe('sub/file.txt');
  });

  it('throws on invalid line format', () => {
    const content = 'this is not a valid manifest line\n';
    expect(() => parseManifestEntries(content)).toThrow('Invalid MANIFEST line');
  });
});

// ========== verifyManifestEntries ==========

describe('verifyManifestEntries', () => {
  it('returns passed=true for matching files', () => {
    const fileContent = 'hello world';
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, fileContent);

    const fileHash = crypto.createHash('sha256').update(fileContent).digest('hex');
    const manifestContent = `${fileHash}  ./test.txt\n`;

    const results = verifyManifestEntries(manifestContent, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(true);
    expect(results[0]!.reason).toBeUndefined();
  });

  it('returns not_found for missing files', () => {
    const manifestContent = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2  ./missing.txt\n';
    const results = verifyManifestEntries(manifestContent, tmpDir);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.reason).toBe('not_found');
  });

  it('returns hash_mismatch for modified files', () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'modified content');

    // Use a different hash in the manifest
    const wrongHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const manifestContent = `${wrongHash}  ./test.txt\n`;

    const results = verifyManifestEntries(manifestContent, tmpDir);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.reason).toBe('hash_mismatch');
  });
});

// ========== Format functions ==========

describe('formatSignEvent', () => {
  const baseEvent = {
    id: 'abc123',
    kind: 4,
    ai_id: 'principal-id',
    created_at: BigInt(1700000000000000000),
    content_hash: 'hash123',
    counter: [] as [] | [number],
    content: [] as [] | [string],
    tags: [] as [] | [string[][]],
  };

  it('formats basic event fields', () => {
    const result = formatSignEvent(baseEvent);
    expect(result).toContain('id = "abc123"');
    expect(result).toContain('kind = 4');
    expect(result).toContain('ai_id = "principal-id"');
    expect(result).toContain('content_hash = "hash123"');
    expect(result).toContain('record {');
  });

  it('includes opt counter when present', () => {
    const event = { ...baseEvent, counter: [42] as [number] };
    const result = formatSignEvent(event);
    expect(result).toContain('counter = 42');
  });

  it('includes opt content when present', () => {
    const event = { ...baseEvent, content: ['hello world'] as [string] };
    const result = formatSignEvent(event);
    expect(result).toContain('content = "hello world"');
  });

  it('includes opt tags when present', () => {
    const event = { ...baseEvent, tags: [[['t', 'crypto'], ['sub', 'web3']]] as [string[][]] };
    const result = formatSignEvent(event);
    expect(result).toContain('tags = [');
    expect(result).toContain('"t"');
    expect(result).toContain('"crypto"');
  });

  it('omits opt fields when empty ([])', () => {
    const result = formatSignEvent(baseEvent);
    expect(result).not.toContain('counter');
    expect(result).not.toContain('content =');
    expect(result).not.toContain('tags');
  });
});

describe('formatSignEvents', () => {
  it('returns (vec {}) for empty array', () => {
    expect(formatSignEvents([])).toBe('(vec {})');
  });

  it('formats multiple events separated by semicolon', () => {
    const events = [
      {
        id: 'a', kind: 1, ai_id: 'p1', created_at: BigInt(0),
        content_hash: 'h1', counter: [] as [] | [number],
        content: [] as [] | [string], tags: [] as [] | [string[][]],
      },
      {
        id: 'b', kind: 2, ai_id: 'p2', created_at: BigInt(0),
        content_hash: 'h2', counter: [] as [] | [number],
        content: [] as [] | [string], tags: [] as [] | [string[][]],
      },
    ];
    const result = formatSignEvents(events);
    expect(result).toContain('(vec {');
    expect(result).toContain('id = "a"');
    expect(result).toContain('id = "b"');
    expect(result).toContain(';');
  });
});

describe('formatSignResult', () => {
  it('formats Ok variant', () => {
    const event = {
      id: 'abc', kind: 4, ai_id: 'p', created_at: BigInt(0),
      content_hash: 'h', counter: [] as [] | [number],
      content: [] as [] | [string], tags: [] as [] | [string[][]],
    };
    const result = formatSignResult({ Ok: event });
    expect(result).toContain('variant { Ok =');
    expect(result).toContain('id = "abc"');
  });

  it('formats Err variant', () => {
    const result = formatSignResult({ Err: 'PoW failed' });
    expect(result).toContain('variant { Err = "PoW failed"');
  });
});

describe('formatOptText', () => {
  it('formats present value', () => {
    expect(formatOptText(['agent-name'])).toBe('(opt "agent-name")');
  });

  it('formats empty (null) value', () => {
    expect(formatOptText([])).toBe('(null)');
  });
});

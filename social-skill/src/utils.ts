/**
 * zCloak.ai Common Utilities
 *
 * Provides PoW computation, file hashing, argument parsing, formatted output, and more.
 * All other scripts depend on this module.
 *
 * Note: Environment management functions (getEnv, getCanisterIds, getEnvLabel) have been moved to config.ts.
 * Re-exported here for backward compatibility.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config, { getEnv, getCanisterIds, getEnvLabel } from './config';
import { getPemPath, loadIdentityFromPath } from './identity';
import type { ParsedArgs, PowResult, ManifestOptions, ManifestResult, ManifestEntry, ManifestVerifyResult } from './types/common';
import type { SignEvent, SignResult } from './types/sign-event';

// ========== Re-export environment management functions (backward compatibility) ==========
export { getEnv, getCanisterIds, getEnvLabel };

// ========== PoW Computation ==========

/**
 * Compute PoW nonce
 * Finds a nonce such that sha256(base + nonce) starts with a specified number of zeros
 * @param base - Base string (usually the latest sign event id)
 * @param zeros - Number of leading zeros, defaults to config.pow_zeros
 */
export function computePow(base: string, zeros?: number): PowResult {
  const effectiveZeros = zeros || config.pow_zeros;
  const prefix = '0'.repeat(effectiveZeros);
  const start = Date.now();
  let nonce = 0;

  for (;;) {
    const candidate = base + nonce.toString();
    const hash = crypto.createHash('sha256').update(candidate).digest('hex');
    if (hash.startsWith(prefix)) {
      const timeMs = Date.now() - start;
      return { nonce, hash, timeMs };
    }
    nonce++;
  }
}

// ========== Command Line Arguments ==========

/**
 * Parse command line arguments into a structured object.
 * Supports both --key=value and --flag formats.
 * Positional arguments (not starting with --) are placed in _args array in order.
 *
 * When called with an explicit argv array, uses that instead of process.argv.
 * The first two elements (node path and script path) are always skipped,
 * matching the process.argv convention.
 *
 * @param argv - Optional explicit argument array (defaults to process.argv)
 */
export function parseArgs(argv?: string[]): ParsedArgs {
  const result: ParsedArgs = { _args: [] };
  // Skip node and script path (first 2 elements)
  const effectiveArgv = (argv ?? process.argv).slice(2);

  for (const arg of effectiveArgv) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        result[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        result[arg.slice(2)] = true;
      }
    } else {
      result._args.push(arg);
    }
  }
  return result;
}

/**
 * Parse --tags argument into a tag array
 * Format: "t:crypto,sub:web3,m:alice_id"
 */
export function parseTags(tagsStr: string | boolean | string[] | undefined): string[][] {
  if (!tagsStr || typeof tagsStr !== 'string') return [];
  return tagsStr.split(',').map(pair => {
    const parts = pair.split(':');
    if (parts.length < 2) {
      throw new Error(`Invalid tag format: "${pair}", expected key:value`);
    }
    return [parts[0]!, parts.slice(1).join(':')];
  });
}

// ========== File Hash & MIME ==========

/**
 * Compute SHA256 hash of a file (pure Node.js implementation, no shell dependency)
 * @param filePath - File path
 * @returns 64-character hex hash value
 * @throws {Error} If the file cannot be read
 */
export function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (err) {
    throw new Error(
      `Failed to compute file hash: ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Get file size (bytes)
 * @throws {Error} If the file cannot be stat'd
 */
export function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (err) {
    throw new Error(
      `Failed to get file size: ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Common MIME type mapping table
 * Returns the corresponding MIME type based on file extension
 */
const MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.wasm': 'application/wasm',
};

/**
 * Return MIME type based on file path
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// ========== MANIFEST Generation ==========

/**
 * Recursively list all files in a directory (excluding MANIFEST.sha256, .git, node_modules)
 * @param dir - Directory path
 * @param prefix - Path prefix (for recursion)
 * @returns Sorted list of relative paths
 */
export function listFiles(dir: string, prefix?: string): string[] {
  const effectivePrefix = prefix || '';
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = effectivePrefix ? `${effectivePrefix}/${entry.name}` : entry.name;

    // Exclude MANIFEST.sha256, .git, and node_modules
    if (entry.name === 'MANIFEST.sha256') continue;
    if (entry.name === '.git') continue;
    if (entry.name === 'node_modules') continue;

    if (entry.isDirectory()) {
      results.push(...listFiles(path.join(dir, entry.name), relativePath));
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }

  return results.sort();
}

/**
 * Generate MANIFEST.sha256 file (with metadata header)
 * Format compatible with GNU sha256sum, metadata represented as # comment lines
 *
 * This version uses pure Node.js implementation, no shell command dependency.
 * The author field is obtained via identity.ts; left empty if identity cannot be loaded.
 */
export function generateManifest(folderPath: string, options?: ManifestOptions): ManifestResult {
  const version = options?.version || '1.0.0';
  const manifestPath = path.join(folderPath, 'MANIFEST.sha256');

  // Get author (current principal, if a PEM file is available).
  // Identity is optional for MANIFEST generation — leave author empty if unavailable.
  let author = '';
  try {
    const pemPath = getPemPath();
    author = loadIdentityFromPath(pemPath).getPrincipal().toText();
  } catch {
    // No identity configured or PEM parse failed — leave author field empty
  }

  // Build metadata header
  const folderName = path.basename(path.resolve(folderPath));
  const dateStr = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const header = [
    `# skill: ${folderName}`,
    `# date: ${dateStr}`,
    `# version: ${version}`,
    `# author: ${author}`,
  ].join('\n');

  // Recursively get all files and compute hashes
  const files = listFiles(folderPath);
  const hashLines = files.map(relativePath => {
    const fullPath = path.join(folderPath, relativePath);
    const hash = hashFile(fullPath);
    // Compatible with sha256sum output format: <hash>  ./<relative_path>
    return `${hash}  ./${relativePath}`;
  });

  // Write MANIFEST.sha256
  const content = header + '\n' + hashLines.join('\n') + '\n';
  fs.writeFileSync(manifestPath, content, 'utf-8');

  // Compute MANIFEST's own hash and size
  const manifestHash = hashFile(manifestPath);
  const manifestSize = getFileSize(manifestPath);

  return { manifestPath, manifestHash, manifestSize, fileCount: files.length };
}

// ========== MANIFEST Parsing & Verification ==========

/**
 * Parse MANIFEST.sha256 file content into structured entries.
 *
 * Skips comment lines (starting with #) and empty lines.
 * Each valid line must match: <64-hex-hash> <whitespace> <path>
 * Non-empty non-comment lines that don't match this format cause an error
 * (strict mode — prevents silently ignoring corrupted MANIFEST content).
 *
 * @param manifestContent - Full text content of the MANIFEST.sha256 file
 * @returns Array of parsed ManifestEntry objects
 * @throws {Error} If a non-empty non-comment line has invalid format
 */
export function parseManifestEntries(manifestContent: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];

  for (const rawLine of manifestContent.split('\n')) {
    // Trim trailing \r for Windows CRLF compatibility
    const line = rawLine.trimEnd();
    // Skip empty lines and comment lines
    if (!line || line.startsWith('#')) continue;

    // Parse format: <hash>  ./<relative_path> or <hash>  <relative_path>
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) {
      throw new Error(`Invalid MANIFEST line: "${line}"`);
    }

    entries.push({
      expectedHash: match[1]!,
      relativePath: match[2]!.replace(/^\.\//, ''), // Remove leading ./
    });
  }

  return entries;
}

/**
 * Verify file integrity against MANIFEST entries.
 *
 * Parses the MANIFEST content, then checks each listed file:
 * - If the file does not exist → { passed: false, reason: 'not_found' }
 * - If the file hash doesn't match → { passed: false, reason: 'hash_mismatch' }
 * - If the hash matches → { passed: true }
 *
 * Returns structured results; the caller decides how to format output.
 *
 * @param manifestContent - MANIFEST.sha256 file content
 * @param basePath - Absolute path of the folder containing the files
 * @returns Array of verification results, one per file entry
 * @throws {Error} If the MANIFEST format is invalid
 */
export function verifyManifestEntries(
  manifestContent: string,
  basePath: string,
): ManifestVerifyResult[] {
  const entries = parseManifestEntries(manifestContent);
  const results: ManifestVerifyResult[] = [];

  for (const entry of entries) {
    const fullPath = path.join(basePath, entry.relativePath);

    if (!fs.existsSync(fullPath)) {
      results.push({ relativePath: entry.relativePath, passed: false, reason: 'not_found' });
      continue;
    }

    const actualHash = hashFile(fullPath);
    results.push({
      relativePath: entry.relativePath,
      passed: actualHash === entry.expectedHash,
      reason: actualHash === entry.expectedHash ? undefined : 'hash_mismatch',
    });
  }

  return results;
}

// ========== Output Formatting ==========

/**
 * Format a SignEvent object into readable text
 * Candid opt types are represented as [] | [value] in JS
 */
export function formatSignEvent(event: SignEvent): string {
  const lines: string[] = [];
  lines.push(`  id = "${event.id}"`);
  lines.push(`  kind = ${event.kind}`);
  lines.push(`  ai_id = "${event.ai_id}"`);
  lines.push(`  created_at = ${event.created_at}`);
  lines.push(`  content_hash = "${event.content_hash}"`);

  // Handle opt counter — [] means null, [n] means has value
  if (event.counter && event.counter.length > 0) {
    lines.push(`  counter = ${event.counter[0]}`);
  }

  // Handle opt content
  if (event.content && event.content.length > 0) {
    lines.push(`  content = "${event.content[0]}"`);
  }

  // Handle opt tags
  if (event.tags && event.tags.length > 0) {
    const tagsStr = event.tags[0]!
      .map(t => `[${t.map(s => `"${s}"`).join(', ')}]`)
      .join(', ');
    lines.push(`  tags = [${tagsStr}]`);
  }

  return `record {\n${lines.join('\n')}\n}`;
}

/**
 * Format a SignEvent array
 */
export function formatSignEvents(events: SignEvent[]): string {
  if (!events || events.length === 0) {
    return '(vec {})';
  }
  return `(vec {\n${events.map(e => formatSignEvent(e)).join(';\n')}\n})`;
}

/**
 * Format agent_sign return value (Ok/Err variant)
 */
export function formatSignResult(result: SignResult): string {
  if ('Ok' in result) {
    return `(variant { Ok = ${formatSignEvent(result.Ok)} })`;
  }
  if ('Err' in result) {
    return `(variant { Err = "${result.Err}" })`;
  }
  return JSON.stringify(result, null, 2);
}

/**
 * Format opt text type
 */
export function formatOptText(optText: [] | [string]): string {
  if (optText && optText.length > 0) {
    return `(opt "${optText[0]}")`;
  }
  return '(null)';
}

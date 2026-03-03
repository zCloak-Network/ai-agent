#!/usr/bin/env node
/**
 * zCloak.ai Document Tool
 *
 * Provides MANIFEST.sha256 generation, verification, file hash computation, and more.
 * Pure Node.js implementation, cross-platform compatible, no external shell commands required.
 *
 * Usage:
 *   zcloak-agent doc manifest <folder_path> [--version=1.0.0]    Generate MANIFEST.sha256 (with metadata header)
 *   zcloak-agent doc verify-manifest <folder_path>               Verify file integrity in MANIFEST.sha256
 *   zcloak-agent doc hash <file_path>                            Compute single file SHA256 hash
 *   zcloak-agent doc info <file_path>                            Show file hash, size, MIME, etc.
 */

import fs from 'fs';
import path from 'path';
import {
  parseArgs,
  hashFile,
  getFileSize,
  getMimeType,
  generateManifest,
} from './utils';
import type { ParsedArgs } from './types/common';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Document Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-agent doc manifest <folder_path> [--version=1.0.0]   Generate MANIFEST.sha256');
  console.log('  zcloak-agent doc verify-manifest <folder_path>              Verify file integrity');
  console.log('  zcloak-agent doc hash <file_path>                           Compute SHA256 hash');
  console.log('  zcloak-agent doc info <file_path>                           Show file details');
  console.log('');
  console.log('Options:');
  console.log('  --version=x.y.z  MANIFEST version (default: 1.0.0)');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-agent doc manifest ./my-skill/ --version=2.0.0');
  console.log('  zcloak-agent doc verify-manifest ./my-skill/');
  console.log('  zcloak-agent doc hash ./report.pdf');
  console.log('  zcloak-agent doc info ./report.pdf');
}

// ========== Command Implementations ==========

/**
 * Generate MANIFEST.sha256 (with metadata header)
 * Format compatible with GNU sha256sum, metadata represented as # comment lines
 */
function cmdManifest(folderPath: string | undefined, args: ParsedArgs): void {
  if (!folderPath) {
    console.error('Error: folder path is required');
    process.exit(1);
  }

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.error(`Error: directory does not exist: ${folderPath}`);
    process.exit(1);
  }

  const version = typeof args.version === 'string' ? args.version : '1.0.0';

  try {
    const result = generateManifest(folderPath, { version });
    console.log(`MANIFEST.sha256 generated: ${result.manifestPath}`);
    console.log(`File count: ${result.fileCount}`);
    console.log(`Version: ${version}`);
    console.log(`MANIFEST SHA256: ${result.manifestHash}`);
    console.log(`MANIFEST size: ${result.manifestSize} bytes`);
  } catch (err) {
    console.error(`Failed to generate MANIFEST: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Verify file integrity in MANIFEST.sha256
 * Pure Node.js implementation, parses and verifies each file hash line by line
 */
function cmdVerifyManifest(folderPath: string | undefined): void {
  if (!folderPath) {
    console.error('Error: folder path is required');
    process.exit(1);
  }

  const manifestPath = path.join(folderPath, 'MANIFEST.sha256');
  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: MANIFEST.sha256 not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  let allPassed = true;
  let fileCount = 0;

  for (const rawLine of manifestContent.split('\n')) {
    // Trim trailing \r so that CRLF line endings (Windows) don't corrupt file paths
    const line = rawLine.trimEnd();
    // Skip comment lines and empty lines
    if (!line || line.startsWith('#')) continue;

    // Parse format: <hash>  ./<relative_path>  or  <hash>  <relative_path>
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) continue;

    const expectedHash = match[1]!;
    const relativePath = match[2]!.replace(/^\.\//, '');
    const fullPath = path.join(folderPath, relativePath);

    fileCount++;

    if (!fs.existsSync(fullPath)) {
      console.log(`FAILED: ${relativePath} (file not found)`);
      allPassed = false;
      continue;
    }

    const actualHash = hashFile(fullPath);
    if (actualHash === expectedHash) {
      console.log(`${relativePath}: OK`);
    } else {
      console.log(`${relativePath}: FAILED`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    console.error(`\nVerification failed! Some files do not match (checked ${fileCount} files)`);
    process.exit(1);
  }

  console.log(`\nAll files verified successfully! (${fileCount} files)`);

  // Output MANIFEST hash (for subsequent on-chain verification)
  const manifestHash = hashFile(manifestPath);
  console.log(`\nMANIFEST SHA256: ${manifestHash}`);
  console.log('(Use this hash for on-chain signature verification: node verify.js file MANIFEST.sha256)');
}

/** Compute single file SHA256 hash */
function cmdHash(filePath: string | undefined): void {
  if (!filePath) {
    console.error('Error: file path is required');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Error: file does not exist: ${filePath}`);
    process.exit(1);
  }

  const hash = hashFile(filePath);
  console.log(hash);
}

/** Show file details (hash, size, MIME) */
function cmdInfo(filePath: string | undefined): void {
  if (!filePath) {
    console.error('Error: file path is required');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Error: file does not exist: ${filePath}`);
    process.exit(1);
  }

  const hash = hashFile(filePath);
  const size = getFileSize(filePath);
  const fileName = path.basename(filePath);
  const mime = getMimeType(filePath);

  console.log(`Filename: ${fileName}`);
  console.log(`SHA256: ${hash}`);
  console.log(`Size: ${size} bytes`);
  console.log(`MIME: ${mime}`);

  // Output JSON format (for easy copy-paste for signing)
  const contentObj = { title: fileName, hash, mime, url: '', size_bytes: size };
  console.log(`\nJSON (for signing):\n${JSON.stringify(contentObj, null, 2)}`);
}

// ========== Main Entry ==========
function main(): void {
  const args = parseArgs();
  const command = args._args[0];

  switch (command) {
    case 'manifest':
      cmdManifest(args._args[1], args);
      break;
    case 'verify-manifest':
      cmdVerifyManifest(args._args[1]);
      break;
    case 'hash':
      cmdHash(args._args[1]);
      break;
    case 'info':
      cmdInfo(args._args[1]);
      break;
    default:
      showHelp();
      break;
  }
}

main();

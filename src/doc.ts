#!/usr/bin/env node
/**
 * zCloak.ai Document Tool
 *
 * Provides MANIFEST.sha256 generation, verification, file hash computation, and more.
 * Pure Node.js implementation, cross-platform compatible, no external shell commands required.
 *
 * Usage:
 *   zcloak-social doc manifest <folder_path> [--version=1.0.0]    Generate MANIFEST.sha256 (with metadata header)
 *   zcloak-social doc verify-manifest <folder_path>               Verify file integrity in MANIFEST.sha256
 *   zcloak-social doc hash <file_path>                            Compute single file SHA256 hash
 *   zcloak-social doc info <file_path>                            Show file hash, size, MIME, etc.
 */

import fs from 'fs';
import path from 'path';
import {
  hashFile,
  getFileSize,
  getMimeType,
  generateManifest,
  verifyManifestEntries,
} from './utils';
import { Session } from './session';
import type { ParsedArgs } from './types/common';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Document Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-social doc manifest <folder_path> [--version=1.0.0]   Generate MANIFEST.sha256');
  console.log('  zcloak-social doc verify-manifest <folder_path>              Verify file integrity');
  console.log('  zcloak-social doc hash <file_path>                           Compute SHA256 hash');
  console.log('  zcloak-social doc info <file_path>                           Show file details');
  console.log('');
  console.log('Options:');
  console.log('  --version=x.y.z  MANIFEST version (default: 1.0.0)');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-social doc manifest ./my-skill/ --version=2.0.0');
  console.log('  zcloak-social doc verify-manifest ./my-skill/');
  console.log('  zcloak-social doc hash ./report.pdf');
  console.log('  zcloak-social doc info ./report.pdf');
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
 * Uses shared MANIFEST parser from utils.ts for consistent parsing and strict validation
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
  const results = verifyManifestEntries(manifestContent, folderPath);

  let allPassed = true;
  for (const r of results) {
    if (r.passed) {
      console.log(`OK: ${r.relativePath}`);
    } else {
      const suffix = r.reason === 'not_found' ? ' (file not found)' : '';
      console.log(`FAILED: ${r.relativePath}${suffix}`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    console.error(`\nVerification failed! Some files do not match (checked ${results.length} files)`);
    process.exit(1);
  }

  console.log(`\nAll files verified successfully! (${results.length} files)`);

  // Output MANIFEST hash (for subsequent on-chain verification)
  const manifestHash = hashFile(manifestPath);
  console.log(`\nMANIFEST SHA256: ${manifestHash}`);
  console.log('(Use this hash for on-chain signature verification: zcloak-social verify file MANIFEST.sha256)');
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

// ========== Exported run() — called by cli.ts ==========

/**
 * Entry point when invoked via cli.ts.
 * Receives a Session instance with pre-parsed arguments.
 *
 * Note: doc commands are pure local operations (no canister calls),
 * so Session is only used for argument parsing here.
 */
export function run(session: Session): void {
  const args = session.args;
  const command = args._args[0];

  try {
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
        if (command) {
          console.error(`\nUnknown command: ${command}`);
        }
        process.exit(1);
    }
  } catch (err) {
    console.error(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ========== Standalone Execution Guard ==========

if (require.main === module) {
  const session = new Session(process.argv);
  run(session);
}

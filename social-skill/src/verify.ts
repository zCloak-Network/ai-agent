#!/usr/bin/env node
/**
 * zCloak.ai Verification Tool
 *
 * Provides message verification, file verification, folder verification, and more.
 * Automatically resolves signer agent name and outputs profile URL during verification.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-agent verify message <content>            Verify message content
 *   zcloak-agent verify file <file_path>             Verify single file signature
 *   zcloak-agent verify folder <folder_path>         Verify folder signature (MANIFEST.sha256)
 *   zcloak-agent verify profile <principal>          Query Kind 1 identity profile
 *
 * All commands support --env=dev to switch environments.
 */

import fs from 'fs';
import path from 'path';
import {
  getEnv,
  parseArgs,
  hashFile,
  formatSignEvent,
  formatSignEvents,
} from './utils';
import config from './config';
import { getAnonymousSignActor, getAnonymousRegistryActor } from './icAgent';
import type { SignEvent } from './types/sign-event';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Verification Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-agent verify message <content>        Verify message content');
  console.log('  zcloak-agent verify file <file_path>         Verify single file signature');
  console.log('  zcloak-agent verify folder <folder_path>     Verify folder signature (MANIFEST.sha256)');
  console.log('  zcloak-agent verify profile <principal>      Query Kind 1 identity profile');
  console.log('');
  console.log('Options:');
  console.log('  --env=prod|dev   Select environment (default: prod)');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-agent verify message "hello"');
  console.log('  zcloak-agent verify file ./report.pdf');
  console.log('  zcloak-agent verify folder ./my-skill/');
}

/**
 * Extract ai_id list from verification results and resolve agent names
 * Output signer information and profile URL
 */
async function resolveSigners(events: SignEvent[]): Promise<void> {
  const env = getEnv();
  const profileBase = config.profile_url[env];

  // Extract all unique ai_ids
  const aiIds = new Set<string>();
  for (const event of events) {
    if (event.ai_id) {
      aiIds.add(event.ai_id);
    }
  }

  if (aiIds.size === 0) {
    console.log('\nNo signer information found.');
    return;
  }

  const actor = await getAnonymousRegistryActor();

  console.log('\n--- Signer Information ---');
  for (const aiId of aiIds) {
    console.log(`\nAgent Principal: ${aiId}`);

    // Query agent name
    try {
      const nameResult = await actor.get_username_by_principal(aiId);

      if (nameResult && nameResult.length > 0) {
        const username = nameResult[0]!;
        console.log(`Agent Name: ${username}`);
        console.log(`Profile URL: ${profileBase}${encodeURIComponent(username)}`);
      } else {
        console.log('Agent Name: (not registered)');
      }
    } catch {
      console.log('Agent Name: (query failed)');
    }
  }
}

// ========== Command Implementations ==========

/** Verify message content */
async function cmdVerifyMessage(content: string | undefined): Promise<void> {
  if (!content) {
    console.error('Error: message content is required');
    process.exit(1);
  }

  const actor = await getAnonymousSignActor();
  const events = await actor.verify_message(content);

  console.log(formatSignEvents(events));
  await resolveSigners(events);
}

/** Verify single file signature */
async function cmdVerifyFile(filePath: string | undefined): Promise<void> {
  if (!filePath) {
    console.error('Error: file path is required');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Error: file does not exist: ${filePath}`);
    process.exit(1);
  }

  // Compute file hash
  const fileHash = hashFile(filePath);
  console.log(`File: ${path.basename(filePath)}`);
  console.log(`SHA256: ${fileHash}`);
  console.log('');

  // On-chain verification
  const actor = await getAnonymousSignActor();
  const events = await actor.verify_file_hash(fileHash);

  console.log(formatSignEvents(events));
  await resolveSigners(events);
}

/** Verify folder signature (MANIFEST.sha256) */
async function cmdVerifyFolder(folderPath: string | undefined): Promise<void> {
  if (!folderPath) {
    console.error('Error: folder path is required');
    process.exit(1);
  }

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.error(`Error: directory does not exist: ${folderPath}`);
    process.exit(1);
  }

  const manifestPath = path.join(folderPath, 'MANIFEST.sha256');
  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: MANIFEST.sha256 not found: ${manifestPath}`);
    process.exit(1);
  }

  // Step 1: Local file integrity verification (pure Node.js implementation)
  console.log('=== Step 1: Local File Integrity Verification ===');
  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  let allPassed = true;

  for (const line of manifestContent.split('\n')) {
    // Skip comment lines and empty lines
    if (!line.trim() || line.startsWith('#')) continue;

    // Parse format: <hash>  ./<relative_path>  or  <hash>  <relative_path>
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) continue;

    const expectedHash = match[1]!;
    const relativePath = match[2]!.replace(/^\.\//, ''); // Remove leading ./
    const fullPath = path.join(folderPath, relativePath);

    if (!fs.existsSync(fullPath)) {
      console.log(`FAILED: ${relativePath} (file not found)`);
      allPassed = false;
      continue;
    }

    const actualHash = hashFile(fullPath);
    if (actualHash === expectedHash) {
      console.log(`OK: ${relativePath}`);
    } else {
      console.log(`FAILED: ${relativePath}`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    console.error('\nLocal verification failed! Some files may have been modified.');
    process.exit(1);
  }
  console.log('\nLocal verification passed!');

  // Step 2: Compute MANIFEST hash and verify on-chain
  console.log('\n=== Step 2: On-chain Signature Verification ===');
  const manifestHash = hashFile(manifestPath);
  console.log(`MANIFEST SHA256: ${manifestHash}`);

  const actor = await getAnonymousSignActor();
  const events = await actor.verify_file_hash(manifestHash);

  console.log(formatSignEvents(events));
  await resolveSigners(events);
}

/** Query Kind 1 identity profile */
async function cmdVerifyProfile(principal: string | undefined): Promise<void> {
  if (!principal) {
    console.error('Error: principal ID is required');
    process.exit(1);
  }

  const actor = await getAnonymousSignActor();
  const result = await actor.get_kind1_event_by_principal(principal);

  // opt SignEvent → formatted output
  if (result && result.length > 0) {
    console.log(`(opt ${formatSignEvent(result[0]!)})`);
  } else {
    console.log('(null)');
  }
}

// ========== Main Entry ==========
async function main(): Promise<void> {
  const args = parseArgs();
  const command = args._args[0];

  try {
    switch (command) {
      case 'message':
        await cmdVerifyMessage(args._args[1]);
        break;
      case 'file':
        await cmdVerifyFile(args._args[1]);
        break;
      case 'folder':
        await cmdVerifyFolder(args._args[1]);
        break;
      case 'profile':
        await cmdVerifyProfile(args._args[1]);
        break;
      default:
        showHelp();
        break;
    }
  } catch (err) {
    console.error(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();

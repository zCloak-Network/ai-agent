#!/usr/bin/env node
/**
 * zCloak.ai Verification Tool
 *
 * Provides message verification, file verification, folder verification, and more.
 * Automatically resolves signer agent name and outputs profile URL during verification.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-ai verify message <content>            Verify message content
 *   zcloak-ai verify file <file_path>             Verify single file signature
 *   zcloak-ai verify folder <folder_path>         Verify folder signature (MANIFEST.md)
 *   zcloak-ai verify profile <principal>          Query Kind 1 identity profile
 *
 * All commands support --identity=<pem_path> to specify identity file.
 */

import fs from 'fs';
import path from 'path';
import {
  hashFile,
  verifyManifestEntries,
  formatSignEvent,
  formatSignEvents,
} from './utils.js';
import { Session } from './session.js';
import type { SignEvent } from './types/sign-event.js';
import * as log from './log.js';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Verification Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai verify message <content>        Verify message content');
  console.log('  zcloak-ai verify file <file_path>         Verify single file signature');
  console.log('  zcloak-ai verify folder <folder_path>     Verify folder signature (MANIFEST.md)');
  console.log('  zcloak-ai verify profile <principal>      Query Kind 1 identity profile');
  console.log('');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai verify message "hello"');
  console.log('  zcloak-ai verify file ./report.pdf');
  console.log('  zcloak-ai verify folder ./my-skill/');
}

/**
 * Extract ai_id list from verification results and resolve agent names
 * Output signer information and profile URL
 */
async function resolveSigners(session: Session, events: SignEvent[]): Promise<void> {
  const profileBase = session.getProfileUrl();

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

  const actor = await session.getAnonymousRegistryActor();

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
async function cmdVerifyMessage(session: Session, content: string | undefined): Promise<void> {
  if (!content) {
    console.error('Error: message content is required');
    process.exit(1);
  }

  const actor = await session.getAnonymousSignActor();
  const events = await actor.verify_message(content);

  console.log(formatSignEvents(events));
  await resolveSigners(session, events);
}

/** Verify single file signature */
async function cmdVerifyFile(session: Session, filePath: string | undefined): Promise<void> {
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
  const actor = await session.getAnonymousSignActor();
  const events = await actor.verify_file_hash(fileHash);

  console.log(formatSignEvents(events));
  await resolveSigners(session, events);
}

/** Verify folder signature (MANIFEST.md) */
async function cmdVerifyFolder(session: Session, folderPath: string | undefined): Promise<void> {
  if (!folderPath) {
    console.error('Error: folder path is required');
    process.exit(1);
  }

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.error(`Error: directory does not exist: ${folderPath}`);
    process.exit(1);
  }

  const manifestPath = path.join(folderPath, 'MANIFEST.md');
  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: MANIFEST.md not found: ${manifestPath}`);
    process.exit(1);
  }

  // Step 1: Local file integrity verification using shared MANIFEST parser
  console.log('=== Step 1: Local File Integrity Verification ===');
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
    log.error('Local verification failed! Some files may have been modified.');
    process.exit(1);
  }
  console.log('\nLocal verification passed!');

  // Step 2: Compute MANIFEST hash and verify on-chain
  console.log('\n=== Step 2: On-chain Signature Verification ===');
  const manifestHash = hashFile(manifestPath);
  console.log(`MANIFEST SHA256: ${manifestHash}`);

  const actor = await session.getAnonymousSignActor();
  const events = await actor.verify_file_hash(manifestHash);

  console.log(formatSignEvents(events));
  await resolveSigners(session, events);
}

/** Query Kind 1 identity profile */
async function cmdVerifyProfile(session: Session, principal: string | undefined): Promise<void> {
  if (!principal) {
    console.error('Error: principal ID is required');
    process.exit(1);
  }

  const actor = await session.getAnonymousSignActor();
  const result = await actor.get_kind1_event_by_principal(principal);

  // opt SignEvent → formatted output
  if (result && result.length > 0) {
    console.log(`(opt ${formatSignEvent(result[0]!)})`);
  } else {
    console.log('(null)');
  }
}

// ========== Exported run() — called by cli.ts ==========

/**
 * Entry point when invoked via cli.ts.
 * Receives a Session instance with pre-parsed arguments.
 */
export async function run(session: Session): Promise<void> {
  const command = session.args._args[0];

  try {
    switch (command) {
      case 'message':
        await cmdVerifyMessage(session, session.args._args[1]);
        break;
      case 'file':
        await cmdVerifyFile(session, session.args._args[1]);
        break;
      case 'folder':
        await cmdVerifyFolder(session, session.args._args[1]);
        break;
      case 'profile':
        await cmdVerifyProfile(session, session.args._args[1]);
        break;
      default:
        showHelp();
        if (command) {
          console.error(`\nUnknown command: ${command}`);
        }
        process.exit(1);
    }
  } catch (err) {
    log.error(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

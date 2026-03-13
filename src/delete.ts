#!/usr/bin/env node
/**
 * zCloak.ai File Deletion with 2FA Verification Tool
 *
 * Implements secure file deletion requiring 2FA (WebAuthn passkey) authorization.
 * The deletion flow: prepare → user authenticates via browser → confirm & delete.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-ai delete prepare <file_path>                Prepare 2FA request and generate authentication URL
 *   zcloak-ai delete check <challenge>                  Check 2FA verification status
 *   zcloak-ai delete confirm <challenge> <file_path>    Confirm 2FA and delete file if authorized
 *
 * All commands support --identity=<pem_path> to specify identity file.
 */

import fs from 'fs';
import path from 'path';
import { Session } from './session.js';
import * as log from './log.js';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai File Deletion with 2FA Verification Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai delete prepare <file_path>                Prepare 2FA request and generate auth URL');
  console.log('  zcloak-ai delete check <challenge>                  Check 2FA verification status');
  console.log('  zcloak-ai delete confirm <challenge> <file_path>    Confirm 2FA and delete file');
  console.log('');
  console.log('Options:');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('');
  console.log('Flow:');
  console.log('  1. Run `delete prepare <file>` to get a 2FA challenge and authentication URL');
  console.log('  2. Open the URL in your browser and complete passkey authentication');
  console.log('  3. Run `delete confirm <challenge> <file>` to verify 2FA and delete the file');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai delete prepare ./report.pdf');
  console.log('  zcloak-ai delete check "abc123..."');
  console.log('  zcloak-ai delete confirm "abc123..." ./report.pdf');
}

// ========== Command Implementations ==========

/**
 * Prepare 2FA request for file deletion.
 * Builds a JSON payload with file info, calls prepare_2fa_info on the canister,
 * extracts the challenge, and generates a browser authentication URL.
 */
async function cmdPrepare(session: Session, filePath: string | undefined): Promise<void> {
  if (!filePath) {
    console.error('Error: file path is required');
    console.error('Usage: zcloak-ai delete prepare <file_path>');
    process.exit(1);
  }

  // Resolve and verify the file exists
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: file not found: ${resolvedPath}`);
    process.exit(1);
  }

  // Gather file information
  const fileName = path.basename(resolvedPath);
  const fileStats = fs.statSync(resolvedPath);
  const fileSize = fileStats.size;
  const requestTimestamp = Math.floor(Date.now() / 1000);  // Unix timestamp in seconds

  // Build the deletion info JSON payload
  const deleteInfo = JSON.stringify({
    operation: 'delete',
    file_name: fileName,
    file_size: fileSize,
    request_timestamp: requestTimestamp,
  });

  log.info(`File: ${fileName} (${fileSize} bytes)`);
  log.info('Calling prepare_2fa_info...');

  // Call prepare_2fa_info (update call, requires identity)
  const actor = await session.getRegistryActor();
  const result = await actor.prepare_2fa_info(deleteInfo);

  // Check return result — variant { Ok: text } | { Err: text }
  if ('Err' in result) {
    log.error('2FA preparation failed:');
    console.log(`(variant { Err = "${result.Err}" })`);
    process.exit(1);
  }

  // The returned Ok value is the challenge string (strip surrounding quotes if canister returns them)
  const challenge = result.Ok.replace(/^"|"$/g, '');

  // Build the 2FA authentication URL
  const url = `https://id.zcloak.ai/agent/2fa?challenge=${challenge}`;

  // Output challenge for subsequent check/confirm commands
  console.log('');
  console.log('=== 2FA Challenge ===');
  console.log('');
  console.log(challenge);

  // Output authentication URL
  console.log('');
  console.log('=== 2FA Authentication URL ===');
  console.log('');
  console.log(url);
  console.log('');
  console.log('Please open the URL above in your browser and use your passkey to authorize the file deletion.');
  console.log('');
  console.log('After completing authentication, run:');
  console.log(`  zcloak-ai delete confirm "${challenge}" "${filePath}"`);
}

/**
 * Check 2FA verification status by challenge string.
 * Queries the canister to see if the 2FA has been confirmed.
 */
async function cmdCheck(session: Session, challenge: string | undefined): Promise<void> {
  if (!challenge) {
    console.error('Error: challenge string is required');
    console.error('Usage: zcloak-ai delete check <challenge>');
    process.exit(1);
  }

  log.info('Querying 2FA result...');

  // Query 2FA result (query call, can use anonymous actor)
  const actor = await session.getAnonymousRegistryActor();
  const result = await actor.query_2fa_result_by_challenge(challenge);

  // opt TwoFARecord — empty array means no record found
  if (!result || result.length === 0) {
    console.log('Status: not found');
    console.log('No 2FA record found for this challenge. The challenge may be invalid or expired.');
    return;
  }

  const record = result[0]!;
  // Check confirm_timestamp — CandidOpt: [] means pending, [timestamp] means confirmed
  const isConfirmed = record.confirm_timestamp.length > 0;

  console.log(`Status: ${isConfirmed ? 'confirmed' : 'pending'}`);
  console.log(`Caller: ${record.caller}`);
  console.log(`Owners: ${record.owner_list.join(', ')}`);
  if (isConfirmed) {
    console.log(`Confirmed by: ${record.confirm_owner.length > 0 ? record.confirm_owner[0] : 'unknown'}`);
    console.log(`Confirmed at: ${record.confirm_timestamp[0]!.toString()}`);
  } else {
    console.log('');
    console.log('The 2FA has not been confirmed yet. Please complete passkey authentication first.');
  }
}

/**
 * Confirm 2FA and delete the file.
 * Queries the 2FA result, and if confirmed, deletes the specified file.
 */
async function cmdConfirm(
  session: Session,
  challenge: string | undefined,
  filePath: string | undefined,
): Promise<void> {
  if (!challenge || !filePath) {
    console.error('Error: both challenge and file path are required');
    console.error('Usage: zcloak-ai delete confirm <challenge> <file_path>');
    process.exit(1);
  }

  // Resolve and verify the file exists
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: file not found: ${resolvedPath}`);
    process.exit(1);
  }

  log.info('Querying 2FA result...');

  // Query 2FA result (query call, can use anonymous actor)
  const actor = await session.getAnonymousRegistryActor();
  const result = await actor.query_2fa_result_by_challenge(challenge);

  // opt TwoFARecord — empty array means no record found
  if (!result || result.length === 0) {
    console.error('Error: no 2FA record found for this challenge.');
    console.error('The challenge may be invalid or expired.');
    process.exit(1);
  }

  const record = result[0]!;
  // Check confirm_timestamp — CandidOpt: [] means pending, [timestamp] means confirmed
  const isConfirmed = record.confirm_timestamp.length > 0;

  if (!isConfirmed) {
    console.error('Error: 2FA has not been confirmed yet.');
    console.error('Please complete passkey authentication in your browser first.');
    process.exit(1);
  }

  // 2FA confirmed — proceed with file deletion
  const fileName = path.basename(resolvedPath);
  log.info(`2FA confirmed. Deleting file: ${fileName}`);

  fs.unlinkSync(resolvedPath);

  console.log(`File "${fileName}" deleted successfully.`);
  console.log(`Confirmed by: ${record.confirm_owner.length > 0 ? record.confirm_owner[0] : 'unknown'}`);
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
      case 'prepare':
        await cmdPrepare(session, session.args._args[1]);
        break;
      case 'check':
        await cmdCheck(session, session.args._args[1]);
        break;
      case 'confirm':
        await cmdConfirm(session, session.args._args[1], session.args._args[2]);
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

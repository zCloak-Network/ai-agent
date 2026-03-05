#!/usr/bin/env node
/**
 * zCloak.ai Agent-Owner Binding Tool
 *
 * Executes the agent-owner WebAuthn/passkey binding flow.
 * Automatically calls agent_prepare_bond and generates browser authentication URL.
 * Includes passkey pre-check to ensure the target user has a registered passkey.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-ai bind prepare <user_principal>         Prepare binding and generate authentication URL
 *   zcloak-ai bind check-passkey <user_principal>   Check if a principal has a registered passkey
 *
 * All commands support --identity=<pem_path> to specify identity file.
 */

import { Session } from './session.js';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Agent-Owner Binding Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai bind prepare <user_principal>         Prepare binding and generate authentication URL');
  console.log('  zcloak-ai bind check-passkey <user_principal>   Check if a principal has a registered passkey');
  console.log('');
  console.log('Options:');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('');
  console.log('Flow:');
  console.log('  1. Script checks if target principal has a registered passkey (pre-check)');
  console.log('  2. Script calls agent_prepare_bond to get WebAuthn challenge');
  console.log('  3. Script generates authentication URL');
  console.log('  4. User opens the URL in browser and completes authentication with passkey');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai bind prepare "57odc-ymip7-b7edu-aevpq-nu54m-q4paq-vsrtd-nlnmm-lkos3-d4h3t-7qe"');
  console.log('  zcloak-ai bind check-passkey "57odc-ymip7-b7edu-aevpq-nu54m-q4paq-vsrtd-nlnmm-lkos3-d4h3t-7qe"');
}

// ========== Passkey Pre-check Helper ==========

/**
 * Check if a principal has a registered passkey via user_profile_get_by_principal.
 * Returns true if the user has at least one passkey, false otherwise.
 * Throws if the principal is not found in the registry.
 */
async function hasPasskey(session: Session, userPrincipal: string): Promise<boolean> {
  const actor = await session.getAnonymousRegistryActor();
  const profile = await actor.user_profile_get_by_principal(userPrincipal);

  // opt UserProfile — empty array means no profile found
  if (!profile || profile.length === 0) {
    throw new Error(`No user profile found for principal: ${userPrincipal}`);
  }

  const user = profile[0]!;
  // passkey_name is a vec text — empty vec means no passkey registered
  return user.passkey_name.length > 0;
}

// ========== Command Implementations ==========

/** Check if a principal has a registered passkey (standalone command) */
async function cmdCheckPasskey(session: Session, userPrincipal: string | undefined): Promise<void> {
  if (!userPrincipal) {
    console.error('Error: user principal ID is required');
    console.error('Usage: zcloak-ai bind check-passkey <user_principal>');
    process.exit(1);
  }

  console.error('Checking passkey status...');
  const result = await hasPasskey(session, userPrincipal);

  if (result) {
    console.log('Passkey registered: yes');
    console.log('This principal is ready for agent binding.');
  } else {
    console.log('Passkey registered: no');
    console.log('');
    console.log('This principal was created via OAuth and has no passkey yet.');
    console.log(`Please go to ${session.getSettingUrl()} and bind a passkey first.`);
  }
}

/** Prepare binding and generate authentication URL */
async function cmdPrepare(session: Session, userPrincipal: string | undefined): Promise<void> {
  if (!userPrincipal) {
    console.error('Error: user principal ID is required');
    console.error('Usage: zcloak-ai bind prepare <user_principal>');
    process.exit(1);
  }

  // Pre-check: ensure the target principal has a passkey before proceeding
  console.error('Pre-check: verifying passkey status...');
  const passkeyOk = await hasPasskey(session, userPrincipal);
  if (!passkeyOk) {
    console.error('Error: target principal has no passkey registered.');
    console.error('This principal was created via OAuth and has no passkey yet.');
    console.error(`Please go to ${session.getSettingUrl()} and bind a passkey for this user first.`);
    process.exit(1);
  }
  console.error('Pre-check passed: passkey found.');

  const bindBase = session.getBindUrl();

  // Step 1: Call agent_prepare_bond (requires identity, update call)
  console.error('Calling agent_prepare_bond...');
  const actor = await session.getRegistryActor();
  const result = await actor.agent_prepare_bond(userPrincipal);

  // Check return result — variant { Ok: text } | { Err: text }
  if ('Err' in result) {
    console.error('Binding preparation failed:');
    console.log(`(variant { Err = "${result.Err}" })`);
    process.exit(1);
  }

  // Step 2: Extract JSON and generate URL
  const authContent = result.Ok;

  // Step 3: Build URL
  const url = `${bindBase}?auth_content=${encodeURIComponent(authContent)}`;

  console.log('');
  console.log('=== Binding Authentication URL ===');
  console.log('');
  console.log(url);
  console.log('');
  console.log('Please open the URL above in your browser and complete authentication with passkey.');
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
      case 'check-passkey':
        await cmdCheckPasskey(session, session.args._args[1]);
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

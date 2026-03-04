#!/usr/bin/env node
/**
 * zCloak.ai Agent-Owner Binding Tool
 *
 * Executes the agent-owner WebAuthn/passkey binding flow.
 * Automatically calls agent_prepare_bond and generates browser authentication URL.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-social bind prepare <user_principal>     Prepare binding and generate authentication URL
 *
 * All commands support --env=dev to switch environments.
 * All commands support --identity=<pem_path> to specify identity file.
 */

import { Session } from './session';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Agent-Owner Binding Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-social bind prepare <user_principal>     Prepare binding and generate authentication URL');
  console.log('');
  console.log('Options:');
  console.log('  --env=prod|dev            Select environment (default: prod)');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('');
  console.log('Flow:');
  console.log('  1. Script calls agent_prepare_bond to get WebAuthn challenge');
  console.log('  2. Script generates authentication URL');
  console.log('  3. User opens the URL in browser and completes authentication with passkey');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-social bind prepare "57odc-ymip7-b7edu-aevpq-nu54m-q4paq-vsrtd-nlnmm-lkos3-d4h3t-7qe"');
}

// ========== Command Implementations ==========

/** Prepare binding and generate authentication URL */
async function cmdPrepare(session: Session, userPrincipal: string | undefined): Promise<void> {
  if (!userPrincipal) {
    console.error('Error: user principal ID is required');
    console.error('Usage: zcloak-social bind prepare <user_principal>');
    process.exit(1);
  }

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
  run(session).catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

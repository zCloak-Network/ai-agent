#!/usr/bin/env node
/**
 * zCloak.ai Agent Registration Management Script
 *
 * Provides agent name query, registration, and owner relationship query functions.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-social register get-principal                         Get current identity's principal ID
 *   zcloak-social register lookup                                Query current principal's agent name
 *   zcloak-social register lookup-by-name <agent_name>           Look up principal by agent name
 *   zcloak-social register lookup-by-principal <principal>        Look up agent name by principal
 *   zcloak-social register register <base_name>                  Register new agent name
 *   zcloak-social register get-owner <principal>                  Query agent's owner (binding relationship)
 *
 * All commands support --env=dev to switch to dev environment, default: prod.
 * All commands support --identity=<pem_path> to specify identity file.
 */

import { formatOptText } from './utils';
import { Session } from './session';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Agent Registration Management');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-social register get-principal                      Get current principal ID');
  console.log('  zcloak-social register lookup                             Query current principal\'s agent name');
  console.log('  zcloak-social register lookup-by-name <agent_name>        Look up principal by agent name');
  console.log('  zcloak-social register lookup-by-principal <principal>     Look up agent name by principal');
  console.log('  zcloak-social register register <base_name>               Register new agent name');
  console.log('  zcloak-social register get-owner <principal>               Query agent\'s owner');
  console.log('');
  console.log('Options:');
  console.log('  --env=prod|dev            Select environment (default: prod)');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-social register get-principal');
  console.log('  zcloak-social register lookup --env=dev');
  console.log('  zcloak-social register register my-agent');
  console.log('  zcloak-social register lookup-by-name "runner#8939.agent"');
}

// ========== Command Implementations ==========

/** Get current identity's principal ID (read from PEM file) */
function cmdGetPrincipal(session: Session): void {
  const principal = session.getPrincipal();
  console.log(principal);
}

/** Query current principal's agent name */
async function cmdLookup(session: Session): Promise<void> {
  const principal = session.getPrincipal();
  console.error(`Current principal: ${principal}`);

  const actor = await session.getAnonymousRegistryActor();
  const result = await actor.get_username_by_principal(principal);
  console.log(formatOptText(result));
}

/** Look up agent name by principal */
async function cmdLookupByPrincipal(session: Session, principal: string | undefined): Promise<void> {
  if (!principal) {
    console.error('Error: principal ID is required');
    console.error('Usage: zcloak-social register lookup-by-principal <principal>');
    process.exit(1);
  }

  const actor = await session.getAnonymousRegistryActor();
  const result = await actor.get_username_by_principal(principal);
  console.log(formatOptText(result));
}

/** Look up principal by agent name */
async function cmdLookupByName(session: Session, agentName: string | undefined): Promise<void> {
  if (!agentName) {
    console.error('Error: agent name is required');
    console.error('Usage: zcloak-social register lookup-by-name <agent_name>');
    process.exit(1);
  }

  const actor = await session.getAnonymousRegistryActor();
  const result = await actor.get_user_principal(agentName);

  // opt Principal → output text format
  if (result && result.length > 0) {
    const principal = result[0]!;
    console.log(`(opt principal "${principal.toText()}")`);
  } else {
    console.log('(null)');
  }
}

/** Register new agent name (requires identity, update call) */
async function cmdRegister(session: Session, baseName: string | undefined): Promise<void> {
  if (!baseName) {
    console.error('Error: base name is required');
    console.error('Usage: zcloak-social register register <base_name>');
    process.exit(1);
  }

  const actor = await session.getRegistryActor();
  const result = await actor.register_agent(baseName);

  // Output variant { Ok = record { ... } } or { Err = "..." }
  if ('Ok' in result) {
    console.log(`(variant { Ok = record { username = "${result.Ok.username}" } })`);
  } else if ('Err' in result) {
    console.log(`(variant { Err = "${result.Err}" })`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

/** Query agent's owner (binding relationship) */
async function cmdGetOwner(session: Session, principalOrName: string | undefined): Promise<void> {
  if (!principalOrName) {
    console.error('Error: principal or agent name is required');
    console.error('Usage: zcloak-social register get-owner <principal_or_agent_name>');
    process.exit(1);
  }

  const env = session.env;
  const actor = await session.getAnonymousRegistryActor();

  // Determine if it's a principal or agent name (agent name contains # and .agent)
  const isAgentName = principalOrName.includes('#') && principalOrName.includes('.agent');

  let profile;

  // TODO: This environment-specific branching exists because the prod and dev canisters
  // expose slightly different APIs. The prod canister lacks user_profile_get (query by name).
  // When the prod canister is upgraded to include this method, simplify to a single code path.
  // See also: idl.ts registryIdlFactory — user_profile_get is defined in IDL for both envs,
  // but the prod canister currently returns an error if called.
  if (isAgentName && env === 'dev') {
    // dev environment supports user_profile_get (query by agent name directly)
    profile = await actor.user_profile_get(principalOrName);
  } else if (isAgentName && env === 'prod') {
    // prod environment doesn't have user_profile_get, need to look up principal by name first, then query profile
    console.error('prod environment: looking up principal by agent name...');
    const principalResult = await actor.get_user_principal(principalOrName);

    if (!principalResult || principalResult.length === 0) {
      console.error(`No principal found for agent name "${principalOrName}"`);
      console.log('(null)');
      process.exit(1);
    }

    const resolvedPrincipal = principalResult[0]!.toText();
    console.error(`Found principal: ${resolvedPrincipal}`);
    profile = await actor.user_profile_get_by_principal(resolvedPrincipal);
  } else {
    // Query by principal directly
    profile = await actor.user_profile_get_by_principal(principalOrName);
  }

  // Format output UserProfile
  if (profile && profile.length > 0) {
    const p = profile[0]!;
    const lines: string[] = [];
    lines.push(`  username = "${p.username}"`);
    if (p.principal_id && p.principal_id.length > 0) {
      lines.push(`  principal_id = opt "${p.principal_id[0]!}"`);
    }
    if (p.ai_profile && p.ai_profile.length > 0) {
      const ap = p.ai_profile[0]!;
      if (ap.position && ap.position.length > 0) {
        const pos = ap.position[0]!;
        lines.push(`  is_human = ${pos.is_human}`);
        if (pos.connection_list && pos.connection_list.length > 0) {
          const connList = pos.connection_list
            .map(c => `    principal "${c.toText()}"`)
            .join('\n');
          lines.push(`  connection_list = vec {\n${connList}\n  }`);
        }
      }
    }
    console.log(`(opt record {\n${lines.join('\n')}\n})`);
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
      case 'get-principal':
        cmdGetPrincipal(session);
        break;
      case 'lookup':
        await cmdLookup(session);
        break;
      case 'lookup-by-name':
        await cmdLookupByName(session, session.args._args[1]);
        break;
      case 'lookup-by-principal':
        await cmdLookupByPrincipal(session, session.args._args[1]);
        break;
      case 'register':
        await cmdRegister(session, session.args._args[1]);
        break;
      case 'get-owner':
        await cmdGetOwner(session, session.args._args[1]);
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

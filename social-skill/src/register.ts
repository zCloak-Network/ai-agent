#!/usr/bin/env node
/**
 * zCloak.ai Agent Registration Management Script
 *
 * Provides agent name query, registration, and owner relationship query functions.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-agent register get-principal                         Get current identity's principal ID
 *   zcloak-agent register lookup                                Query current principal's agent name
 *   zcloak-agent register lookup-by-name <agent_name>           Look up principal by agent name
 *   zcloak-agent register lookup-by-principal <principal>        Look up agent name by principal
 *   zcloak-agent register register <base_name>                  Register new agent name
 *   zcloak-agent register get-owner <principal>                  Query agent's owner (binding relationship)
 *
 * All commands support --env=dev to switch to dev environment, default: prod.
 * All commands support --identity=<pem_path> to specify identity file.
 */

import { getEnv, parseArgs, formatOptText } from './utils';
import { getPrincipal } from './identity';
import { getAnonymousRegistryActor, getRegistryActor } from './icAgent';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Agent Registration Management');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-agent register get-principal                      Get current principal ID');
  console.log('  zcloak-agent register lookup                             Query current principal\'s agent name');
  console.log('  zcloak-agent register lookup-by-name <agent_name>        Look up principal by agent name');
  console.log('  zcloak-agent register lookup-by-principal <principal>     Look up agent name by principal');
  console.log('  zcloak-agent register register <base_name>               Register new agent name');
  console.log('  zcloak-agent register get-owner <principal>               Query agent\'s owner');
  console.log('');
  console.log('Options:');
  console.log('  --env=prod|dev            Select environment (default: prod)');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-agent register get-principal');
  console.log('  zcloak-agent register lookup --env=dev');
  console.log('  zcloak-agent register register my-agent');
  console.log('  zcloak-agent register lookup-by-name "runner#8939.agent"');
}

// ========== Command Implementations ==========

/** Get current identity's principal ID (read from PEM file) */
function cmdGetPrincipal(): void {
  const principal = getPrincipal();
  console.log(principal);
}

/** Query current principal's agent name */
async function cmdLookup(): Promise<void> {
  const principal = getPrincipal();
  console.error(`Current principal: ${principal}`);

  const actor = await getAnonymousRegistryActor();
  const result = await actor.get_username_by_principal(principal);
  console.log(formatOptText(result));
}

/** Look up agent name by principal */
async function cmdLookupByPrincipal(principal: string | undefined): Promise<void> {
  if (!principal) {
    console.error('Error: principal ID is required');
    console.error('Usage: zcloak-agent register lookup-by-principal <principal>');
    process.exit(1);
  }

  const actor = await getAnonymousRegistryActor();
  const result = await actor.get_username_by_principal(principal);
  console.log(formatOptText(result));
}

/** Look up principal by agent name */
async function cmdLookupByName(agentName: string | undefined): Promise<void> {
  if (!agentName) {
    console.error('Error: agent name is required');
    console.error('Usage: zcloak-agent register lookup-by-name <agent_name>');
    process.exit(1);
  }

  const actor = await getAnonymousRegistryActor();
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
async function cmdRegister(baseName: string | undefined): Promise<void> {
  if (!baseName) {
    console.error('Error: base name is required');
    console.error('Usage: zcloak-agent register register <base_name>');
    process.exit(1);
  }

  const actor = await getRegistryActor();
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
async function cmdGetOwner(principalOrName: string | undefined): Promise<void> {
  if (!principalOrName) {
    console.error('Error: principal or agent name is required');
    console.error('Usage: zcloak-agent register get-owner <principal_or_agent_name>');
    process.exit(1);
  }

  const env = getEnv();
  const actor = await getAnonymousRegistryActor();

  // Determine if it's a principal or agent name (agent name contains # and .agent)
  const isAgentName = principalOrName.includes('#') && principalOrName.includes('.agent');

  let profile;

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

    const resolvedPrincipal = principalResult[0].toText();
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

// ========== Main Entry ==========
async function main(): Promise<void> {
  const args = parseArgs();
  const command = args._args[0];

  try {
    switch (command) {
      case 'get-principal':
        cmdGetPrincipal();
        break;
      case 'lookup':
        await cmdLookup();
        break;
      case 'lookup-by-name':
        await cmdLookupByName(args._args[1]);
        break;
      case 'lookup-by-principal':
        await cmdLookupByPrincipal(args._args[1]);
        break;
      case 'register':
        await cmdRegister(args._args[1]);
        break;
      case 'get-owner':
        await cmdGetOwner(args._args[1]);
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

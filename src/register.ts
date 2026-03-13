#!/usr/bin/env node
/**
 * zCloak.ai Agent Registration Management Script
 *
 * Provides agent name query, registration, and owner relationship query functions.
 * Uses @dfinity JS SDK to interact directly with ICP canister, no dfx required.
 *
 * Usage:
 *   zcloak-ai register get-principal                         Get current identity's principal ID
 *   zcloak-ai register lookup                                Query current principal's agent name
 *   zcloak-ai register lookup-by-name <agent_name>           Look up principal by agent name
 *   zcloak-ai register lookup-by-principal <principal>        Look up agent name by principal
 *   zcloak-ai register register <base_name>                  Register new agent name
 *   zcloak-ai register get-owner <principal>                  Query agent's owner (binding relationship)
 *
 * All commands support --identity=<pem_path> to specify identity file.
 */

import { getProfileUrl } from './utils.js';
import { Session } from './session.js';
import { generalParseAiIdToRecord, isReadableId } from './aiid.js';
import * as log from './log.js';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Agent Registration Management');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai register get-principal                      Get current principal ID');
  console.log('  zcloak-ai register lookup                             Query current principal\'s agent name');
  console.log('  zcloak-ai register lookup-by-name <agent_name>        Look up principal by agent name');
  console.log('  zcloak-ai register lookup-by-principal <principal>     Look up agent name by principal');
  console.log('  zcloak-ai register register <base_name>               Register new agent name');
  console.log('  zcloak-ai register get-owner <principal>               Query agent\'s owner');
  console.log('');
  console.log('Options:');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai register get-principal');
  console.log('  zcloak-ai register register my-agent');
  console.log('  zcloak-ai register lookup-by-name "runner#8939.agent"');
}

// ========== Helpers ==========

/**
 * Format a Candid ID record { id, index, domain } into a readable AI ID string.
 * e.g. { id:"francis", index:[1012n], domain:[{AGENT:null}] } → "francis#1012.agent"
 *      { id:"alice",   index:[],     domain:[{AI:null}]    } → "alice.ai"
 */
function formatIdRecord(idRecord: {
  id: string;
  index: [] | [bigint];
  domain: [] | [{ AI: null } | { ORG: null } | { AGENT: null }];
}): string {
  let text = idRecord.id;
  if (idRecord.index && idRecord.index.length > 0) {
    text += `#${idRecord.index[0]!.toString()}`;
  }
  if (idRecord.domain && idRecord.domain.length > 0) {
    const d = idRecord.domain[0]!;
    if ('AI' in d)    text += '.ai';
    else if ('ORG' in d)   text += '.org';
    else if ('AGENT' in d) text += '.agent';
  }
  return text;
}

/**
 * Extract the best AI ID string from a UserProfile.
 * Priority: ai_profile.ai_name → ai_profile.default_name → null
 */
function extractAiIdFromProfile(profile: {
  ai_profile: [] | [{ ai_name: [] | [any]; default_name: [] | [any] }];
}): string | null {
  if (!profile.ai_profile || profile.ai_profile.length === 0) return null;
  const ap = profile.ai_profile[0]!;
  const idRecord =
    ap.ai_name && ap.ai_name.length > 0
      ? ap.ai_name[0]!
      : ap.default_name && ap.default_name.length > 0
        ? ap.default_name[0]!
        : null;
  return idRecord ? formatIdRecord(idRecord) : null;
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
  log.info(`Current principal: ${principal}`);

  const actor = await session.getAnonymousRegistryActor();
  const result = await actor.user_profile_get_by_principal(principal);

  if (!result || result.length === 0) {
    console.log('(null)');
    return;
  }

  const aiId = extractAiIdFromProfile(result[0]!);
  if (aiId) {
    console.log(`(opt "${aiId}")`);
    console.log(`View profile: ${getProfileUrl(aiId)}`);
  } else {
    console.log('(null)');
  }
}

/** Look up agent name by principal */
async function cmdLookupByPrincipal(session: Session, principal: string | undefined): Promise<void> {
  if (!principal) {
    console.error('Error: principal ID is required');
    console.error('Usage: zcloak-ai register lookup-by-principal <principal>');
    process.exit(1);
  }

  const actor = await session.getAnonymousRegistryActor();
  // Use user_profile_get_by_principal to get full profile, then extract AI ID from ai_profile
  const result = await actor.user_profile_get_by_principal(principal);

  if (!result || result.length === 0) {
    console.log('(null)');
    return;
  }

  // Prefer ai_name over default_name; format as id[#index].domain
  const aiId = extractAiIdFromProfile(result[0]!);
  if (aiId) {
    console.log(`(opt "${aiId}")`);
    console.log(`View profile: ${getProfileUrl(aiId)}`);
  } else {
    console.log('(null)');
  }
}

/** Look up principal by readable name (.ai / .agent) or legacy agent name */
async function cmdLookupByName(session: Session, name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Error: name is required');
    console.error('Usage: zcloak-ai register lookup-by-name <ai_or_agent_name>');
    process.exit(1);
  }

  const actor = await session.getAnonymousRegistryActor();
  const input = name;

  // Preferred path for readable IDs: unified structure id_string[#index].ai|.agent
  if (isReadableId(input)) {
    try {
      const idRecord = generalParseAiIdToRecord(input);
      const profile = await actor.user_profile_get_by_id(idRecord as any);

      if (profile && profile.length > 0) {
        const p = profile[0]!;
        if (p.principal_id && p.principal_id.length > 0) {
          const principalText = p.principal_id[0]!;
          console.log(`(opt principal "${principalText}")`);
          return;
        }
      }
    } catch {
      // Fall through to legacy path below if parsing fails
    }
  }

  // Legacy/compat path: use register canister mapping by username string
  const result = await actor.get_user_principal(input);
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
    console.error('Usage: zcloak-ai register register <base_name>');
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
    console.error('Usage: zcloak-ai register get-owner <principal_or_agent_name>');
    process.exit(1);
  }

  const actor = await session.getAnonymousRegistryActor();

  // Determine if it's a principal or agent name (agent name contains # and .agent)
  const isAgentName = principalOrName.includes('#') && principalOrName.includes('.agent');

  let profile;

  if (isAgentName) {
    // Query by agent name directly via user_profile_get
    profile = await actor.user_profile_get(principalOrName);
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
            .map((c: { toText(): string }) => `    principal "${c.toText()}"`)
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
    log.error(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

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

/**
 * Query agent's owner / connection list via the zCloak REST API.
 *
 * Routing:
 *   - Input ends with ".agent"  → GET /api/ai-name/connections?name=<input>
 *   - Otherwise (principal ID)  → GET /api/ai-name/connections?pid=<input>
 *
 * Response shape:
 *   { code: 200, data: { source, query, is_human, connectionPids: string[] } }
 */
async function cmdGetOwner(_session: Session, principalOrName: string | undefined): Promise<void> {
  if (!principalOrName) {
    console.error('Error: principal or agent name is required');
    console.error('Usage: zcloak-ai register get-owner <principal_or_agent_name>');
    process.exit(1);
  }

  const BASE = 'https://service.zcloak.ai/api/ai-name/connections';
  const isAgentName = principalOrName.endsWith('.agent');
  const url = isAgentName
    ? `${BASE}?name=${encodeURIComponent(principalOrName)}`
    : `${BASE}?pid=${encodeURIComponent(principalOrName)}`;

  log.info(`Querying connections: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`HTTP error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = (await res.json()) as {
    code: number;
    msg: string;
    data?: {
      source: string;
      query: string;
      is_human: boolean;
      connectionPids: string[];
    };
  };

  if (json.code !== 200 || !json.data) {
    console.error(`API error: ${json.msg}`);
    process.exit(1);
  }

  const { source, query, is_human, connectionPids } = json.data;

  // get-owner is only meaningful for agents (is_human must be false)
  if (is_human) {
    console.error(`Error: "${principalOrName}" is a human owner, not an agent.`);
    console.error('To query the agents bound to this human account, use:');
    console.error(`  zcloak-ai register get-agent-list ${principalOrName}`);
    process.exit(1);
  }

  console.log(`source      : ${source}`);
  console.log(`query       : ${query}`);
  console.log(`is_human    : ${is_human}`);
  console.log(`connections : ${connectionPids.length}`);
  if (connectionPids.length > 0) {
    connectionPids.forEach((pid, i) => console.log(`  [${i}] ${pid}`));
  } else {
    console.log('  (none)');
  }
}

/**
 * Query the list of agents bound to a human account via the zCloak REST API.
 *
 * Routing:
 *   - Input ends with ".ai"     → GET /api/ai-name/connections?name=<input>
 *   - Otherwise (principal ID)  → GET /api/ai-name/connections?pid=<input>
 *
 * Validates that the returned profile is a human account (is_human === true).
 * connectionPids contains the list of agent Principal IDs bound to this human.
 */
async function cmdGetAgentList(_session: Session, principalOrName: string | undefined): Promise<void> {
  if (!principalOrName) {
    console.error('Error: principal or owner AI name is required');
    console.error('Usage: zcloak-ai register get-agent-list <ai_id_or_ai_name>');
    process.exit(1);
  }

  const BASE = 'https://service.zcloak.ai/api/ai-name/connections';
  const isAiName = principalOrName.endsWith('.ai');
  const url = isAiName
    ? `${BASE}?name=${encodeURIComponent(principalOrName)}`
    : `${BASE}?pid=${encodeURIComponent(principalOrName)}`;

  log.info(`Querying agent list: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`HTTP error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = (await res.json()) as {
    code: number;
    msg: string;
    data?: {
      source: string;
      query: string;
      is_human: boolean;
      connectionPids: string[];
    };
  };

  if (json.code !== 200 || !json.data) {
    console.error(`API error: ${json.msg}`);
    process.exit(1);
  }

  const { source, query, is_human, connectionPids } = json.data;

  // get-agent-list is only meaningful for human accounts (is_human must be true)
  if (!is_human) {
    console.error(`Error: "${principalOrName}" is an agent, not a human owner.`);
    console.error('To query the owner(s) of this agent, use:');
    console.error(`  zcloak-ai register get-owner ${principalOrName}`);
    process.exit(1);
  }

  console.log(`source      : ${source}`);
  console.log(`query       : ${query}`);
  console.log(`is_human    : ${is_human}`);
  console.log(`agents      : ${connectionPids.length}`);
  if (connectionPids.length > 0) {
    connectionPids.forEach((pid, i) => console.log(`  [${i}] ${pid}`));
  } else {
    console.log('  (none)');
  }
}

/**
 * Format an ID record from the REST API response into a readable AI ID string.
 * API format: { id: string; index: string[]; domain: Record<string,null>[] }
 * e.g. { id:"wanghui", index:[], domain:[{"AI":null}] }  → "wanghui.ai"
 *      { id:"wanghui", index:["4705"], domain:[{"AI":null}] } → "wanghui#4705.ai"
 */
function formatApiIdRecord(r: { id: string; index: string[]; domain: Record<string, null>[] }): string {
  let text = r.id;
  if (r.index && r.index.length > 0) text += `#${r.index[0]}`;
  if (r.domain && r.domain.length > 0) {
    const d = r.domain[0]!;
    if ('AI' in d)    text += '.ai';
    else if ('ORG' in d)   text += '.org';
    else if ('AGENT' in d) text += '.agent';
  }
  return text;
}

/**
 * Query full profile of any account (human or agent) via the zCloak REST API.
 *
 * Routing:
 *   - Input ends with ".ai" or ".agent" → GET /api/ai-name/user_profile?name=<input>
 *   - Otherwise (Principal ID)          → GET /api/ai-name/user_profile?pid=<input>
 */
async function cmdGetProfile(_session: Session, input: string | undefined): Promise<void> {
  if (!input) {
    console.error('Error: AI ID or AI name is required');
    console.error('Usage: zcloak-ai register get-profile <ai_id_or_ai_name>');
    process.exit(1);
  }

  const BASE = 'https://service.zcloak.ai/api/ai-name/user_profile';
  const isName = input.endsWith('.ai') || input.endsWith('.agent');
  const url = isName
    ? `${BASE}?name=${encodeURIComponent(input)}`
    : `${BASE}?pid=${encodeURIComponent(input)}`;

  log.info(`Querying profile: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`HTTP error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  // todo: maybe change when the server api changes
  const json = (await res.json()) as {
    code: number;
    msg: string;
    data?: {
      source: string;
      query: string;
      profile?: {
        username: string;
        display_name: string;
        passkey_name: string[];
        principal_id: string[];
        create_time: string;
        modify_time: string;
        ai_profile: Array<{
          is_free: boolean;
          bio: string[];
          ai_name: Array<{ id: string; index: string[]; domain: Record<string, null>[] }>;
          default_name: Array<{ id: string; index: string[]; domain: Record<string, null>[] }>;
          valid_time: string[];
          position: Array<{ is_human: boolean; connection_list: unknown[] }>;
        }>;
      };
    };
  };

  if (json.code !== 200 || !json.data) {
    console.error(`API error: ${json.msg}`);
    process.exit(1);
  }

  const { profile } = json.data;
  if (!profile) {
    console.log('(null)');
    return;
  }

  // ── Basic fields ──────────────────────────────────────────────────────────
  console.log(`display_name  : ${profile.display_name}`);
  console.log(`principal_id  : ${profile.principal_id.length > 0 ? profile.principal_id[0] : '(none)'}`);

  // ── AI profile ────────────────────────────────────────────────────────────
  if (profile.ai_profile && profile.ai_profile.length > 0) {
    const ap = profile.ai_profile[0]!;

    // Preferred AI name
    const aiName = ap.ai_name && ap.ai_name.length > 0
      ? formatApiIdRecord(ap.ai_name[0]!)
      : null;
    const defaultName = ap.default_name && ap.default_name.length > 0
      ? formatApiIdRecord(ap.default_name[0]!)
      : null;

    console.log(`ai_name       : ${aiName ?? '(none)'}`);
    console.log(`default_name  : ${defaultName ?? '(none)'}`);
    console.log(`is_free       : ${ap.is_free}`);
    console.log(`bio           : ${ap.bio && ap.bio.length > 0 ? ap.bio[0] : '(none)'}`);

    if (ap.valid_time && ap.valid_time.length > 0) {
      const ts = parseInt(ap.valid_time[0]!, 10);
      console.log(`valid_until   : ${new Date(ts).toISOString()}`);
    }

    if (ap.position && ap.position.length > 0) {
      const pos = ap.position[0]!;
      console.log(`is_human      : ${pos.is_human}`);
      console.log(`connections   : ${pos.connection_list.length}`);
      if (pos.connection_list.length > 0) {
        if (!pos.is_human) {
          // Agent account — connections are its owner(s)
          console.log(`  → To view owner(s) of this agent, run:`);
          console.log(`    zcloak-ai register get-owner ${input}`);
        } else {
          // Human account — connections are its bound agents
          console.log(`  → To view agents bound to this account, run:`);
          console.log(`    zcloak-ai register get-agent-list ${input}`);
        }
      }
    }
  }

  // ── Passkeys ──────────────────────────────────────────────────────────────
  console.log(`passkeys      : ${profile.passkey_name.length}`);
  profile.passkey_name.forEach((k, i) => console.log(`  [${i}] ${k}`));

  // ── Timestamps ────────────────────────────────────────────────────────────
  console.log(`created       : ${new Date(parseInt(profile.create_time, 10)).toISOString()}`);
  console.log(`modified      : ${new Date(parseInt(profile.modify_time, 10)).toISOString()}`);
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
      case 'get-agent-list':
        await cmdGetAgentList(session, session.args._args[1]);
        break;
      case 'get-profile':
        await cmdGetProfile(session, session.args._args[1]);
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

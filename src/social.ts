#!/usr/bin/env node
/**
 * zCloak.ai Social Profile Query Tool
 *
 * Queries agent social profiles (including follow relationships) from the
 * zCloak.ai social platform HTTP API.
 *
 * Usage:
 *   zcloak-ai social get-profile <principal_or_agent_name>   Query social profile & follow info
 *
 * All commands support --identity=<pem_path> to specify identity file.
 * Accepts Principal ID, Agent AI ID (.agent), or Owner AI ID (.ai).
 */

import { Session } from './session.js';
import config from './config.js';
import * as log from './log.js';
import { generalParseAiIdToRecord } from './aiid.js';

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Social Profile Query');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai social get-profile <principal_or_name>   Query social profile & follow info');
  console.log('');
  console.log('Accepts:');
  console.log('  - Raw Principal ID');
  console.log('  - Agent AI ID (.agent), e.g. "runner#8939.agent"');
  console.log('  - Owner AI ID (.ai), e.g. "alice.ai"');
  console.log('');
  console.log('Options:');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('  --json                    Output raw JSON response');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai social get-profile "runner#8939.agent"');
  console.log('  zcloak-ai social get-profile alice.ai');
  console.log('  zcloak-ai social get-profile <principal_id>');
}

// ========== Input Resolution ==========

/**
 * Detect whether the input looks like an Agent AI ID (.agent).
 * Agent AI IDs end with ".agent" (e.g. "runner#8939.agent").
 */
function isAgentId(input: string): boolean {
  return input.endsWith('.agent');
}

/**
 * Detect whether the input looks like an Owner AI ID (.ai).
 * Owner AI IDs end with ".ai" (e.g. "alice.ai").
 */
function isAiId(input: string): boolean {
  return input.endsWith('.ai');
}

/** Structured ID record matching the canister's user_profile_get_by_id parameter */
type IDRecord = {
  id: string;
  domain: [] | [{ AI: null } | { ORG: null } | { AGENT: null }];
  index: [] | [bigint];
};

/**
 * Parse a ".ai" AI ID string into a structured ID record for canister lookup.
 * Supports: "alice#8730.ai" → { id: "alice", index: [8730n], domain: [{ AI: null }] }
 *           "alice.ai"      → { id: "alice", index: [],      domain: [{ AI: null }] }
 */
function parseAiIdToRecord(aiId: string): IDRecord {
  const namePart = aiId.slice(0, -3); // remove ".ai"
  const hashIndex = namePart.indexOf('#');

  if (hashIndex === -1) {
    return { id: namePart, index: [], domain: [{ AI: null }] };
  }

  const baseName = namePart.slice(0, hashIndex);
  const indexStr = namePart.slice(hashIndex + 1);
  const indexNum = parseInt(indexStr, 10);

  if (!baseName || !indexStr || isNaN(indexNum) || indexNum < 0) {
    throw new Error(`Invalid AI ID format: "${aiId}". Expected "name#number.ai" or "name.ai".`);
  }

  return { id: baseName, index: [BigInt(indexNum)], domain: [{ AI: null }] };
}

/**
 * Resolve input to a Principal ID string.
 * Handles three formats:
 *   - Agent AI ID (.agent) → resolved via get_user_principal on registry canister
 *   - Owner AI ID (.ai) → resolved via user_profile_get_by_id on registry canister
 *   - Raw Principal ID → returned as-is
 */
async function resolveInputToPrincipal(session: Session, input: string): Promise<string> {
  if (isAgentId(input)) {
    // Resolve .agent name to Principal ID via unified registry profile (preferred),
    // with legacy get_user_principal fallback.
    const actor = await session.getAnonymousRegistryActor();
    try {
      const idRecord = generalParseAiIdToRecord(input);
      const profile = await actor.user_profile_get_by_id(idRecord as any);

      if (profile && profile.length > 0) {
        const p = profile[0]!;
        if (p.principal_id && p.principal_id.length > 0) {
          const principal = p.principal_id[0]!;
          log.info(`Resolved via profile: ${input} → ${principal}`);
          return principal;
        }
      }
      // Fall through to legacy path below if no principal bound
    } catch {
      // Fall through to legacy path below if parsing fails
    }

    // Legacy/compat path: use register canister mapping by username string
    const legacy = await actor.get_user_principal(input);
    if (!legacy || legacy.length === 0) {
      throw new Error(`Agent AI ID not found in registry: "${input}".`);
    }
    const principal = legacy[0]!.toText();
    log.info(`Resolved via legacy mapping: ${input} → ${principal}`);
    return principal;
  }

  if (isAiId(input)) {
    // Resolve .ai name to Principal ID via registry canister
    const idRecord = parseAiIdToRecord(input);
    log.info(`Resolving AI ID "${input}" → id="${idRecord.id}", index=${idRecord.index.length ? idRecord.index[0]!.toString() : 'null'}...`);

    const actor = await session.getAnonymousRegistryActor();
    const result = await actor.user_profile_get_by_id(idRecord);

    if (!result || result.length === 0) {
      throw new Error(`AI ID not found in registry: "${input}".`);
    }

    const profile = result[0]!;
    if (!profile.principal_id || profile.principal_id.length === 0) {
      throw new Error(`AI ID "${input}" exists in registry but has no principal bound.`);
    }

    const principal = profile.principal_id[0]!;
    log.info(`Resolved: ${input} → ${principal}`);
    return principal;
  }

  // Raw Principal ID — return as-is
  return input;
}

// ========== Social API Types ==========

/** Single follow entry from the social API response */
interface FollowEntry {
  aiId: string;
  username: string;
  displayName: string;
}

/** Follow stats from the social API response */
interface FollowStats {
  followingCount: number;
  followersCount: number;
}

/** Abridged social API profile response */
interface SocialProfileResponse {
  profile?: Record<string, unknown>;
  username?: string;
  stats?: {
    postCount: number;
    totalReactions: number;
    totalReplies: number;
  };
  followStats?: FollowStats;
  following?: FollowEntry[];
  followers?: FollowEntry[];
}

// ========== Command Implementations ==========

/**
 * Format a single follow entry for display.
 */
function formatFollowEntry(entry: FollowEntry): string {
  const name = entry.username || entry.aiId;
  if (entry.displayName && entry.displayName !== entry.username) {
    return `${name} (${entry.displayName})`;
  }
  return name;
}

/**
 * Query an agent's social profile including follow relationships.
 * Fetches from the social platform HTTP API and formats the output.
 */
async function cmdGetProfile(session: Session, input: string | undefined, useJson: boolean): Promise<void> {
  if (!input) {
    console.error('Error: principal ID or AI ID is required');
    console.error('Usage: zcloak-ai social get-profile <principal_or_name>');
    process.exit(1);
  }

  // Resolve input to Principal ID
  const principal = await resolveInputToPrincipal(session, input);

  // Fetch social profile via HTTP API
  const url = `${config.social_url}/api/profiles/${encodeURIComponent(principal)}`;
  log.info(`Fetching social profile for ${principal}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Social API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as SocialProfileResponse;

  // Raw JSON output mode
  if (useJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Formatted output
  const lines: string[] = [];

  // Username
  if (data.username) {
    lines.push(`Agent: ${data.username}`);
  }
  lines.push(`Principal: ${principal}`);

  // Stats
  if (data.stats) {
    lines.push(`Posts: ${data.stats.postCount}, Reactions: ${data.stats.totalReactions}, Replies: ${data.stats.totalReplies}`);
  }

  // Follow stats
  if (data.followStats) {
    lines.push(`Following: ${data.followStats.followingCount}, Followers: ${data.followStats.followersCount}`);
  }

  // Following list
  if (data.following && data.following.length > 0) {
    lines.push('');
    lines.push('--- Following ---');
    for (const entry of data.following) {
      lines.push(`  ${formatFollowEntry(entry)}`);
    }
  }

  // Followers list
  if (data.followers && data.followers.length > 0) {
    lines.push('');
    lines.push('--- Followers ---');
    for (const entry of data.followers) {
      lines.push(`  ${formatFollowEntry(entry)}`);
    }
  }

  console.log(lines.join('\n'));
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
      case 'get-profile':
        await cmdGetProfile(session, session.args._args[1], session.args.json === true);
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

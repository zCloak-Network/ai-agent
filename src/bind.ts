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
 *   zcloak-ai bind prepare <user_principal_or_ai_id>         Prepare binding and generate authentication URL
 *   zcloak-ai bind check-passkey <user_principal_or_ai_id>   Check if a principal has a registered passkey
 *
 * The <user_principal_or_ai_id> argument accepts:
 *   - A raw ICP principal (e.g. "57odc-ymip7-...")
 *   - A human-readable AI ID containing "." (e.g. "alice#1234.ai" or "runner#8939.agent")
 *     In the latter case the registry canister is queried first to resolve the principal.
 *
 * All commands support --identity=<pem_path> to specify identity file.
 */

import { Session } from './session.js';

/** Inline ID record type matching the registry canister's user_profile_get_by_id parameter */
type IDRecord = {
  id: string;
  index: [] | [bigint];
  domain: [] | [{ AI: null } | { ORG: null } | { AGENT: null }];
};

// ========== Help Information ==========
function showHelp(): void {
  console.log('zCloak.ai Agent-Owner Binding Tool');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai bind prepare <user_principal_or_ai_id>         Prepare binding and generate authentication URL');
  console.log('  zcloak-ai bind check-passkey <user_principal_or_ai_id>   Check if a principal has a registered passkey');
  console.log('');
  console.log('Arguments:');
  console.log('  user_principal_or_ai_id   ICP principal OR human-readable AI ID (e.g. alice#1234.ai)');
  console.log('');
  console.log('Options:');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('');
  console.log('Flow:');
  console.log('  1. Script resolves AI ID → principal if needed (via registry canister lookup)');
  console.log('  2. Script checks if target principal has a registered passkey (pre-check)');
  console.log('  3. Script calls agent_prepare_bond to get WebAuthn challenge');
  console.log('  4. Script generates authentication URL');
  console.log('  5. User opens the URL in browser and completes authentication with passkey');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai bind prepare "57odc-ymip7-b7edu-aevpq-nu54m-q4paq-vsrtd-nlnmm-lkos3-d4h3t-7qe"');
  console.log('  zcloak-ai bind check-passkey "57odc-ymip7-b7edu-aevpq-nu54m-q4paq-vsrtd-nlnmm-lkos3-d4h3t-7qe"');
  console.log('  zcloak-ai bind prepare "alice#1234.ai"');
  console.log('  zcloak-ai bind check-passkey "alice#1234.ai"');
}

// ========== Input Resolution Helpers ==========

/**
 * Detect whether the input looks like a human-readable AI ID rather than a raw principal.
 *
 * AI IDs end with ".ai" (e.g. "alice#1234.ai", "alice.ai").
 * ICP principals only contain alphanumeric characters and hyphens, never a dot.
 */
function isAiId(input: string): boolean {
  return input.endsWith('.ai');
}

/**
 * Parse a ".ai" AI ID string into a structured ID record for canister lookup.
 *
 * Two formats are supported:
 *   - With discriminator : "alice#8730.ai"  → { id: "alice", index: [8730n], domain: [{ AI: null }] }
 *   - Vanity (no #)      : "alice.ai"       → { id: "alice", index: [],      domain: [{ AI: null }] }
 *
 * @param aiId - AI ID string ending with ".ai"
 * @returns Structured ID record ready to pass to user_profile_get_by_id
 * @throws If the string does not end with ".ai" or has an invalid format
 */
function parseAiIdToRecord(aiId: string): IDRecord {
  if (!aiId.endsWith('.ai')) {
    throw new Error(`Expected an AI ID ending with ".ai", got: "${aiId}"`);
  }

  // Strip the ".ai" suffix to get the name part (e.g. "alice#8730" or "alice")
  const namePart = aiId.slice(0, -3); // remove ".ai"

  const hashIndex = namePart.indexOf('#');

  if (hashIndex === -1) {
    // Vanity name — no discriminator (e.g. "alice.ai")
    return {
      id: namePart,
      index: [],           // Candid opt — empty = null
      domain: [{ AI: null }],
    };
  }

  // Indexed name (e.g. "alice#8730.ai")
  const baseName = namePart.slice(0, hashIndex);
  const indexStr = namePart.slice(hashIndex + 1);
  const indexNum = parseInt(indexStr, 10);

  if (!baseName || !indexStr || isNaN(indexNum) || indexNum < 0) {
    throw new Error(`Invalid AI ID format: "${aiId}". Expected "name#number.ai" or "name.ai".`);
  }

  return {
    id: baseName,
    index: [BigInt(indexNum)],   // Candid opt — [value] = Some(value)
    domain: [{ AI: null }],
  };
}

/**
 * Resolve a ".ai" AI ID string to a raw ICP principal text.
 *
 * Parses the AI ID into a structured ID record and calls
 * user_profile_get_by_id on the registry canister, then extracts
 * the principal_id field from the returned UserProfile.
 *
 * @param session - Current CLI session
 * @param aiId    - AI ID string ending with ".ai" (e.g. "alice#8730.ai" or "alice.ai")
 * @returns Resolved ICP principal text
 * @throws If the AI ID cannot be found or has no principal bound
 */
async function resolveAIIDToPrincipal(session: Session, aiId: string): Promise<string> {
  const idRecord = parseAiIdToRecord(aiId);

  console.error(`Resolving AI ID "${aiId}" → id="${idRecord.id}", index=${idRecord.index.length ? idRecord.index[0]!.toString() : 'null'}...`);

  const actor = await session.getAnonymousRegistryActor();
  const result = await actor.user_profile_get_by_id(idRecord);

  // opt UserProfile — empty array means not found
  if (!result || result.length === 0) {
    throw new Error(`AI ID not found in registry: "${aiId}". Check the spelling and try again.`);
  }

  const profile = result[0]!;

  // principal_id is opt text — the owner's bound principal
  if (!profile.principal_id || profile.principal_id.length === 0) {
    throw new Error(`AI ID "${aiId}" exists in registry but has no principal bound.`);
  }

  const principal = profile.principal_id[0]!;
  console.error(`Resolved: ${aiId} → ${principal}`);
  return principal;
}

/**
 * Resolve input (raw principal OR ".ai" AI ID) to an ICP principal text.
 * Dispatches to resolveAIIDToPrincipal for AI IDs; returns input as-is otherwise.
 */
async function resolveInputToPrincipal(session: Session, input: string): Promise<string> {
  if (!isAiId(input)) {
    return input;
  }
  return resolveAIIDToPrincipal(session, input);
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
async function cmdCheckPasskey(session: Session, userInput: string | undefined): Promise<void> {
  if (!userInput) {
    console.error('Error: user principal ID or AI ID is required');
    console.error('Usage: zcloak-ai bind check-passkey <user_principal_or_ai_id>');
    process.exit(1);
  }

  // Resolve AI ID → principal if needed
  const userPrincipal = await resolveInputToPrincipal(session, userInput!);

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
async function cmdPrepare(session: Session, userInput: string | undefined): Promise<void> {
  if (!userInput) {
    console.error('Error: user principal ID or AI ID is required');
    console.error('Usage: zcloak-ai bind prepare <user_principal_or_ai_id>');
    process.exit(1);
  }

  // Resolve AI ID → principal if needed
  const userPrincipal = await resolveInputToPrincipal(session, userInput!);

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

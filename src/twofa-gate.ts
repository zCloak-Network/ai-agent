/**
 * zCloak.ai 2FA Gate — Keyword-Based Two-Factor Authentication Gate
 *
 * Implements a state-machine-driven 2FA gate for the OpenClaw `before_agent_reply` hook.
 * When a user message contains sensitive operation keywords, the gate requires Owner
 * passkey (WebAuthn) verification before the agent can proceed.
 *
 * State machine (2 states):
 *   IDLE    → no pending challenge
 *   PENDING → challenge created, awaiting Owner passkey confirmation
 *
 * Every sensitive operation requires fresh 2FA — no caching, no exceptions.
 *
 * Two-turn conversation pattern (no polling):
 *   Turn 1: keyword detected → block LLM → return 2FA URL
 *   Turn 2: user sends next message → query pending challenge → confirmed → pass
 *
 * Usage:
 *   zcloak-ai twofa-gate check <message>    Keyword scan + state machine decision (JSON output)
 *   zcloak-ai twofa-gate status             Show current 2FA gate state (debug)
 *
 * All commands support --identity=<pem_path> and --session=<id>.
 */

import fs from 'fs';
import path from 'path';
import { Session } from './session.js';
import { twofaStatePath } from './paths.js';
import config from './config.js';
import * as log from './log.js';

// ========== Keyword Rules ==========

/**
 * A keyword rule that maps user intent patterns to a sensitive operation.
 * Any match triggers 2FA — no levels, no caching.
 */
interface KeywordRule {
  /** Rule identifier, used in logs and state tracking */
  id: string;
  /** Regex patterns — any single match triggers this rule (English + Chinese) */
  patterns: RegExp[];
}

/** All sensitive operations that require 2FA before the agent can act. */
const KEYWORD_RULES: KeywordRule[] = [
  { id: 'delete', patterns: [/\b(delete|remove)\b/i, /删除|移除/] },
  { id: 'bind',   patterns: [/\bbind(ing)?\b/i, /绑定/] },
];

/** Maximum age for a PENDING challenge before auto-expiring back to IDLE (ms) */
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ========== State File Types ==========

/** Persisted 2FA gate state — one active challenge at a time, always PENDING */
interface TwoFAState {
  /** Challenge string returned by prepare_2fa_info */
  challenge: string;
  /** Matched keyword rule ID (e.g. 'sign', 'delete') */
  operation: string;
  /** Epoch ms when the challenge was created */
  created_at: number;
}

/**
 * JSON output from the `check` command — consumed by the OpenClaw hook.
 * NOTE: A mirror of this interface exists in src/hooks/before-agent-reply.ts
 * (kept separate intentionally because the hook communicates via CLI stdout,
 * not module imports). Keep both in sync when changing.
 */
export interface GateDecision {
  /** 'pass' = let LLM reply; 'block' = 2FA required; 'pending' = still waiting */
  action: 'pass' | 'block' | 'pending';
  /** Challenge string (present when action is 'block' or 'pending') */
  challenge?: string;
  /** 2FA authentication URL (present when action is 'block' or 'pending') */
  url?: string;
  /** Matched operation ID (present when action is 'block') */
  operation?: string;
}

// ========== Keyword Matching ==========

/**
 * Scan a user message for sensitive operation keywords.
 *
 * @returns The first matched rule, or null if no keywords found
 */
export function matchKeywords(message: string): KeywordRule | null {
  for (const rule of KEYWORD_RULES) {
    if (rule.patterns.some(p => p.test(message))) {
      return rule;
    }
  }
  return null;
}

// ========== State File I/O ==========

/**
 * Read the current 2FA gate state from disk.
 * Returns null if the file is missing, empty, or contains invalid JSON.
 * Corrupted state files are silently treated as IDLE (no state).
 *
 * @param sessionId - OpenClaw session ID for per-session isolation (optional)
 */
export function readState(sessionId?: string): TwoFAState | null {
  try {
    const raw = fs.readFileSync(twofaStatePath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw);
    // Basic shape validation — must have challenge and operation
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.challenge === 'string' &&
      typeof parsed.operation === 'string'
    ) {
      return parsed as TwoFAState;
    }
    log.warn('2FA state file has unexpected shape, treating as IDLE');
    return null;
  } catch {
    // ENOENT (file missing) or JSON parse error — both are IDLE
    return null;
  }
}

/**
 * Write 2FA gate state to disk. Ensures parent directory exists first.
 * Throws on failure — callers must handle this to avoid silent 2FA bypass.
 *
 * @param state - The state to persist
 * @param sessionId - OpenClaw session ID for per-session isolation (optional)
 */
export function writeState(state: TwoFAState, sessionId?: string): void {
  const filePath = twofaStatePath(sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

/**
 * Clear 2FA gate state (delete the file).
 *
 * @param sessionId - OpenClaw session ID for per-session isolation (optional)
 */
export function clearState(sessionId?: string): void {
  try {
    fs.unlinkSync(twofaStatePath(sessionId));
  } catch {
    // Already gone — fine
  }
}

// ========== Core Gate Logic ==========

/** Build the 2FA authentication URL from a challenge string. */
function buildTwoFAUrl(challenge: string): string {
  return `${config.twofa_url}?challenge=${challenge}`;
}

/** Output a JSON decision to stdout (consumed by the OpenClaw hook). */
function outputDecision(decision: GateDecision): void {
  console.log(JSON.stringify(decision));
}

/**
 * Main state machine logic for the `check` command.
 *
 * Decision flow:
 *   1. If PENDING state exists → query canister for confirmation
 *      - Confirmed → clear state → output "pass"
 *      - Expired (no record) → clear state → fall through to IDLE
 *      - Still pending → output "pending" with reminder URL
 *   2. If IDLE → scan message for keywords
 *      - No match → output "pass"
 *      - Match → call prepare_2fa_info → write PENDING state → output "block"
 *
 * @param session - CLI session with identity and actor access
 * @param message - The user's message text to scan for keywords
 * @param sessionId - OpenClaw session ID for per-session state isolation (optional)
 */
async function cmdCheck(session: Session, message: string, sessionId?: string): Promise<void> {
  const state = readState(sessionId);

  // ── State: PENDING — check if the Owner has confirmed ──
  if (state) {
    // TTL guard — auto-expire stale PENDING state to prevent permanent deadlock
    // when the canister is unreachable or the user abandons the challenge.
    if (Date.now() - state.created_at > PENDING_TTL_MS) {
      log.warn(`2FA gate: pending challenge expired (age ${Math.round((Date.now() - state.created_at) / 1000)}s > TTL), clearing state`);
      clearState(sessionId);
      // Fall through to IDLE keyword scan below
    } else {
      log.info('2FA gate: checking pending challenge confirmation...');
      try {
        const actor = await session.getAnonymousRegistryActor();
        const result = await actor.query_2fa_result_by_challenge(state.challenge);

        // No record found — challenge expired or invalid on the canister side.
        // Clear local state to avoid permanent deadlock, fall through to IDLE.
        if (!result || result.length === 0) {
          log.warn('2FA gate: pending challenge not found on canister (expired?), clearing state');
          clearState(sessionId);
          // Fall through to IDLE keyword scan below
        } else {
          const record = result[0]!;
          const isConfirmed = record.confirm_timestamp.length > 0;

          if (isConfirmed) {
            // 2FA passed — clear state and fall through to IDLE keyword scan.
            // We do NOT return "pass" here because the current message itself
            // may contain a new sensitive operation that needs its own 2FA.
            log.info(`2FA gate: challenge confirmed for operation "${state.operation}"`);
            clearState(sessionId);
          } else {
            // Still pending — remind the user
            outputDecision({
              action: 'pending',
              challenge: state.challenge,
              url: buildTwoFAUrl(state.challenge),
            });
            return;
          }
        }
      } catch (err) {
        // Canister query failed — remind the user (don't silently drop pending state)
        log.warn(`2FA gate: failed to query challenge status: ${err instanceof Error ? err.message : String(err)}`);
        outputDecision({
          action: 'pending',
          challenge: state.challenge,
          url: buildTwoFAUrl(state.challenge),
        });
        return;
      }
    }
  }

  // ── State: IDLE — scan message for sensitive keywords ──
  const rule = matchKeywords(message);
  if (!rule) {
    outputDecision({ action: 'pass' });
    return;
  }

  log.info(`2FA gate: keyword "${rule.id}" detected, initiating 2FA...`);

  // Create a 2FA challenge via the registry canister
  const twofaInfo = JSON.stringify({
    operation: rule.id,
    request_timestamp: Math.floor(Date.now() / 1000),
  });

  // ── Canister call + state write ──
  // SECURITY: A sensitive keyword was detected — we MUST NOT output "pass"
  // unless 2FA is completed. If anything fails (actor creation, canister call,
  // state write), output "block" so the user is never silently allowed through.
  let actor;
  try {
    actor = await session.getRegistryActor();
  } catch (err) {
    // Cannot create actor — fail-closed: block the operation and tell the user.
    log.error(`2FA gate: failed to get registry actor: ${err instanceof Error ? err.message : String(err)}`);
    outputDecision({ action: 'block', operation: rule.id });
    return;
  }

  let challenge: string;
  let url: string;
  try {
    const result = await actor.prepare_2fa_info(twofaInfo);

    if ('Err' in result) {
      // Canister rejected (e.g. no owner bound) — fail-closed: block.
      log.error(`2FA gate: prepare_2fa_info rejected: ${result.Err}`);
      outputDecision({ action: 'block', operation: rule.id });
      return;
    }

    // The canister may return the challenge wrapped in JSON quotes;
    // strip them to get the raw challenge string for URL construction.
    challenge = result.Ok.replace(/^"|"$/g, '');
    url = buildTwoFAUrl(challenge);
  } catch (err) {
    // Network error calling canister — fail-closed: block.
    log.error(`2FA gate: canister call failed: ${err instanceof Error ? err.message : String(err)}`);
    outputDecision({ action: 'block', operation: rule.id });
    return;
  }

  // Challenge created on canister — persist state locally.
  // If write fails, still output "block" so the user sees the 2FA URL.
  try {
    writeState({
      challenge,
      operation: rule.id,
      created_at: Date.now(),
    }, sessionId);
  } catch (err) {
    log.error(`2FA gate: CRITICAL — failed to write state file: ${err instanceof Error ? err.message : String(err)}`);
  }

  outputDecision({
    action: 'block',
    challenge,
    url,
    operation: rule.id,
  });
}

/**
 * Show current 2FA gate state (debug / inspection command).
 *
 * @param sessionId - OpenClaw session ID for per-session isolation (optional)
 */
function cmdStatus(sessionId?: string): void {
  const state = readState(sessionId);
  if (!state) {
    console.log('idle');
    return;
  }
  console.log(JSON.stringify(state, null, 2));
}

// ========== Help ==========

function showHelp(): void {
  console.log('zCloak.ai 2FA Gate — Keyword-Based Two-Factor Authentication');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai twofa-gate check <message>              Scan message and return gate decision (JSON)');
  console.log('  zcloak-ai twofa-gate check --session=<id> <msg>   Same, with session-scoped state');
  console.log('  zcloak-ai twofa-gate status                       Show current 2FA gate state');
  console.log('  zcloak-ai twofa-gate status --session=<id>        Show session-scoped state');
  console.log('');
  console.log('Options:');
  console.log('  --identity=<pem_path>     Specify identity PEM file');
  console.log('  --session=<id>            Session ID for state isolation (set by OpenClaw hook)');
  console.log('');
  console.log('The `check` command outputs a single JSON line to stdout:');
  console.log('  {"action":"pass"}                             No 2FA needed');
  console.log('  {"action":"block","challenge":"...","url":"..."} 2FA required');
  console.log('  {"action":"pending","challenge":"...","url":"..."} Awaiting confirmation');
}

// ========== Exported run() — called by cli.ts ==========

/**
 * Entry point when invoked via cli.ts.
 * Receives a Session instance with pre-parsed arguments.
 */
export async function run(session: Session): Promise<void> {
  const command = session.args._args[0];
  // Extract --session= from parsed named args for per-session state isolation
  const sessionId = session.args.session as string | undefined;

  try {
    switch (command) {
      case 'check': {
        const message = session.args._args[1];
        if (!message) {
          console.error('Error: message text is required');
          console.error('Usage: zcloak-ai twofa-gate check <message>');
          process.exit(1);
        }
        await cmdCheck(session, message, sessionId);
        break;
      }
      case 'status':
        cmdStatus(sessionId);
        break;
      default:
        showHelp();
        if (command) {
          console.error(`\nUnknown command: ${command}`);
        }
        process.exit(1);
    }
  } catch (err) {
    log.error(`2FA gate operation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

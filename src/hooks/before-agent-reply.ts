/**
 * OpenClaw `before_agent_reply` Hook — 2FA Gate
 *
 * Thin wrapper that intercepts user messages before the LLM replies.
 * Calls `zcloak-ai twofa-gate check <message>` via execFileSync to determine
 * whether 2FA verification is required. Does NOT import zcloak-agent internals
 * — communicates exclusively through the CLI binary (same boundary pattern as
 * openclaw.ts).
 *
 * Gate decisions:
 *   pass    → { handled: false }  — let LLM reply normally
 *   block   → { handled: true }   — short-circuit with 2FA URL
 *   pending → { handled: true }   — remind user to complete 2FA
 *
 * On any error (CLI missing, timeout, parse failure), the hook falls through
 * to let the LLM reply (fail-open), so a broken 2FA gate never silently
 * blocks the user.
 *
 * @see https://docs.openclaw.ai/automation/hooks — OpenClaw hook documentation
 * @see src/twofa-gate.ts — CLI command that implements the gate logic
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Resolved binary name — overridable via environment for testing or custom installs */
const ZCLOAK_BIN = process.env['ZCLOAK_AI_BIN'] || 'zcloak-ai';

/** Maximum time to wait for the CLI check command (ms) */
const CHECK_TIMEOUT_MS = 15_000;

/**
 * JSON shape returned by `zcloak-ai twofa-gate check`.
 * Only the fields we consume are declared here.
 *
 * NOTE: The canonical definition lives in src/twofa-gate.ts (GateDecision).
 * This mirror is kept separate intentionally — the hook communicates via CLI
 * stdout JSON, not module imports. Keep both in sync when changing.
 */
interface GateDecision {
  action: 'pass' | 'block' | 'pending';
  challenge?: string;
  url?: string;
  operation?: string;
}

/** Format a synthetic reply for 2FA verification, shown in place of the LLM response. */
function formatBlockReply(decision: GateDecision): string {
  const header = decision.action === 'block'
    ? `⚠️ This operation requires Owner 2FA verification: **${decision.operation ?? 'sensitive operation'}**`
    : '⏳ 2FA verification is still pending.';

  // When the canister is unreachable, the gate outputs "block" without a URL.
  // Show a clear error message so the user knows to retry.
  if (!decision.url) {
    return `${header}\n\nFailed to create 2FA challenge (canister unreachable). Please try again later.`;
  }

  return `${header}\n\nPlease complete passkey authentication in your browser:\n\n${decision.url}\n\nAfter completing verification, send any message to continue.`;
}

/** OpenClaw hook context — we only consume sessionId for state isolation. */
interface HookContext {
  sessionId?: string;
  [key: string]: unknown;
}

export default function register(api: {
  registerHook: (
    event: string,
    handler: (
      event: { cleanedBody: string },
      context: HookContext,
    ) => Promise<{ handled: boolean; reply?: { text: string }; reason?: string }>,
  ) => void;
}): void {
  api.registerHook('before_agent_reply', async (event, context) => {
    const message = event.cleanedBody;

    // Skip empty messages — nothing to gate
    if (!message || message.trim().length === 0) {
      return { handled: false };
    }

    // Build CLI args — include --session= for per-session state isolation
    const args = ['twofa-gate', 'check'];
    if (context.sessionId) {
      args.push(`--session=${context.sessionId}`);
    }
    args.push(message);

    let decision: GateDecision;
    try {
      const { stdout } = await execFileAsync(ZCLOAK_BIN, args, {
        timeout: CHECK_TIMEOUT_MS,
        encoding: 'utf-8',
      });
      decision = JSON.parse(stdout.trim());
    } catch {
      // CLI call failed — fail-open so the user is never silently blocked
      return { handled: false };
    }

    // Pass-through: no 2FA needed
    if (decision.action === 'pass') {
      return { handled: false };
    }

    // Block or pending: short-circuit LLM with synthetic reply
    return {
      handled: true,
      reply: { text: formatBlockReply(decision) },
      reason: `2fa-gate: ${decision.action} (${decision.operation ?? 'check'})`,
    };
  });
}

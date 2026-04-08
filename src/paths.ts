/**
 * Centralized file system path definitions for zcloak-agent.
 *
 * ALL directory and file paths used by the application are defined here.
 * No other module should construct paths using os.homedir() directly.
 *
 * Directory layout:
 *   ~/.config/zcloak/
 *     ai-id.pem                  Identity PEM file
 *     .last-update-check         Update check timestamp
 *     run/                       Daemon runtime files (PID, socket, logs)
 *       debug.log                Shared debug log file
 *       {sanitized_id}.pid
 *       {sanitized_id}.sock
 *       {keyname}-daemon.log
 *     mailboxes/{principal}/     Per-principal mailbox cache
 *       inbox.json
 *       sent.json
 *       sync-state.json
 */

import { join } from 'path';
import { homedir } from 'os';

// ============================================================================
// Root Directories
// ============================================================================

/** Root configuration directory: ~/.config/zcloak/ */
export function configDir(): string {
  return join(homedir(), '.config', 'zcloak');
}

/** Daemon runtime directory: ~/.config/zcloak/run/ */
export function runtimeDir(): string {
  return join(configDir(), 'run');
}

/** Mailboxes root: ~/.config/zcloak/mailboxes/ */
export function mailboxesRoot(): string {
  return join(configDir(), 'mailboxes');
}

// ============================================================================
// Identity
// ============================================================================

/** Default identity PEM file path: ~/.config/zcloak/ai-id.pem */
export function defaultPemPath(): string {
  return join(configDir(), 'ai-id.pem');
}

// ============================================================================
// Logging
// ============================================================================

/** Debug log file path: ~/.config/zcloak/run/debug.log */
export function debugLogPath(): string {
  return join(runtimeDir(), 'debug.log');
}

/** Daemon log file path for a given key name: ~/.config/zcloak/run/{keyname}-daemon.log */
export function daemonLogPath(keyName: string): string {
  return join(runtimeDir(), `${keyName.toLowerCase()}-daemon.log`);
}

// ============================================================================
// Update Check
// ============================================================================

/** Last update check timestamp file: ~/.config/zcloak/.last-update-check */
export function lastUpdateCheckPath(): string {
  return join(configDir(), '.last-update-check');
}

// ============================================================================
// Mailbox Per-Principal Paths
// ============================================================================

/** Mailbox directory for a given principal: ~/.config/zcloak/mailboxes/{principal}/ */
export function mailboxDir(principal: string): string {
  return join(mailboxesRoot(), principal);
}

// ============================================================================
// 2FA Gate
// ============================================================================

/**
 * 2FA gate state file, scoped per session to prevent cross-session interference.
 *
 * With a sessionId: ~/.config/zcloak/twofa-state-<sanitized>.json
 * Without (fallback): ~/.config/zcloak/twofa-state.json
 *
 * The sessionId is provided by the OpenClaw `before_agent_reply` hook context.
 * It is sanitized to prevent path traversal — only alphanumerics, hyphens, and
 * underscores are kept; everything else is replaced with underscores.
 */
export function twofaStatePath(sessionId?: string): string {
  if (!sessionId) {
    return join(configDir(), 'twofa-state.json');
  }
  // Whitelist: keep only safe filename characters to prevent path traversal
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(configDir(), `twofa-state-${safe}.json`);
}

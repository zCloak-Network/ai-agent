/**
 * Daemon Lifecycle Management — PID file, socket path, runtime directory
 *
 * Manages the daemon's file system footprint:
 *   - Runtime directory: ~/.config/zcloak/run/ (created with 0o700 permissions)
 *   - PID file:   ~/.config/zcloak/run/{sanitized_id}.pid
 *   - Socket file: ~/.config/zcloak/run/{sanitized_id}.sock
 *
 * Prevents duplicate daemon instances by checking PID files and verifying
 * whether the process is still alive. Stale PID/socket files from crashed
 * daemons are automatically cleaned up.
 *
 * The DaemonRuntime class implements cleanup-on-drop semantics via
 * process exit handlers, ensuring PID and socket files are removed
 * even on unexpected termination (SIGTERM, SIGINT, uncaught exceptions).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { daemonError } from './error.js';
import * as log from './log.js';
import { runtimeDir as _runtimeDir } from './paths.js';

// Re-export runtimeDir from paths.ts so existing consumers (tests, vetkey.ts)
// can continue importing from daemon.ts without changes.
export { runtimeDir } from './paths.js';

/**
 * Maximum socket path length.
 * macOS limits Unix socket paths to 104 bytes, Linux to 108 bytes.
 * We use 100 as a safe threshold.
 */
const MAX_SOCKET_PATH_LEN = 100;

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Sanitize a daemon identifier for use in file names.
 *
 * Replaces special characters (:, /, \) with underscores.
 * If the resulting path would exceed the Unix socket path limit,
 * falls back to a SHA-256 hash prefix (16 hex characters) to keep
 * the path short enough.
 *
 * @param derivationId - Raw daemon ID (for example a principal or "{principal}:{key_name}")
 * @returns Safe file name prefix
 */
export function sanitizeDerivationId(derivationId: string): string {
  const sanitized = derivationId
    .replace(/:/g, "_")
    .replace(/\//g, "_")
    .replace(/\\/g, "_");

  // Check if the full socket path would be too long
  const dir = _runtimeDir();
  const fullPath = join(dir, `${sanitized}.sock`);
  if (fullPath.length > MAX_SOCKET_PATH_LEN) {
    // Use SHA-256 hash prefix for long derivation IDs
    const hash = crypto.createHash("sha256").update(derivationId).digest("hex");
    return `vk_${hash.slice(0, 16)}`;
  }

  return sanitized;
}

/** Get the socket file path for a daemon ID */
export function socketPath(derivationId: string): string {
  const name = sanitizeDerivationId(derivationId);
  return join(_runtimeDir(), `${name}.sock`);
}

/** Get the PID file path for a daemon ID */
export function pidPath(derivationId: string): string {
  const name = sanitizeDerivationId(derivationId);
  return join(_runtimeDir(), `${name}.pid`);
}

// ============================================================================
// Process Detection
// ============================================================================

/**
 * Check if a process with the given PID is still alive.
 *
 * Uses `kill -0` which checks process existence without sending a signal.
 * Works on both macOS and Linux without requiring native dependencies.
 *
 * @param pid - Process ID to check
 * @returns true if the process exists, false otherwise
 */
function isProcessAlive(pid: number): boolean {
  try {
    // kill -0 checks existence without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM = process exists but we don't have permission → still alive
    if (e && typeof e === "object" && "code" in e && (e as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    // ESRCH = no such process → dead
    return false;
  }
}

/**
 * Check whether a daemon for the given daemon ID is alive.
 *
 * Returns a simple boolean — suitable for pre-checks where the caller wants to
 * decide whether to auto-start a daemon without catching exceptions.
 *
 * Checks (in order):
 *   1. If PID file exists and the recorded PID is alive → return socket exists
 *   2. If PID file is missing/corrupt but socket file exists → return true
 *      (conservatively assume the daemon is alive to prevent orphan creation;
 *      callers like cmdStop should attempt socket shutdown in this case)
 *   3. If neither PID nor socket exists → return false
 *
 * If stale PID/socket files are found (process confirmed dead), they are
 * cleaned up.
 *
 * @param derivationId - Daemon ID (for example "{principal}:Mail" or just "{principal}")
 * @returns true if the daemon is (or may be) running and connectable
 */
export function isDaemonAlive(derivationId: string): boolean {
  const pid = pidPath(derivationId);
  const sock = socketPath(derivationId);

  if (existsSync(pid)) {
    try {
      const pidStr = readFileSync(pid, "utf-8").trim();
      const existingPid = parseInt(pidStr, 10);

      if (isNaN(existingPid) || !isProcessAlive(existingPid)) {
        // Process is confirmed dead — clean up stale files
        safeUnlink(pid);
        safeUnlink(sock);
        return false;
      }

      // PID is alive — also verify socket file exists
      return existsSync(sock);
    } catch {
      log.warn('Failed to read daemon PID file, falling back to socket-only liveness check', {
        derivationId,
        pidPath: pid,
      });
      // PID file read error — fall through to socket-only check
    }
  }

  // No PID file (or unreadable). If socket file still exists, conservatively
  // treat the daemon as alive to prevent callers from spawning a new daemon
  // that would delete the socket and orphan the existing process.
  return existsSync(sock);
}

// ============================================================================
// DaemonRuntime
// ============================================================================

/**
 * Manages the lifecycle of a daemon instance.
 *
 * On creation:
 *   - Creates the runtime directory if needed
 *   - Checks for existing running instances (PID file + process alive check)
 *   - Cleans up stale PID/socket files from crashed daemons
 *   - Writes the current PID to the PID file
 *
 * On cleanup (via destroy() or process exit handlers):
 *   - Removes the PID file
 *   - Removes the socket file
 */
export class DaemonRuntime {
  private _socketPath: string;
  private _pidPath: string;
  private _derivationId: string;
  private cleanedUp = false;

  /** Bound cleanup handler for process exit events */
  private exitHandler: () => void;

  private constructor(socketFilePath: string, pidFilePath: string, derivationId: string) {
    this._socketPath = socketFilePath;
    this._pidPath = pidFilePath;
    this._derivationId = derivationId;

    // Register cleanup handler for process exit
    this.exitHandler = () => this.cleanup();
    process.on("exit", this.exitHandler);
    // Note: SIGTERM/SIGINT signal handlers are managed by serve.ts
    // to coordinate with the server shutdown. We only handle 'exit' here.
  }

  /**
   * Create a new DaemonRuntime, performing all startup checks.
   *
   * @param derivationId - Daemon ID for this daemon instance
   * @returns Initialized DaemonRuntime
   * @throws ToolError with code DAEMON if another instance is already running
   */
  static create(derivationId: string): DaemonRuntime {
    const dir = _runtimeDir();
    const sock = socketPath(derivationId);
    const pid = pidPath(derivationId);

    // Create runtime directory with restricted permissions (0o700)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Check for existing running instance
    if (existsSync(pid)) {
      try {
        const pidStr = readFileSync(pid, "utf-8").trim();
        const existingPid = parseInt(pidStr, 10);

        if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
          throw daemonError(
            `daemon already running for "${derivationId}" (PID ${existingPid})`,
          );
        }
      } catch (e) {
        // Re-throw ToolError (daemon already running)
        if (e instanceof Error && e.name === "ToolError") throw e;
        // Other errors (corrupted PID file) — just clean up
        log.warn(`Removing corrupted PID file: ${e}`);
      }
      safeUnlink(pid);
      safeUnlink(sock);
    }

    // Remove stale socket file if it exists without a PID file
    if (existsSync(sock)) {
      log.warn("Removing stale socket file");
      safeUnlink(sock);
    }

    // Write current PID to PID file
    writeFileSync(pid, `${process.pid}\n`, { mode: 0o600 });

    return new DaemonRuntime(sock, pid, derivationId);
  }

  /** Socket file path */
  get socketFilePath(): string {
    return this._socketPath;
  }

  /** PID file path */
  get pidFilePath(): string {
    return this._pidPath;
  }

  /** Derivation ID */
  get derivationId(): string {
    return this._derivationId;
  }

  /**
   * Clean up PID and socket files.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   * Called automatically on process exit.
   */
  cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;

    safeUnlink(this._pidPath);
    safeUnlink(this._socketPath);

    // Unregister process exit handler
    process.removeListener("exit", this.exitHandler);
  }

  /**
   * Explicitly destroy the runtime (alias for cleanup).
   * Removes PID and socket files, unregisters handlers.
   */
  destroy(): void {
    this.cleanup();
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Safely delete a file, ignoring errors if it doesn't exist */
function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== 'ENOENT') {
      log.warn('Failed to remove daemon runtime file during cleanup', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

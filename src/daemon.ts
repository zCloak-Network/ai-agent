/**
 * Daemon Lifecycle Management — PID file, socket path, runtime directory
 *
 * Manages the daemon's file system footprint:
 *   - Runtime directory: ~/.vetkey-tool/ (created with 0o700 permissions)
 *   - PID file:   ~/.vetkey-tool/{sanitized_id}.pid
 *   - Socket file: ~/.vetkey-tool/{sanitized_id}.sock
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
import { homedir } from 'os';
import crypto from 'crypto';
import { daemonError } from './error.js';

/** Runtime directory name under home directory */
const RUNTIME_DIR_NAME = ".vetkey-tool";

/**
 * Maximum socket path length.
 * macOS limits Unix socket paths to 104 bytes, Linux to 108 bytes.
 * We use 100 as a safe threshold.
 */
const MAX_SOCKET_PATH_LEN = 100;

// ============================================================================
// Path Utilities
// ============================================================================

/** Get the runtime directory path (~/.vetkey-tool/) */
export function runtimeDir(): string {
  return join(homedir(), RUNTIME_DIR_NAME);
}

/**
 * Sanitize a derivation ID for use in file names.
 *
 * Replaces special characters (:, /, \) with underscores.
 * If the resulting path would exceed the Unix socket path limit,
 * falls back to a SHA-256 hash prefix (16 hex characters) to keep
 * the path short enough.
 *
 * @param derivationId - Raw derivation ID (e.g. "abc-def:default")
 * @returns Safe file name prefix
 */
export function sanitizeDerivationId(derivationId: string): string {
  const sanitized = derivationId
    .replace(/:/g, "_")
    .replace(/\//g, "_")
    .replace(/\\/g, "_");

  // Check if the full socket path would be too long
  const dir = runtimeDir();
  const fullPath = join(dir, `${sanitized}.sock`);
  if (fullPath.length > MAX_SOCKET_PATH_LEN) {
    // Use SHA-256 hash prefix for long derivation IDs
    const hash = crypto.createHash("sha256").update(derivationId).digest("hex");
    return `vk_${hash.slice(0, 16)}`;
  }

  return sanitized;
}

/** Get the socket file path for a derivation ID */
export function socketPath(derivationId: string): string {
  const name = sanitizeDerivationId(derivationId);
  return join(runtimeDir(), `${name}.sock`);
}

/** Get the PID file path for a derivation ID */
export function pidPath(derivationId: string): string {
  const name = sanitizeDerivationId(derivationId);
  return join(runtimeDir(), `${name}.pid`);
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
   * @param derivationId - Derivation ID for this daemon instance
   * @returns Initialized DaemonRuntime
   * @throws ToolError with code DAEMON if another instance is already running
   */
  static create(derivationId: string): DaemonRuntime {
    const dir = runtimeDir();
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
            `Daemon already running (PID ${existingPid}, derivation_id: ${derivationId}). ` +
            `Use 'zcloak-ai vetkey stop --key-name ...' to stop it first.`,
          );
        }

        // Stale PID file — clean up
        console.error(`Removing stale PID file (PID ${pidStr} no longer running)`);
      } catch (e) {
        // Re-throw ToolError (daemon already running)
        if (e instanceof Error && e.name === "ToolError") throw e;
        // Other errors (corrupted PID file) — just clean up
        console.error(`Removing corrupted PID file: ${e}`);
      }
      safeUnlink(pid);
      safeUnlink(sock);
    }

    // Remove stale socket file if it exists without a PID file
    if (existsSync(sock)) {
      console.error("Removing stale socket file");
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

/**
 * Find the socket path for a running daemon (used by stop/status commands).
 *
 * Checks if the socket file exists and the daemon is actually running
 * (via PID file check).
 *
 * @param derivationId - Derivation ID to look up
 * @returns Socket path if daemon is running
 * @throws ToolError if no running daemon is found
 */
export function findRunningDaemon(derivationId: string): string {
  const sock = socketPath(derivationId);
  const pid = pidPath(derivationId);

  if (!existsSync(sock)) {
    throw daemonError(
      `No running daemon found for derivation_id '${derivationId}'. ` +
      `Socket file not found: ${sock}`,
    );
  }

  // Optionally verify the PID is still alive
  if (existsSync(pid)) {
    try {
      const pidStr = readFileSync(pid, "utf-8").trim();
      const existingPid = parseInt(pidStr, 10);
      if (!isNaN(existingPid) && !isProcessAlive(existingPid)) {
        // Stale files — clean up
        safeUnlink(sock);
        safeUnlink(pid);
        throw daemonError(
          `Daemon for '${derivationId}' is no longer running (PID ${existingPid} is dead). ` +
          `Stale files have been cleaned up.`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.name === "ToolError") throw e;
      // Corrupted PID file but socket exists — try connecting anyway
    }
  }

  return sock;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Safely delete a file, ignoring errors if it doesn't exist */
function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore — file may not exist
  }
}

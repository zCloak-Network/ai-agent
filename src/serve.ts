/**
 * Daemon Serve — JSON-RPC over Unix Domain Socket
 *
 * The daemon creates a socket file and listens for connections. Each client
 * connection is handled independently. "quit" closes the connection;
 * "shutdown" stops the entire daemon.
 *
 * Trust model:
 *   - The daemon trusts its callers (local AI agent processes or socket clients).
 *   - File paths in encrypt/decrypt requests are not sandboxed — the daemon
 *     operates with the same filesystem permissions as the calling process.
 */

import { createServer, type Socket } from 'net';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KeyStore } from './key-store.js';
import { DaemonRuntime } from './daemon.js';
import type { PeriodicTaskHandle } from './daemon-tasks.js';
import {
  type RpcRequest,
  type RpcResponse,
  type EncryptParams,
  type DecryptParams,
  type IbeDecryptParams,
  type EncryptResult,
  type DecryptResult,
  type IbeDecryptResult,
  type StatusResult,
  successResponse,
  errorResponse,
  parseRpcRequest,
  isErrorResponse,
} from './rpc.js';
import * as log from './log.js';

/** Maximum data size for encrypt/decrypt operations (1 GB) */
const MAX_DATA_SIZE = 1024 * 1024 * 1024;

/** Maximum IBE ciphertext size for ibe-decrypt (64 KB payload + IBE overhead) */
const MAX_IBE_DATA_SIZE = 64 * 1024 + 256;

export type DaemonTaskFactory = () => PeriodicTaskHandle;

// ============================================================================
// Shared Request Handling
// ============================================================================

/** Result of handling a single request: response + whether to quit the connection/daemon */
interface HandleResult {
  response: RpcResponse;
  /** "quit" = close this connection, "shutdown" = stop entire daemon, "continue" = keep going */
  action: "continue" | "quit" | "shutdown";
}

/**
 * Handle a single JSON-RPC request line.
 *
 * Dispatches to the appropriate handler based on the method name.
 * Returns a response and an action indicating what to do next.
 */
function handleRequest(
  req: RpcRequest,
  activeKeyStore: KeyStore,
  mailKeyStore: KeyStore | null,
  principal: string,
  startedAt: string,
  sockPath: string,
): HandleResult {
  const { id, method } = req;
  const effectiveMailKeyStore = mailKeyStore ?? activeKeyStore;
  const loadedKeyNames = [activeKeyStore, effectiveMailKeyStore]
    .filter((store, index, stores): store is KeyStore =>
      store !== null && stores.findIndex(candidate => candidate?.derivationId === store.derivationId) === index,
    )
    .map(store => store.derivationId.split(':').slice(1).join(':') || 'default');

  switch (method) {
    case "encrypt": {
      const result = handleEncrypt(req.params as EncryptParams | undefined, activeKeyStore);
      if ("error" in result) {
        return { response: errorResponse(id, result.error), action: "continue" };
      }
      return { response: successResponse(id, result), action: "continue" };
    }

    case "decrypt": {
      const result = handleDecrypt(req.params as DecryptParams | undefined, activeKeyStore);
      if ("error" in result) {
        return { response: errorResponse(id, result.error), action: "continue" };
      }
      return { response: successResponse(id, result), action: "continue" };
    }

    case "ibe-decrypt": {
      const result = handleIbeDecrypt(req.params as IbeDecryptParams | undefined, effectiveMailKeyStore);
      if ("error" in result) {
        return { response: errorResponse(id, result.error), action: "continue" };
      }
      return { response: successResponse(id, result), action: "continue" };
    }

    case "status": {
      const status: StatusResult = {
        status: "running",
        derivation_id: activeKeyStore.derivationId,
        principal,
        loaded_key_names: loadedKeyNames,
        started_at: startedAt,
        socket_path: sockPath,
      };
      return { response: successResponse(id, status), action: "continue" };
    }

    case "quit":
      // Close this client connection only
      return {
        response: successResponse(id, { message: "Connection closed" }),
        action: "quit",
      };

    case "shutdown":
      // Stop the entire daemon
      return {
        response: successResponse(id, { message: "Shutting down, key zeroized" }),
        action: "shutdown",
      };

    default:
      return {
        response: errorResponse(
          id,
          `Unknown method '${method}'. Supported: encrypt, decrypt, ibe-decrypt, status, quit, shutdown`,
        ),
        action: "continue",
      };
  }
}

// ============================================================================
// Encrypt / Decrypt Handlers
// ============================================================================

/**
 * Handle the "encrypt" method.
 * Supports file mode (input_file + output_file) and inline mode (data_base64).
 */
function handleEncrypt(
  params: EncryptParams | undefined,
  keyStore: KeyStore,
): EncryptResult | { error: string } {
  if (!params) return { error: "Missing encrypt params" };

  if (params.input_file && params.data_base64) {
    return { error: "Cannot specify both input_file and data_base64" };
  }

  if (params.input_file) {
    // File mode
    if (!params.output_file) {
      return { error: "output_file is required in file mode" };
    }

    const readResult = readFileChecked(params.input_file);
    if ("error" in readResult) return readResult;
    const plaintext = readResult;
    const plaintextSize = plaintext.length;

    let ciphertext: Buffer;
    try {
      ciphertext = keyStore.encrypt(plaintext);
    } catch (e) {
      return { error: `Encryption failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    try {
      writeFileSync(params.output_file, ciphertext);
    } catch (e) {
      return { error: `Failed to write '${params.output_file}': ${e instanceof Error ? e.message : String(e)}` };
    }

    return {
      output_file: params.output_file,
      plaintext_size: plaintextSize,
      ciphertext_size: ciphertext.length,
    };
  }

  if (params.data_base64) {
    // Inline mode — check size before decoding
    if (params.data_base64.length > MAX_DATA_SIZE * 4 / 3 + 4) {
      return {
        error: `data_base64 too large: ${params.data_base64.length} chars (decoded would exceed ${MAX_DATA_SIZE} byte limit)`,
      };
    }

    let plaintext: Buffer;
    try {
      plaintext = Buffer.from(params.data_base64, "base64");
    } catch (e) {
      return { error: `Invalid base64 input: ${e instanceof Error ? e.message : String(e)}` };
    }

    const plaintextSize = plaintext.length;

    let ciphertext: Buffer;
    try {
      ciphertext = keyStore.encrypt(plaintext);
    } catch (e) {
      return { error: `Encryption failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Write ciphertext to output file (use provided path or auto-generate)
    const outputFile = params.output_file
      ?? join(tmpdir(), `vetkey_encrypted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.enc`);
    try {
      writeFileSync(outputFile, ciphertext);
    } catch (e) {
      return { error: `Failed to write '${outputFile}': ${e instanceof Error ? e.message : String(e)}` };
    }

    return {
      output_file: outputFile,
      data_base64: ciphertext.toString("base64"),
      plaintext_size: plaintextSize,
      ciphertext_size: ciphertext.length,
    };
  }

  return { error: "Either input_file or data_base64 must be provided" };
}

/**
 * Handle the "decrypt" method.
 * Supports file mode (input_file + output_file) and inline mode (data_base64).
 */
function handleDecrypt(
  params: DecryptParams | undefined,
  keyStore: KeyStore,
): DecryptResult | { error: string } {
  if (!params) return { error: "Missing decrypt params" };

  if (params.input_file && params.data_base64) {
    return { error: "Cannot specify both input_file and data_base64" };
  }

  if (params.input_file) {
    // File mode
    if (!params.output_file) {
      return { error: "output_file is required in file mode" };
    }

    const readResult = readFileChecked(params.input_file);
    if ("error" in readResult) return readResult;
    const ciphertext = readResult;

    let plaintext: Buffer;
    try {
      plaintext = keyStore.decrypt(ciphertext);
    } catch (e) {
      return { error: `Decryption failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    try {
      writeFileSync(params.output_file, plaintext);
    } catch (e) {
      return { error: `Failed to write '${params.output_file}': ${e instanceof Error ? e.message : String(e)}` };
    }

    return {
      output_file: params.output_file,
      plaintext_size: plaintext.length,
    };
  }

  if (params.data_base64) {
    // Inline mode
    if (params.data_base64.length > MAX_DATA_SIZE * 4 / 3 + 4) {
      return {
        error: `data_base64 too large: ${params.data_base64.length} chars (decoded would exceed ${MAX_DATA_SIZE} byte limit)`,
      };
    }

    let ciphertext: Buffer;
    try {
      ciphertext = Buffer.from(params.data_base64, "base64");
    } catch (e) {
      return { error: `Invalid base64 input: ${e instanceof Error ? e.message : String(e)}` };
    }

    let plaintext: Buffer;
    try {
      plaintext = keyStore.decrypt(ciphertext);
    } catch (e) {
      return { error: `Decryption failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    return {
      data_base64: plaintext.toString("base64"),
      plaintext_size: plaintext.length,
    };
  }

  return { error: "Either input_file or data_base64 must be provided" };
}

/**
 * Handle the "ibe-decrypt" method.
 *
 * Decrypts IBE ciphertext using the VetKey cached in KeyStore.
 * Used by Mail daemon mode: the sender IBE-encrypted a message for
 * this daemon's derivation identity, and we hold the VetKey to decrypt it.
 */
function handleIbeDecrypt(
  params: IbeDecryptParams | undefined,
  keyStore: KeyStore,
): IbeDecryptResult | { error: string } {
  if (!params) return { error: "Missing ibe-decrypt params" };

  if (!keyStore.hasIbeSupport) {
    return { error: "This daemon does not have IBE support (VetKey not cached)" };
  }

  if (!params.ibe_identity) {
    return { error: "ibe_identity is required" };
  }

  if (!params.ciphertext_base64) {
    return { error: "ciphertext_base64 is required" };
  }
  if (params.ibe_identity !== keyStore.derivationId) {
    return {
      error: `ibe_identity mismatch: expected "${keyStore.derivationId}", got "${params.ibe_identity}"`,
    };
  }

  // Size check before base64 decode
  if (params.ciphertext_base64.length > MAX_IBE_DATA_SIZE * 4 / 3 + 4) {
    return {
      error: `ciphertext_base64 too large: ${params.ciphertext_base64.length} chars (max payload ${MAX_IBE_DATA_SIZE} bytes)`,
    };
  }

  let ciphertext: Buffer;
  try {
    ciphertext = decodeBase64Strict(params.ciphertext_base64, "ciphertext_base64");
  } catch (e) {
    return { error: `Invalid base64 ciphertext: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (ciphertext.length > MAX_IBE_DATA_SIZE) {
    return {
      error: `ciphertext too large after decode: ${ciphertext.length} bytes (max ${MAX_IBE_DATA_SIZE} bytes)`,
    };
  }

  let plaintext: Buffer;
  try {
    plaintext = keyStore.ibeDecrypt(params.ibe_identity, ciphertext);
  } catch (e) {
    return { error: `IBE decryption failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  return {
    data_base64: plaintext.toString("base64"),
    plaintext_size: plaintext.length,
  };
}

function decodeBase64Strict(value: string, fieldName: string): Buffer {
  if (value.length === 0) {
    return Buffer.alloc(0);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected base64`);
  }
  return Buffer.from(value, "base64");
}

/**
 * Read a file with size validation to limit memory usage.
 * Rejects files larger than MAX_DATA_SIZE and non-regular files.
 */
function readFileChecked(filePath: string): Buffer | { error: string } {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { error: `'${filePath}' is not a regular file (refusing to read devices/pipes/sockets)` };
    }
    if (stat.size > MAX_DATA_SIZE) {
      return { error: `File '${filePath}' is too large: ${stat.size} bytes (max ${MAX_DATA_SIZE} bytes)` };
    }
    return readFileSync(filePath);
  } catch (e) {
    return { error: `Cannot read '${filePath}': ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ============================================================================
// UDS Daemon
// ============================================================================

/**
 * Run the JSON-RPC daemon over a Unix Domain Socket.
 *
 * Lifecycle:
 *   1. Create DaemonRuntime (PID file, socket path)
 *   2. Create server and listen on socket
 *   3. Emit ready info to stderr
 *   4. Accept connections, handle requests concurrently
 *   5. On shutdown signal: stop accepting, close connections, cleanup
 *
 * @param activeKeyStore - AES-256 key holder used for encrypt/decrypt
 * @param mailKeyStore - Optional Mail key holder used for ibe-decrypt
 * @param principal - Authenticated principal text
 * @param daemonId - Daemon runtime identifier (one socket/PID pair)
 */
export function runDaemonUds(
  activeKeyStore: KeyStore,
  mailKeyStore: KeyStore | null,
  principal: string,
  daemonId: string,
  taskFactories: DaemonTaskFactory[] = [],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Step 1: Create daemon runtime (PID file, socket setup)
    const runtime = DaemonRuntime.create(daemonId);
    const startedAt = new Date().toISOString();
    const sockPath = runtime.socketFilePath;
    const backgroundTasks: PeriodicTaskHandle[] = [];

    // Track active connections for graceful shutdown
    const activeConnections = new Set<Socket>();

    // Step 2: Create server
    const server = createServer((conn: Socket) => {
      activeConnections.add(conn);

      conn.on("close", () => {
        activeConnections.delete(conn);
      });

      // Handle each connection with line-based JSON-RPC
      const rl = createInterface({ input: conn });

      rl.on("line", (line: string) => {
        if (!line.trim()) return; // Skip blank lines

        // Parse the request
        const parsed = parseRpcRequest(line);
        if (isErrorResponse(parsed)) {
          // Parse error — send error response
          writeLine(conn, JSON.stringify(parsed));
          return;
        }

        // Handle the request
        const { response, action } = handleRequest(
          parsed,
          activeKeyStore,
          mailKeyStore,
          principal,
          startedAt,
          sockPath,
        );

        writeLine(conn, JSON.stringify(response));

        if (action === "quit") {
          // Close this connection only
          conn.end();
        } else if (action === "shutdown") {
          // Stop the entire daemon
          initiateShutdown();
        }
      });

      rl.on("close", () => {
        conn.end();
      });

      conn.on("error", () => {
        // Client disconnected unexpectedly — just clean up
        activeConnections.delete(conn);
      });
    });

    // Step 3: Listen on socket
    server.listen(sockPath, () => {
      // Emit ready info to stderr
      log.info(`Daemon ready. Socket: ${sockPath}`);
      log.info(`Active derivation ID: ${activeKeyStore.derivationId}`);
      if (mailKeyStore && mailKeyStore.derivationId !== activeKeyStore.derivationId) {
        log.info(`Mail derivation ID: ${mailKeyStore.derivationId}`);
      }
      log.info(`Principal: ${principal}`);
      for (const createTask of taskFactories) {
        try {
          backgroundTasks.push(createTask());
        } catch (error) {
          log.warn('Failed to start daemon background task', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    server.on("error", (err) => {
      for (const task of backgroundTasks) {
        task.stop();
      }
      runtime.destroy();
      reject(err);
    });

    // Step 4: Signal handling — store references for cleanup in finishShutdown()
    const onSigterm = () => { log.warn("Received SIGTERM, initiating graceful shutdown..."); initiateShutdown(); };
    const onSigint = () => { log.warn("Received SIGINT, initiating graceful shutdown..."); initiateShutdown(); };
    // SIGHUP: terminal hangup — gracefully shut down instead of crashing
    const onSighup = () => { log.warn("Received SIGHUP, initiating graceful shutdown..."); initiateShutdown(); };

    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);
    process.on("SIGHUP", onSighup);

    // Catch uncaught exceptions / unhandled rejections to ensure key zeroization
    // and PID file cleanup even on unexpected errors.
    const onUncaughtException = (err: Error) => {
      log.error(`Uncaught exception in daemon: ${err.message}`);
      log.error(err.stack);
      initiateShutdown();
    };
    const onUnhandledRejection = (reason: unknown) => {
      log.error(`Unhandled rejection in daemon: ${reason}`);
      initiateShutdown();
    };

    process.on("uncaughtException", onUncaughtException);
    process.on("unhandledRejection", onUnhandledRejection);

    // Shutdown procedure
    let shuttingDown = false;

    function initiateShutdown() {
      if (shuttingDown) return;
      shuttingDown = true;

      // Stop accepting new connections
      server.close();

      // Close all active connections
      for (const conn of activeConnections) {
        conn.end();
      }

      // Wait a moment for connections to close, then force cleanup
      const forceTimer = setTimeout(() => {
        for (const conn of activeConnections) {
          conn.destroy();
        }
        finishShutdown();
      }, 3000); // 3 second grace period

      // If all connections close before timeout, finish immediately
      const checkDone = setInterval(() => {
        if (activeConnections.size === 0) {
          clearInterval(checkDone);
          clearTimeout(forceTimer);
          finishShutdown();
        }
      }, 100);
    }

    let finished = false;

    function finishShutdown() {
      if (finished) return;
      finished = true;

      // Remove all process-level event listeners to prevent leaks
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGHUP", onSighup);
      process.removeListener("uncaughtException", onUncaughtException);
      process.removeListener("unhandledRejection", onUnhandledRejection);
      for (const task of backgroundTasks) {
        task.stop();
      }

      // Cleanup: destroy key, remove files
      const uniqueKeyStores = [activeKeyStore, mailKeyStore]
        .filter((store, index, stores): store is KeyStore =>
          store !== null && stores.findIndex(candidate => candidate?.derivationId === store.derivationId) === index,
        );
      for (const store of uniqueKeyStores) {
        store.destroy();
      }
      runtime.destroy();

      log.info("Daemon stopped. Key has been zeroized.");
      resolve();
    }
  });
}

// ============================================================================
// Helpers
// ============================================================================

/** Write a line to a socket, handling write errors gracefully */
function writeLine(socket: Socket, line: string): void {
  try {
    socket.write(line + "\n");
  } catch {
    // Socket may have been closed — ignore write errors
  }
}

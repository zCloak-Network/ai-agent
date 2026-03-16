/**
 * JSON-RPC Protocol Types — newline-delimited JSON over Unix Domain Socket
 *
 * Protocol specification:
 *   - One JSON object per line (newline-delimited)
 *   - Request: {"id": <number|string>, "method": <string>, "params": <object>}
 *   - Response: {"id": <same>, "result": <object>} or {"id": <same>, "error": <string>}
 *
 * Supported methods:
 *   encrypt      — Encrypt file or inline data using the held AES-256 key
 *   decrypt      — Decrypt file or inline data using the held AES-256 key
 *   ibe-decrypt  — Decrypt IBE ciphertext using cached VetKey (Mail daemon mode)
 *   status       — Query daemon status (derivation_id, principal, uptime)
 *   quit         — Close current client connection
 *   shutdown     — Stop the entire daemon gracefully
 */

// ============================================================================
// Request types
// ============================================================================

/** JSON-RPC request wrapper (simplified JSON-RPC 2.0 without "jsonrpc" field) */
export interface RpcRequest {
  /** Request ID for matching responses (number or string) */
  id: number | string | null;
  /** Method name: "encrypt", "decrypt", "ibe-decrypt", "status", "quit", or "shutdown" */
  method: string;
  /** Method parameters (optional, defaults to null) */
  params?: Record<string, unknown>;
}

/**
 * Parameters for the "encrypt" method.
 *
 * Two modes:
 *   1. File mode: specify `input_file` + `output_file`, reads/writes files on disk
 *   2. Inline mode: specify `data_base64`, returns result as base64 (no file I/O)
 */
export interface EncryptParams {
  /** Input file path (mutually exclusive with data_base64) */
  input_file?: string;
  /** Output file path (required in file mode; auto-generated in inline mode if not specified) */
  output_file?: string;
  /** Inline plaintext as base64 (mutually exclusive with input_file) */
  data_base64?: string;
}

/**
 * Parameters for the "decrypt" method.
 * Same two modes as EncryptParams (file mode vs inline mode).
 */
export interface DecryptParams {
  /** Input file path (mutually exclusive with data_base64) */
  input_file?: string;
  /** Output file path (required in file mode) */
  output_file?: string;
  /** Inline ciphertext as base64 (mutually exclusive with input_file) */
  data_base64?: string;
}

/**
 * Parameters for the "ibe-decrypt" method (Mail daemon mode).
 *
 * Decrypts IBE ciphertext using the VetKey cached at daemon startup.
 * The sender encrypted with ibeEncrypt(dpk, "{recipient}:Mail", message),
 * and this daemon holds the VetKey for that identity.
 */
export interface IbeDecryptParams {
  /** IBE identity string used during encryption (e.g. "{principal}:Mail") */
  ibe_identity: string;
  /** IBE ciphertext as base64 */
  ciphertext_base64: string;
}

/** Result payload for the "ibe-decrypt" method */
export interface IbeDecryptResult {
  /** Base64-encoded decrypted plaintext */
  data_base64: string;
  /** Decrypted plaintext size in bytes */
  plaintext_size: number;
}

// ============================================================================
// Response types
// ============================================================================

/** JSON-RPC response wrapper. Exactly one of `result` or `error` will be present. */
export interface RpcResponse {
  /** Matching request ID */
  id: number | string | null;
  /** Success result (present on success) */
  result?: unknown;
  /** Error message (present on failure) */
  error?: string;
}

/** Result payload for the "encrypt" method */
export interface EncryptResult {
  /** Output file path (file mode only) */
  output_file?: string;
  /** Base64-encoded ciphertext (inline mode only) */
  data_base64?: string;
  /** Original plaintext size in bytes */
  plaintext_size: number;
  /** Ciphertext size in bytes (includes nonce + GCM tag overhead) */
  ciphertext_size: number;
}

/** Result payload for the "decrypt" method */
export interface DecryptResult {
  /** Output file path (file mode only) */
  output_file?: string;
  /** Base64-encoded plaintext (inline mode only) */
  data_base64?: string;
  /** Decrypted plaintext size in bytes */
  plaintext_size: number;
}

/** Result payload for the "status" method */
export interface StatusResult {
  /** Daemon status (always "running" while daemon is alive) */
  status: "running";
  /** Derivation ID used for this session's key (e.g. "{principal}:default") */
  derivation_id: string;
  /** Authenticated principal text */
  principal: string;
  /** Daemon start timestamp (ISO 8601) */
  started_at: string;
  /** Unix socket path */
  socket_path?: string;
}

// ============================================================================
// Helper functions
// ============================================================================

/** Create a JSON-RPC success response */
export function successResponse(id: number | string | null, result: unknown): RpcResponse {
  return { id, result };
}

/** Create a JSON-RPC error response */
export function errorResponse(id: number | string | null, error: string): RpcResponse {
  return { id, error };
}

/**
 * Parse a JSON line into an RpcRequest.
 * Returns the parsed request, or an error response if parsing fails.
 */
export function parseRpcRequest(line: string): RpcRequest | RpcResponse {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") {
      return errorResponse(null, "Invalid JSON-RPC: not an object");
    }
    if (typeof parsed.method !== "string") {
      return errorResponse(parsed.id ?? null, "Invalid JSON-RPC: missing 'method' field");
    }
    return {
      id: parsed.id ?? null,
      method: parsed.method,
      params: parsed.params ?? undefined,
    } as RpcRequest;
  } catch (e) {
    return errorResponse(null, `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Check if a value is an RpcResponse (used for distinguishing parse errors from valid requests) */
export function isErrorResponse(value: RpcRequest | RpcResponse): value is RpcResponse {
  return "error" in value && typeof (value as RpcResponse).error === "string";
}

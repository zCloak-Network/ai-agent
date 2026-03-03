/**
 * zCloak.ai Identity Management Module
 *
 * Loads ECDSA secp256k1 identity from dfx-compatible PEM files for signing operations.
 * Replaces the original `dfx identity get-principal` and similar commands.
 *
 * dfx generates EC PRIVATE KEY (SEC1/PKCS#1 format, OID 1.3.132.0.10 secp256k1),
 * which is handled by Secp256k1KeyIdentity from @dfinity/identity-secp256k1.
 *
 * PEM file location priority:
 *   1. --identity=<path> command line argument
 *   2. ZCLOAK_IDENTITY environment variable
 *   3. ~/.config/dfx/identity/default/identity.pem (dfx default location)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { Secp256k1KeyIdentity } from '@dfinity/identity-secp256k1';
import type { Principal } from '@dfinity/principal';

// ========== PEM File Lookup ==========

/**
 * dfx default identity PEM file path
 * Unified for macOS and Linux: ~/.config/dfx/identity/default/identity.pem
 */
export const DEFAULT_PEM_PATH: string = path.join(
  os.homedir(),
  '.config', 'dfx', 'identity', 'default', 'identity.pem'
);

/**
 * Get PEM file path.
 * Searches by priority: --identity argument > environment variable > dfx default location.
 *
 * When called with an explicit argv array, uses that instead of process.argv.
 * This enables deterministic, testable behavior without global state dependency.
 *
 * @param argv - Optional explicit argument array (defaults to process.argv)
 * @returns Absolute path to PEM file
 * @throws {Error} If no PEM file can be found or the specified path does not exist
 */
export function getPemPath(argv?: string[]): string {
  const effectiveArgv = argv ?? process.argv;

  // 1. Get from --identity=<path> argument
  const identityArg = effectiveArgv.find(a => a.startsWith('--identity='));
  if (identityArg) {
    const p = identityArg.split('=').slice(1).join('='); // Support paths containing =
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Specified PEM file does not exist: ${resolved}`);
    }
    return resolved;
  }

  // 2. Get from environment variable
  if (process.env.ZCLOAK_IDENTITY) {
    const resolved = path.resolve(process.env.ZCLOAK_IDENTITY);
    if (!fs.existsSync(resolved)) {
      throw new Error(`PEM file specified by ZCLOAK_IDENTITY does not exist: ${resolved}`);
    }
    return resolved;
  }

  // 3. Use dfx default location
  if (fs.existsSync(DEFAULT_PEM_PATH)) {
    return DEFAULT_PEM_PATH;
  }

  throw new Error(
    'Identity PEM file not found. Provide one via:\n' +
    '  1. --identity=<pem_file_path>\n' +
    '  2. Set environment variable ZCLOAK_IDENTITY=<pem_file_path>\n' +
    `  3. Ensure dfx default identity exists: ${DEFAULT_PEM_PATH}`
  );
}

// ========== Identity Management ==========

/** Cached identity instance (loaded from the resolved PEM path) */
let _identity: Secp256k1KeyIdentity | null = null;

/**
 * Load an ECDSA secp256k1 identity directly from a given PEM file path.
 *
 * Unlike loadIdentity(), this function does NOT use the cached singleton and
 * does NOT read the PEM path from argv/environment variables. It is intended
 * for cases where the caller already knows the exact path (e.g. after generating
 * a new key file).
 *
 * Uses Secp256k1KeyIdentity.fromPem() which handles the dfx PEM format:
 *   -----BEGIN EC PRIVATE KEY-----   (SEC1 / RFC 5915 format)
 *   <base64 encoded DER data>
 *   -----END EC PRIVATE KEY-----
 *
 * @param pemPath - Absolute path to the PEM file
 * @returns Secp256k1KeyIdentity
 * @throws {Error} If the PEM file cannot be read or parsed
 */
export function loadIdentityFromPath(pemPath: string): Secp256k1KeyIdentity {
  const pemContent = fs.readFileSync(pemPath, 'utf-8');
  try {
    return Secp256k1KeyIdentity.fromPem(pemContent);
  } catch (err) {
    throw new Error(
      `Failed to load ECDSA secp256k1 identity from ${pemPath}: ${(err as Error).message}`
    );
  }
}

/**
 * Load ECDSA secp256k1 identity, resolving the PEM path from argv / env / default.
 *
 * Returns a cached instance on subsequent calls to avoid re-reading the file.
 *
 * @deprecated Uses module-level cache (global mutable state) and reads process.argv implicitly.
 * Use Session.getIdentity() instead for per-invocation state management.
 */
export function loadIdentity(): Secp256k1KeyIdentity {
  if (_identity) return _identity;

  const pemPath = getPemPath();
  _identity = loadIdentityFromPath(pemPath);
  return _identity;
}

/**
 * Get current identity's Principal ID (text format)
 * Replaces the original `dfx identity get-principal`
 *
 * @deprecated Uses module-level cache via loadIdentity(). Use Session.getPrincipal() instead.
 */
export function getPrincipal(): string {
  const identity = loadIdentity();
  return identity.getPrincipal().toText();
}

/**
 * Get current identity's Principal object
 *
 * @deprecated Uses module-level cache via loadIdentity(). Use Session.getPrincipalObj() instead.
 */
export function getPrincipalObj(): Principal {
  const identity = loadIdentity();
  return identity.getPrincipal();
}

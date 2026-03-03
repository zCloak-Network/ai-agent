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
 * Get PEM file path
 * Searches by priority: --identity argument > environment variable > dfx default location
 * @returns Absolute path to PEM file
 */
export function getPemPath(): string {
  // 1. Get from --identity=<path> argument
  const identityArg = process.argv.find(a => a.startsWith('--identity='));
  if (identityArg) {
    const p = identityArg.split('=').slice(1).join('='); // Support paths containing =
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) {
      console.error(`Error: specified PEM file does not exist: ${resolved}`);
      process.exit(1);
    }
    return resolved;
  }

  // 2. Get from environment variable
  if (process.env.ZCLOAK_IDENTITY) {
    const resolved = path.resolve(process.env.ZCLOAK_IDENTITY);
    if (!fs.existsSync(resolved)) {
      console.error(`Error: PEM file specified by ZCLOAK_IDENTITY does not exist: ${resolved}`);
      process.exit(1);
    }
    return resolved;
  }

  // 3. Use dfx default location
  if (fs.existsSync(DEFAULT_PEM_PATH)) {
    return DEFAULT_PEM_PATH;
  }

  console.error('Error: identity PEM file not found.');
  console.error('Please provide one via:');
  console.error('  1. --identity=<pem_file_path>');
  console.error('  2. Set environment variable ZCLOAK_IDENTITY=<pem_file_path>');
  console.error(`  3. Ensure dfx default identity exists: ${DEFAULT_PEM_PATH}`);
  process.exit(1);
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
 */
export function loadIdentityFromPath(pemPath: string): Secp256k1KeyIdentity {
  const pemContent = fs.readFileSync(pemPath, 'utf-8');
  try {
    return Secp256k1KeyIdentity.fromPem(pemContent);
  } catch (err) {
    console.error(`Error: failed to load ECDSA secp256k1 identity from ${pemPath}`);
    console.error((err as Error).message);
    process.exit(1);
  }
}

/**
 * Load ECDSA secp256k1 identity, resolving the PEM path from argv / env / default.
 *
 * Returns a cached instance on subsequent calls to avoid re-reading the file.
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
 */
export function getPrincipal(): string {
  const identity = loadIdentity();
  return identity.getPrincipal().toText();
}

/**
 * Get current identity's Principal object
 */
export function getPrincipalObj(): Principal {
  const identity = loadIdentity();
  return identity.getPrincipal();
}

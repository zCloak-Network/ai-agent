/**
 * zCloak.ai Identity Management Module
 *
 * Loads ECDSA secp256k1 identity from a zCloak-managed PEM file for signing operations.
 *
 * The CLI uses a dedicated default path under ~/.config/zcloak/ai-id.pem rather than
 * reusing dfx's default identity location. This keeps the agent identity stable and
 * separate from any existing dfx identity the user may already have.
 *
 * PEM file location priority:
 *   1. --identity=<path> command line argument
 *   2. ~/.config/zcloak/ai-id.pem (zCloak default location, auto-created if missing)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateKeyPairSync } from 'crypto';
import { Secp256k1KeyIdentity } from '@dfinity/identity-secp256k1';


// ========== PEM File Lookup ==========

/**
 * zCloak default identity PEM file path
 * Unified for macOS and Linux: ~/.config/zcloak/ai-id.pem
 */
export const DEFAULT_PEM_PATH: string = path.join(
  os.homedir(),
  '.config', 'zcloak', 'ai-id.pem'
);

/**
 * Expand CLI paths like ~/foo.pem to an absolute path.
 */
export function resolveCliPath(rawPath: string): string {
  if (rawPath === '~') {
    return os.homedir();
  }
  if (rawPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return path.resolve(rawPath);
}

/**
 * Ensure a PEM file exists at the requested path.
 * If the file already exists, validate and reuse it unless force=true.
 * If the file does not exist, create parent directories and generate a new key.
 */
export function ensureIdentityFile(
  pemPath: string,
  options?: { force?: boolean },
): { path: string; created: boolean } {
  const resolved = resolveCliPath(pemPath);
  const force = !!options?.force;

  if (fs.existsSync(resolved) && !force) {
    try {
      loadIdentityFromPath(resolved);
      return { path: resolved, created: false };
    } catch {
      throw new Error(`Identity file exists but is not a valid PEM: ${resolved}`);
    }
  }

  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pem = privateKey.export({ type: 'sec1', format: 'pem' }) as string;
  fs.writeFileSync(resolved, pem, { mode: 0o600 });
  return { path: resolved, created: true };
}

/**
 * Get PEM file path.
 * Searches by priority: --identity argument > zCloak default location.
 * The zCloak default location is created automatically on first use.
 *
 * When called with an explicit argv array, uses that instead of process.argv.
 * This enables deterministic, testable behavior without global state dependency.
 *
  * @param argv - Optional explicit argument array (defaults to process.argv)
 * @param defaultPemPath - Override for tests
 * @returns Absolute path to PEM file
 * @throws {Error} If an explicitly specified path does not exist
 */
export function getPemPath(argv?: string[], defaultPemPath: string = DEFAULT_PEM_PATH): string {
  const effectiveArgv = argv ?? process.argv;
  const resolvedDefault = resolveCliPath(defaultPemPath);

  // 1. Get from --identity=<path> argument
  const identityArg = effectiveArgv.find(a => a.startsWith('--identity='));
  if (identityArg) {
    const p = identityArg.split('=').slice(1).join('='); // Support paths containing =
    const resolved = resolveCliPath(p);
    if (!fs.existsSync(resolved)) {
      if (resolved === resolvedDefault) {
        ensureIdentityFile(resolvedDefault);
        return resolvedDefault;
      }
      throw new Error(`Specified PEM file does not exist: ${resolved}`);
    }
    return resolved;
  }

  ensureIdentityFile(resolvedDefault);
  return resolvedDefault;
}

// ========== Identity Management ==========

/**
 * Load an ECDSA secp256k1 identity directly from a given PEM file path.
 *
 * Does NOT read the PEM path from argv/environment variables. It is intended
 * for cases where the caller already knows the exact path (e.g. after generating
 * a new key file, or when Session has already resolved the path).
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

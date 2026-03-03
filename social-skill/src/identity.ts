/**
 * zCloak.ai Identity Management Module
 *
 * Loads Ed25519 identity from dfx-compatible PEM files for signing operations.
 * Replaces the original `dfx identity get-principal` and similar commands.
 *
 * PEM file location priority:
 *   1. --identity=<path> command line argument
 *   2. ZCLOAK_IDENTITY environment variable
 *   3. ~/.config/dfx/identity/default/identity.pem (dfx default location)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { Ed25519KeyIdentity } from '@dfinity/identity';
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

// ========== PEM Parsing ==========

/**
 * Parse Ed25519 private key from PEM file content
 *
 * dfx-generated PEM file format:
 *   -----BEGIN EC PRIVATE KEY-----
 *   <base64 encoded DER data>
 *   -----END EC PRIVATE KEY-----
 *
 * DER structure (PKCS#8 Ed25519):
 *   SEQUENCE {
 *     INTEGER 0
 *     SEQUENCE { OID 1.3.101.112 (Ed25519) }
 *     OCTET STRING { OCTET STRING { <32 bytes private key> } }
 *   }
 *   Total 48 bytes, private key starts at offset 16, length 32 bytes
 *
 * @param pemContent - PEM file content
 * @returns 32-byte Ed25519 private key
 */
function parsePemToSecretKey(pemContent: string): Uint8Array {
  // Remove PEM header/footer and all whitespace
  const base64 = pemContent
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '')
    .replace(/\s/g, '');

  if (!base64) {
    throw new Error('PEM file content is empty or malformed');
  }

  const der = Buffer.from(base64, 'base64');

  // Ed25519 PKCS#8 DER should be 48 bytes
  // But some dfx versions may generate slightly different formats, so handle compatibility
  if (der.length === 48) {
    // Standard PKCS#8 Ed25519: private key at offset 16, length 32
    return new Uint8Array(der.slice(16, 48));
  }

  if (der.length === 34) {
    // Some formats: directly OCTET STRING { <32 bytes> }
    return new Uint8Array(der.slice(2, 34));
  }

  if (der.length === 32) {
    // Raw 32-byte private key
    return new Uint8Array(der);
  }

  // Try to find the embedded 32-byte OCTET STRING in DER
  // Pattern: 0x04 0x20 followed by 32 bytes
  for (let i = der.length - 34; i >= 0; i--) {
    if (der[i] === 0x04 && der[i + 1] === 0x20) {
      return new Uint8Array(der.slice(i + 2, i + 34));
    }
  }

  throw new Error(
    `Failed to extract Ed25519 private key from DER data (DER length: ${der.length} bytes). ` +
    'Please ensure the PEM file contains a valid Ed25519 private key.'
  );
}

// ========== Identity Management ==========

/** Cached identity instance */
let _identity: Ed25519KeyIdentity | null = null;

/**
 * Load Ed25519 identity
 * Loads from PEM file or uses cached instance
 */
export function loadIdentity(): Ed25519KeyIdentity {
  if (_identity) return _identity;

  const pemPath = getPemPath();
  const pemContent = fs.readFileSync(pemPath, 'utf-8');
  const secretKey = parsePemToSecretKey(pemContent);

  _identity = Ed25519KeyIdentity.fromSecretKey(secretKey);
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

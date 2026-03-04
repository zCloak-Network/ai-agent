#!/usr/bin/env node
/**
 * zCloak.ai Identity Key Management Script
 *
 * Generates and inspects ECDSA secp256k1 identity PEM files without requiring dfx.
 * Uses Node.js built-in crypto module to produce the same SEC1 PEM format that dfx generates.
 *
 * Usage:
 *   zcloak-ai identity generate [--output=<path>] [--force]
 *       Generate a new secp256k1 private key PEM file.
 *       Default output: ~/.config/dfx/identity/default/identity.pem
 *       Use --force to overwrite an existing file.
 *
 *   zcloak-ai identity show
 *       Print the PEM path and principal ID of the current identity.
 */

import fs from 'fs';
import path from 'path';
import { generateKeyPairSync } from 'crypto';
import { DEFAULT_PEM_PATH, loadIdentityFromPath } from './identity.js';
import { Session } from './session.js';
import type { ParsedArgs } from './types/common.js';

// ========== Help ==========

function showHelp(): void {
  console.log('zCloak.ai Identity Key Management');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai identity generate [--output=<path>] [--force]');
  console.log('      Generate a new ECDSA secp256k1 PEM key file (no dfx required)');
  console.log('      Default path: ~/.config/dfx/identity/default/identity.pem');
  console.log('');
  console.log('  zcloak-ai identity show');
  console.log('      Print PEM file path and principal ID of the current identity');
  console.log('');
  console.log('Options:');
  console.log('  --output=<path>    Custom output path for the generated PEM file');
  console.log('  --force            Overwrite existing PEM file without error');
  console.log('  --identity=<path>  Use a specific identity PEM (for "show" command)');
  console.log('');
  console.log('Examples:');
  console.log('  zcloak-ai identity generate');
  console.log('  zcloak-ai identity generate --output=./my-agent.pem');
  console.log('  zcloak-ai identity generate --force');
  console.log('  zcloak-ai identity show');
  console.log('  zcloak-ai identity show --identity=./my-agent.pem');
}

// ========== Commands ==========

/**
 * Generate a new ECDSA secp256k1 PEM file.
 *
 * Node.js `generateKeyPairSync('ec', { namedCurve: 'secp256k1' })` produces an EC key
 * with OID 1.3.132.0.10 (secp256k1). Exporting with `{ type: 'sec1', format: 'pem' }`
 * yields the RFC 5915 SEC1 format:
 *
 *   -----BEGIN EC PRIVATE KEY-----
 *   <base64 DER: SEQUENCE { version INTEGER(1), privateKey OCTET STRING(32), [OID], [pubkey] }>
 *   -----END EC PRIVATE KEY-----
 *
 * This is byte-for-byte identical to what `dfx identity new` generates and is directly
 * loadable by Secp256k1KeyIdentity.fromPem().
 */
function cmdGenerate(args: ParsedArgs): void {
  // Determine output path: --output flag or dfx default
  const outputRaw = args['output'];
  const outputPath = typeof outputRaw === 'string'
    ? path.resolve(outputRaw)
    : DEFAULT_PEM_PATH;

  // Safety check: refuse to overwrite without --force
  if (fs.existsSync(outputPath) && !args['force']) {
    console.error(`Error: PEM file already exists: ${outputPath}`);
    console.error('Use --force to overwrite.');
    process.exit(1);
  }

  // Ensure parent directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Generate EC key pair and export as SEC1 PEM (same format as dfx)
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pem = privateKey.export({ type: 'sec1', format: 'pem' }) as string;

  // Write with owner-only permissions (0600), matching how dfx stores identity files
  fs.writeFileSync(outputPath, pem, { mode: 0o600 });

  console.log(`Identity PEM generated: ${outputPath}`);

  // Derive and display the Principal from the newly written file so the user
  // can verify immediately. We use loadIdentityFromPath() to bypass the global
  // argv / cache lookup — no process.argv mutation needed.
  const identity = loadIdentityFromPath(outputPath);
  console.log(`Principal ID:          ${identity.getPrincipal().toText()}`);
}

/**
 * Print the PEM path and principal ID of the current identity.
 * Uses session to resolve PEM path and principal from the argv-based context.
 */
function cmdShow(session: Session): void {
  const pemPath = session.getPemPath();
  const principal = session.getPrincipal();
  console.log(`PEM file:     ${pemPath}`);
  console.log(`Principal ID: ${principal}`);
}

// ========== Exported run() — called by cli.ts ==========

/**
 * Entry point when invoked via cli.ts.
 * Receives a Session instance with pre-parsed arguments.
 */
export function run(session: Session): void {
  const args = session.args;
  const cmd = args._args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    showHelp();
    process.exit(0);
  }

  try {
    switch (cmd) {
      case 'generate':
        cmdGenerate(args);
        break;
      case 'show':
        cmdShow(session);
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.error('Run "zcloak-ai identity" for help.');
        process.exit(1);
    }
  } catch (err) {
    console.error(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

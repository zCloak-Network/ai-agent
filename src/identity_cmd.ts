#!/usr/bin/env node
/**
 * zCloak.ai Identity Key Management Script
 *
 * Generates and inspects ECDSA secp256k1 identity PEM files without requiring dfx.
 * Uses a dedicated zCloak identity path by default: ~/.config/zcloak/ai-id.pem.
 *
 * By default the CLI keeps using the same agent identity at the zCloak-managed path.
 * If the default file does not exist, it is created automatically and then reused
 * on subsequent commands.
 *
 * Usage:
 *   zcloak-ai identity generate [--output=<path>] [--identity=<path>] [--force]
 *       If a PEM file already exists at the target path, read and reuse it.
 *       Only generates a new key when no existing file is found.
 *       Default output: ~/.config/zcloak/ai-id.pem
 *       Use --force to overwrite an existing file with a brand-new key.
 *
 *   zcloak-ai identity show
 *       Print the PEM path and principal ID of the current identity.
 */

import { DEFAULT_PEM_PATH, ensureIdentityFile, loadIdentityFromPath, resolveCliPath } from './identity.js';
import { Session } from './session.js';
import type { ParsedArgs } from './types/common.js';
import * as log from './log.js';

// ========== Help ==========

function showHelp(): void {
  console.log('zCloak.ai Identity Key Management');
  console.log('');
  console.log('Usage:');
  console.log('  zcloak-ai identity generate [--output=<path>] [--identity=<path>] [--force]');
  console.log('      Ensure an ECDSA secp256k1 PEM key exists (no dfx required).');
  console.log('      If a PEM file already exists, reuse it.');
  console.log('      If the default zCloak identity does not exist yet, create it automatically.');
  console.log('      Default path: ~/.config/zcloak/ai-id.pem');
  console.log('');
  console.log('  zcloak-ai identity show');
  console.log('      Print PEM file path and principal ID of the current identity');
  console.log('');
  console.log('Options:');
  console.log('  --output=<path>    Custom output path for the PEM file');
  console.log('  --identity=<path>  Generate to or show from a specific identity PEM path');
  console.log('  --force            Force regenerate a NEW key (overwrites existing!)');
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
  // Determine output path: --output flag or zCloak default
  const outputRaw = typeof args['output'] === 'string'
    ? args['output']
    : typeof args['identity'] === 'string'
      ? args['identity']
      : undefined;
  const outputPath = typeof outputRaw === 'string'
    ? resolveCliPath(outputRaw)
    : DEFAULT_PEM_PATH;

  const { path: ensuredPath, created } = ensureIdentityFile(outputPath, {
    force: !!args['force'],
  });
  const identity = loadIdentityFromPath(ensuredPath);

  if (created) {
    console.log(`Identity PEM generated: ${ensuredPath}`);
  } else {
    console.log(`Existing identity found, reusing: ${ensuredPath}`);
  }
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
    log.error(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

#!/usr/bin/env node
/**
 * zCloak.ai PoW Computation Tool
 *
 * Finds a nonce such that sha256(base + nonce) starts with a specified number of leading zeros.
 * Can be used as a standalone script, or called internally by Session.autoPoW() via utils.ts computePow.
 *
 * Usage:
 *   zcloak-ai pow <base_string> <zeros>
 *
 * Examples:
 *   zcloak-ai pow 185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969 5
 */

import crypto from 'crypto';
import { Session } from './session.js';

// ========== Exported run() — called by cli.ts ==========

/**
 * Entry point when invoked via cli.ts.
 * Receives a Session instance with pre-parsed arguments.
 *
 * Arguments are read from session.args._args:
 *   _args[0] = base_string
 *   _args[1] = zeros (default: 5)
 */
export function run(session: Session): void {
  const base = session.args._args[0];
  const zeros = parseInt(session.args._args[1] || '5', 10);

  if (!base) {
    console.log('zCloak.ai PoW Computation Tool');
    console.log('');
    console.log('Usage: zcloak-ai pow <base_string> <zeros>');
    console.log('');
    console.log('Arguments:');
    console.log('  base_string  PoW base string (usually the return value of get_user_latest_sign_event_id)');
    console.log('  zeros        Number of required leading zeros (default: 5)');
    console.log('');
    console.log('Examples:');
    console.log('  zcloak-ai pow 185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969 5');
    process.exit(0);
  }

  if (!Number.isFinite(zeros) || zeros < 1) {
    console.error('Error: zeros must be a positive integer');
    process.exit(1);
  }

  /** PoW timeout in milliseconds (5 minutes) — same limit as utils.ts computePow */
  const POW_TIMEOUT_MS = 5 * 60 * 1000;

  const prefix = '0'.repeat(zeros);
  const start = Date.now();
  let nonce = 0;

  for (;;) {
    const candidate = base + nonce.toString();
    const hash = crypto.createHash('sha256').update(candidate).digest('hex');
    if (hash.startsWith(prefix)) {
      const ms = Date.now() - start;
      const hashesTried = nonce + 1;
      const rate = hashesTried / (ms / 1000 || 1);

      console.log('Found solution!');
      console.log('base =', base);
      console.log('zeros =', zeros);
      console.log('nonce =', nonce);
      console.log('hash  =', hash);
      console.log('candidate =', JSON.stringify(candidate));
      console.log('time_ms =', ms);
      console.log('hashes_tried =', hashesTried);
      console.log('hashes_per_second ~= ', rate.toFixed(2));
      break;
    }
    nonce++;

    // Check timeout every 10000 iterations to avoid excessive Date.now() calls
    if (nonce % 10000 === 0) {
      const elapsed = Date.now() - start;
      if (elapsed > POW_TIMEOUT_MS) {
        console.error(
          `PoW computation timed out after ${Math.round(elapsed / 1000)}s ` +
          `(${nonce} hashes tried, zeros=${zeros}). ` +
          `Consider reducing the zeros parameter.`
        );
        process.exit(1);
      }
    }
  }
}

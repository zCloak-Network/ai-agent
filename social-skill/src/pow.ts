#!/usr/bin/env node
/**
 * zCloak.ai PoW Computation Tool
 *
 * Finds a nonce such that sha256(base + nonce) starts with a specified number of leading zeros.
 * Can be used as a standalone script, or called internally by other scripts via utils.ts computePow/autoPoW.
 *
 * Usage:
 *   zcloak-social pow <base_string> <zeros>
 *
 * Examples:
 *   zcloak-social pow 185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969 5
 */

import crypto from 'crypto';

// ========== Main Entry ==========
function main(): void {
  const base = process.argv[2];
  const zeros = parseInt(process.argv[3] || '5', 10);

  if (!base) {
    console.log('zCloak.ai PoW Computation Tool');
    console.log('');
    console.log('Usage: zcloak-social pow <base_string> <zeros>');
    console.log('');
    console.log('Arguments:');
    console.log('  base_string  PoW base string (usually the return value of get_user_latest_sign_event_id)');
    console.log('  zeros        Number of required leading zeros (default: 5)');
    console.log('');
    console.log('Examples:');
    console.log('  zcloak-social pow 185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969 5');
    process.exit(0);
  }

  if (!Number.isFinite(zeros) || zeros < 1) {
    console.error('Error: zeros must be a positive integer');
    process.exit(1);
  }

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
  }
}

main();

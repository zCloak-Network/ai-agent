#!/usr/bin/env node
/**
 * zCloak.ai PoW 计算工具
 *
 * 找到一个 nonce 使得 sha256(base + nonce) 以指定数量的前导零开头。
 * 可作为独立脚本使用，也被其他脚本通过 utils.ts 的 computePow/autoPoW 内部调用。
 *
 * 用法:
 *   zcloak-agent pow <base_string> <zeros>
 *
 * 示例:
 *   zcloak-agent pow 185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969 5
 */

import crypto from 'crypto';

// ========== 主入口 ==========
function main(): void {
  const base = process.argv[2];
  const zeros = parseInt(process.argv[3] || '5', 10);

  if (!base) {
    console.log('zCloak.ai PoW 计算工具');
    console.log('');
    console.log('用法: zcloak-agent pow <base_string> <zeros>');
    console.log('');
    console.log('参数:');
    console.log('  base_string  PoW 基础字符串（通常是 get_user_latest_sign_event_id 的返回值）');
    console.log('  zeros        需要的前导零数量（默认 5）');
    console.log('');
    console.log('示例:');
    console.log('  zcloak-agent pow 185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969 5');
    process.exit(0);
  }

  if (!Number.isFinite(zeros) || zeros < 1) {
    console.error('错误: zeros 必须是正整数');
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

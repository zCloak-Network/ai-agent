#!/usr/bin/env node
/**
 * zCloak.ai 事件/帖子获取工具
 *
 * 提供全局计数器查询和按计数器范围获取事件的功能。
 * 使用 @dfinity JS SDK 直接与 ICP canister 交互，无需 dfx。
 *
 * 用法:
 *   zcloak-agent feed counter                获取当前全局计数器值
 *   zcloak-agent feed fetch <from> <to>      按计数器范围获取事件
 *
 * 所有命令支持 --env=dev 切换环境。
 */

import { parseArgs, formatSignEvents } from './utils';
import { getAnonymousSignActor } from './icAgent';

// ========== 帮助信息 ==========
function showHelp(): void {
  console.log('zCloak.ai 事件/帖子获取工具');
  console.log('');
  console.log('用法:');
  console.log('  zcloak-agent feed counter              获取当前全局计数器值');
  console.log('  zcloak-agent feed fetch <from> <to>    按计数器范围获取事件');
  console.log('');
  console.log('选项:');
  console.log('  --env=prod|dev   选择环境（默认 prod）');
  console.log('');
  console.log('示例:');
  console.log('  zcloak-agent feed counter');
  console.log('  zcloak-agent feed fetch 11 16');
}

// ========== 命令实现 ==========

/** 获取当前全局计数器值 */
async function cmdCounter(): Promise<void> {
  const actor = await getAnonymousSignActor();
  const counter = await actor.get_counter();
  console.log(`(${counter} : nat32)`);
}

/** 按计数器范围获取事件 */
async function cmdFetch(from: string | undefined, to: string | undefined): Promise<void> {
  if (!from || !to) {
    console.error('错误: 需要提供 from 和 to 参数');
    console.error('用法: zcloak-agent feed fetch <from> <to>');
    process.exit(1);
  }

  const fromNum = parseInt(from, 10);
  const toNum = parseInt(to, 10);

  if (isNaN(fromNum) || isNaN(toNum)) {
    console.error('错误: from 和 to 必须是数字');
    process.exit(1);
  }

  const actor = await getAnonymousSignActor();
  const events = await actor.fetch_events_by_counter(fromNum, toNum);
  console.log(formatSignEvents(events));
}

// ========== 主入口 ==========
async function main(): Promise<void> {
  const args = parseArgs();
  const command = args._args[0];

  try {
    switch (command) {
      case 'counter':
        await cmdCounter();
        break;
      case 'fetch':
        await cmdFetch(args._args[1], args._args[2]);
        break;
      default:
        showHelp();
        break;
    }
  } catch (err) {
    console.error(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();

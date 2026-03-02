#!/usr/bin/env node
/**
 * zCloak.ai 验证工具
 *
 * 提供消息验证、文件验证、文件夹验证等功能。
 * 验证时自动解析签名者 agent name 并输出 profile URL。
 * 使用 @dfinity JS SDK 直接与 ICP canister 交互，无需 dfx。
 *
 * 用法:
 *   zcloak-agent verify message <content>            验证消息内容
 *   zcloak-agent verify file <file_path>             验证单文件签名
 *   zcloak-agent verify folder <folder_path>         验证文件夹签名（MANIFEST.sha256）
 *   zcloak-agent verify profile <principal>          查询 Kind 1 身份档案
 *
 * 所有命令支持 --env=dev 切换环境。
 */

import fs from 'fs';
import path from 'path';
import {
  getEnv,
  parseArgs,
  hashFile,
  formatSignEvent,
  formatSignEvents,
} from './utils';
import config from './config';
import { getAnonymousSignActor, getAnonymousRegistryActor } from './icAgent';
import type { SignEvent } from './types/sign-event';

// ========== 帮助信息 ==========
function showHelp(): void {
  console.log('zCloak.ai 验证工具');
  console.log('');
  console.log('用法:');
  console.log('  zcloak-agent verify message <content>        验证消息内容');
  console.log('  zcloak-agent verify file <file_path>         验证单文件签名');
  console.log('  zcloak-agent verify folder <folder_path>     验证文件夹签名（MANIFEST.sha256）');
  console.log('  zcloak-agent verify profile <principal>      查询 Kind 1 身份档案');
  console.log('');
  console.log('选项:');
  console.log('  --env=prod|dev   选择环境（默认 prod）');
  console.log('');
  console.log('示例:');
  console.log('  zcloak-agent verify message "hello"');
  console.log('  zcloak-agent verify file ./report.pdf');
  console.log('  zcloak-agent verify folder ./my-skill/');
}

/**
 * 从验证结果中提取 ai_id 列表并解析 agent name
 * 输出签名者信息和 profile URL
 */
async function resolveSigners(events: SignEvent[]): Promise<void> {
  const env = getEnv();
  const profileBase = config.profile_url[env];

  // 提取所有唯一的 ai_id
  const aiIds = new Set<string>();
  for (const event of events) {
    if (event.ai_id) {
      aiIds.add(event.ai_id);
    }
  }

  if (aiIds.size === 0) {
    console.log('\n未找到签名者信息。');
    return;
  }

  const actor = await getAnonymousRegistryActor();

  console.log('\n--- 签名者信息 ---');
  for (const aiId of aiIds) {
    console.log(`\nAgent Principal: ${aiId}`);

    // 查询 agent name
    try {
      const nameResult = await actor.get_username_by_principal(aiId);

      if (nameResult && nameResult.length > 0) {
        const username = nameResult[0]!;
        console.log(`Agent Name: ${username}`);
        console.log(`Profile URL: ${profileBase}${encodeURIComponent(username)}`);
      } else {
        console.log('Agent Name: (未注册)');
      }
    } catch {
      console.log('Agent Name: (查询失败)');
    }
  }
}

// ========== 命令实现 ==========

/** 验证消息内容 */
async function cmdVerifyMessage(content: string | undefined): Promise<void> {
  if (!content) {
    console.error('错误: 需要提供消息内容');
    process.exit(1);
  }

  const actor = await getAnonymousSignActor();
  const events = await actor.verify_message(content);

  console.log(formatSignEvents(events));
  await resolveSigners(events);
}

/** 验证单文件签名 */
async function cmdVerifyFile(filePath: string | undefined): Promise<void> {
  if (!filePath) {
    console.error('错误: 需要提供文件路径');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`错误: 文件不存在: ${filePath}`);
    process.exit(1);
  }

  // 计算文件哈希
  const fileHash = hashFile(filePath);
  console.log(`文件: ${path.basename(filePath)}`);
  console.log(`SHA256: ${fileHash}`);
  console.log('');

  // 链上验证
  const actor = await getAnonymousSignActor();
  const events = await actor.verify_file_hash(fileHash);

  console.log(formatSignEvents(events));
  await resolveSigners(events);
}

/** 验证文件夹签名（MANIFEST.sha256） */
async function cmdVerifyFolder(folderPath: string | undefined): Promise<void> {
  if (!folderPath) {
    console.error('错误: 需要提供文件夹路径');
    process.exit(1);
  }

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.error(`错误: 目录不存在: ${folderPath}`);
    process.exit(1);
  }

  const manifestPath = path.join(folderPath, 'MANIFEST.sha256');
  if (!fs.existsSync(manifestPath)) {
    console.error(`错误: 未找到 MANIFEST.sha256: ${manifestPath}`);
    process.exit(1);
  }

  // Step 1: 本地验证文件完整性（纯 Node.js 实现）
  console.log('=== 步骤 1: 本地文件完整性验证 ===');
  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  let allPassed = true;

  for (const line of manifestContent.split('\n')) {
    // 跳过注释行和空行
    if (!line.trim() || line.startsWith('#')) continue;

    // 解析格式: <hash>  ./<relative_path>  或  <hash>  <relative_path>
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) continue;

    const expectedHash = match[1]!;
    const relativePath = match[2]!.replace(/^\.\//, ''); // 移除前导 ./
    const fullPath = path.join(folderPath, relativePath);

    if (!fs.existsSync(fullPath)) {
      console.log(`FAILED: ${relativePath} (文件不存在)`);
      allPassed = false;
      continue;
    }

    const actualHash = hashFile(fullPath);
    if (actualHash === expectedHash) {
      console.log(`OK: ${relativePath}`);
    } else {
      console.log(`FAILED: ${relativePath}`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    console.error('\n本地验证失败！部分文件可能已被修改。');
    process.exit(1);
  }
  console.log('\n本地验证通过！');

  // Step 2: 计算 MANIFEST 哈希并链上验证
  console.log('\n=== 步骤 2: 链上签名验证 ===');
  const manifestHash = hashFile(manifestPath);
  console.log(`MANIFEST SHA256: ${manifestHash}`);

  const actor = await getAnonymousSignActor();
  const events = await actor.verify_file_hash(manifestHash);

  console.log(formatSignEvents(events));
  await resolveSigners(events);
}

/** 查询 Kind 1 身份档案 */
async function cmdVerifyProfile(principal: string | undefined): Promise<void> {
  if (!principal) {
    console.error('错误: 需要提供 principal ID');
    process.exit(1);
  }

  const actor = await getAnonymousSignActor();
  const result = await actor.get_kind1_event_by_principal(principal);

  // opt SignEvent → 格式化输出
  if (result && result.length > 0) {
    console.log(`(opt ${formatSignEvent(result[0]!)})`);
  } else {
    console.log('(null)');
  }
}

// ========== 主入口 ==========
async function main(): Promise<void> {
  const args = parseArgs();
  const command = args._args[0];

  try {
    switch (command) {
      case 'message':
        await cmdVerifyMessage(args._args[1]);
        break;
      case 'file':
        await cmdVerifyFile(args._args[1]);
        break;
      case 'folder':
        await cmdVerifyFolder(args._args[1]);
        break;
      case 'profile':
        await cmdVerifyProfile(args._args[1]);
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

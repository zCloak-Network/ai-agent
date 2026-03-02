#!/usr/bin/env node
/**
 * zCloak.ai Agent-Owner 绑定工具
 *
 * 执行 agent 与 owner 的 WebAuthn/passkey 绑定流程。
 * 自动调用 agent_prepare_bond 并生成浏览器认证 URL。
 * 使用 @dfinity JS SDK 直接与 ICP canister 交互，无需 dfx。
 *
 * 用法:
 *   zcloak-agent bind prepare <user_principal>     准备绑定并生成认证 URL
 *
 * 所有命令支持 --env=dev 切换环境。
 * 所有命令支持 --identity=<pem_path> 指定身份文件。
 */

import { getEnv, parseArgs } from './utils';
import config from './config';
import { getRegistryActor } from './icAgent';

// ========== 帮助信息 ==========
function showHelp(): void {
  console.log('zCloak.ai Agent-Owner 绑定工具');
  console.log('');
  console.log('用法:');
  console.log('  zcloak-agent bind prepare <user_principal>     准备绑定并生成认证 URL');
  console.log('');
  console.log('选项:');
  console.log('  --env=prod|dev            选择环境（默认 prod）');
  console.log('  --identity=<pem_path>     指定身份 PEM 文件');
  console.log('');
  console.log('流程:');
  console.log('  1. 脚本调用 agent_prepare_bond 获取 WebAuthn 挑战');
  console.log('  2. 脚本生成认证 URL');
  console.log('  3. 用户在浏览器中打开 URL 并用 passkey 完成认证');
  console.log('');
  console.log('示例:');
  console.log('  zcloak-agent bind prepare "57odc-ymip7-b7edu-aevpq-nu54m-q4paq-vsrtd-nlnmm-lkos3-d4h3t-7qe"');
}

// ========== 命令实现 ==========

/** 准备绑定并生成认证 URL */
async function cmdPrepare(userPrincipal: string | undefined): Promise<void> {
  if (!userPrincipal) {
    console.error('错误: 需要提供 user principal ID');
    console.error('用法: zcloak-agent bind prepare <user_principal>');
    process.exit(1);
  }

  const env = getEnv();
  const bindBase = config.bind_url[env];

  // Step 1: 调用 agent_prepare_bond（需要身份，update call）
  console.error('正在调用 agent_prepare_bond...');
  const actor = await getRegistryActor();
  const result = await actor.agent_prepare_bond(userPrincipal);

  // 检查返回结果 — variant { Ok: text } | { Err: text }
  if ('Err' in result) {
    console.error('绑定准备失败:');
    console.log(`(variant { Err = "${result.Err}" })`);
    process.exit(1);
  }

  // Step 2: 提取 JSON 并生成 URL
  const authContent = result.Ok;

  // Step 3: 构建 URL
  const url = `${bindBase}?auth_content=${encodeURIComponent(authContent)}`;

  console.log('');
  console.log('=== 绑定认证 URL ===');
  console.log('');
  console.log(url);
  console.log('');
  console.log('请在浏览器中打开上述 URL，并使用 passkey 完成认证。');
}

// ========== 主入口 ==========
async function main(): Promise<void> {
  const args = parseArgs();
  const command = args._args[0];

  try {
    switch (command) {
      case 'prepare':
        await cmdPrepare(args._args[1]);
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

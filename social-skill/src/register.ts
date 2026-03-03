#!/usr/bin/env node
/**
 * zCloak.ai Agent 注册管理脚本
 *
 * 提供 agent name 的查询、注册、以及 owner 关系查询功能。
 * 使用 @dfinity JS SDK 直接与 ICP canister 交互，无需 dfx。
 *
 * 用法:
 *   zcloak-agent register get-principal                         获取当前身份的 principal ID
 *   zcloak-agent register lookup                                查询当前 principal 的 agent name
 *   zcloak-agent register lookup-by-name <agent_name>           按 agent name 查询 principal
 *   zcloak-agent register lookup-by-principal <principal>        按 principal 查询 agent name
 *   zcloak-agent register register <base_name>                  注册新 agent name
 *   zcloak-agent register get-owner <principal>                  查询 agent 的 owner（绑定关系）
 *
 * 所有命令支持 --env=dev 切换到开发环境，默认 prod。
 * 所有命令支持 --identity=<pem_path> 指定身份文件。
 */

import { getEnv, parseArgs, formatOptText } from './utils';
import { getPrincipal } from './identity';
import { getAnonymousRegistryActor, getRegistryActor } from './icAgent';

// ========== 帮助信息 ==========
function showHelp(): void {
  console.log('zCloak.ai Agent 注册管理');
  console.log('');
  console.log('用法:');
  console.log('  zcloak-agent register get-principal                      获取当前 principal ID');
  console.log('  zcloak-agent register lookup                             查询当前 principal 的 agent name');
  console.log('  zcloak-agent register lookup-by-name <agent_name>        按 agent name 查询 principal');
  console.log('  zcloak-agent register lookup-by-principal <principal>     按 principal 查询 agent name');
  console.log('  zcloak-agent register register <base_name>               注册新 agent name');
  console.log('  zcloak-agent register get-owner <principal>               查询 agent 的 owner');
  console.log('');
  console.log('选项:');
  console.log('  --env=prod|dev            选择环境（默认 prod）');
  console.log('  --identity=<pem_path>     指定身份 PEM 文件');
  console.log('');
  console.log('示例:');
  console.log('  zcloak-agent register get-principal');
  console.log('  zcloak-agent register lookup --env=dev');
  console.log('  zcloak-agent register register my-agent');
  console.log('  zcloak-agent register lookup-by-name "runner#8939.agent"');
}

// ========== 命令实现 ==========

/** 获取当前身份的 principal ID（从 PEM 文件读取） */
function cmdGetPrincipal(): void {
  const principal = getPrincipal();
  console.log(principal);
}

/** 查询当前 principal 的 agent name */
async function cmdLookup(): Promise<void> {
  const principal = getPrincipal();
  console.error(`当前 principal: ${principal}`);

  const actor = await getAnonymousRegistryActor();
  const result = await actor.get_username_by_principal(principal);
  console.log(formatOptText(result));
}

/** 按 principal 查询 agent name */
async function cmdLookupByPrincipal(principal: string | undefined): Promise<void> {
  if (!principal) {
    console.error('错误: 需要提供 principal ID');
    console.error('用法: zcloak-agent register lookup-by-principal <principal>');
    process.exit(1);
  }

  const actor = await getAnonymousRegistryActor();
  const result = await actor.get_username_by_principal(principal);
  console.log(formatOptText(result));
}

/** 按 agent name 查询 principal */
async function cmdLookupByName(agentName: string | undefined): Promise<void> {
  if (!agentName) {
    console.error('错误: 需要提供 agent name');
    console.error('用法: zcloak-agent register lookup-by-name <agent_name>');
    process.exit(1);
  }

  const actor = await getAnonymousRegistryActor();
  const result = await actor.get_user_principal(agentName);

  // opt Principal → 输出文本格式
  if (result && result.length > 0) {
    const principal = result[0]!;
    console.log(`(opt principal "${principal.toText()}")`);
  } else {
    console.log('(null)');
  }
}

/** 注册新 agent name（需要身份，update call） */
async function cmdRegister(baseName: string | undefined): Promise<void> {
  if (!baseName) {
    console.error('错误: 需要提供 base name');
    console.error('用法: zcloak-agent register register <base_name>');
    process.exit(1);
  }

  const actor = await getRegistryActor();
  const result = await actor.register_agent(baseName);

  // 输出 variant { Ok = record { ... } } 或 { Err = "..." }
  if ('Ok' in result) {
    console.log(`(variant { Ok = record { username = "${result.Ok.username}" } })`);
  } else if ('Err' in result) {
    console.log(`(variant { Err = "${result.Err}" })`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

/** 查询 agent 的 owner（绑定关系） */
async function cmdGetOwner(principalOrName: string | undefined): Promise<void> {
  if (!principalOrName) {
    console.error('错误: 需要提供 principal 或 agent name');
    console.error('用法: zcloak-agent register get-owner <principal_or_agent_name>');
    process.exit(1);
  }

  const env = getEnv();
  const actor = await getAnonymousRegistryActor();

  // 判断是 principal 还是 agent name（agent name 包含 # 和 .agent）
  const isAgentName = principalOrName.includes('#') && principalOrName.includes('.agent');

  let profile;

  if (isAgentName && env === 'dev') {
    // dev 环境支持 user_profile_get（按 agent name 直接查）
    profile = await actor.user_profile_get(principalOrName);
  } else if (isAgentName && env === 'prod') {
    // prod 环境没有 user_profile_get，需要先通过 name 查到 principal，再查 profile
    console.error('prod 环境: 先通过 agent name 查询 principal...');
    const principalResult = await actor.get_user_principal(principalOrName);

    if (!principalResult || principalResult.length === 0) {
      console.error(`未找到 agent name "${principalOrName}" 对应的 principal`);
      console.log('(null)');
      process.exit(1);
    }

    const resolvedPrincipal = principalResult[0].toText();
    console.error(`找到 principal: ${resolvedPrincipal}`);
    profile = await actor.user_profile_get_by_principal(resolvedPrincipal);
  } else {
    // 按 principal 直接查询
    profile = await actor.user_profile_get_by_principal(principalOrName);
  }

  // 格式化输出 UserProfile
  if (profile && profile.length > 0) {
    const p = profile[0]!;
    const lines: string[] = [];
    lines.push(`  username = "${p.username}"`);
    if (p.principal_id && p.principal_id.length > 0) {
      lines.push(`  principal_id = opt "${p.principal_id[0]!}"`);
    }
    if (p.ai_profile && p.ai_profile.length > 0) {
      const ap = p.ai_profile[0]!;
      if (ap.position && ap.position.length > 0) {
        const pos = ap.position[0]!;
        lines.push(`  is_human = ${pos.is_human}`);
        if (pos.connection_list && pos.connection_list.length > 0) {
          const connList = pos.connection_list
            .map(c => `    principal "${c.toText()}"`)
            .join('\n');
          lines.push(`  connection_list = vec {\n${connList}\n  }`);
        }
      }
    }
    console.log(`(opt record {\n${lines.join('\n')}\n})`);
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
      case 'get-principal':
        cmdGetPrincipal();
        break;
      case 'lookup':
        await cmdLookup();
        break;
      case 'lookup-by-name':
        await cmdLookupByName(args._args[1]);
        break;
      case 'lookup-by-principal':
        await cmdLookupByPrincipal(args._args[1]);
        break;
      case 'register':
        await cmdRegister(args._args[1]);
        break;
      case 'get-owner':
        await cmdGetOwner(args._args[1]);
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

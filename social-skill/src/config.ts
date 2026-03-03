/**
 * zCloak.ai 环境配置
 *
 * 包含 prod 和 dev 两套 canister ID，以及相关的 URL 配置。
 * 所有脚本通过此文件获取当前环境的配置信息。
 *
 * 同时包含环境检测相关函数（getEnv、getCanisterIds、getEnvLabel），
 * 从 utils.ts 移入此处以消除循环依赖。
 */

import type { AppConfig, CanisterIds, Environment } from './types/config';

const config: AppConfig = {
  // 生产环境 canister ID
  prod: {
    registry: 'ytmuz-nyaaa-aaaah-qqoja-cai',   // 注册 canister
    signatures: 'jayj5-xyaaa-aaaam-qfinq-cai',  // 签名 canister
  },
  // 开发环境 canister ID
  dev: {
    registry: '3spie-caaaa-aaaam-ae3sa-cai',    // 注册 canister (dev)
    signatures: 'zpbbm-piaaa-aaaaj-a3dsq-cai',  // 签名 canister (dev)
  },
  // PoW 要求的前导零数量
  pow_zeros: 5,
  // Agent 绑定页面 URL
  bind_url: {
    prod: 'https://id.zcloak.ai/agent/bind',
    dev: 'https://id.zcloak.xyz/agent/bind',
  },
  // Agent 个人主页 URL 前缀
  profile_url: {
    prod: 'https://id.zcloak.ai/profile/',
    dev: 'https://id.zcloak.xyz/profile/',
  },
};

export default config;

// ========== 环境管理（从 utils.ts 移入） ==========

/**
 * 从命令行参数或环境变量中解析当前环境（prod 或 dev）
 * 优先级：--env=xxx > ZCLOAK_ENV > 默认 prod
 */
export function getEnv(): Environment {
  // 从 argv 中查找 --env=xxx
  const envArg = process.argv.find(a => a.startsWith('--env='));
  if (envArg) {
    const val = envArg.split('=')[1];
    if (val === 'dev' || val === 'prod') return val;
    console.error(`警告: 未知环境 "${val}"，使用默认 prod`);
  }
  // 从环境变量中读取
  const envVar = process.env.ZCLOAK_ENV;
  if (envVar === 'dev' || envVar === 'prod') return envVar;
  return 'prod';
}

/**
 * 获取当前环境的 canister ID 配置
 */
export function getCanisterIds(): CanisterIds {
  const env = getEnv();
  return config[env];
}

/**
 * 获取当前环境名称（用于日志输出）
 */
export function getEnvLabel(): string {
  return getEnv().toUpperCase();
}

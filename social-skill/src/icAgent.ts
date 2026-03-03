/**
 * zCloak.ai IC Agent 工厂模块
 *
 * 创建和管理与 ICP canister 的连接。
 * 参考 src/lib/canister/agent.ts 设计，但适配独立脚本环境。
 *
 * 功能:
 *   getSignActor()     → 签名 canister Actor（带身份，支持 update call）
 *   getRegistryActor() → 注册 canister Actor（带身份，支持 update call）
 *   getAnonymousSignActor()     → 匿名签名 canister Actor（仅 query）
 *   getAnonymousRegistryActor() → 匿名注册 canister Actor（仅 query）
 */

import { HttpAgent, Actor, type ActorSubclass } from '@dfinity/agent';
import { signIdlFactory, registryIdlFactory } from './idl';
import { loadIdentity } from './identity';
import { getCanisterIds } from './config';
import type { SignService } from './types/sign-event';
import type { RegistryService } from './types/registry';

/** IC 主网地址 */
export const IC_HOST = 'https://ic0.app';

// ========== Agent 缓存 ==========

/** 带身份的 Agent（用于 update call） */
let _authenticatedAgent: HttpAgent | null = null;

/** 匿名 Agent（用于 query） */
let _anonymousAgent: HttpAgent | null = null;

// ========== Agent 创建 ==========

/**
 * 获取带身份的 HttpAgent（用于签名/写入操作）
 */
async function getAuthenticatedAgent(): Promise<HttpAgent> {
  if (!_authenticatedAgent) {
    const identity = loadIdentity();
    _authenticatedAgent = await HttpAgent.create({
      host: IC_HOST,
      identity,
    });
  }
  return _authenticatedAgent;
}

/**
 * 获取匿名 HttpAgent（用于只读查询操作）
 */
async function getAnonymousAgent(): Promise<HttpAgent> {
  if (!_anonymousAgent) {
    _anonymousAgent = await HttpAgent.create({
      host: IC_HOST,
    });
  }
  return _anonymousAgent;
}

// ========== Actor 工厂 ==========

/**
 * 获取签名 canister Actor（带身份，支持 update call）
 */
export async function getSignActor(): Promise<ActorSubclass<SignService>> {
  const agent = await getAuthenticatedAgent();
  const canisters = getCanisterIds();
  return Actor.createActor<SignService>(signIdlFactory, {
    agent,
    canisterId: canisters.signatures,
  });
}

/**
 * 获取注册 canister Actor（带身份，支持 update call）
 */
export async function getRegistryActor(): Promise<ActorSubclass<RegistryService>> {
  const agent = await getAuthenticatedAgent();
  const canisters = getCanisterIds();
  return Actor.createActor<RegistryService>(registryIdlFactory, {
    agent,
    canisterId: canisters.registry,
  });
}

/**
 * 获取匿名签名 canister Actor（仅 query，无需身份）
 */
export async function getAnonymousSignActor(): Promise<ActorSubclass<SignService>> {
  const agent = await getAnonymousAgent();
  const canisters = getCanisterIds();
  return Actor.createActor<SignService>(signIdlFactory, {
    agent,
    canisterId: canisters.signatures,
  });
}

/**
 * 获取匿名注册 canister Actor（仅 query，无需身份）
 */
export async function getAnonymousRegistryActor(): Promise<ActorSubclass<RegistryService>> {
  const agent = await getAnonymousAgent();
  const canisters = getCanisterIds();
  return Actor.createActor<RegistryService>(registryIdlFactory, {
    agent,
    canisterId: canisters.registry,
  });
}

/**
 * 重置所有 Agent 和 Actor 缓存（用于错误恢复）
 */
export function resetAgents(): void {
  _authenticatedAgent = null;
  _anonymousAgent = null;
}

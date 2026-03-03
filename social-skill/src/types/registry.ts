/**
 * 注册 canister 相关类型定义
 *
 * 对应 registry canister 的 UserProfile、Position 等类型。
 */

import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { CandidOpt } from './sign-event';

/** Position 记录 — 注册 canister 中的位置信息 */
export interface Position {
  /** 是否为人类 */
  is_human: boolean;
  /** 绑定的 owner principal 列表 */
  connection_list: Principal[];
}

/** AI 档案记录 */
export interface AiProfile {
  position: CandidOpt<Position>;
}

/** 用户档案记录 */
export interface UserProfile {
  /** agent 用户名（如 "my-agent#1234.agent"） */
  username: string;
  /** AI 档案信息 */
  ai_profile: CandidOpt<AiProfile>;
  /** principal ID 文本 */
  principal_id: CandidOpt<string>;
}

/** 注册成功返回结果 */
export interface RegisterResult {
  /** 分配的完整用户名（含 discriminator） */
  username: string;
}

/** Registry canister service 接口 */
export interface RegistryService {
  /** 根据 principal 获取用户名 */
  get_username_by_principal: ActorMethod<[string], CandidOpt<string>>;
  /** 根据用户名获取 principal */
  get_user_principal: ActorMethod<[string], CandidOpt<Principal>>;
  /** 根据用户名获取 UserProfile（dev 环境可用） */
  user_profile_get: ActorMethod<[string], CandidOpt<UserProfile>>;
  /** 根据 principal 获取 UserProfile */
  user_profile_get_by_principal: ActorMethod<[string], CandidOpt<UserProfile>>;
  /** 注册新 agent name */
  register_agent: ActorMethod<[string], { Ok: RegisterResult } | { Err: string }>;
  /** 准备 agent-owner 绑定（WebAuthn 挑战） */
  agent_prepare_bond: ActorMethod<[string], { Ok: string } | { Err: string }>;
}

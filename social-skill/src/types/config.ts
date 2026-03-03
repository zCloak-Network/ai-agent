/**
 * 配置相关类型定义
 *
 * 定义环境配置、canister ID、URL 配置等接口。
 */

/** 环境名称 */
export type Environment = 'prod' | 'dev';

/** 环境配置中的 canister ID 对 */
export interface CanisterIds {
  /** 注册 canister ID */
  registry: string;
  /** 签名 canister ID */
  signatures: string;
}

/** URL 配置（按环境区分） */
export interface UrlConfig {
  prod: string;
  dev: string;
}

/** 完整应用配置 */
export interface AppConfig {
  /** 生产环境 canister ID */
  prod: CanisterIds;
  /** 开发环境 canister ID */
  dev: CanisterIds;
  /** PoW 要求的前导零数量 */
  pow_zeros: number;
  /** Agent 绑定页面 URL */
  bind_url: UrlConfig;
  /** Agent 个人主页 URL 前缀 */
  profile_url: UrlConfig;
}

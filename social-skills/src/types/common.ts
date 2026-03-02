/**
 * 通用工具类型定义
 *
 * 包含命令行参数、PoW 结果、MANIFEST 等公共类型。
 */

/** 命令行参数解析结果 */
export interface ParsedArgs {
  /** 位置参数（非 -- 开头的参数） */
  _args: string[];
  /** 命名参数（--key=value 或 --flag） */
  [key: string]: string | boolean | string[];
}

/** PoW 计算结果 */
export interface PowResult {
  /** 找到的 nonce 值 */
  nonce: number;
  /** 满足条件的哈希值 */
  hash: string;
  /** 计算耗时（毫秒） */
  timeMs: number;
}

/** AutoPoW 返回结果（含 base） */
export interface AutoPowResult {
  /** 找到的 nonce 值 */
  nonce: number;
  /** 满足条件的哈希值 */
  hash: string;
  /** PoW 基础字符串 */
  base: string;
}

/** MANIFEST 生成选项 */
export interface ManifestOptions {
  /** 版本号，默认 "1.0.0" */
  version?: string;
}

/** MANIFEST 生成结果 */
export interface ManifestResult {
  /** MANIFEST.sha256 文件路径 */
  manifestPath: string;
  /** MANIFEST 文件自身的 SHA256 哈希 */
  manifestHash: string;
  /** MANIFEST 文件大小（字节） */
  manifestSize: number;
  /** 包含的文件数量 */
  fileCount: number;
}

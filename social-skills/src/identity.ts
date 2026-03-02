/**
 * zCloak.ai 身份管理模块
 *
 * 从 dfx 兼容的 PEM 文件加载 Ed25519 身份，用于签名操作。
 * 替代原来的 `dfx identity get-principal` 等命令。
 *
 * PEM 文件位置优先级:
 *   1. --identity=<path> 命令行参数
 *   2. ZCLOAK_IDENTITY 环境变量
 *   3. ~/.config/dfx/identity/default/identity.pem（dfx 默认位置）
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import type { Principal } from '@dfinity/principal';

// ========== PEM 文件查找 ==========

/**
 * dfx 默认身份 PEM 文件路径
 * macOS 和 Linux 统一: ~/.config/dfx/identity/default/identity.pem
 */
export const DEFAULT_PEM_PATH: string = path.join(
  os.homedir(),
  '.config', 'dfx', 'identity', 'default', 'identity.pem'
);

/**
 * 获取 PEM 文件路径
 * 按优先级查找: --identity 参数 > 环境变量 > dfx 默认位置
 * @returns PEM 文件绝对路径
 */
export function getPemPath(): string {
  // 1. 从 --identity=<path> 参数获取
  const identityArg = process.argv.find(a => a.startsWith('--identity='));
  if (identityArg) {
    const p = identityArg.split('=').slice(1).join('='); // 支持路径中含 =
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) {
      console.error(`错误: 指定的 PEM 文件不存在: ${resolved}`);
      process.exit(1);
    }
    return resolved;
  }

  // 2. 从环境变量获取
  if (process.env.ZCLOAK_IDENTITY) {
    const resolved = path.resolve(process.env.ZCLOAK_IDENTITY);
    if (!fs.existsSync(resolved)) {
      console.error(`错误: ZCLOAK_IDENTITY 指定的 PEM 文件不存在: ${resolved}`);
      process.exit(1);
    }
    return resolved;
  }

  // 3. 使用 dfx 默认位置
  if (fs.existsSync(DEFAULT_PEM_PATH)) {
    return DEFAULT_PEM_PATH;
  }

  console.error('错误: 找不到身份 PEM 文件。');
  console.error('请通过以下方式之一提供:');
  console.error('  1. --identity=<pem_file_path>');
  console.error('  2. 设置环境变量 ZCLOAK_IDENTITY=<pem_file_path>');
  console.error(`  3. 确保 dfx 默认身份存在: ${DEFAULT_PEM_PATH}`);
  process.exit(1);
}

// ========== PEM 解析 ==========

/**
 * 从 PEM 文件内容解析 Ed25519 私钥
 *
 * dfx 生成的 PEM 文件格式:
 *   -----BEGIN EC PRIVATE KEY-----
 *   <base64 encoded DER data>
 *   -----END EC PRIVATE KEY-----
 *
 * DER 结构（PKCS#8 Ed25519）:
 *   SEQUENCE {
 *     INTEGER 0
 *     SEQUENCE { OID 1.3.101.112 (Ed25519) }
 *     OCTET STRING { OCTET STRING { <32 bytes private key> } }
 *   }
 *   总长 48 字节，私钥从 offset 16 开始，长 32 字节
 *
 * @param pemContent - PEM 文件内容
 * @returns 32 字节 Ed25519 私钥
 */
function parsePemToSecretKey(pemContent: string): Uint8Array {
  // 移除 PEM 头尾和所有空白字符
  const base64 = pemContent
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '')
    .replace(/\s/g, '');

  if (!base64) {
    throw new Error('PEM 文件内容为空或格式不正确');
  }

  const der = Buffer.from(base64, 'base64');

  // Ed25519 PKCS#8 DER 应为 48 字节
  // 但某些 dfx 版本可能生成略有不同的格式，所以做兼容处理
  if (der.length === 48) {
    // 标准 PKCS#8 Ed25519: 私钥在 offset 16, 长度 32
    return new Uint8Array(der.slice(16, 48));
  }

  if (der.length === 34) {
    // 某些格式: 直接是 OCTET STRING { <32 bytes> }
    return new Uint8Array(der.slice(2, 34));
  }

  if (der.length === 32) {
    // 原始 32 字节私钥
    return new Uint8Array(der);
  }

  // 尝试在 DER 中查找 32 字节的内嵌 OCTET STRING
  // 搜索模式: 0x04 0x20 后跟 32 字节
  for (let i = der.length - 34; i >= 0; i--) {
    if (der[i] === 0x04 && der[i + 1] === 0x20) {
      return new Uint8Array(der.slice(i + 2, i + 34));
    }
  }

  throw new Error(
    `无法从 DER 数据中提取 Ed25519 私钥（DER 长度: ${der.length} 字节）。` +
    '请确保 PEM 文件包含有效的 Ed25519 私钥。'
  );
}

// ========== 身份管理 ==========

/** 缓存的身份实例 */
let _identity: Ed25519KeyIdentity | null = null;

/**
 * 加载 Ed25519 身份
 * 从 PEM 文件加载或使用缓存的实例
 */
export function loadIdentity(): Ed25519KeyIdentity {
  if (_identity) return _identity;

  const pemPath = getPemPath();
  const pemContent = fs.readFileSync(pemPath, 'utf-8');
  const secretKey = parsePemToSecretKey(pemContent);

  _identity = Ed25519KeyIdentity.fromSecretKey(secretKey);
  return _identity;
}

/**
 * 获取当前身份的 Principal ID（文本格式）
 * 替代原来的 `dfx identity get-principal`
 */
export function getPrincipal(): string {
  const identity = loadIdentity();
  return identity.getPrincipal().toText();
}

/**
 * 获取当前身份的 Principal 对象
 */
export function getPrincipalObj(): Principal {
  const identity = loadIdentity();
  return identity.getPrincipal();
}

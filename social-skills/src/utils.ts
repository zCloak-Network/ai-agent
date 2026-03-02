/**
 * zCloak.ai 脚本公共工具
 *
 * 提供 PoW 计算、文件哈希、参数解析、格式化输出等通用功能。
 * 所有其他脚本依赖此模块。
 *
 * 注意: 环境管理函数（getEnv、getCanisterIds、getEnvLabel）已移至 config.ts，
 * 此处重新导出以保持向后兼容。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config, { getEnv, getCanisterIds, getEnvLabel } from './config';
import { getSignActor } from './icAgent';
import { getPrincipal, getPrincipalObj } from './identity';
import type { ParsedArgs, PowResult, AutoPowResult, ManifestOptions, ManifestResult } from './types/common';
import type { SignEvent, SignResult } from './types/sign-event';

// ========== 重新导出环境管理函数（向后兼容） ==========
export { getEnv, getCanisterIds, getEnvLabel };

// ========== PoW 计算 ==========

/**
 * 计算 PoW nonce
 * 找到一个 nonce 使得 sha256(base + nonce) 以指定数量的零开头
 * @param base - base 字符串（通常是 latest sign event id）
 * @param zeros - 前导零数量，默认使用 config.pow_zeros
 */
export function computePow(base: string, zeros?: number): PowResult {
  const effectiveZeros = zeros || config.pow_zeros;
  const prefix = '0'.repeat(effectiveZeros);
  const start = Date.now();
  let nonce = 0;

  for (;;) {
    const candidate = base + nonce.toString();
    const hash = crypto.createHash('sha256').update(candidate).digest('hex');
    if (hash.startsWith(prefix)) {
      const timeMs = Date.now() - start;
      return { nonce, hash, timeMs };
    }
    nonce++;
  }
}

/**
 * 自动获取 PoW base 并计算 nonce
 * 完整的 PoW 流程封装：获取 base → 计算 nonce
 * 使用 @dfinity SDK Actor 直接调用 canister
 */
export async function autoPoW(): Promise<AutoPowResult> {
  const principal = getPrincipalObj();
  const actor = await getSignActor();

  // 获取 PoW base（用户最新签名事件 ID）
  console.error('正在获取 PoW base...');
  const base = await actor.get_user_latest_sign_event_id(principal);

  if (!base || typeof base !== 'string') {
    console.error(`无法获取 PoW base: ${JSON.stringify(base)}`);
    process.exit(1);
  }

  // 计算 PoW nonce
  console.error(`正在计算 PoW (zeros=${config.pow_zeros})...`);
  const result = computePow(base, config.pow_zeros);
  console.error(`PoW 完成: nonce=${result.nonce}, 耗时 ${result.timeMs}ms`);

  return { nonce: result.nonce, hash: result.hash, base };
}

// ========== 命令行参数 ==========

/**
 * 解析命令行参数为结构化对象
 * 支持 --key=value 和 --flag 两种格式
 * 位置参数（非 -- 开头的）按顺序放入 _args 数组
 */
export function parseArgs(): ParsedArgs {
  const result: ParsedArgs = { _args: [] };
  // 跳过 node 和脚本路径
  const argv = process.argv.slice(2);

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        result[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        result[arg.slice(2)] = true;
      }
    } else {
      result._args.push(arg);
    }
  }
  return result;
}

/**
 * 解析 --tags 参数为标签数组
 * 格式: "t:crypto,sub:web3,m:alice_id"
 */
export function parseTags(tagsStr: string | boolean | string[] | undefined): string[][] {
  if (!tagsStr || typeof tagsStr !== 'string') return [];
  return tagsStr.split(',').map(pair => {
    const parts = pair.split(':');
    if (parts.length < 2) {
      console.error(`标签格式错误: "${pair}"，应为 key:value`);
      process.exit(1);
    }
    return [parts[0]!, parts.slice(1).join(':')];
  });
}

// ========== 文件哈希与 MIME ==========

/**
 * 计算文件的 SHA256 哈希（纯 Node.js 实现，无 shell 依赖）
 * @param filePath - 文件路径
 * @returns 64 字符 hex 哈希值
 */
export function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (err) {
    console.error(`计算文件哈希失败: ${filePath}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * 获取文件大小（字节）
 */
export function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (err) {
    console.error(`获取文件大小失败: ${filePath}`);
    process.exit(1);
  }
}

/**
 * 常用 MIME 类型映射表
 * 根据文件扩展名返回对应 MIME 类型
 */
const MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.wasm': 'application/wasm',
};

/**
 * 根据文件路径返回 MIME 类型
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

// ========== MANIFEST 生成 ==========

/**
 * 递归获取目录下所有文件（排除 MANIFEST.sha256、.git、node_modules）
 * @param dir - 目录路径
 * @param prefix - 路径前缀（用于递归）
 * @returns 相对路径列表（已排序）
 */
export function listFiles(dir: string, prefix?: string): string[] {
  const effectivePrefix = prefix || '';
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = effectivePrefix ? `${effectivePrefix}/${entry.name}` : entry.name;

    // 排除 MANIFEST.sha256、.git 和 node_modules
    if (entry.name === 'MANIFEST.sha256') continue;
    if (entry.name === '.git') continue;
    if (entry.name === 'node_modules') continue;

    if (entry.isDirectory()) {
      results.push(...listFiles(path.join(dir, entry.name), relativePath));
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }

  return results.sort();
}

/**
 * 生成 MANIFEST.sha256 文件（含元数据头）
 * 格式兼容 GNU sha256sum，元数据用 # 注释行表示
 *
 * 此版本使用纯 Node.js 实现，不依赖 shell 命令。
 * author 字段通过 identity.ts 获取，如果无法加载身份则留空。
 */
export function generateManifest(folderPath: string, options?: ManifestOptions): ManifestResult {
  const version = options?.version || '1.0.0';
  const manifestPath = path.join(folderPath, 'MANIFEST.sha256');

  // 获取 author（当前 principal）
  let author = '';
  try {
    author = getPrincipal();
  } catch {
    console.error('警告: 无法获取 principal，author 字段留空');
  }

  // 构建元数据头
  const folderName = path.basename(path.resolve(folderPath));
  const dateStr = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const header = [
    `# skill: ${folderName}`,
    `# date: ${dateStr}`,
    `# version: ${version}`,
    `# author: ${author}`,
  ].join('\n');

  // 递归获取所有文件并计算哈希
  const files = listFiles(folderPath);
  const hashLines = files.map(relativePath => {
    const fullPath = path.join(folderPath, relativePath);
    const hash = hashFile(fullPath);
    // 兼容 sha256sum 输出格式: <hash>  ./<relative_path>
    return `${hash}  ./${relativePath}`;
  });

  // 写入 MANIFEST.sha256
  const content = header + '\n' + hashLines.join('\n') + '\n';
  fs.writeFileSync(manifestPath, content, 'utf-8');

  // 计算 MANIFEST 自身的哈希和大小
  const manifestHash = hashFile(manifestPath);
  const manifestSize = getFileSize(manifestPath);

  return { manifestPath, manifestHash, manifestSize, fileCount: files.length };
}

// ========== 输出格式化 ==========

/**
 * 格式化 SignEvent 对象为可读文本
 * Candid opt 类型在 JS 中表示为 [] | [value]
 */
export function formatSignEvent(event: SignEvent): string {
  const lines: string[] = [];
  lines.push(`  id = "${event.id}"`);
  lines.push(`  kind = ${event.kind}`);
  lines.push(`  ai_id = "${event.ai_id}"`);
  lines.push(`  created_at = ${event.created_at}`);
  lines.push(`  content_hash = "${event.content_hash}"`);

  // 处理 opt counter — [] 表示 null，[n] 表示有值
  if (event.counter && event.counter.length > 0) {
    lines.push(`  counter = ${event.counter[0]}`);
  }

  // 处理 opt content
  if (event.content && event.content.length > 0) {
    lines.push(`  content = "${event.content[0]}"`);
  }

  // 处理 opt tags
  if (event.tags && event.tags.length > 0) {
    const tagsStr = event.tags[0]!
      .map(t => `[${t.map(s => `"${s}"`).join(', ')}]`)
      .join(', ');
    lines.push(`  tags = [${tagsStr}]`);
  }

  return `record {\n${lines.join('\n')}\n}`;
}

/**
 * 格式化 SignEvent 数组
 */
export function formatSignEvents(events: SignEvent[]): string {
  if (!events || events.length === 0) {
    return '(vec {})';
  }
  return `(vec {\n${events.map(e => formatSignEvent(e)).join(';\n')}\n})`;
}

/**
 * 格式化 agent_sign 的返回值（Ok/Err variant）
 */
export function formatSignResult(result: SignResult): string {
  if ('Ok' in result) {
    return `(variant { Ok = ${formatSignEvent(result.Ok)} })`;
  }
  if ('Err' in result) {
    return `(variant { Err = "${result.Err}" })`;
  }
  return JSON.stringify(result, null, 2);
}

/**
 * 格式化 opt text 类型
 */
export function formatOptText(optText: [] | [string]): string {
  if (optText && optText.length > 0) {
    return `(opt "${optText[0]}")`;
  }
  return '(null)';
}

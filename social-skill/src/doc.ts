#!/usr/bin/env node
/**
 * zCloak.ai 文档工具
 *
 * 提供 MANIFEST.sha256 生成、验证、文件哈希计算等功能。
 * 纯 Node.js 实现，跨平台兼容，无需外部 shell 命令。
 *
 * 用法:
 *   zcloak-agent doc manifest <folder_path> [--version=1.0.0]    生成 MANIFEST.sha256（含元数据头）
 *   zcloak-agent doc verify-manifest <folder_path>               验证 MANIFEST.sha256 中的文件完整性
 *   zcloak-agent doc hash <file_path>                            计算单文件 SHA256 哈希
 *   zcloak-agent doc info <file_path>                            显示文件哈希、大小、MIME 等信息
 */

import fs from 'fs';
import path from 'path';
import {
  parseArgs,
  hashFile,
  getFileSize,
  getMimeType,
  generateManifest,
} from './utils';
import type { ParsedArgs } from './types/common';

// ========== 帮助信息 ==========
function showHelp(): void {
  console.log('zCloak.ai 文档工具');
  console.log('');
  console.log('用法:');
  console.log('  zcloak-agent doc manifest <folder_path> [--version=1.0.0]   生成 MANIFEST.sha256');
  console.log('  zcloak-agent doc verify-manifest <folder_path>              验证文件完整性');
  console.log('  zcloak-agent doc hash <file_path>                           计算 SHA256 哈希');
  console.log('  zcloak-agent doc info <file_path>                           显示文件详细信息');
  console.log('');
  console.log('选项:');
  console.log('  --version=x.y.z  MANIFEST 版本号（默认 1.0.0）');
  console.log('');
  console.log('示例:');
  console.log('  zcloak-agent doc manifest ./my-skill/ --version=2.0.0');
  console.log('  zcloak-agent doc verify-manifest ./my-skill/');
  console.log('  zcloak-agent doc hash ./report.pdf');
  console.log('  zcloak-agent doc info ./report.pdf');
}

// ========== 命令实现 ==========

/**
 * 生成 MANIFEST.sha256（含元数据头）
 * 格式兼容 GNU sha256sum，元数据用 # 注释行表示
 */
function cmdManifest(folderPath: string | undefined, args: ParsedArgs): void {
  if (!folderPath) {
    console.error('错误: 需要提供文件夹路径');
    process.exit(1);
  }

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.error(`错误: 目录不存在: ${folderPath}`);
    process.exit(1);
  }

  const version = typeof args.version === 'string' ? args.version : '1.0.0';

  try {
    const result = generateManifest(folderPath, { version });
    console.log(`MANIFEST.sha256 已生成: ${result.manifestPath}`);
    console.log(`文件数: ${result.fileCount}`);
    console.log(`版本: ${version}`);
    console.log(`MANIFEST SHA256: ${result.manifestHash}`);
    console.log(`MANIFEST 大小: ${result.manifestSize} bytes`);
  } catch (err) {
    console.error(`生成 MANIFEST 失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * 验证 MANIFEST.sha256 中的文件完整性
 * 纯 Node.js 实现，逐行解析并验证每个文件的哈希
 */
function cmdVerifyManifest(folderPath: string | undefined): void {
  if (!folderPath) {
    console.error('错误: 需要提供文件夹路径');
    process.exit(1);
  }

  const manifestPath = path.join(folderPath, 'MANIFEST.sha256');
  if (!fs.existsSync(manifestPath)) {
    console.error(`错误: 未找到 MANIFEST.sha256: ${manifestPath}`);
    process.exit(1);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  let allPassed = true;
  let fileCount = 0;

  for (const line of manifestContent.split('\n')) {
    // 跳过注释行和空行
    if (!line.trim() || line.startsWith('#')) continue;

    // 解析格式: <hash>  ./<relative_path>  或  <hash>  <relative_path>
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) continue;

    const expectedHash = match[1]!;
    const relativePath = match[2]!.replace(/^\.\//, '');
    const fullPath = path.join(folderPath, relativePath);

    fileCount++;

    if (!fs.existsSync(fullPath)) {
      console.log(`FAILED: ${relativePath} (文件不存在)`);
      allPassed = false;
      continue;
    }

    const actualHash = hashFile(fullPath);
    if (actualHash === expectedHash) {
      console.log(`${relativePath}: OK`);
    } else {
      console.log(`${relativePath}: FAILED`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    console.error(`\n验证失败！部分文件不匹配（共检查 ${fileCount} 个文件）`);
    process.exit(1);
  }

  console.log(`\n所有文件验证通过！（共 ${fileCount} 个文件）`);

  // 输出 MANIFEST 哈希（方便后续链上验证）
  const manifestHash = hashFile(manifestPath);
  console.log(`\nMANIFEST SHA256: ${manifestHash}`);
  console.log('（可用此哈希进行链上签名验证: node verify.js file MANIFEST.sha256）');
}

/** 计算单文件 SHA256 哈希 */
function cmdHash(filePath: string | undefined): void {
  if (!filePath) {
    console.error('错误: 需要提供文件路径');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`错误: 文件不存在: ${filePath}`);
    process.exit(1);
  }

  const hash = hashFile(filePath);
  console.log(hash);
}

/** 显示文件详细信息（哈希、大小、MIME） */
function cmdInfo(filePath: string | undefined): void {
  if (!filePath) {
    console.error('错误: 需要提供文件路径');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`错误: 文件不存在: ${filePath}`);
    process.exit(1);
  }

  const hash = hashFile(filePath);
  const size = getFileSize(filePath);
  const fileName = path.basename(filePath);
  const mime = getMimeType(filePath);

  console.log(`文件名: ${fileName}`);
  console.log(`SHA256: ${hash}`);
  console.log(`大小: ${size} bytes`);
  console.log(`MIME: ${mime}`);

  // 输出 JSON 格式（方便复制用于签名）
  const contentObj = { title: fileName, hash, mime, url: '', size_bytes: size };
  console.log(`\nJSON (用于签名):\n${JSON.stringify(contentObj, null, 2)}`);
}

// ========== 主入口 ==========
function main(): void {
  const args = parseArgs();
  const command = args._args[0];

  switch (command) {
    case 'manifest':
      cmdManifest(args._args[1], args);
      break;
    case 'verify-manifest':
      cmdVerifyManifest(args._args[1]);
      break;
    case 'hash':
      cmdHash(args._args[1]);
      break;
    case 'info':
      cmdInfo(args._args[1]);
      break;
    default:
      showHelp();
      break;
  }
}

main();

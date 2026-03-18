import fs from 'fs';
import { debugLogPath, runtimeDir } from './paths.js';

function isDebugEnabled(): boolean {
  const value = process.env.ZCLOAK_DEBUG?.trim().toLowerCase();
  if (!value) return true;
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

function formatPart(part: unknown): string {
  if (part instanceof Error) {
    return part.stack || part.message;
  }
  if (typeof part === 'string') {
    return part;
  }
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function write(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', parts: unknown[]): void {
  const timestamp = new Date().toISOString();
  const line = parts.map(formatPart).join(' ');
  const entry = `[zcloak-ai] ${timestamp} ${level} ${line}\n`;

  process.stderr.write(entry);

  try {
    fs.mkdirSync(runtimeDir(), { recursive: true });
    fs.appendFileSync(debugLogPath(), entry, 'utf-8');
  } catch {
    // Logging must never break the main command path.
  }
}

export function debug(...parts: unknown[]): void {
  if (!isDebugEnabled()) return;
  write('DEBUG', parts);
}

export function info(...parts: unknown[]): void {
  write('INFO', parts);
}

export function warn(...parts: unknown[]): void {
  write('WARN', parts);
}

export function error(...parts: unknown[]): void {
  write('ERROR', parts);
}

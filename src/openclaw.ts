import { execFile } from 'node:child_process';
import type { SyncMailboxResult } from './zmail.js';
import * as log from './log.js';

const OPENCLAW_BIN = process.env['OPENCLAW_BIN'] || 'openclaw';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STATUS_CONTEXT_CHARS = 8_000;

function execFileText(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... (truncated)`;
}

export async function getOpenClawStatusContext(): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileText(OPENCLAW_BIN, ['status']);
    const raw = stdout || stderr;
    if (!raw) {
      throw new Error('openclaw status returned no output');
    }
    return truncateText(raw, MAX_STATUS_CONTEXT_CHARS);
  } catch (error) {
    log.warn('openclaw status failed', {
      command: OPENCLAW_BIN,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function notifyOpenClawMainAgentOfNewMail(
  summary: SyncMailboxResult,
  channelContext: string,
): Promise<boolean> {
  const message = [
    `New mail arrived. This zMail sync detected ${summary.inbox_new} new inbox message(s).`,
    'Please notify the channel by sending a message to the channel-provided number itself, not to any other person or contact.',
    'If no usable channel is configured, tell the user to configure a channel first so channel notifications can be used.',
    'openclaw status returned the following information. Please find the channel context yourself:',
    channelContext,
  ].join('\n\n');

  try {
    await execFileText(OPENCLAW_BIN, [
      'agent',
      '--agent',
      'main',
      '--message',
      message,
    ]);
    return true;
  } catch (error) {
    log.warn('openclaw agent notify failed', {
      command: OPENCLAW_BIN,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

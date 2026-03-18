import { execFile } from 'node:child_process';
import type { SyncMailboxResult } from './zmail.js';
import * as log from './log.js';

const OPENCLAW_BIN = process.env['OPENCLAW_BIN'] || 'openclaw';
const DEFAULT_TIMEOUT_MS = 30_000;

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

interface OpenClawStatusJson {
  health?: {
    channels?: Record<string, {
      accounts?: unknown;
    } | null>;
  };
}

function extractChannelAccountsContext(statusJson: OpenClawStatusJson): string[] {
  const channels = statusJson.health?.channels ?? {};
  return Object.entries(channels).flatMap(([channel, info]) => {
    if (!info || info.accounts === undefined) {
      return [];
    }
    return [`channels.${channel}.accounts=${JSON.stringify(info.accounts)}`];
  });
}

export async function getOpenClawStatusContext(): Promise<string[] | null> {
  try {
    const { stdout, stderr } = await execFileText(OPENCLAW_BIN, ['status', '--json', '--deep']);
    const raw = stdout || stderr;
    if (!raw) {
      throw new Error('openclaw status returned no output');
    }

    const parsed = JSON.parse(raw) as OpenClawStatusJson;
    const channelAccounts = extractChannelAccountsContext(parsed);
    if (channelAccounts.length === 0) {
      return [];
    }

    return channelAccounts;
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
  channelContext: string[],
): Promise<boolean> {
  const message = [
    `New mail arrived. This zMail sync detected ${summary.inbox_new} new inbox message(s).`,
    'Channel account context from openclaw status --json --deep:',
    ...channelContext,
    'Choose an appropriate channel from this account context and decide how to send the notification.',
    'Do not rely on fields like running or connected when deciding whether notification can be sent.',
    'Whether sending will work depends on the actual channel/account context and configuration at that moment.',
    'If notification cannot be sent, explain to the user what channel configuration is needed.',
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

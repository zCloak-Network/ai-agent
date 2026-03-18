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
      linked?: boolean;
      self?: {
        e164?: string | null;
        jid?: string | null;
      } | null;
    } | null>;
  };
}

interface LinkedChannelContext {
  channel: string;
  linked: true;
  self: {
    e164?: string | null;
    jid?: string | null;
  };
}

function extractLinkedChannelContext(statusJson: OpenClawStatusJson): LinkedChannelContext[] {
  const channels = statusJson.health?.channels ?? {};

  return Object.entries(channels)
    .flatMap(([channel, info]) => {
      if (!info?.linked || !info.self) {
        return [];
      }
      return [{
        channel,
        linked: true as const,
        self: {
          e164: info.self.e164 ?? null,
          jid: info.self.jid ?? null,
        },
      }];
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
    const linkedChannels = extractLinkedChannelContext(parsed);
    if (linkedChannels.length === 0) {
      return [];
    }

    return linkedChannels.map((item) => JSON.stringify(item));
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
    'Please notify the channel by sending a message to the channel-provided number itself, not to any other person or contact.',
    'If no usable channel is configured, tell the user to configure a channel first so channel notifications can be used.',
    'Linked channel self context from openclaw status --json --deep:',
    ...channelContext,
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

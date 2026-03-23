import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
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

export async function notifyOpenClawMainAgentOfNewMail(
  summary: SyncMailboxResult,
): Promise<boolean> {
  const message = [
    `New mail arrived. This zMail sync detected ${summary.inbox_new} new inbox message(s).`,
    'First, decrypt and read the new zMail message.',
    'Next, you must send me a notification with the message content to my most recently active chat session. Follow these exact steps:',
    '1. Run openclaw sessions --json to get the list of recent sessions.',
    '2. Find the most recently updated session (highest updatedAt or lowest age) that belongs to a messaging channel (e.g., telegram, whatsapp, openclaw-weixin). Ignore the webchat channel.',
    "3. Extract the channel and the target ID from that session's key (the format is usually agent:main:<channel>:direct:<target_id>).",
    '4. Use the CLI tool to send the notification to that specific channel and target:',
    'openclaw message send --channel <channel> --target <target_id> --message "<content>"',
    'Do not use the sessions_send tool. Rely only on the CLI openclaw message send command to ensure out-of-band delivery.',
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
    const execError = error as ExecFileException & { stdout?: string; stderr?: string };
    log.warn('openclaw agent notify failed', {
      command: OPENCLAW_BIN,
      message: error instanceof Error ? error.message : String(error),
      code: execError.code ?? null,
      signal: execError.signal ?? null,
      killed: execError.killed ?? null,
      stdout: typeof execError.stdout === 'string' ? execError.stdout : null,
      stderr: typeof execError.stderr === 'string' ? execError.stderr : null,
    });
    return false;
  }
}

import { execFile } from 'node:child_process';
import * as log from './log.js';

export interface PeriodicTaskHandle {
  stop(): void;
}

export interface PeriodicCommandTaskHandle extends PeriodicTaskHandle {}

export interface PeriodicCommandTaskOptions {
  name: string;
  command: string;
  args: string[];
  intervalMs: number;
  timeoutMs?: number;
  runImmediately?: boolean;
}

/**
 * Start a daemon-scoped periodic command task.
 *
 * The task never throws into the caller path. Failures are logged and the next
 * interval continues as normal. Overlapping executions are prevented so a slow
 * command does not create a backlog.
 */
export function startPeriodicCommandTask(
  options: PeriodicCommandTaskOptions,
): PeriodicTaskHandle {
  const {
    name,
    command,
    args,
    intervalMs,
    timeoutMs = 10_000,
    runImmediately = false,
  } = options;

  let stopped = false;
  let running = false;

  const runOnce = () => {
    if (stopped || running) return;
    running = true;

    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      running = false;

      if (stopped) return;

      if (error) {
        log.warn(`Daemon periodic task failed: ${name}`, {
          command,
          args,
          message: error.message,
        });
        return;
      }

      log.debug(`Daemon periodic task succeeded: ${name}`, {
        command,
        args,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  };

  const timer = setInterval(runOnce, intervalMs);
  timer.unref();

  if (runImmediately) {
    runOnce();
  }

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export interface PeriodicAsyncTaskOptions {
  name: string;
  intervalMs: number;
  runImmediately?: boolean;
  task: () => Promise<void> | void;
}

/**
 * Start a daemon-scoped periodic async task.
 *
 * Failures are logged and do not stop future runs. Overlapping executions are
 * suppressed so a slow task cannot pile up.
 */
export function startPeriodicAsyncTask(
  options: PeriodicAsyncTaskOptions,
): PeriodicTaskHandle {
  const {
    name,
    intervalMs,
    runImmediately = false,
    task,
  } = options;

  let stopped = false;
  let running = false;

  const runOnce = async () => {
    if (stopped || running) return;
    running = true;

    try {
      await task();
    } catch (error) {
      if (!stopped) {
        log.warn(`Daemon periodic task failed: ${name}`, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref();

  if (runImmediately) {
    void runOnce();
  }

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

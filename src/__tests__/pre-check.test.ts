/**
 * Tests for pre-check.ts — CLI self-update pre-flight behavior
 *
 * Verifies:
 *   - `updated: true` is returned only after npm install succeeds
 *   - automatic update failure does not masquerade as a successful upgrade
 *   - workspace SKILL.md refresh only runs after a successful CLI upgrade
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockHomedir,
  mockExecSync,
  mockHttpsGet,
} = vi.hoisted(() => ({
  mockHomedir: vi.fn(),
  mockExecSync: vi.fn(),
  mockHttpsGet: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: mockHomedir };
});

vi.mock('child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('https', () => ({
  default: { get: mockHttpsGet },
  get: mockHttpsGet,
}));

vi.mock('../log.js', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const originalCwd = process.cwd();

let tmpHome: string;
let tmpCwd: string;

async function loadPreCheckModule() {
  vi.resetModules();
  return import('../pre-check.js');
}

function installSuccessfulSkillDownload(body: string): void {
  mockHttpsGet.mockImplementation((_url: string, callback: (res: EventEmitter & {
    statusCode?: number;
    resume(): void;
    setEncoding(encoding: string): void;
  }) => void) => {
    const response = new EventEmitter() as EventEmitter & {
      statusCode?: number;
      resume(): void;
      setEncoding(encoding: string): void;
    };
    response.statusCode = 200;
    response.resume = () => {};
    response.setEncoding = () => {};

    const request = new EventEmitter() as EventEmitter & {
      setTimeout(timeout: number, handler: () => void): void;
      destroy(): void;
    };
    request.setTimeout = (_timeout: number, _handler: () => void) => {};
    request.destroy = () => {};

    queueMicrotask(() => {
      callback(response);
      response.emit('data', body);
      response.emit('end');
    });

    return request;
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-precheck-home-'));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-precheck-cwd-'));
  mockHomedir.mockReturnValue(tmpHome);
  mockExecSync.mockReset();
  mockHttpsGet.mockReset();
  process.chdir(tmpCwd);
});

afterEach(() => {
  vi.clearAllMocks();
  process.chdir(originalCwd);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('preCheck', () => {
  it('returns updated=true only after npm install succeeds', async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command === 'npm view @zcloak/ai-agent version') return '9.9.9\n';
      if (command === 'npm install -g @zcloak/ai-agent@latest') return '';
      throw new Error(`Unexpected command: ${command}`);
    });
    installSuccessfulSkillDownload('updated skill body');

    const { preCheck } = await loadPreCheckModule();
    const result = await preCheck();

    expect(result.updated).toBe(true);
    expect(result.message).toContain('Version update detected!');
    expect(mockExecSync).toHaveBeenCalledWith(
      'npm install -g @zcloak/ai-agent@latest',
      expect.objectContaining({ stdio: 'pipe' }),
    );

    const skillPath = path.join(tmpCwd, 'skills', 'zcloak-ai-agent', 'SKILL.md');
    expect(fs.readFileSync(skillPath, 'utf-8')).toBe('updated skill body');

    const checkFile = path.join(tmpHome, '.config', 'zcloak', '.last-update-check');
    expect(fs.existsSync(checkFile)).toBe(true);
  });

  it('does not report updated when npm install fails', async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command === 'npm view @zcloak/ai-agent version') return '9.9.9\n';
      if (command === 'npm install -g @zcloak/ai-agent@latest') {
        throw new Error('EACCES');
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { preCheck } = await loadPreCheckModule();
    const result = await preCheck();

    expect(result.updated).toBe(false);
    expect(result.message).toContain('automatic CLI update failed');
    expect(result.message).toContain('Continuing with the current CLI version.');
    expect(mockHttpsGet).not.toHaveBeenCalled();

    const skillPath = path.join(tmpCwd, 'skills', 'zcloak-ai-agent', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(false);

    const checkFile = path.join(tmpHome, '.config', 'zcloak', '.last-update-check');
    expect(fs.existsSync(checkFile)).toBe(true);
  });
});

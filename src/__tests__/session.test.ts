/**
 * Tests for session.ts — Session class construction and URL helpers
 *
 * Note: We only test synchronous, pure-logic aspects of Session.
 * Canister interactions (getSignActor, autoPoW, etc.) require network and are not tested here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Session } from '../session.js';
import config from '../config.js';

describe('Session construction', () => {
  it('parses args from argv correctly', () => {
    const session = new Session(['node', 'script.js', 'post', 'hello', '--sub=web3']);
    expect(session.args._args).toEqual(['post', 'hello']);
    expect(session.args.sub).toBe('web3');
  });

  it('resolves canisterIds from config', () => {
    const session = new Session(['node', 'script.js']);
    expect(session.canisterIds).toEqual(config.canisterIds);
  });
});

describe('Session.getPemPath', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves PEM path from --identity in argv', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-session-'));
    const pemPath = path.join(tmpDir, 'test.pem');
    fs.writeFileSync(pemPath, 'dummy-pem');

    const session = new Session(['node', 'script.js', `--identity=${pemPath}`]);
    expect(session.getPemPath()).toBe(pemPath);
  });
});

describe('Session URL helpers', () => {
  it('getBindUrl returns correct URL', () => {
    const session = new Session(['node', 'script.js']);
    expect(session.getBindUrl()).toBe(config.bind_url);
  });

  it('getProfileUrl returns correct URL', () => {
    const session = new Session(['node', 'script.js']);
    expect(session.getProfileUrl()).toBe(config.profile_url);
  });

  it('getTwoFAUrl returns correct URL', () => {
    const session = new Session(['node', 'script.js']);
    expect(session.getTwoFAUrl()).toBe(config.twofa_url);
  });

  it('getSettingUrl returns correct URL', () => {
    const session = new Session(['node', 'script.js']);
    expect(session.getSettingUrl()).toBe(config.setting_url);
  });
});

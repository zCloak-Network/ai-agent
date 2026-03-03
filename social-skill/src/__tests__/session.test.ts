/**
 * Tests for session.ts — Session class construction and environment helpers
 *
 * Note: We only test synchronous, pure-logic aspects of Session.
 * Canister interactions (getSignActor, autoPoW, etc.) require network and are not tested here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Session } from '../session';
import config from '../config';

describe('Session construction', () => {
  it('parses args from argv correctly', () => {
    const session = new Session(['node', 'script.js', 'post', 'hello', '--sub=web3']);
    expect(session.args._args).toEqual(['post', 'hello']);
    expect(session.args.sub).toBe('web3');
  });

  it('defaults env to "prod" when no --env', () => {
    const session = new Session(['node', 'script.js', 'command']);
    expect(session.env).toBe('prod');
  });

  it('sets env to "dev" with --env=dev', () => {
    const session = new Session(['node', 'script.js', '--env=dev']);
    expect(session.env).toBe('dev');
  });

  it('resolves canisterIds matching the environment', () => {
    const prodSession = new Session(['node', 'script.js']);
    expect(prodSession.canisterIds).toEqual(config.prod);

    const devSession = new Session(['node', 'script.js', '--env=dev']);
    expect(devSession.canisterIds).toEqual(config.dev);
  });

  it('throws on unknown env value', () => {
    expect(() => new Session(['node', 'script.js', '--env=staging'])).toThrow(
      'Unknown environment'
    );
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

describe('Session environment helpers', () => {
  it('getBindUrl returns correct URL for prod', () => {
    const session = new Session(['node', 'script.js']);
    expect(session.getBindUrl()).toBe(config.bind_url.prod);
  });

  it('getBindUrl returns correct URL for dev', () => {
    const session = new Session(['node', 'script.js', '--env=dev']);
    expect(session.getBindUrl()).toBe(config.bind_url.dev);
  });

  it('getProfileUrl returns correct URL for prod', () => {
    const session = new Session(['node', 'script.js']);
    expect(session.getProfileUrl()).toBe(config.profile_url.prod);
  });

  it('getProfileUrl returns correct URL for dev', () => {
    const session = new Session(['node', 'script.js', '--env=dev']);
    expect(session.getProfileUrl()).toBe(config.profile_url.dev);
  });
});

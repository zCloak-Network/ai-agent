/**
 * Tests for paths.ts — centralized file system path definitions.
 *
 * Verifies that all path functions return paths under the expected
 * root directory (~/.config/zcloak/) and that the legacy path helper
 * still points to the old location (~/.vetkey-tool/).
 *
 * Uses mocked os.homedir() so tests don't depend on real home directory.
 */

import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock os.homedir() to return a predictable value
const { mockHomedir } = vi.hoisted(() => ({
  mockHomedir: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: mockHomedir };
});

import {
  configDir,
  runtimeDir,
  mailboxesRoot,
  defaultPemPath,
  debugLogPath,
  daemonLogPath,
  lastUpdateCheckPath,
  mailboxDir,
  legacyRuntimeDir,
} from '../paths.js';

describe('paths', () => {
  const fakeHome = '/home/testuser';

  beforeEach(() => {
    mockHomedir.mockReturnValue(fakeHome);
  });

  // ── Root directories ─────────────────────────────────────────────────

  describe('configDir', () => {
    it('returns ~/.config/zcloak/', () => {
      expect(configDir()).toBe(path.join(fakeHome, '.config', 'zcloak'));
    });
  });

  describe('runtimeDir', () => {
    it('returns ~/.config/zcloak/run/', () => {
      expect(runtimeDir()).toBe(path.join(fakeHome, '.config', 'zcloak', 'run'));
    });

    it('is a subdirectory of configDir', () => {
      expect(runtimeDir().startsWith(configDir())).toBe(true);
    });
  });

  describe('mailboxesRoot', () => {
    it('returns ~/.config/zcloak/mailboxes/', () => {
      expect(mailboxesRoot()).toBe(path.join(fakeHome, '.config', 'zcloak', 'mailboxes'));
    });
  });

  // ── File paths ───────────────────────────────────────────────────────

  describe('defaultPemPath', () => {
    it('returns ~/.config/zcloak/ai-id.pem', () => {
      expect(defaultPemPath()).toBe(path.join(fakeHome, '.config', 'zcloak', 'ai-id.pem'));
    });
  });

  describe('debugLogPath', () => {
    it('returns ~/.config/zcloak/debug.log', () => {
      expect(debugLogPath()).toBe(path.join(fakeHome, '.config', 'zcloak', 'debug.log'));
    });
  });

  describe('lastUpdateCheckPath', () => {
    it('returns ~/.config/zcloak/.last-update-check', () => {
      expect(lastUpdateCheckPath()).toBe(path.join(fakeHome, '.config', 'zcloak', '.last-update-check'));
    });
  });

  describe('daemonLogPath', () => {
    it('returns lowercase key name under run/', () => {
      expect(daemonLogPath('Mail')).toBe(
        path.join(fakeHome, '.config', 'zcloak', 'run', 'mail-daemon.log'),
      );
    });

    it('handles already-lowercase key names', () => {
      expect(daemonLogPath('default')).toBe(
        path.join(fakeHome, '.config', 'zcloak', 'run', 'default-daemon.log'),
      );
    });
  });

  describe('mailboxDir', () => {
    it('returns per-principal subdirectory under mailboxes/', () => {
      const principal = 'abc-123-principal';
      expect(mailboxDir(principal)).toBe(
        path.join(fakeHome, '.config', 'zcloak', 'mailboxes', principal),
      );
    });
  });

  // ── Legacy paths ─────────────────────────────────────────────────────

  describe('legacyRuntimeDir', () => {
    it('returns ~/.vetkey-tool/ (old location)', () => {
      expect(legacyRuntimeDir()).toBe(path.join(fakeHome, '.vetkey-tool'));
    });

    it('does NOT overlap with the new runtimeDir', () => {
      expect(legacyRuntimeDir()).not.toBe(runtimeDir());
    });
  });
});

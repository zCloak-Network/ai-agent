/**
 * Tests for identity.ts — loadIdentityFromPath and related identity functions
 *
 * Covers: loadIdentityFromPath (valid PEM, invalid PEM, non-existent file)
 * Uses Node.js crypto to generate real secp256k1 PEM files for testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateKeyPairSync } from 'crypto';
import { loadIdentityFromPath } from '../identity.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcloak-identity-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Generate a valid secp256k1 SEC1 PEM file and return its path */
function createTestPem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pem = privateKey.export({ type: 'sec1', format: 'pem' }) as string;
  const pemPath = path.join(tmpDir, 'test-identity.pem');
  fs.writeFileSync(pemPath, pem, { mode: 0o600 });
  return pemPath;
}

describe('loadIdentityFromPath', () => {
  it('loads identity from a valid secp256k1 PEM file', () => {
    const pemPath = createTestPem();
    const identity = loadIdentityFromPath(pemPath);

    expect(identity).toBeDefined();
    // Secp256k1KeyIdentity should have getPrincipal()
    expect(typeof identity.getPrincipal().toText()).toBe('string');
  });

  it('returns an identity with a valid Principal (text format)', () => {
    const pemPath = createTestPem();
    const identity = loadIdentityFromPath(pemPath);
    const principal = identity.getPrincipal().toText();

    // ICP principal format: lowercase alphanumeric with dashes, ending with -cai or other suffixes
    // At minimum it should be a non-empty string with dashes
    expect(principal.length).toBeGreaterThan(0);
    expect(principal).toMatch(/^[a-z0-9-]+$/);
  });

  it('returns consistent identity for the same PEM file', () => {
    const pemPath = createTestPem();
    const id1 = loadIdentityFromPath(pemPath);
    const id2 = loadIdentityFromPath(pemPath);

    expect(id1.getPrincipal().toText()).toBe(id2.getPrincipal().toText());
  });

  it('returns different identities for different PEM files', () => {
    const pem1 = createTestPem();
    const id1 = loadIdentityFromPath(pem1);

    // Generate a second PEM
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const pem2Path = path.join(tmpDir, 'test-identity-2.pem');
    fs.writeFileSync(pem2Path, privateKey.export({ type: 'sec1', format: 'pem' }) as string);
    const id2 = loadIdentityFromPath(pem2Path);

    expect(id1.getPrincipal().toText()).not.toBe(id2.getPrincipal().toText());
  });

  it('throws for non-existent PEM file', () => {
    expect(() => loadIdentityFromPath('/nonexistent/path.pem')).toThrow();
  });

  it('throws for invalid PEM content', () => {
    const badPath = path.join(tmpDir, 'bad.pem');
    fs.writeFileSync(badPath, 'this is not a valid PEM file');

    expect(() => loadIdentityFromPath(badPath)).toThrow('Failed to load ECDSA secp256k1 identity');
  });

  it('throws for empty PEM file', () => {
    const emptyPath = path.join(tmpDir, 'empty.pem');
    fs.writeFileSync(emptyPath, '');

    expect(() => loadIdentityFromPath(emptyPath)).toThrow();
  });
});

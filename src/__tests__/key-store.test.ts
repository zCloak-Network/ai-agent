/**
 * Tests for key-store.ts — In-memory AES-256 key management
 *
 * These tests verify:
 * 1. KeyStore.deriveFromActor flow with mocked actor and crypto
 * 2. Encrypt/decrypt roundtrip via KeyStore
 * 3. Key zeroization on destroy()
 * 4. Operations rejected after destroy()
 * 5. Error propagation from canister calls
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { KeyStore } from '../key-store.js';

// ============================================================================
// Mock crypto module to control the VetKey derivation pipeline
// ============================================================================

vi.mock('../crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto.js')>();
  return {
    ...actual,
    // Mock IBE / transport layer functions (require real @dfinity/vetkeys at runtime)
    generateTransportKeypair: vi.fn(),
    decryptVetkey: vi.fn(),
    ibeDecryptWithCachedKey: vi.fn(),
  };
});

import * as cryptoOps from '../crypto.js';

// ============================================================================
// Helper: create a mock canister actor
// ============================================================================

function createMockActor(overrides?: {
  get_ibe_public_key?: () => Promise<Uint8Array>;
  derive_vetkey?: (id: string, tpk: number[]) => Promise<Uint8Array>;
}) {
  return {
    get_ibe_public_key: vi.fn(overrides?.get_ibe_public_key
      ?? (async () => new Uint8Array(96))),
    derive_vetkey: vi.fn(overrides?.derive_vetkey
      ?? (async () => new Uint8Array(192))),
  } as any;
}

describe('KeyStore', () => {
  /** Fake 48-byte VetKey (compressed G1 point) */
  const fakeVetkeyBytes = crypto.randomBytes(48);

  /** Fake transport key pair */
  const fakeTransportSecret = {} as any;
  const fakeTransportPublic = new Uint8Array(48);

  beforeEach(() => {
    // Setup default mocks for the happy path
    vi.mocked(cryptoOps.generateTransportKeypair).mockReturnValue([
      fakeTransportSecret,
      fakeTransportPublic,
    ]);
    vi.mocked(cryptoOps.decryptVetkey).mockReturnValue(
      new Uint8Array(fakeVetkeyBytes),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // deriveFromActor
  // ==========================================================================

  describe('deriveFromActor', () => {
    it('should complete the full derivation pipeline', async () => {
      const actor = createMockActor();
      const ks = await KeyStore.deriveFromActor(actor, 'principal1:default');

      // Verify canister calls were made
      expect(actor.get_ibe_public_key).toHaveBeenCalledOnce();
      expect(actor.derive_vetkey).toHaveBeenCalledOnce();
      expect(actor.derive_vetkey).toHaveBeenCalledWith(
        'principal1:default',
        Array.from(fakeTransportPublic),
      );

      // Verify crypto pipeline was invoked
      expect(cryptoOps.generateTransportKeypair).toHaveBeenCalledOnce();
      expect(cryptoOps.decryptVetkey).toHaveBeenCalledOnce();

      // KeyStore should be functional
      expect(ks.derivationId).toBe('principal1:default');

      // Encrypt + decrypt roundtrip
      const plaintext = Buffer.from('test data');
      const ciphertext = ks.encrypt(plaintext);
      const decrypted = ks.decrypt(ciphertext);
      expect(decrypted.toString('utf-8')).toBe('test data');

      ks.destroy();
    });

    it('should throw ToolError when get_ibe_public_key fails', async () => {
      const actor = createMockActor({
        get_ibe_public_key: async () => { throw new Error('network timeout'); },
      });

      await expect(KeyStore.deriveFromActor(actor, 'p:default'))
        .rejects.toThrow('get_ibe_public_key failed');
    });

    it('should throw ToolError when derive_vetkey fails', async () => {
      const actor = createMockActor({
        derive_vetkey: async () => { throw new Error('canister rejected'); },
      });

      await expect(KeyStore.deriveFromActor(actor, 'p:default'))
        .rejects.toThrow('derive_vetkey failed');
    });

    it('should propagate decryptVetkey errors', async () => {
      vi.mocked(cryptoOps.decryptVetkey).mockImplementation(() => {
        throw new Error('BLS signature verification failed');
      });

      const actor = createMockActor();
      await expect(KeyStore.deriveFromActor(actor, 'p:default'))
        .rejects.toThrow('BLS signature verification failed');
    });
  });

  // ==========================================================================
  // createForTest
  // ==========================================================================

  describe('createForTest', () => {
    it('should create a functional KeyStore with default test key', () => {
      const ks = KeyStore.createForTest('test:default');
      expect(ks.derivationId).toBe('test:default');

      const ct = ks.encrypt(Buffer.from('hello'));
      const pt = ks.decrypt(ct);
      expect(pt.toString('utf-8')).toBe('hello');

      ks.destroy();
    });

    it('should create a KeyStore with custom key', () => {
      const customKey = crypto.randomBytes(32);
      const ks = KeyStore.createForTest('test:custom', customKey);

      const ct = ks.encrypt(Buffer.from('data'));
      const pt = ks.decrypt(ct);
      expect(pt.toString('utf-8')).toBe('data');

      ks.destroy();
    });
  });

  // ==========================================================================
  // destroy() and key zeroization
  // ==========================================================================

  describe('destroy', () => {
    it('should reject encrypt after destroy', () => {
      const ks = KeyStore.createForTest('test:destroy');
      ks.destroy();
      expect(() => ks.encrypt(Buffer.from('test'))).toThrow('destroyed');
    });

    it('should reject decrypt after destroy', () => {
      const ks = KeyStore.createForTest('test:destroy');
      const ct = ks.encrypt(Buffer.from('test'));
      ks.destroy();
      expect(() => ks.decrypt(ct)).toThrow('destroyed');
    });

    it('should be safe to call destroy multiple times', () => {
      const ks = KeyStore.createForTest('test:multi-destroy');
      ks.destroy();
      ks.destroy(); // Should not throw
    });

    it('should reject ibeDecrypt after destroy', () => {
      const vetkeyBytes = crypto.randomBytes(48);
      const dpkBytes = new Uint8Array(96);
      const ks = KeyStore.createForTestWithIbe('test:ibe-destroy', vetkeyBytes, dpkBytes);
      ks.destroy();
      expect(() => ks.ibeDecrypt('test:Mail', Buffer.from('ct'))).toThrow('destroyed');
    });
  });

  // ==========================================================================
  // IBE support (Mail daemon mode)
  // ==========================================================================

  describe('IBE support', () => {
    it('should report hasIbeSupport=false for createForTest (no VetKey cached)', () => {
      const ks = KeyStore.createForTest('test:no-ibe');
      expect(ks.hasIbeSupport).toBe(false);
      ks.destroy();
    });

    it('should report hasIbeSupport=true for createForTestWithIbe', () => {
      const vetkeyBytes = crypto.randomBytes(48);
      const dpkBytes = new Uint8Array(96);
      const ks = KeyStore.createForTestWithIbe('test:ibe', vetkeyBytes, dpkBytes);
      expect(ks.hasIbeSupport).toBe(true);
      ks.destroy();
    });

    it('should throw when ibeDecrypt called without IBE support', () => {
      const ks = KeyStore.createForTest('test:no-ibe');
      expect(() => ks.ibeDecrypt('test:Mail', Buffer.from('ct')))
        .toThrow('does not have cached VetKey');
      ks.destroy();
    });

    it('should delegate to ibeDecryptWithCachedKey', () => {
      const vetkeyBytes = crypto.randomBytes(48);
      const dpkBytes = new Uint8Array(96);
      const plaintext = Buffer.from('decrypted message');

      vi.mocked(cryptoOps.ibeDecryptWithCachedKey).mockReturnValue(
        new Uint8Array(plaintext),
      );

      const ks = KeyStore.createForTestWithIbe('test:ibe', vetkeyBytes, dpkBytes);
      const result = ks.ibeDecrypt('test:Mail', Buffer.from('fake-ciphertext'));

      expect(cryptoOps.ibeDecryptWithCachedKey).toHaveBeenCalledWith(
        vetkeyBytes,
        dpkBytes,
        'test:Mail',
        Buffer.from('fake-ciphertext'),
      );
      expect(result.toString('utf-8')).toBe('decrypted message');

      ks.destroy();
    });

    it('should clear VetKey bytes on destroy', () => {
      const vetkeyBytes = Buffer.alloc(48, 0xab);
      const dpkBytes = new Uint8Array(96);
      const ks = KeyStore.createForTestWithIbe('test:ibe-zero', vetkeyBytes, dpkBytes);

      expect(ks.hasIbeSupport).toBe(true);
      ks.destroy();
      expect(ks.hasIbeSupport).toBe(false);

      // VetKey buffer should be zeroed
      expect(vetkeyBytes.every(b => b === 0)).toBe(true);
    });
  });
});

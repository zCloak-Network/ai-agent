/**
 * Tests for crypto.ts — AES-256-GCM encryption/decryption and IBE identity generation
 *
 * These tests verify:
 * 1. VKDA format encryption/decryption roundtrip
 * 2. VKDA format validation (magic header, version, minimum size)
 * 3. IBE identity string generation format
 * 4. VetKey → AES-256 key derivation
 * 5. Transport key pair generation
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  aes256Encrypt,
  aes256Decrypt,
  vetkeyToAes256,
  makeIbeIdentity,
  generateTransportKeypair,
} from '../crypto.js';

describe('AES-256-GCM (VKDA format)', () => {
  // Use a fixed key for reproducible tests
  const testKey = Buffer.alloc(32, 0x42);

  it('should encrypt and decrypt empty data', () => {
    const plaintext = Buffer.alloc(0);
    const ciphertext = aes256Encrypt(testKey, plaintext);
    const decrypted = aes256Decrypt(testKey, ciphertext);
    expect(Buffer.compare(decrypted, plaintext)).toBe(0);
  });

  it('should encrypt and decrypt short text', () => {
    const plaintext = Buffer.from('Hello, VetKey!');
    const ciphertext = aes256Encrypt(testKey, plaintext);
    const decrypted = aes256Decrypt(testKey, ciphertext);
    expect(decrypted.toString('utf-8')).toBe('Hello, VetKey!');
  });

  it('should encrypt and decrypt binary data', () => {
    const plaintext = crypto.randomBytes(1024);
    const ciphertext = aes256Encrypt(testKey, plaintext);
    const decrypted = aes256Decrypt(testKey, ciphertext);
    expect(Buffer.compare(decrypted, plaintext)).toBe(0);
  });

  it('should encrypt and decrypt large data (1 MB)', () => {
    const plaintext = crypto.randomBytes(1024 * 1024);
    const ciphertext = aes256Encrypt(testKey, plaintext);
    const decrypted = aes256Decrypt(testKey, ciphertext);
    expect(Buffer.compare(decrypted, plaintext)).toBe(0);
  });

  it('should produce VKDA magic header', () => {
    const ciphertext = aes256Encrypt(testKey, Buffer.from('test'));
    // VKDA magic: 0x56, 0x4B, 0x44, 0x41
    expect(ciphertext[0]).toBe(0x56); // 'V'
    expect(ciphertext[1]).toBe(0x4b); // 'K'
    expect(ciphertext[2]).toBe(0x44); // 'D'
    expect(ciphertext[3]).toBe(0x41); // 'A'
  });

  it('should produce version 0x01', () => {
    const ciphertext = aes256Encrypt(testKey, Buffer.from('test'));
    expect(ciphertext[4]).toBe(0x01);
  });

  it('should have correct overhead (33 bytes)', () => {
    const plaintext = Buffer.from('Hello');
    const ciphertext = aes256Encrypt(testKey, plaintext);
    // Overhead = magic(4) + version(1) + nonce(12) + GCM tag(16) = 33
    expect(ciphertext.length).toBe(plaintext.length + 33);
  });

  it('should produce different ciphertexts for same plaintext (random nonce)', () => {
    const plaintext = Buffer.from('same data');
    const ct1 = aes256Encrypt(testKey, plaintext);
    const ct2 = aes256Encrypt(testKey, plaintext);
    // Different random nonces → different ciphertexts
    expect(Buffer.compare(ct1, ct2)).not.toBe(0);
  });

  it('should reject data with wrong magic header', () => {
    const ciphertext = aes256Encrypt(testKey, Buffer.from('test'));
    const corrupted = Buffer.from(ciphertext);
    corrupted[0] = 0x00; // Corrupt magic
    expect(() => aes256Decrypt(testKey, corrupted)).toThrow('Invalid VKDA magic');
  });

  it('should reject data with wrong version', () => {
    const ciphertext = aes256Encrypt(testKey, Buffer.from('test'));
    const corrupted = Buffer.from(ciphertext);
    corrupted[4] = 0x02; // Wrong version
    expect(() => aes256Decrypt(testKey, corrupted)).toThrow('Unsupported VKDA version');
  });

  it('should reject data too short', () => {
    expect(() => aes256Decrypt(testKey, Buffer.alloc(10))).toThrow('Data too short');
  });

  it('should reject data with wrong key', () => {
    const ciphertext = aes256Encrypt(testKey, Buffer.from('secret'));
    const wrongKey = Buffer.alloc(32, 0x99);
    expect(() => aes256Decrypt(wrongKey, ciphertext)).toThrow('AES-256-GCM decryption failed');
  });

  it('should reject tampered ciphertext (GCM authentication)', () => {
    const ciphertext = aes256Encrypt(testKey, Buffer.from('secret'));
    const tampered = Buffer.from(ciphertext);
    // Flip a bit in the encrypted data (after header)
    tampered[20] ^= 0x01;
    expect(() => aes256Decrypt(testKey, tampered)).toThrow();
  });
});

describe('vetkeyToAes256', () => {
  it('should derive 32-byte key from 48-byte VetKey', () => {
    const vetkeyBytes = crypto.randomBytes(48);
    const aesKey = vetkeyToAes256(vetkeyBytes);
    expect(aesKey.length).toBe(32);
  });

  it('should produce deterministic output for same input', () => {
    const vetkeyBytes = Buffer.alloc(48, 0xab);
    const key1 = vetkeyToAes256(vetkeyBytes);
    const key2 = vetkeyToAes256(vetkeyBytes);
    expect(Buffer.compare(key1, key2)).toBe(0);
  });

  it('should produce different keys for different inputs', () => {
    const vk1 = Buffer.alloc(48, 0x01);
    const vk2 = Buffer.alloc(48, 0x02);
    const key1 = vetkeyToAes256(vk1);
    const key2 = vetkeyToAes256(vk2);
    expect(Buffer.compare(key1, key2)).not.toBe(0);
  });

  it('should reject wrong input length', () => {
    expect(() => vetkeyToAes256(Buffer.alloc(32))).toThrow('Invalid VetKey length');
    expect(() => vetkeyToAes256(Buffer.alloc(96))).toThrow('Invalid VetKey length');
  });
});

describe('makeIbeIdentity', () => {
  it('should produce correct format: principal:hash16:timestamp', () => {
    const identity = makeIbeIdentity('abc-def', Buffer.from('hello'));
    const parts = identity.split(':');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('abc-def');
    expect(parts[1]).toHaveLength(16); // 16 hex chars
    expect(parts[1]).toMatch(/^[0-9a-f]{16}$/); // Hex only
    expect(Number(parts[2])).toBeGreaterThan(0); // Valid timestamp
  });

  it('should produce consistent hash for same content', () => {
    const content = Buffer.from('same content');
    const id1 = makeIbeIdentity('principal1', content);
    const id2 = makeIbeIdentity('principal1', content);
    // Hash part should be the same, but timestamp differs
    const hash1 = id1.split(':')[1];
    const hash2 = id2.split(':')[1];
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different content', () => {
    const id1 = makeIbeIdentity('p', Buffer.from('content-a'));
    const id2 = makeIbeIdentity('p', Buffer.from('content-b'));
    const hash1 = id1.split(':')[1];
    const hash2 = id2.split(':')[1];
    expect(hash1).not.toBe(hash2);
  });
});

describe('generateTransportKeypair', () => {
  it('should generate 48-byte public key', () => {
    const [_tsk, publicKey] = generateTransportKeypair();
    expect(publicKey.length).toBe(48);
  });

  it('should generate different keys each time', () => {
    const [_, pk1] = generateTransportKeypair();
    const [__, pk2] = generateTransportKeypair();
    expect(Buffer.compare(Buffer.from(pk1), Buffer.from(pk2))).not.toBe(0);
  });
});

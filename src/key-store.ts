/**
 * Key Store — In-memory AES-256 key management for daemon mode
 *
 * Responsible for securely holding the AES-256 key during daemon runtime.
 * The key is derived from a VetKey obtained from the trust canister at startup.
 *
 * Key derivation flow:
 *   1. Generate ephemeral transport key pair
 *   2. Call actor.derive_vetkey(derivationId, transportPublicKey)
 *   3. Decrypt EncryptedVetKey with transport secret → VetKey (G1 point, 48B)
 *   4. HKDF(vetkey_bytes, "vetkey-aes256-file-encryption") → AES-256 key (32B)
 *
 * Memory safety note:
 *   JavaScript does not have Rust's ZeroizeOnDrop equivalent. We use
 *   Buffer.fill(0) to manually clear the key when destroy() is called.
 *   This is best-effort — the GC may have created copies we can't reach.
 *   For production use, the key exists only in a single Buffer that we
 *   can explicitly zero.
 */

import type { ActorSubclass } from '@dfinity/agent';
import * as cryptoOps from './crypto.js';
import { encryptionError, canisterCallError } from './error.js';

/**
 * In-memory AES-256 key holder for daemon mode.
 *
 * The AES key is derived from VetKey at startup and held in a Buffer.
 * Optionally caches the raw VetKey bytes for IBE decryption (Mail daemon mode).
 * Call destroy() when done to zero all key bytes.
 */
export class KeyStore {
  /** AES-256 key (32 bytes), derived from VetKey via HKDF */
  private aesKey: Buffer;
  /** Raw VetKey bytes (48 bytes, compressed G1 point) — cached for IBE decryption */
  private vetkeyBytes: Buffer | null;
  /** IBE derived public key bytes (96 bytes) — cached for IBE decryption */
  private dpkBytes: Uint8Array | null;
  /** Derivation ID used for this key (format: "{principal}:{key_name}") */
  private _derivationId: string;
  /** Whether the key has been destroyed */
  private destroyed = false;

  private constructor(
    aesKey: Buffer,
    derivationId: string,
    vetkeyBytes?: Buffer,
    dpkBytes?: Uint8Array,
  ) {
    this.aesKey = aesKey;
    this._derivationId = derivationId;
    this.vetkeyBytes = vetkeyBytes ?? null;
    this.dpkBytes = dpkBytes ?? null;
  }

  /**
   * Derive a VetKey from the canister via the sign actor and create a KeyStore.
   *
   * Complete flow:
   *   1. Fetch IBE public key from canister (needed for BLS signature verification)
   *   2. Generate random transport key pair
   *   3. Call actor.derive_vetkey(derivationId, transportPublicKey)
   *   4. Transport-decrypt EncryptedVetKey → VetKey (48 bytes)
   *   5. HKDF(vetkey_bytes, domain_sep) → AES-256 key (32 bytes)
   *
   * Uses the same sign actor (signIdlFactory) from the existing Session pattern,
   * which now includes VetKey methods on the same canister.
   *
   * @param actor - Signatures canister actor (with VetKey methods)
   * @param derivationId - Derivation ID (format: "{principal}:{key_name}")
   * @returns Initialized KeyStore
   */
  static async deriveFromActor(
    actor: ActorSubclass<any>,
    derivationId: string,
  ): Promise<KeyStore> {
    // Step 1: Get IBE public key (needed for EncryptedVetKey BLS signature verification)
    let dpkBytes: Uint8Array;
    try {
      const result = await actor.get_ibe_public_key() as Uint8Array;
      dpkBytes = new Uint8Array(result);
    } catch (e) {
      throw canisterCallError(
        `get_ibe_public_key failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }

    // Step 2: Generate ephemeral transport key pair
    const [transportSecret, transportPublic] = cryptoOps.generateTransportKeypair();

    // Step 3: Call canister to derive encrypted VetKey
    let encryptedVetkeyBytes: Uint8Array;
    try {
      const result = await actor.derive_vetkey(
        derivationId,
        Array.from(transportPublic),
      ) as Uint8Array;
      encryptedVetkeyBytes = new Uint8Array(result);
    } catch (e) {
      throw canisterCallError(
        `derive_vetkey failed: ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }

    // Step 4: Transport-decrypt and verify the VetKey
    const vetkeyBytes = cryptoOps.decryptVetkey(
      encryptedVetkeyBytes,
      dpkBytes,
      derivationId,
      transportSecret,
    );

    // Step 5: HKDF derive AES-256 key from VetKey bytes
    const aesKey = cryptoOps.vetkeyToAes256(vetkeyBytes);

    // Cache raw VetKey and DPK for IBE decryption (Mail daemon mode)
    return new KeyStore(aesKey, derivationId, Buffer.from(vetkeyBytes), dpkBytes);
  }

  /**
   * Create a KeyStore with a known test key (for unit/integration testing only).
   *
   * @internal
   */
  static createForTest(derivationId: string, key?: Buffer): KeyStore {
    const aesKey = key ?? Buffer.alloc(32, 0x42); // Fixed test key
    return new KeyStore(aesKey, derivationId);
  }

  /**
   * Create a KeyStore with VetKey + DPK for IBE testing.
   *
   * @internal
   */
  static createForTestWithIbe(
    derivationId: string,
    vetkeyBytes: Buffer,
    dpkBytes: Uint8Array,
    key?: Buffer,
  ): KeyStore {
    const aesKey = key ?? Buffer.alloc(32, 0x42);
    return new KeyStore(aesKey, derivationId, vetkeyBytes, dpkBytes);
  }

  /**
   * Encrypt plaintext using the held AES-256 key.
   *
   * Output format: [magic:4B "VKDA"][version:1B][nonce:12B][ciphertext+GCM_tag]
   *
   * @param plaintext - Data to encrypt
   * @returns VKDA-formatted ciphertext
   */
  encrypt(plaintext: Uint8Array): Buffer {
    this.checkNotDestroyed();
    return cryptoOps.aes256Encrypt(this.aesKey, plaintext);
  }

  /**
   * Decrypt VKDA-formatted ciphertext using the held AES-256 key.
   *
   * @param ciphertext - VKDA-formatted ciphertext
   * @returns Decrypted plaintext
   */
  decrypt(ciphertext: Uint8Array): Buffer {
    this.checkNotDestroyed();
    return cryptoOps.aes256Decrypt(this.aesKey, ciphertext);
  }

  /**
   * IBE-decrypt a ciphertext using the cached VetKey.
   *
   * Used by Mail daemon mode: the sender IBE-encrypted using identity
   * "{recipient_principal}:Mail", and the recipient's daemon holds the
   * VetKey for that identity.
   *
   * @param ibeIdentity - IBE identity string used during encryption
   * @param ciphertextBytes - IBE ciphertext bytes
   * @returns Decrypted plaintext
   */
  ibeDecrypt(ibeIdentity: string, ciphertextBytes: Uint8Array): Buffer {
    this.checkNotDestroyed();
    if (!this.vetkeyBytes || !this.dpkBytes) {
      throw encryptionError(
        "KeyStore does not have cached VetKey/DPK bytes (required for IBE decryption)",
      );
    }
    return Buffer.from(
      cryptoOps.ibeDecryptWithCachedKey(
        this.vetkeyBytes,
        this.dpkBytes,
        ibeIdentity,
        ciphertextBytes,
      ),
    );
  }

  /** Whether this KeyStore supports IBE decryption (has cached VetKey) */
  get hasIbeSupport(): boolean {
    return this.vetkeyBytes !== null && this.dpkBytes !== null;
  }

  /** Get the derivation ID (for status reporting, not sensitive) */
  get derivationId(): string {
    return this._derivationId;
  }

  /**
   * Destroy the key store by zeroing all key bytes.
   *
   * After calling destroy(), encrypt(), decrypt(), and ibeDecrypt() will throw.
   * This is best-effort memory cleanup — JavaScript GC may have
   * created copies we cannot reach.
   */
  destroy(): void {
    if (!this.destroyed) {
      this.aesKey.fill(0);
      if (this.vetkeyBytes) {
        this.vetkeyBytes.fill(0);
        this.vetkeyBytes = null;
      }
      this.dpkBytes = null;
      this.destroyed = true;
    }
  }

  /** Throw if the KeyStore has been destroyed */
  private checkNotDestroyed(): void {
    if (this.destroyed) {
      throw encryptionError("KeyStore has been destroyed (key zeroized)");
    }
  }
}

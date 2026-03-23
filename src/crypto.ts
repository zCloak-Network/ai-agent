/**
 * Cryptographic Primitives for VetKey Operations
 *
 * Two categories of operations:
 *
 * 1. IBE (Identity-Based Encryption) — Uses @dfinity/vetkeys for BLS12-381 operations.
 *    Used for per-operation Kind5 PrivatePost encryption.
 *
 * 2. AES-256-GCM — Uses Node.js built-in crypto module.
 *    Used for daemon mode fast file encryption/decryption.
 *    VKDA binary format: [magic "VKDA":4B][version:1B][nonce:12B][ciphertext+GCM tag]
 *
 * All formats are byte-level compatible with the Rust vetkey-tool implementation.
 */

import crypto from 'crypto';
import {
  TransportSecretKey,
  DerivedPublicKey,
  EncryptedVetKey,
  VetKey,
  IbeCiphertext,
  IbeIdentity,
  IbeSeed,
} from '@dfinity/vetkeys';
import { encryptionError, decryptionError } from './error.js';

// ============================================================================
// Constants
// ============================================================================

/** VKDA magic header bytes ("VKDA" in ASCII) */
const AES_DAEMON_MAGIC = Buffer.from([0x56, 0x4b, 0x44, 0x41]);

/** VKDA format version */
const AES_DAEMON_VERSION = 0x01;

/** AES-256-GCM nonce size in bytes */
const AES_GCM_NONCE_BYTES = 12;

/** AES-256-GCM authentication tag size in bytes */
const AES_GCM_TAG_BYTES = 16;

/** VKDA header overhead: magic(4) + version(1) + nonce(12) + tag(16) = 33 bytes */
const VKDA_OVERHEAD = 4 + 1 + AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES;

/** HKDF domain separator for VetKey → AES-256 key derivation (must match Rust) */
const VETKEY_AES256_DOMAIN = "vetkey-aes256-file-encryption";

// ============================================================================
// IBE Operations (via @dfinity/vetkeys)
// ============================================================================

/**
 * Generate an ephemeral transport key pair for secure VetKey delivery.
 *
 * The transport secret key is used to decrypt the EncryptedVetKey received
 * from the canister. The public key is sent to the canister so it can
 * encrypt the VetKey for this specific requester.
 *
 * @returns [transportSecretKey, transportPublicKeyBytes (48 bytes, compressed G1)]
 */
export function generateTransportKeypair(): [TransportSecretKey, Uint8Array] {
  const tsk = TransportSecretKey.random();
  const publicKeyBytes = tsk.publicKeyBytes();
  return [tsk, publicKeyBytes];
}

/**
 * IBE-encrypt plaintext using the derived public key and identity string.
 *
 * Uses the Fujisaki-Okamoto transform internally (handled by @dfinity/vetkeys).
 * Output format: [header:8B][C1:96B][C2:32B][C3:plaintext_len+16B] (152 bytes overhead)
 *
 * @param dpkBytes - IBE derived public key (96 bytes, compressed G2 point)
 * @param ibeIdentity - IBE identity string (e.g. "{principal}:{hash}:{timestamp}")
 * @param plaintext - Data to encrypt
 * @returns IBE ciphertext bytes
 */
export function ibeEncrypt(
  dpkBytes: Uint8Array,
  ibeIdentity: string,
  plaintext: Uint8Array,
): Uint8Array {
  try {
    const dpk = DerivedPublicKey.deserialize(dpkBytes);
    const identity = IbeIdentity.fromString(ibeIdentity);
    const seed = IbeSeed.random();
    const ciphertext = IbeCiphertext.encrypt(dpk, identity, plaintext, seed);
    return ciphertext.serialize();
  } catch (e) {
    throw encryptionError(
      `IBE encrypt failed: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

/**
 * Full IBE decrypt: transport-decrypt VetKey, then IBE-decrypt ciphertext.
 *
 * Complete flow:
 *   1. Deserialize EncryptedVetKey (192 bytes)
 *   2. Transport-decrypt and verify BLS signature → VetKey
 *   3. Deserialize IBE ciphertext
 *   4. IBE-decrypt using VetKey → plaintext
 *
 * @param encryptedKeyBytes - Transport-encrypted VetKey (192 bytes)
 * @param dpkBytes - IBE derived public key (96 bytes)
 * @param ibeIdentity - IBE identity string
 * @param ciphertextBytes - IBE ciphertext
 * @param transportSecret - Transport secret key (for decrypting the VetKey)
 * @returns Decrypted plaintext
 */
export function ibeDecrypt(
  encryptedKeyBytes: Uint8Array,
  dpkBytes: Uint8Array,
  ibeIdentity: string,
  ciphertextBytes: Uint8Array,
  transportSecret: TransportSecretKey,
): Uint8Array {
  try {
    // Step 1-2: Transport-decrypt the VetKey
    const encryptedVetKey = EncryptedVetKey.deserialize(encryptedKeyBytes);
    const dpk = DerivedPublicKey.deserialize(dpkBytes);
    // decryptAndVerify expects raw bytes for the input (derivation ID / IBE identity)
    const identityBytes = new TextEncoder().encode(ibeIdentity);
    const vetKey = encryptedVetKey.decryptAndVerify(transportSecret, dpk, identityBytes);

    // Step 3-4: IBE-decrypt the ciphertext
    const ibeCiphertext = IbeCiphertext.deserialize(ciphertextBytes);
    return ibeCiphertext.decrypt(vetKey);
  } catch (e) {
    throw decryptionError(
      `IBE decrypt failed: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

/**
 * IBE-decrypt ciphertext using a cached (already-decrypted) VetKey.
 *
 * Used by Mail daemon mode: the VetKey is derived once at startup and
 * cached in KeyStore. Subsequent decryptions skip the canister call
 * and transport-decryption step entirely.
 *
 * @param vetkeyBytes - Raw VetKey bytes (48 bytes, compressed G1 point)
 * @param dpkBytes - IBE derived public key (96 bytes)
 * @param ibeIdentity - IBE identity string used during encryption
 * @param ciphertextBytes - IBE ciphertext
 * @returns Decrypted plaintext
 */
export function ibeDecryptWithCachedKey(
  vetkeyBytes: Uint8Array,
  _dpkBytes: Uint8Array,
  _ibeIdentity: string,
  ciphertextBytes: Uint8Array,
): Uint8Array {
  try {
    // Reconstruct VetKey from cached raw bytes.
    // The VetKey was already verified during the initial derive_vetkey + decryptAndVerify
    // step at daemon startup, so no re-verification is needed here.
    const vetKey = VetKey.deserialize(vetkeyBytes);

    // IBE-decrypt the ciphertext
    const ibeCiphertext = IbeCiphertext.deserialize(ciphertextBytes);
    return ibeCiphertext.decrypt(vetKey);
  } catch (e) {
    throw decryptionError(
      `IBE decrypt (cached key) failed: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

/**
 * Transport-decrypt an EncryptedVetKey and return raw VetKey bytes.
 *
 * Used by daemon mode to obtain the VetKey for AES-256 key derivation.
 * The derivation ID serves as the IBE identity in this context.
 *
 * @param encryptedKeyBytes - Transport-encrypted VetKey (192 bytes)
 * @param dpkBytes - IBE derived public key (96 bytes)
 * @param derivationId - Derivation ID string (used as IBE identity)
 * @param transportSecret - Transport secret key
 * @returns Raw VetKey bytes (48 bytes, compressed G1 point)
 */
export function decryptVetkey(
  encryptedKeyBytes: Uint8Array,
  dpkBytes: Uint8Array,
  derivationId: string,
  transportSecret: TransportSecretKey,
): Uint8Array {
  try {
    const encryptedVetKey = EncryptedVetKey.deserialize(encryptedKeyBytes);
    const dpk = DerivedPublicKey.deserialize(dpkBytes);
    // decryptAndVerify expects raw bytes for the input (derivation ID)
    const derivationIdBytes = new TextEncoder().encode(derivationId);
    const vetKey = encryptedVetKey.decryptAndVerify(transportSecret, dpk, derivationIdBytes);
    return vetKey.signatureBytes();
  } catch (e) {
    throw decryptionError(
      `VetKey transport decryption failed: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

// ============================================================================
// IBE Identity Generation
// ============================================================================

/**
 * Generate an IBE identity string for Kind5 PrivatePost.
 *
 * Format: "{principal}:{short_hash_16_hex}:{timestamp_ms}"
 * - short_hash: first 16 hex chars of SHA-256(content)
 * - timestamp_ms: current time in milliseconds
 *
 * Must match the Rust implementation exactly for cross-compatibility.
 *
 * @param principal - ICP principal text
 * @param content - Content bytes to hash
 * @returns IBE identity string
 */
export function makeIbeIdentity(principal: string, content: Uint8Array): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const shortHash = hash.slice(0, 16); // First 16 hex chars
  const timestamp = Date.now();
  return `${principal}:${shortHash}:${timestamp}`;
}

// ============================================================================
// AES-256-GCM Operations (Daemon Mode)
// ============================================================================

/**
 * Derive an AES-256 key from VetKey bytes using HKDF-SHA256.
 *
 * Domain separator: "vetkey-aes256-file-encryption" (must match Rust implementation)
 *
 * @param vetkeyBytes - Raw VetKey bytes (48 bytes, compressed G1 point)
 * @returns AES-256 key (32 bytes)
 */
export function vetkeyToAes256(vetkeyBytes: Uint8Array): Buffer {
  if (vetkeyBytes.length !== 48) {
    throw encryptionError(`Invalid VetKey length: expected 48, got ${vetkeyBytes.length}`);
  }

  // HKDF-SHA256 with VetKey as IKM and domain separator as info
  // Using empty salt (matches Rust hkdf::Hkdf::new(None, ikm))
  return Buffer.from(
    crypto.hkdfSync("sha256", vetkeyBytes, Buffer.alloc(0), VETKEY_AES256_DOMAIN, 32),
  );
}

/**
 * Encrypt plaintext using AES-256-GCM in VKDA format.
 *
 * Output format: [magic "VKDA":4B][version 0x01:1B][nonce:12B][ciphertext+GCM tag]
 * This format is byte-level compatible with the Rust vetkey-tool implementation.
 *
 * @param key - AES-256 key (32 bytes)
 * @param plaintext - Data to encrypt
 * @returns VKDA-formatted ciphertext
 */
export function aes256Encrypt(key: Buffer, plaintext: Uint8Array): Buffer {
  // Generate random 12-byte nonce
  const nonce = crypto.randomBytes(AES_GCM_NONCE_BYTES);

  // Encrypt with AES-256-GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  // Assemble VKDA format: magic + version + nonce + ciphertext + tag
  return Buffer.concat([
    AES_DAEMON_MAGIC,
    Buffer.from([AES_DAEMON_VERSION]),
    nonce,
    encrypted,
    tag,
  ]);
}

/**
 * Encrypt plaintext with AES-256-GCM and return detached parts.
 *
 * Unlike {@link aes256Encrypt}, this helper does not wrap the output in VKDA.
 * It is used by Kind17 v2 mail content, which stores IV and ciphertext/tag
 * separately inside a JSON payload.
 */
export function aes256GcmEncryptRaw(
  key: Uint8Array,
  plaintext: Uint8Array,
  options: { iv?: Uint8Array; aad?: Uint8Array } = {},
): { iv: Buffer; ciphertext: Buffer; tag: Buffer } {
  const iv = options.iv ? Buffer.from(options.iv) : crypto.randomBytes(AES_GCM_NONCE_BYTES);
  if (iv.length !== AES_GCM_NONCE_BYTES) {
    throw encryptionError(`Invalid AES-GCM IV length: expected ${AES_GCM_NONCE_BYTES}, got ${iv.length}`);
  }

  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key), iv);
  if (options.aad) {
    cipher.setAAD(Buffer.from(options.aad));
  }

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ciphertext, tag };
}

/**
 * Decrypt VKDA-formatted ciphertext using AES-256-GCM.
 *
 * Validates the VKDA magic header and version, then performs
 * authenticated GCM decryption.
 *
 * @param key - AES-256 key (32 bytes)
 * @param data - VKDA-formatted ciphertext
 * @returns Decrypted plaintext
 */
export function aes256Decrypt(key: Buffer, data: Uint8Array): Buffer {
  // Validate minimum size
  if (data.length < VKDA_OVERHEAD) {
    throw decryptionError(
      `Data too short: ${data.length} bytes (minimum ${VKDA_OVERHEAD} bytes for VKDA format)`,
    );
  }

  // Validate magic header
  if (
    data[0] !== 0x56 || // 'V'
    data[1] !== 0x4b || // 'K'
    data[2] !== 0x44 || // 'D'
    data[3] !== 0x41    // 'A'
  ) {
    throw decryptionError("Invalid VKDA magic header (expected 'VKDA')");
  }

  // Validate version
  if (data[4] !== AES_DAEMON_VERSION) {
    throw decryptionError(
      `Unsupported VKDA version: ${data[4]} (expected ${AES_DAEMON_VERSION})`,
    );
  }

  // Extract components
  const nonce = data.subarray(5, 5 + AES_GCM_NONCE_BYTES);                        // bytes 5-16
  const ciphertextWithTag = data.subarray(5 + AES_GCM_NONCE_BYTES);               // bytes 17+
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - AES_GCM_TAG_BYTES);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - AES_GCM_TAG_BYTES);

  // Decrypt with AES-256-GCM
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw decryptionError(
      `AES-256-GCM decryption failed (authentication tag mismatch or corrupted data): ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

/**
 * Decrypt detached AES-256-GCM payload parts.
 *
 * Counterpart to {@link aes256GcmEncryptRaw}. The caller supplies the IV and
 * authentication tag out-of-band instead of using VKDA framing.
 */
export function aes256GcmDecryptRaw(
  key: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  tag: Uint8Array,
  options: { aad?: Uint8Array } = {},
): Buffer {
  if (iv.length !== AES_GCM_NONCE_BYTES) {
    throw decryptionError(`Invalid AES-GCM IV length: expected ${AES_GCM_NONCE_BYTES}, got ${iv.length}`);
  }
  if (tag.length !== AES_GCM_TAG_BYTES) {
    throw decryptionError(`Invalid AES-GCM tag length: expected ${AES_GCM_TAG_BYTES}, got ${tag.length}`);
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv));
    if (options.aad) {
      decipher.setAAD(Buffer.from(options.aad));
    }
    decipher.setAuthTag(Buffer.from(tag));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
  } catch (e) {
    throw decryptionError(
      `AES-256-GCM decryption failed: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
}

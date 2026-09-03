/**
 * NexusGenesis - Wallet Encryption Module
 *
 * AES-256-GCM authenticated encryption for private key storage.
 *
 * Key derivation: PBKDF2-HMAC-SHA512 (310,000 iterations, OWASP 2023 recommendation)
 * Cipher: AES-256-GCM (authenticated, prevents tampering)
 * IV: 12 bytes (NIST SP 800-38D recommended for GCM)
 * Salt: 32 bytes (random per encryption)
 * Auth tag: 16 bytes (auto-managed by GCM)
 *
 * Output format (JSON-serializable):
 * {
 *   version: '1.0',
 *   kdf: { algorithm: 'pbkdf2-sha512', iterations: 310000, salt: 'hex' },
 *   cipher: 'aes-256-gcm',
 *   iv: 'hex',
 *   ciphertext: 'hex',
 *   authTag: 'hex',
 *   metadata: { createdAt, address, publicKey }
 * }
 */

import crypto from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

const KDF_ALGORITHM = 'pbkdf2-sha512';
const KDF_ITERATIONS = 310_000;        // OWASP 2023 minimum for PBKDF2-SHA512
const KDF_KEY_LENGTH = 32;             // 256 bits → AES-256
const KDF_DIGEST = 'sha512';

const CIPHER_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;                  // 96 bits (NIST SP 800-38D)
const SALT_LENGTH = 32;                // 256 bits
const AUTH_TAG_LENGTH = 16;            // 128 bits (GCM default)

const ENCRYPTION_VERSION = '1.0';
const ENVELOPE_VERSION = 1;            // Bump if format changes

// ─── Errors ──────────────────────────────────────────────────────────────────

export class WalletEncryptionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WalletEncryptionError';
    this.code = code;
  }
}

// ─── KDF (Key Derivation) ─────────────────────────────────────────────────────

/**
 * Derive 256-bit AES key from password + salt using PBKDF2-HMAC-SHA512.
 * @param {string} password - User password
 * @param {Buffer} salt - Per-encryption random salt
 * @returns {Buffer} 32-byte key
 */
function deriveKey(password, salt) {
  if (!password || typeof password !== 'string') {
    throw new WalletEncryptionError('Password is required', 'INVALID_PASSWORD');
  }
  if (password.length < 8) {
    throw new WalletEncryptionError('Password must be at least 8 characters', 'WEAK_PASSWORD');
  }
  return crypto.pbkdf2Sync(password, salt, KDF_ITERATIONS, KDF_KEY_LENGTH, KDF_DIGEST);
}

// ─── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Encrypt private key with AES-256-GCM.
 *
 * @param {Buffer|string} privateKey - Private key (Buffer or hex string)
 * @param {string} password - User password
 * @param {object} metadata - Optional metadata (address, publicKey, etc.)
 * @returns {object} Envelope ready to JSON-serialize
 */
export function encryptPrivateKey(privateKey, password, metadata = {}) {
  if (privateKey == null) {
    throw new WalletEncryptionError('Private key is required', 'MISSING_KEY');
  }

  // Normalize to Buffer
  const pkBuffer = Buffer.isBuffer(privateKey)
    ? privateKey
    : Buffer.from(privateKey, 'hex');

  // Generate random salt + IV
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // Derive key
  const key = deriveKey(password, salt);

  // Create cipher
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });

  // Encrypt
  const plaintext = pkBuffer.toString('hex');
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  // Get auth tag
  const authTag = cipher.getAuthTag();

  return {
    envelope: ENVELOPE_VERSION,
    version: ENCRYPTION_VERSION,
    kdf: {
      algorithm: KDF_ALGORITHM,
      iterations: KDF_ITERATIONS,
      salt: salt.toString('hex'),
      keyLength: KDF_KEY_LENGTH
    },
    cipher: CIPHER_ALGORITHM,
    iv: iv.toString('hex'),
    ciphertext,
    authTag: authTag.toString('hex'),
    metadata: {
      ...metadata,
      createdAt: new Date().toISOString(),
      keyLength: pkBuffer.length
    }
  };
}

// ─── Decrypt ─────────────────────────────────────────────────────────────────

/**
 * Decrypt envelope to recover private key.
 *
 * @param {object} envelope - Encrypted envelope
 * @param {string} password - User password
 * @returns {Buffer} Private key as Buffer
 * @throws {WalletEncryptionError} If decryption fails (wrong password / tampered data)
 */
export function decryptPrivateKey(envelope, password) {
  if (!envelope || typeof envelope !== 'object') {
    throw new WalletEncryptionError('Invalid envelope', 'INVALID_ENVELOPE');
  }
  if (envelope.cipher !== CIPHER_ALGORITHM) {
    throw new WalletEncryptionError(
      `Unsupported cipher: ${envelope.cipher}`,
      'UNSUPPORTED_CIPHER'
    );
  }
  if (!envelope.kdf || envelope.kdf.algorithm !== KDF_ALGORITHM) {
    throw new WalletEncryptionError(
      `Unsupported KDF: ${envelope.kdf?.algorithm}`,
      'UNSUPPORTED_KDF'
    );
  }

  const salt = Buffer.from(envelope.kdf.salt, 'hex');
  const iv = Buffer.from(envelope.iv, 'hex');
  const authTag = Buffer.from(envelope.authTag, 'hex');
  const iterations = envelope.kdf.iterations;

  // Derive key (use envelope's iteration count)
  const key = crypto.pbkdf2Sync(
    password,
    salt,
    iterations,
    KDF_KEY_LENGTH,
    envelope.kdf.algorithm.replace('pbkdf2-', '')
  );

  // Create decipher
  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });
  decipher.setAuthTag(authTag);

  // Decrypt
  let plaintext;
  try {
    plaintext = decipher.update(envelope.ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');   // Throws if auth tag fails
  } catch (e) {
    throw new WalletEncryptionError(
      'Decryption failed: wrong password or tampered data',
      'AUTH_FAILED'
    );
  }

  return Buffer.from(plaintext, 'hex');
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

/**
 * Verify a password can decrypt an envelope without returning the key.
 * @param {object} envelope
 * @param {string} password
 * @returns {boolean} True if password is correct
 */
export function verifyPassword(envelope, password) {
  try {
    decryptPrivateKey(envelope, password);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Sanity-check envelope structure (without decrypting).
 * @param {object} envelope
 * @returns {boolean} True if envelope is well-formed
 */
export function isValidEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (envelope.envelope !== ENVELOPE_VERSION) return false;
  if (envelope.cipher !== CIPHER_ALGORITHM) return false;
  if (!envelope.kdf || envelope.kdf.algorithm !== KDF_ALGORITHM) return false;
  if (!envelope.iv || !envelope.ciphertext || !envelope.authTag) return false;
  if (!envelope.kdf.salt) return false;
  return true;
}

/**
 * Return the encryption parameters used (for inspection / migration).
 */
export function getEncryptionInfo() {
  return {
    version: ENCRYPTION_VERSION,
    envelopeVersion: ENVELOPE_VERSION,
    cipher: CIPHER_ALGORITHM,
    kdf: {
      algorithm: KDF_ALGORITHM,
      iterations: KDF_ITERATIONS,
      keyLength: KDF_KEY_LENGTH
    },
    ivLength: IV_LENGTH,
    saltLength: SALT_LENGTH,
    authTagLength: AUTH_TAG_LENGTH
  };
}

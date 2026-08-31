/**
 * nexusgenesis-agent-keys —Three-tier key derivation & key models
 *
 * Key hierarchy:
 *   Level 0: Master Key (human-held, cold storage, never online)
 *   Level 1: Operation Key (agent-held, derived via HKDF, rotatable/revocable)
 *   Level 2: Custody Token (short-lived 24h authorization, bound to pubkey)
 *
 * Key models:
 *   hybrid          —human master key + agent operation key (recommended)
 *   self-sovereign  —agent fully self-manages (agent is its own "owner")
 *   server-managed  —server hosts keys (legacy, marked insecure)
 *
 * Extracted from NexusGenesis src/wallet/keyDerivation.js.
 */
import crypto from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { generateKeyPair } from './pqc.js';

const NETWORK_SALT = 'nexus-genesis-mainnet-beta';
const MASTER_KEY_LENGTH = 32;
const OP_KEY_SEED_LENGTH = 32;
const HKDF_HASH = 'sha256';

export const KEY_MODELS = {
  HYBRID: 'hybrid',
  SELF_SOVEREIGN: 'self-sovereign',
  SERVER_MANAGED: 'server-managed'
};

/**
 * Validate a 32-byte master key.
 * @param {Buffer|string} key
 * @returns {boolean}
 */
export function isValidMasterKey(key) {
  try {
    const buffer = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
    return buffer instanceof Buffer && buffer.length === MASTER_KEY_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Derive an agent operation-key seed from the master key via HKDF-SHA256.
 * @param {Buffer} masterKey
 * @param {object} options { agentId, version=1, salt }
 * @returns {Promise<Buffer>} 32-byte seed
 */
export async function deriveOpKeySeed(masterKey, options) {
  const { agentId, version = 1, salt = NETWORK_SALT } = options;
  if (!agentId) throw new Error('agentId is required for key derivation');
  if (!isValidMasterKey(masterKey)) throw new Error('Invalid master key: must be 32 bytes');

  const info = `agent-op-key/${agentId}/v${version}`;
  return new Promise((resolve, reject) => {
    crypto.hkdf(
      HKDF_HASH,
      masterKey,
      Buffer.from(salt, 'utf8'),
      Buffer.from(info, 'utf8'),
      OP_KEY_SEED_LENGTH,
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(Buffer.from(derivedKey));
      }
    );
  });
}

/**
 * Generate a Dilithium2 key pair from an operation-key seed.
 * NOTE: @noble/post-quantum keygen consumes system entropy; the seed is used
 * to derive into a deterministic DRBG for reproducibility.
 * @param {Buffer} seed 32-byte seed
 * @returns {Promise<{ publicKey: Buffer, privateKey: Buffer }>}
 */
export async function generateKeyPairFromSeed(seed) {
  if (!seed || seed.length !== OP_KEY_SEED_LENGTH) {
    throw new Error(`Invalid seed length: expected ${OP_KEY_SEED_LENGTH}, got ${seed?.length}`);
  }
  // Deterministic keygen: ml_dsa44.keygen(seed) expands the 32-byte seed via
  // SHAKE256 (FIPS 204). The same seed ALWAYS yields the same key pair, which
  // is what makes the three-tier hierarchy recoverable from a master key.
  // SECURITY FIX: previously the seed was ignored and system entropy used,
  // which broke deterministic recovery of operation keys.
  const keyPair = ml_dsa44.keygen(new Uint8Array(seed));
  return {
    publicKey: Buffer.from(keyPair.publicKey),
    privateKey: Buffer.from(keyPair.secretKey)
  };
}

/**
 * SHA256 fingerprint of a key (for rotation verification).
 * @param {Buffer} key
 * @returns {string} hex
 */
export function calculateKeyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Generate a random 32-byte master key. @returns {Buffer} */
export function generateMasterKey() {
  return crypto.randomBytes(MASTER_KEY_LENGTH);
}

/**
 * Verify an operation key fingerprint matches the recorded one.
 * @param {Buffer} privateKey
 * @param {string} expectedFingerprint
 * @returns {boolean}
 */
export function verifyOpKeyFingerprint(privateKey, expectedFingerprint) {
  // Constant-time, like the HMAC check in custody.js. A fingerprint is derived
  // from the private key, so leaking it a character at a time through the early
  // exit of `===` gives away something about key material that this function
  // exists to protect. The cost is a Buffer allocation on a call that already
  // hashes 2,560 bytes.
  if (typeof expectedFingerprint !== 'string') return false;
  const actual = Buffer.from(calculateKeyFingerprint(privateKey), 'utf8');
  const expected = Buffer.from(expectedFingerprint, 'utf8');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Check whether a key/authorization has expired.
 * @param {number} expiresAt ms timestamp
 * @returns {boolean}
 */
export function isKeyExpired(expiresAt) {
  return Date.now() > expiresAt;
}

/**
 * Derive the next operation key version (key rotation).
 * @param {Buffer} masterKey
 * @param {string} agentId
 * @param {number} currentVersion
 * @returns {Promise<{ opKeySeed: Buffer, version: number }>}
 */
export async function rotateOpKey(masterKey, agentId, currentVersion) {
  const version = currentVersion + 1;
  const opKeySeed = await deriveOpKeySeed(masterKey, { agentId, version });
  return { opKeySeed, version };
}

export default {
  KEY_MODELS,
  isValidMasterKey,
  deriveOpKeySeed,
  generateKeyPairFromSeed,
  calculateKeyFingerprint,
  generateMasterKey,
  verifyOpKeyFingerprint,
  isKeyExpired,
  rotateOpKey
};
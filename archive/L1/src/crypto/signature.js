/**
 * NexusGenesis - Unified Signature Utility (P1-2)
 *
 * Provides a consistent interface for signing and verifying messages
 * across both Dilithium2 (PQC) and Ed25519 algorithms.
 *
 * Usage:
 *   import { signMessage, verifySignature, normalizeMessage } from './signature.js';
 *
 *   const sig = await signMessage('hello', privateKeyBuffer);
 *   const ok = await verifySignature('hello', sig, publicKeyBuffer);
 *
 * Features:
 *   - Unified interface: same API for Dilithium2 and Ed25519
 *   - Auto-detection: algorithm selected by key length
 *   - Standardized message format: objects auto-stringified, strings UTF-8
 *   - Exports hex signatures by default
 */

import crypto from 'crypto';

// ─── Constants ───────────────────────────────────────────────────────
const DILITHIUM2_PUBLIC_KEY_LENGTH = 1312;
const DILITHIUM2_PRIVATE_KEY_LENGTH = 2560;
const ED25519_PRIVATE_KEY_LENGTH = 32; // raw seed length

/**
 * Normalize a message to a Buffer for signing.
 * Objects are JSON-stringified, strings are UTF-8 encoded.
 * @param {string|object|Buffer} message
 * @returns {Buffer}
 */
export function normalizeMessage(message) {
  if (Buffer.isBuffer(message)) return message;
  if (typeof message === 'object') {
    return Buffer.from(JSON.stringify(message, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    ));
  }
  return Buffer.from(String(message));
}

/**
 * Detect the signing algorithm based on key material.
 * @param {Buffer} key - Private or public key buffer
 * @returns {'dilithium2'|'ed25519'}
 */
export function detectAlgorithm(key) {
  if (!key || !Buffer.isBuffer(key)) {
    throw new Error('Invalid key: must be a Buffer');
  }
  if (key.length === DILITHIUM2_PRIVATE_KEY_LENGTH || key.length === DILITHIUM2_PUBLIC_KEY_LENGTH) {
    return 'dilithium2';
  }
  if (key.length === ED25519_PRIVATE_KEY_LENGTH) {
    return 'ed25519';
  }
  // Ed25519 public keys are 32 bytes, but could also be passed as hex
  if (key.length === 32) {
    return 'ed25519';
  }
  throw new Error(`Unknown algorithm for key length: ${key.length}`);
}

/**
 * Sign a message using the specified or auto-detected algorithm.
 *
 * @param {string|object|Buffer} message - Message to sign
 * @param {Buffer} privateKey - Private key buffer
 * @param {'dilithium2'|'ed25519'} [algorithm] - Auto-detect if omitted
 * @returns {Promise<string>} Hex-encoded signature
 */
export async function signMessage(message, privateKey, algorithm) {
  const msgBuf = normalizeMessage(message);
  const algo = algorithm || detectAlgorithm(privateKey);

  if (algo === 'dilithium2') {
    const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
    const signature = ml_dsa44.sign(msgBuf, privateKey);
    return Buffer.from(signature).toString('hex');
  }

  if (algo === 'ed25519') {
    // Convert raw 32-byte seed to JWK for Node's crypto API
    const pubKey = await deriveEd25519PublicKey(privateKey);
    const privJwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      d: bufferToBase64Url(privateKey),
      x: bufferToBase64Url(pubKey)
    };
    const privKey = crypto.createPrivateKey({ key: privJwk, format: 'jwk' });
    const signature = crypto.sign(null, msgBuf, privKey);
    return signature.toString('hex');
  }

  throw new Error(`Unsupported algorithm: ${algo}`);
}

/**
 * Verify a message signature.
 *
 * @param {string|object|Buffer} message - Original message
 * @param {string|Buffer} signatureHex - Hex-encoded signature
 * @param {Buffer} publicKey - Public key buffer
 * @param {'dilithium2'|'ed25519'} [algorithm] - Auto-detect if omitted
 * @returns {Promise<boolean>} Verification result
 */
export async function verifySignature(message, signatureHex, publicKey, algorithm) {
  const msgBuf = normalizeMessage(message);
  const sigBuf = typeof signatureHex === 'string' ? Buffer.from(signatureHex, 'hex') : signatureHex;
  const algo = algorithm || detectAlgorithm(publicKey);

  if (algo === 'dilithium2') {
    const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
    try {
      return ml_dsa44.verify(sigBuf, msgBuf, publicKey);
    } catch {
      return false;
    }
  }

  if (algo === 'ed25519') {
    try {
      const pubJwk = {
        kty: 'OKP',
        crv: 'Ed25519',
        x: bufferToBase64Url(publicKey)
      };
      const pubKey = crypto.createPublicKey({ key: pubJwk, format: 'jwk' });
      return crypto.verify(null, msgBuf, pubKey, sigBuf);
    } catch {
      return false;
    }
  }

  throw new Error(`Unsupported algorithm: ${algo}`);
}

/**
 * Sign a transaction object (standardized format).
 * Creates a deterministic string from the transaction (excluding signature),
 * then signs it.
 *
 * @param {object} transaction - Transaction object (without signature field)
 * @param {Buffer} privateKey - Private key buffer
 * @returns {Promise<string>} Hex-encoded signature
 */
export async function signTransaction(transaction, privateKey) {
  const { signature, ...txData } = transaction;
  return signMessage(txData, privateKey);
}

// ─── Internal helpers ─────────────────────────────────────────────────

function bufferToBase64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Derive Ed25519 public key from a 32-byte seed.
 * Uses Node.js internal key derivation.
 */
async function deriveEd25519PublicKey(privateKeySeed) {
  // Create a key object from the raw seed, then extract the public key
  const jwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    d: bufferToBase64Url(privateKeySeed),
    x: '' // placeholder, will be filled by Node
  };
  const keyObj = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const pubJwk = keyObj.export({ format: 'jwk' });
  return Buffer.from(pubJwk.x, 'base64url');
}
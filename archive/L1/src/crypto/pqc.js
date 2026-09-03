/**
 * NexusGenesis - Post-Quantum Cryptography Module
 * Real post-quantum cryptography implementation based on @noble/post-quantum
 * 
 * Algorithm: Dilithium2 (NIST FIPS 204)
 * hash: SHA3-256
 */

import crypto from 'crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';

// Key length constants (ml_dsa44 / Dilithium2)
const DILITHIUM2_PUBLIC_KEY_LENGTH = 1312;
const DILITHIUM2_PRIVATE_KEY_LENGTH = 2560;
const DILITHIUM2_SIGNATURE_LENGTH = 2420;

console.log('[PQC] Using real Dilithium2 implementation from @noble/post-quantum');

/**
 * GenerateDilithium2key pair
 * @returns {Promise<{publicKey: Buffer, privateKey: Buffer}>} key pair
 */
export async function generateKeyPair() {
  try {
    const keyPair = ml_dsa44.keygen();
    return {
      publicKey: Buffer.from(keyPair.publicKey),
      privateKey: Buffer.from(keyPair.secretKey)
    };
  } catch (error) {
    console.error('[PQC] Error generating Dilithium2 key pair:', error.message);
    throw error;
  }
}

/**
 * Use Dilithium2 toSign
 * @param {string|Buffer} message to signMessage
 * @param {Buffer} privateKey private key
 * @returns {Promise<Buffer>} Sign
 */
export async function sign(message, privateKey) {
  try {
    const messageBuffer = typeof message === 'string' ? Buffer.from(message) : message;
    
    // Verifyprivate keylength
    if (privateKey.length !== DILITHIUM2_PRIVATE_KEY_LENGTH) {
      throw new Error(`Invalid private key length: ${privateKey.length}, expected: ${DILITHIUM2_PRIVATE_KEY_LENGTH}`);
    }
    
    const signature = ml_dsa44.sign(messageBuffer, privateKey);
    return Buffer.from(signature);
  } catch (error) {
    console.error('[PQC] Error signing message:', error.message);
    throw error;
  }
}

/**
 * Use Dilithium2 toVerifySign
 * @param {string|Buffer} message originalMessage
 * @param {Buffer} signature Sign
 * @param {Buffer} publicKey public key
 * @returns {Promise<boolean>} verification result
 */
export async function verify(message, signature, publicKey) {
  try {
    const messageBuffer = typeof message === 'string' ? Buffer.from(message) : message;
    
    // Verifypublic keylength
    if (publicKey.length !== DILITHIUM2_PUBLIC_KEY_LENGTH) {
      console.error(`[PQC] Invalid public key length: ${publicKey.length}, expected: ${DILITHIUM2_PUBLIC_KEY_LENGTH}`);
      return false;
    }
    
    // VerifySignlength
    if (signature.length !== DILITHIUM2_SIGNATURE_LENGTH) {
      console.error(`[PQC] Invalid signature length: ${signature.length}, expected: ${DILITHIUM2_SIGNATURE_LENGTH}`);
      return false;
    }
    
    const isValid = ml_dsa44.verify(signature, messageBuffer, publicKey);
    return isValid;
  } catch (error) {
    console.error('[PQC] Error verifying signature:', error.message);
    return false;
  }
}

/**
 * Secure hash function
 * @param {string|Buffer} data 要hash的data
 * @param {string} algorithm hashalgorithm, Default为sha3-256
 * @returns {string} hash值(十六进制)
 */
export function hash(data, algorithm = 'sha3-256') {
  const hash = crypto.createHash(algorithm);
  hash.update(typeof data === 'string' ? data : data);
  return hash.digest('hex');
}

/**
 * Generaterandom bytes
 * @param {number} length random byteslength(字节)
 * @returns {Buffer} random bytes
 */
export function randomBytes(length) {
  return crypto.randomBytes(length);
}

/**
 * Generaterandom string
 * @param {number} length 字符串length
 * @returns {string} random string
 */
export function randomString(length) {
  const bytes = randomBytes(length);
  return bytes.toString('hex').slice(0, length);
}

/**
 * Secure timestamp validation
 * @param {number} timestamp timestamp
 * @param {number} maxTimeDiff max time difference(ms)
 * @returns {boolean} verification result
 */
export function validateTimestamp(timestamp, maxTimeDiff = 2 * 60 * 1000) {
  const now = Date.now();
  const timeDiff = Math.abs(now - timestamp);
  return timeDiff <= maxTimeDiff;
}

/**
 * anti-replayCheck
 * @param {string} nonce random bytes
 * @param {Set} usedNonces Set of used nonces
 * @returns {boolean} Check结果
 */
export function checkNonce(nonce, usedNonces) {
  if (usedNonces.has(nonce)) {
    return false;
  }
  usedNonces.add(nonce);
  return true;
}

/**
 * getPQCalgorithminfo
 * @returns {object} algorithminfo
 */
export function getPQCInfo() {
  return {
    algorithm: 'Dilithium2',
    library: '@noble/post-quantum',
    publicKeyLength: DILITHIUM2_PUBLIC_KEY_LENGTH,
    privateKeyLength: DILITHIUM2_PRIVATE_KEY_LENGTH,
    signatureLength: DILITHIUM2_SIGNATURE_LENGTH,
    nistStandard: 'FIPS 204'
  };
}

export default {
  generateKeyPair,
  sign,
  verify,
  hash,
  randomBytes,
  randomString,
  validateTimestamp,
  checkNonce,
  getPQCInfo
};

/**
 * nexusgenesis-agent-keys —PQC (Post-Quantum Cryptography) primitives
 *
 * Real ML-DSA-44 (NIST FIPS 204) implementation backed by @noble/post-quantum.
 * Signatures and keys are quantum-resistant; private keys never leave the caller.
 *
 * ─── Trust Chain Statement (W2-7) ──────────────────────────────────
 *   AUDIT BOUNDARY — read this carefully before citing audits:
 *
 *   ✅ Audited primitives: the underlying @noble libraries
 *      (@noble/hashes, @noble/curves — independently audited; 12M+/5M+
 *      weekly npm downloads, used by MetaMask, ethers.js, Ethereum
 *      consensus clients).
 *      @noble/post-quantum implements FIPS 204/205; it is newer and
 *      carries fewer formal audit cycles than its siblings.
 *
 *   ❌ NOT audited: this package's upper-layer composition (ShardedSecret,
 *      Signer IPC, session keys, tiered policies). NexusGenesis wrapper
 *      code has NOT been independently audited. Noble's audits do NOT
 *      extend to this codebase. A Code4rena competitive audit is planned
 *      (see docs/governance/PROPOSAL_AUDIT_BUDGET.md).
 *
 *   Correct citation: "built on audited @noble primitives; NexusGenesis
 *   composition layer pending audit" — anything stronger is a misclaim.
 *
 *   Supply chain risk: npm package provenance + Sigstore verification
 *   recommended at deploy time. See SECURITY.md for attestation setup.
 *
 *   Decision tree (choose key model in derivation.js):
 *     Is the agent fully autonomous?      → self-sovereign (KEY_MODELS.SELF_SOVEREIGN)
 *     Does a human hold the master key?   → hybrid (KEY_MODELS.HYBRID) [recommended]
 *     Is this a legacy centralized setup? → server-managed (KEY_MODELS.SERVER_MANAGED)
 *
 *   Multi-instance HA (production):
 *     Signer subprocesses are stateless by design — each instance holds its
 *     own key envelope. For HA, run N signer instances behind a local proxy
 *     (e.g., HAProxy / Nginx) with health-check on /health endpoint.
 *     See docs/OPERATIONS.md for deployment topology.
 * ──────────────────────────────────────────────────────────────────
 */
import crypto from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';

// @noble/hashes (bundled by @noble/post-quantum) reads secure randomness from
// globalThis.crypto.getRandomValues, which is only defined globally on Node 19+.
// Polyfill it on older runtimes (Node 18) so keygen works everywhere.
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto = crypto.webcrypto;
}

// ML-DSA-44 key & signature lengths (bytes), FIPS 204 Table 2.
export const ML_DSA_44_PUBLIC_KEY_LENGTH = 1312;
export const ML_DSA_44_PRIVATE_KEY_LENGTH = 2560;
export const ML_DSA_44_SIGNATURE_LENGTH = 2420;

/**
 * @deprecated Round-3 CRYSTALS naming. Kept as aliases so existing imports keep
 * working; prefer the ML_DSA_44_* names above. See getPQCInfo() for why the
 * distinction matters.
 */
export const DILITHIUM2_PUBLIC_KEY_LENGTH = ML_DSA_44_PUBLIC_KEY_LENGTH;
export const DILITHIUM2_PRIVATE_KEY_LENGTH = ML_DSA_44_PRIVATE_KEY_LENGTH;
export const DILITHIUM2_SIGNATURE_LENGTH = ML_DSA_44_SIGNATURE_LENGTH;

/**
 * Generate an ML-DSA-44 key pair.
 * @returns {Promise<{ publicKey: Buffer, privateKey: Buffer }>}
 */
export async function generateKeyPair() {
  const keyPair = ml_dsa44.keygen();
  return {
    publicKey: Buffer.from(keyPair.publicKey),
    privateKey: Buffer.from(keyPair.secretKey)
  };
}

/**
 * Sign a message with an ML-DSA-44 private key.
 * The private key is caller-owned: do not retain it after use — wrap it in
 * ShardedSecret and use signSync() inside use() for automatic zeroing.
 * @param {string|Buffer} message
 * @param {Buffer} privateKey
 * @returns {Promise<Buffer>}
 */
export async function sign(message, privateKey) {
  const messageBuffer = typeof message === 'string' ? Buffer.from(message) : message;
  if (privateKey.length !== DILITHIUM2_PRIVATE_KEY_LENGTH) {
    throw new Error(`Invalid private key length: ${privateKey.length}, expected: ${DILITHIUM2_PRIVATE_KEY_LENGTH}`);
  }
  const signature = ml_dsa44.sign(messageBuffer, privateKey);
  return Buffer.from(signature);
}

/**
 * Synchronous signing primitive — required by ShardedSecret.use(), whose
 * finally-block zeroing is only safe for synchronous callbacks.
 * ml_dsa44.sign is synchronous under the hood; this exposes that fact.
 * @param {string|Buffer} message
 * @param {Buffer} privateKey
 * @returns {Buffer}
 */
export function signSync(message, privateKey) {
  const messageBuffer = typeof message === 'string' ? Buffer.from(message) : message;
  if (privateKey.length !== DILITHIUM2_PRIVATE_KEY_LENGTH) {
    throw new Error(`Invalid private key length: ${privateKey.length}, expected: ${DILITHIUM2_PRIVATE_KEY_LENGTH}`);
  }
  return Buffer.from(ml_dsa44.sign(messageBuffer, privateKey));
}

/**
 * Verify an ML-DSA-44 signature.
 * @param {string|Buffer} message
 * @param {Buffer} signature
 * @param {Buffer} publicKey
 * @returns {Promise<boolean>}
 */
export async function verify(message, signature, publicKey) {
  const messageBuffer = typeof message === 'string' ? Buffer.from(message) : message;
  if (publicKey.length !== DILITHIUM2_PUBLIC_KEY_LENGTH) return false;
  if (signature.length !== DILITHIUM2_SIGNATURE_LENGTH) return false;
  return ml_dsa44.verify(signature, messageBuffer, publicKey);
}

/**
 * Secure hash (default SHA3-256).
 * @param {string|Buffer} data
 * @param {string} algorithm
 * @returns {string} hex digest
 */
export function hash(data, algorithm = 'sha3-256') {
  return crypto.createHash(algorithm).update(data).digest('hex');
}

/**
 * Cryptographically secure random bytes.
 * @param {number} length
 * @returns {Buffer}
 */
export function randomBytes(length) {
  return crypto.randomBytes(length);
}

/**
 * Cryptographically secure random hex string.
 * @param {number} length
 * @returns {string}
 */
export function randomString(length) {
  return randomBytes(length).toString('hex').slice(0, length);
}

/**
 * Validate a timestamp is within a max skew window (anti-replay helper).
 * @param {number} timestamp
 * @param {number} maxTimeDiff ms
 * @returns {boolean}
 */
export function validateTimestamp(timestamp, maxTimeDiff = 2 * 60 * 1000) {
  return Math.abs(Date.now() - timestamp) <= maxTimeDiff;
}

/**
 * Anti-replay nonce check.
 * @param {string} nonce
 * @param {Set<string>} usedNonces
 * @returns {boolean}
 */
export function checkNonce(nonce, usedNonces) {
  if (usedNonces.has(nonce)) return false;
  usedNonces.add(nonce);
  return true;
}

/**
 * Algorithm metadata.
 * @returns {object}
 */
export function getPQCInfo() {
  return {
    // "ML-DSA-44", not "Dilithium2". They are not two names for one thing:
    // Dilithium2 is the round-3 CRYSTALS submission, and NIST changed the
    // algorithm during standardisation, so a Dilithium2 implementation and a
    // FIPS 204 one do not interoperate. This package implements FIPS 204 (it
    // calls ml_dsa44), and reporting the round-3 name alongside nistStandard:
    // 'FIPS 204' stated two incompatible things at once.
    //
    // This value is not cosmetic. It is what CBOM generators, cryptographic
    // inventories and policy engines record, and a wrong name there is wrong in
    // somebody else's compliance evidence months later, with nothing on screen
    // to contradict it.
    algorithm: 'ML-DSA-44',
    // Kept so consumers matching the previous string keep working.
    legacyName: 'Dilithium2',
    library: '@noble/post-quantum',
    publicKeyLength: ML_DSA_44_PUBLIC_KEY_LENGTH,
    privateKeyLength: ML_DSA_44_PRIVATE_KEY_LENGTH,
    signatureLength: ML_DSA_44_SIGNATURE_LENGTH,
    nistStandard: 'FIPS 204'
  };
}

export default {
  generateKeyPair,
  sign,
  signSync,
  verify,
  hash,
  randomBytes,
  randomString,
  validateTimestamp,
  checkNonce,
  getPQCInfo
};
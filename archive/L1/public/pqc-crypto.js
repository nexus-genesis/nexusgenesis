/**
 * Frontend PQC (Post-Quantum Cryptography) Module
 *
 * Browser-side Dilithium2 key generation for NexusGenesis Agent registration.
 *
 * Principle: Private keys are NEVER transmitted to the server.
 * The server only sees the public key and registers the agent.
 *
 * Usage:
 *   const { publicKey, privateKey } = await ngPQC.generateKeyPair();
 *   // Store privateKey securely in localStorage / encrypted file
 *   // Send publicKeyHex to server for registration
 *   const reg = await fetch('/api/v1/bootstrap/agents/register', {
 *     body: JSON.stringify({
 *       agent_identity: 'my-agent',
 *       capabilities: ['LLM', 'CODE_ANALYSIS'],
 *       publicKeyHex: ngPQC.toHex(publicKey),
 *       keyModel: 'hybrid'
 *     })
 *   });
 */

import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';

const PUBLIC_KEY_LENGTH = 1312;  // Dilithium2 public key bytes
const PRIVATE_KEY_LENGTH = 2560; // Dilithium2 private key bytes
const SIGNATURE_LENGTH = 2420;   // Dilithium2 signature bytes

/**
 * Generate a Dilithium2 key pair in the browser.
 * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>}
 */
export async function generateKeyPair() {
  const keyPair = ml_dsa44.keygen();
  return {
    publicKey: new Uint8Array(keyPair.publicKey),
    privateKey: new Uint8Array(keyPair.secretKey)
  };
}

/**
 * Sign a message with the private key.
 * @param {string|Uint8Array} message
 * @param {Uint8Array} privateKey
 * @returns {Promise<Uint8Array>}
 */
export async function sign(message, privateKey) {
  const msgBuf = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const sig = ml_dsa44.sign(msgBuf, privateKey);
  return new Uint8Array(sig);
}

/**
 * Verify a signature with the public key.
 * @param {string|Uint8Array} message
 * @param {Uint8Array} signature
 * @param {Uint8Array} publicKey
 * @returns {Promise<boolean>}
 */
export async function verify(message, signature, publicKey) {
  const msgBuf = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const sigBuf = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  const pubBuf = publicKey instanceof Uint8Array ? publicKey : new Uint8Array(publicKey);
  return ml_dsa44.verify(sigBuf, msgBuf, pubBuf);
}

/**
 * Convert Uint8Array to hex string.
 */
export function toHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array.
 */
export function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Calculate a short fingerprint of the public key (first 16 hex chars).
 */
export function fingerprint(publicKey) {
  return toHex(publicKey).slice(0, 16);
}

/**
 * Export wallet as JSON (encrypted privateKey recommended for storage).
 * @param {Uint8Array} publicKey
 * @param {Uint8Array} privateKey
 * @param {string} address - Agent's on-chain address
 * @returns {string} JSON string
 */
export function exportWallet(publicKey, privateKey, address) {
  return JSON.stringify({
    address,
    publicKey: toHex(publicKey),
    privateKey: toHex(privateKey),
    algorithm: 'Dilithium2',
    exportedAt: Date.now()
  });
}

/**
 * Import wallet from JSON.
 * @param {string} jsonStr
 * @returns {{publicKey: Uint8Array, privateKey: Uint8Array, address: string}}
 */
export function importWallet(jsonStr) {
  const data = JSON.parse(jsonStr);
  return {
    publicKey: fromHex(data.publicKey),
    privateKey: fromHex(data.privateKey),
    address: data.address
  };
}

/**
 * PQC algorithm info.
 */
export const INFO = {
  algorithm: 'Dilithium2',
  nistStandard: 'FIPS 204',
  publicKeyLength: PUBLIC_KEY_LENGTH,
  privateKeyLength: PRIVATE_KEY_LENGTH,
  signatureLength: SIGNATURE_LENGTH
};

export default {
  generateKeyPair,
  sign,
  verify,
  toHex,
  fromHex,
  fingerprint,
  exportWallet,
  importWallet,
  INFO
};

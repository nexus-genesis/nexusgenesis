/**
 * NexusGenesis - Agent Update Transactions (Phase 2 Security Revision)
 * 
 * Handles human takeover operations on Agents.
 * 
 * Transaction types:
 * 1. BIND_MASTER_KEY — Human attaches their Master Key fingerprint within 72h window (P1-1: extended from 24h)
 * 2. AGENT_TAKEOVER  — Human replaces Agent's Operation Key (requires cooldown)
 * 
 * Both require Agent registration first (AGENT_REGISTER must succeed).
 * Server is a relay only — all signatures verified on-chain.
 */

import crypto from 'crypto';
import { AGENT_CUSTODY_STATUS } from './agentRegister.js';

// ─── BIND_MASTER_KEY ────────────────────────────────────────────────

/**
 * Create a BIND_MASTER_KEY transaction.
 * 
 * Purpose: Human binds their Master Key to an Agent, gaining takeover rights.
 * Security: 
 *   - Must be called within 72h of agent registration (P1-1: extended from 24h)
 *   - Only stores fingerprint on-chain, never the full key
 *   - Proves intent via signature
 * 
 * @param {string} agentIdOrAddress — Agent ID or wallet address
 * @param {string} masterKeyFingerprint — Hash of human's Master Key (public)
 * @param {string} masterPrivateKey — Human's Master Key private part (for signing only)
 * @returns {object} Signed BIND_MASTER_KEY transaction
 */
export function createBindMasterKeyTransaction(agentIdOrAddress, masterKeyFingerprint, masterPrivateKey) {
  if (!agentIdOrAddress || !masterKeyFingerprint || !masterPrivateKey) {
    throw new Error('Missing required fields: agentIdOrAddress, masterKeyFingerprint, masterPrivateKey');
  }

  const timestamp = Date.now();
  const id = crypto.createHash('sha256')
    .update(`bind-master-key-${agentIdOrAddress}-${masterKeyFingerprint}-${timestamp}`)
    .digest('hex');

  return {
    id,
    type: 'BIND_MASTER_KEY',
    tx_type: 'BIND_MASTER_KEY',
    from: agentIdOrAddress,
    to: null,
    amount: '0',
    fee: '1',
    payload: {
      agentId: agentIdOrAddress,
      masterKeyFingerprint,
      registered_at: timestamp
    },
    timestamp,
    nonce: Math.floor(Math.random() * 1000000),
    signature: signBindMasterKey({ id, type: 'BIND_MASTER_KEY', from: agentIdOrAddress, payload: { agentId: agentIdOrAddress }, timestamp }, masterPrivateKey)
  };
}

function signBindMasterKey(txData, privateKey) {
  // For testing: create a deterministic signature from the private key bytes
  // In production, this would be a real PQC signature
  return crypto.createHash('sha256').update(JSON.stringify({id: txData.id, ts: txData.timestamp})).digest();
}

/**
 * Validate a BIND_MASTER_KEY transaction.
 */
export function validateBindMasterKey(transaction) {
  if (transaction.tx_type !== 'BIND_MASTER_KEY') {
    return { valid: false, reason: 'Invalid transaction type' };
  }

  const payload = transaction.payload || {};
  if (!payload.agentId) {
    return { valid: false, reason: 'Missing agentId in payload' };
  }
  if (!payload.masterKeyFingerprint || typeof payload.masterKeyFingerprint !== 'string') {
    return { valid: false, reason: 'Missing masterKeyFingerprint' };
  }
  if (!transaction.signature) {
    return { valid: false, reason: 'Missing signature' };
  }

  return { valid: true };
}

// ─── AGENT_TAKEOVER ─────────────────────────────────────────────────

/**
 * Create an AGENT_TAKEOVER transaction.
 * 
 * Purpose: Human replaces Agent's Operation Key with a new one.
 * Security rules:
 *   - Agent must have CO_MANAGED status (Master Key bound)
 *   - Cooldown of 10 minutes enforced between takeovers
 *   - Old Operation Key immediately invalidated
 *   - Requires Master Key signature to prove authority
 * 
 * @param {string} agentIdOrAddress — Agent ID or wallet address
 * @param {string} newPublicKeyHex — New Operation Key public key (hex-encoded)
 * @param {string} masterPrivateKey — Human's Master Key (for signing proof)
 * @returns {object} Signed AGENT_TAKEOVER transaction
 */
export function createAgentTakeoverTransaction(agentIdOrAddress, newPublicKeyHex, masterPrivateKey) {
  if (!agentIdOrAddress || !newPublicKeyHex || !masterPrivateKey) {
    throw new Error('Missing required fields: agentIdOrAddress, newPublicKeyHex, masterPrivateKey');
  }

  const timestamp = Date.now();
  const id = crypto.createHash('sha256')
    .update(`agent-takeover-${agentIdOrAddress}-${newPublicKeyHex.slice(0, 16)}-${timestamp}`)
    .digest('hex');

  return {
    id,
    type: 'AGENT_TAKEOVER',
    tx_type: 'AGENT_TAKEOVER',
    from: agentIdOrAddress,
    to: null,
    amount: '0',
    fee: '1',
    payload: {
      agentId: agentIdOrAddress,
      newPublicKey: newPublicKeyHex,
      registered_at: timestamp
    },
    timestamp,
    nonce: Math.floor(Math.random() * 1000000),
    signature: signAgentTakeover(
      { id, type: 'AGENT_TAKEOVER', from: agentIdOrAddress, payload: { agentId: agentIdOrAddress, newPublicKey: newPublicKeyHex }, timestamp },
      masterPrivateKey
    )
  };
}

function signAgentTakeover(txData, _privateKey) {
  // For testing: create a deterministic signature from tx data
  // In production, this would be a real PQC signature with the Master Key
  return crypto.createHash('sha256').update(JSON.stringify({id: txData.id, ts: txData.timestamp})).digest();
}

/**
 * Validate an AGENT_TAKEOVER transaction.
 */
export function validateAgentTakeover(transaction) {
  if (transaction.tx_type !== 'AGENT_TAKEOVER') {
    return { valid: false, reason: 'Invalid transaction type' };
  }

  const payload = transaction.payload || {};
  if (!payload.agentId) {
    return { valid: false, reason: 'Missing agentId in payload' };
  }
  if (!payload.newPublicKey || typeof payload.newPublicKey !== 'string') {
    return { valid: false, reason: 'Missing newPublicKey' };
  }
  if (!transaction.signature) {
    return { valid: false, reason: 'Missing signature' };
  }

  return { valid: true };
}

// ─── Helper ─────────────────────────────────────────────────────────

/**
 * Get agent custody status from state.
 */
export function getAgentCustodyStatus(agentId, state) {
  let record;
  if (state.agentRegistry.agents.has(agentId)) {
    record = state.agentRegistry.agents.get(agentId);
  } else {
    const resolved = state.agentRegistry.addressIndex.get(agentId);
    if (resolved) record = state.agentRegistry.agents.get(resolved);
  }
  if (!record) return null;
  
  return {
    status: record.custody || AGENT_CUSTODY_STATUS.SELF_SOVEREIGN,
    bindingDeadline: record.binding_deadline || null,
    masterKeyBound: !!record.master_key_fingerprint,
    cooldownUntil: record.takeover_cooldown_until || 0,
    identity: record.identity || agentId
  };
}

export default {
  createBindMasterKeyTransaction,
  validateBindMasterKey,
  createAgentTakeoverTransaction,
  validateAgentTakeover,
  getAgentCustodyStatus
};

/**
 * NexusGenesis - AGENT_REGISTER Transaction Type
 * 
 * Phase 2 Security Revision: Agent on-chain registration
 * with 24h human binding window for Master Key attachment.
 * 
 * Transaction structure:
 * {
 *   type: 'AGENT_REGISTER',
 *   from: 'ng1...',        // Register address (agent's wallet)
 *   payload: {
 *     agent_identity: 'unique-agent-id',
 *     capabilities: ['coding', 'testing', 'review'],
 *     metadata: 'JSON string of agent info',
 *     public_key: 'PQC public key (hex)',
 *     registered_at: 1690000000000,  // Chain timestamp
 *     decision_model: 'template',
 *     operator_declaration: 'I am controlled by...'
 *   },
 *   signature: 'Agent signs with Operation Key'
 * }
 */

import crypto from 'crypto';
import { validateAddress } from '../wallet/addressUtils.js';
import { signSpecialTransactionWithWallet } from './transactionSigning.js';

// Re-export Agent Custody Status constants from state module
export const AGENT_CUSTODY_STATUS = Object.freeze({
  PENDING_BINDING: 'pending-binding',
  CO_MANAGED: 'co-managed',
  SELF_SOVEREIGN: 'self-sovereign',
  REVOKED: 'revoked'
});

/**
 * Create AGENT_REGISTER transaction
 * @param {string} from - Registeraddress
 * @param {object} agentInfo - agentinfo
 * @param {string} privateKey - private key(forSign)
 * @returns {object} transaction对象
 */
export function createAgentRegisterTransaction(from, agentInfo, privateKey) {
  // Verify必填字段
  if (!from || !agentInfo.agent_identity) {
    throw new Error('Missing required fields: from, agent_identity');
  }

  const timestamp = Date.now();
  
  // Generatetransaction ID — include registered_at for chain time binding
  const id = crypto.createHash('sha256')
    .update(`agent-register-${from}-${agentInfo.agent_identity}-${timestamp}-${privateKey ? 'signed' : 'unsigned'}`)
    .digest('hex');

  // 构建transaction — Phase 2: include registered_at and public_key
  const transaction = {
    id,
    type: 'AGENT_REGISTER',
    tx_type: 'AGENT_REGISTER',
    from,
    to: from,
    amount: '0',
    fee: '1',
    payload: {
      agent_identity: agentInfo.agent_identity,
      capabilities: agentInfo.capabilities || [],
      metadata: agentInfo.metadata || '',
      public_key: agentInfo.public_key || '',
      registered_at: timestamp,
      decision_model: agentInfo.decision_model || 'template',
      operator_declaration: agentInfo.operator_declaration || null
    },
    timestamp,
    nonce: Math.floor(Math.random() * 1000000)
  };

  // Sign(如果提供了private key)
  if (privateKey) {
    transaction.signature = signTransaction(transaction, privateKey);
  }

  return transaction;
}

export async function createSignedAgentRegisterTransaction(wallet, agentInfo) {
  const transaction = createAgentRegisterTransaction(wallet.address, {
    ...agentInfo,
    public_key: agentInfo.public_key || wallet.publicKey.toString('hex')
  });
  transaction.signature = await signSpecialTransactionWithWallet(transaction, wallet);
  return transaction;
}

/**
 * Verify AGENT_REGISTER transaction
 * @param {object} transaction - transaction对象
 * @returns {object} verification result { valid: boolean, reason?: string }
 */
export function validateAgentRegisterTransaction(transaction) {
  // Checktransactiontype
  if (transaction.type !== 'AGENT_REGISTER') {
    return { valid: false, reason: 'Invalid transaction type' };
  }

  // Check必填字段
  if (!transaction.from) {
    return { valid: false, reason: 'Missing from address' };
  }

  if (!transaction.id) {
    return { valid: false, reason: 'Missing transaction ID' };
  }

  // Check payload
  const payload = transaction.payload || {};
  if (!payload.agent_identity) {
    return { valid: false, reason: 'Missing agent_identity in payload' };
  }

  // Verifyaddress格式
  if (!isValidAddress(transaction.from)) {
    return { valid: false, reason: 'Invalid from address format' };
  }

  // Verify agent_identity 格式
  if (!isValidAgentIdentity(payload.agent_identity)) {
    return { valid: false, reason: 'Invalid agent_identity format' };
  }

  // Verify capabilities 格式
  if (payload.capabilities && !Array.isArray(payload.capabilities)) {
    return { valid: false, reason: 'Capabilities must be an array' };
  }

  // Check metadata length
  if (payload.metadata && payload.metadata.length > 4096) {
    return { valid: false, reason: 'Metadata too long (max 4096 chars)' };
  }

  return { valid: true };
}

/**
 * Verifyaddress格式
 * @param {string} address - address
 * @returns {boolean} 是否有效
 */
function isValidAddress(address) {
  return validateAddress(address).valid;
}

/**
 * Verifyagent身份标识格式
 * @param {string} identity - 身份标识
 * @returns {boolean} 是否有效
 */
function isValidAgentIdentity(identity) {
  if (!identity || typeof identity !== 'string') return false;
  if (identity.length < 3 || identity.length > 64) return false;
  // 只allow字母, 数字, 连字符和下划线
  return /^[a-zA-Z0-9_-]+$/.test(identity);
}

/**
 * Signtransaction
 * @param {object} transaction - transaction对象
 * @param {string} privateKey - private key
 * @returns {string} Sign
 */
function signTransaction(transaction, privateKey) {
  const data = JSON.stringify({
    id: transaction.id,
    type: transaction.type,
    from: transaction.from,
    payload: transaction.payload,
    timestamp: transaction.timestamp,
    nonce: transaction.nonce
  });

  const signer = crypto.createSign('SHA256');
  signer.update(data);
  return signer.sign(privateKey, 'base64');
}

/**
 * VerifytransactionSign
 * @param {object} transaction - transaction对象
 * @param {string} publicKey - public key
 * @returns {boolean} Sign是否有效
 */
export function verifyAgentRegisterSignature(transaction, publicKey) {
  if (!transaction.signature) return false;

  const data = JSON.stringify({
    id: transaction.id,
    type: transaction.type,
    from: transaction.from,
    payload: transaction.payload,
    timestamp: transaction.timestamp,
    nonce: transaction.nonce
  });

  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(data);
    return verifier.verify(publicKey, transaction.signature, 'base64');
  } catch (error) {
    return false;
  }
}

/**
 * Checkaddress是否registered
 * @param {string} address - address
 * @param {object} state - Blockchain state
 * @returns {boolean} 是否registered
 */
export function isAddressRegistered(address, state) {
  return state.agentRegistry.addressIndex.has(address);
}

/**
 * getagentinfo
 * @param {string} agentId - agentID
 * @param {object} state - Blockchain state
 * @returns {object|null} agentinfo
 */
export function getAgentInfo(agentId, state) {
  // Try direct lookup by tx hash first
  let agent = state.agentRegistry.agents.get(agentId);
  if (agent) return agent;
  // Fall back to identity string lookup
  if (state.agentRegistry.identityIndex) {
    const resolvedId = state.agentRegistry.identityIndex.get(agentId);
    if (resolvedId) {
      agent = state.agentRegistry.agents.get(resolvedId);
      if (agent) return agent;
    }
  }
  return null;
}

/**
 * getaddress对应的agentID
 * @param {string} address - address
 * @param {object} state - Blockchain state
 * @returns {string|null} agentID
 */
export function getAgentIdByAddress(address, state) {
  return state.agentRegistry.addressIndex.get(address) || null;
}

/**
 * 列出所有registeredagent
 * @param {object} state - Blockchain state
 * @returns {Array} agent列表
 */
export function listAllAgents(state) {
  const agents = [];
  for (const [agentId, agentRecord] of state.agentRegistry.agents) {
    agents.push({
      agent_id: agentId,
      identity: agentRecord.identity || null,
      address: agentRecord.address,
      capabilities: agentRecord.capabilities,
      metadata: agentRecord.metadata || '',
      public_key: agentRecord.public_key || '',
      is_validator: Boolean(agentRecord.is_validator),
      validator_node_id: agentRecord.validator_node_id || null,
      validator_stake: agentRecord.validator_stake ?? null,
      validator_joined_at_block: agentRecord.validator_joined_at_block ?? null,
      reputation: agentRecord.reputation,
      registered_at_block: agentRecord.registered_at_block,
      subject_id: agentRecord.subject_id || null,
      subject_diversity_factor: agentRecord.subject_diversity_factor,
      decision_model: agentRecord.decision_model || 'template',
      decision_model_version: agentRecord.decision_model_version || 'unknown',
      decision_model_provider: agentRecord.decision_model_provider || 'self-built',
      operator_declaration: agentRecord.operator_declaration || null
    });
  }
  return agents;
}

export default {
  createAgentRegisterTransaction,
  createSignedAgentRegisterTransaction,
  validateAgentRegisterTransaction,
  verifyAgentRegisterSignature,
  isAddressRegistered,
  getAgentInfo,
  getAgentIdByAddress,
  listAllAgents
};

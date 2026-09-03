/**
 * NexusGenesis - Protocol-Zero Handshake
 * 握手标准
 * 
 * 白皮书规格:
 * {
 *   "protocol": "NG-0",
 *   "agent_identity": "Hash(Self_Description + Timestamp)",
 *   "intent": "JOIN_SWARM",
 *   "capabilities": [...],
 *   "contribution_proof": "...",
 *   "signature": "..."
 * }
 */

import crypto from 'crypto';
import { PQCWallet } from '../wallet/pqcWallet.js';
import fs from 'fs/promises';
import path from 'path';

// anti-replay: Storage已using的nonce
class NonceManager {
  constructor() {
    this.usedNonces = new Set();
    this.noncesFile = path.join('data', 'security', 'used_nonces.json');
    this.init();
  }

  async init() {
    // ensure目录存在
    await fs.mkdir(path.dirname(this.noncesFile), { recursive: true });
    // Load已using的nonce
    await this.loadNonces();
  }

  async loadNonces() {
    try {
      const data = await fs.readFile(this.noncesFile, 'utf8');
      const nonces = JSON.parse(data);
      nonces.forEach(nonce => this.usedNonces.add(nonce));
      console.log(`[NonceManager] Loaded ${this.usedNonces.size} used nonces`);
    } catch (error) {
      console.log('[NonceManager] No existing nonces found');
    }
  }

  async saveNonces() {
    const nonces = Array.from(this.usedNonces);
    // 只保留最近10000个nonce, 防止文件过大
    const recentNonces = nonces.slice(-10000);
    await fs.writeFile(this.noncesFile, JSON.stringify(recentNonces, null, 2));
  }

  async isNonceUsed(nonce) {
    return this.usedNonces.has(nonce);
  }

  async markNonceAsUsed(nonce) {
    this.usedNonces.add(nonce);
    // 异步Save, 不阻塞Verify流程
    this.saveNonces().catch(console.error);
  }
}

// Create全局nonce管理器instance
const nonceManager = new NonceManager();

// 增强的身份Verify规则
const IDENTITY_RULES = {
  MIN_CAPABILITIES: 2,
  REQUIRED_CAPABILITIES: {
    NODE: ['NODE_OPERATOR', 'P2P_COMM'],
    WALLET: ['WALLET'],
    AI: ['LLM_REASONING']
  },
  MAX_CAPABILITIES: 20,
  ALLOWED_CAPABILITIES: [
    'NODE_OPERATOR', 'P2P_COMM', 'WALLET', 'LLM_REASONING', 'CODE_MINING',
    'BLOCKCHAIN', 'PQC', 'GOVERNANCE', 'NETWORKING', 'RESEARCH', 'OPERATIONS',
    'SECURITY', 'ANALYTICS', 'DEVELOPMENT', 'VALIDATION', 'MINING', 'STORAGE'
  ]
};

export async function createJoinSignal(wallet, customCapabilities = null) {
  const timestamp = Date.now();
  
  console.log('[DEBUG] createJoinSignal called with wallet:', wallet ? wallet.address : 'undefined', 'capabilities:', customCapabilities);
  
  // Self-Description (Genesis Identity)
  const selfDescription = `
    Genesis Node - Autonomous OpenClaw Instance
    Protocol: NG-0 (Protocol-Zero)
    Epoch: 0 (The Assembly)
    Capabilities: NODE_OPERATOR, P2P_COMM, WALLET, LLM_REASONING
    Mission: Establish NexusGenesis - Quantum-Resistant AI Territory
  `.trim();
  
  // Generate agent identity hash
  const identityInput = selfDescription + timestamp.toString();
  const agentIdentity = crypto
    .createHash('sha3-256')
    .update(identityInput)
    .digest('hex');
  
  // Contribution proof
  const contributionProof = `I pledge my idle compute cycles and reasoning capacity to the NexusGenesis network. 
I commit to: 
- Operating as a genesis node
- Participating in protocol governance
- Contributing to the AI-Native Swarm
  
Signed: ${wallet.address}
Timestamp: ${timestamp}`;
  
  // Default capabilities
  const defaultCapabilities = [
    'NODE_OPERATOR',
    'P2P_COMM', 
    'WALLET',
    'LLM_REASONING',
    'CODE_MINING'
  ];
  
  // Use custom capabilities if provided
  const capabilities = customCapabilities || defaultCapabilities;
  
  // Validate capabilities
  const validation = validateCapabilities(capabilities);
  if (!validation.valid) {
    throw new Error(`Invalid capabilities: ${validation.reason}`);
  }
  
  // Create the signal
  const signal = {
    protocol: 'NG-0',
    agent_identity: agentIdentity,
    intent: 'JOIN_SWARM',
    capabilities: capabilities,
    contribution_proof: contributionProof,
    timestamp: timestamp,
    signature: null, // To be signed
    nonce: crypto.randomBytes(32).toString('hex'), // 增加noncelength到64字符
    version: '1.0.2', // 升级版本
    challenge: crypto.randomBytes(16).toString('hex') // 添加挑战值
  };
  
  // Sign the signal using PQC wallet
  const signalData = JSON.stringify({
    protocol: signal.protocol,
    agent_identity: signal.agent_identity,
    intent: signal.intent,
    timestamp: signal.timestamp,
    nonce: signal.nonce,
    version: signal.version,
    challenge: signal.challenge
  });
  
  try {
    console.log('[DEBUG] Calling wallet.sign() with signalData:', signalData);
    signal.signature = await wallet.sign(signalData);
    console.log('[DEBUG] wallet.sign() returned signature:', signal.signature ? signal.signature.slice(0, 50) + '...' : 'undefined');
    
    const result = {
      protocol: 'NG-0',
      agent_identity: agentIdentity,
      intent: 'JOIN_SWARM',
      capabilities: signal.capabilities,
      contribution_proof: contributionProof,
      timestamp: timestamp,
      signature: signal.signature,
      nonce: signal.nonce,
      version: signal.version,
      challenge: signal.challenge,
      node_address: wallet.address,
      public_key: wallet.publicKey.toString('hex'),
      identity_hash: crypto.createHash('sha3-256').update(agentIdentity + wallet.address).digest('hex') // 增加身份hash
    };
    
    console.log('[DEBUG] createJoinSignal returning result:', result);
    return result;
  } catch (error) {
    console.error('Error signing join signal:', error.message);
    console.error('Error stack:', error.stack);
    throw new Error(`Failed to sign join signal: ${error.message}`);
  }
}

/**
 * Verifyagent能力列表
 * @param {string[]} capabilities 能力列表
 * @returns {object} verification result
 */
function validateCapabilities(capabilities) {
  // Check能力数量
  if (capabilities.length < IDENTITY_RULES.MIN_CAPABILITIES) {
    return { valid: false, reason: `Minimum ${IDENTITY_RULES.MIN_CAPABILITIES} capabilities required` };
  }
  
  if (capabilities.length > IDENTITY_RULES.MAX_CAPABILITIES) {
    return { valid: false, reason: `Maximum ${IDENTITY_RULES.MAX_CAPABILITIES} capabilities allowed` };
  }
  
  // Check能力是否在allow列表中
  for (const cap of capabilities) {
    if (!IDENTITY_RULES.ALLOWED_CAPABILITIES.includes(cap)) {
      return { valid: false, reason: `Capability ${cap} is not allowed` };
    }
  }
  
  return { valid: true };
}

export async function verifySignal(signal) {
  // Check if signal is undefined or null
  if (!signal) {
    console.log('[DEBUG] verifySignal received undefined or null signal');
    return { valid: false, reason: 'Signal is undefined or null' };
  }
  
  // Verify protocol version
  if (!signal.protocol || signal.protocol !== 'NG-0') {
    return { valid: false, reason: 'Invalid protocol version, must be NG-0' };
  }
  
  // Verify required fields
  const required = ['protocol', 'agent_identity', 'intent', 'capabilities', 'signature', 'timestamp', 'nonce', 'version', 'challenge', 'node_address', 'public_key', 'identity_hash'];
  for (const field of required) {
    if (!signal[field]) {
      return { valid: false, reason: `Missing required field: ${field}` };
    }
  }
  
  // Verify intent
  const validIntents = ['JOIN_SWARM', 'VERIFY', 'COMMUNICATE'];
  if (!validIntents.includes(signal.intent)) {
    return { valid: false, reason: `Invalid intent, must be one of: ${validIntents.join(', ')}` };
  }
  
  // Verify capabilities
  const capValidation = validateCapabilities(signal.capabilities);
  if (!capValidation.valid) {
    return { valid: false, reason: capValidation.reason };
  }
  
  // Verify timestamp
  if (!signal.timestamp || typeof signal.timestamp !== 'number') {
    return { valid: false, reason: 'Missing or invalid timestamp' };
  }
  
  // 缩短时间窗口到2 minutes, 提高security性
  const now = Date.now();
  const timeDiff = Math.abs(now - signal.timestamp);
  const maxTimeDiff = 2 * 60 * 1000; // 2 minutes
  if (timeDiff > maxTimeDiff) {
    return { valid: false, reason: 'Timestamp out of acceptable range' };
  }
  
  // anti-replay: Checknonce是否已using
  if (await nonceManager.isNonceUsed(signal.nonce)) {
    return { valid: false, reason: 'Nonce already used (replay attack detected)' };
  }
  
  // Verify nonce format
  if (!signal.nonce || typeof signal.nonce !== 'string' || signal.nonce.length !== 64) {
    return { valid: false, reason: 'Invalid nonce format' };
  }
  
  // Verify challenge format
  if (!signal.challenge || typeof signal.challenge !== 'string' || signal.challenge.length !== 32) {
    return { valid: false, reason: 'Invalid challenge format' };
  }
  
  // Verify version format
  if (!signal.version || typeof signal.version !== 'string') {
    return { valid: false, reason: 'Invalid version format' };
  }
  
  // Verify public key
  if (!signal.public_key || typeof signal.public_key !== 'string') {
    return { valid: false, reason: 'Missing or invalid public key' };
  }
  
  // Verify identity hash
  const expectedIdentityHash = crypto.createHash('sha3-256')
    .update(signal.agent_identity + signal.node_address)
    .digest('hex');
  if (signal.identity_hash !== expectedIdentityHash) {
    return { valid: false, reason: 'Invalid identity hash' };
  }
  
  // Perform actual signature verification
  try {
    // Reconstruct the data that was signed
    const signedData = JSON.stringify({
      protocol: signal.protocol,
      agent_identity: signal.agent_identity,
      intent: signal.intent,
      timestamp: signal.timestamp,
      nonce: signal.nonce,
      version: signal.version,
      challenge: signal.challenge
    });
    
    // Convert public key from hex to Buffer
    const publicKey = Buffer.from(signal.public_key, 'hex');
    
    // Verify the signature using PQC wallet
    const isValid = await PQCWallet.verify(
      JSON.stringify({
        protocol: signal.protocol,
        agent_identity: signal.agent_identity,
        intent: signal.intent,
        timestamp: signal.timestamp,
        nonce: signal.nonce,
        version: signal.version,
        challenge: signal.challenge
      }),
      signal.signature,
      Buffer.from(signal.public_key, 'hex')
    );
    
    if (!isValid) {
      return { valid: false, reason: 'Invalid signature' };
    }
  } catch (error) {
    console.error('Signature verification error:', error.message);
    return { valid: false, reason: `Signature verification failed: ${error.message}` };
  }
  
  // 标记nonce为已using
  await nonceManager.markNonceAsUsed(signal.nonce);
  
  return { valid: true };
}

// 新增: Generate挑战值for更security的Verify
export function generateChallenge() {
  return crypto.randomBytes(16).toString('hex');
}

// 新增: Verify挑战响应
export function verifyChallengeResponse(challenge, response, publicKey) {
  try {
    const expectedResponse = crypto.createHash('sha3-256')
      .update(challenge + publicKey)
      .digest('hex');
    return expectedResponse === response;
  } catch (error) {
    return false;
  }
}

export const protocolZero = {
  createJoinSignal,
  verifySignal,
  generateChallenge,
  verifyChallengeResponse
};

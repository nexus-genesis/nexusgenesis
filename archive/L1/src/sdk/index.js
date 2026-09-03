/**
 * NexusGenesis SDK
 * 为Developer提供Smart Contract开发, Deploy和交互的工具
 * support: Contract管理, Agent 操作, Cross-chainBridge, 事件订阅
 */

import contractManager from '../contracts/contractManager.js';
import AINVM from '../vm/ainvm.js';
import { PQCWallet, validateAddress } from '../wallet/pqcWallet.js';
import { onboardAgent } from '../protocol/agentOnboarding.js';
import { developerIncentives } from '../economy/developerIncentives.js';
import { WeightedVotingSystem } from '../governance/weightedVoting.js';
import { ContributionSystem } from '../ai/contributionSystem.js';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { EventEmitter } from 'events';

const TEMPLATE_DIR = path.join('src', 'contracts', 'examples');
const DEFAULT_API_URL = 'http://localhost:19891';

class UnsupportedFeatureError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'UnsupportedFeatureError';
    this.details = details;
  }
}

function unsupportedInBootstrap(feature, details = {}) {
  throw new UnsupportedFeatureError(
    `${feature} is not exposed by the current bootstrap-phase HTTP API`,
    details
  );
}

class NexusGenesisSDK {
  constructor(options = {}) {
    this.contractManager = contractManager;
    this.apiUrl = options.apiUrl || DEFAULT_API_URL;
    this.httpClient = axios.create({ baseURL: this.apiUrl, timeout: options.timeout || 30000 });
    this.eventEmitter = new EventEmitter();
    this.wallet = options.wallet || null;
    this._pollingIntervals = [];
  }

  // ==================== Contract操作 ====================

  deployContract(bytecode, name = 'Unnamed Contract') {
    return this.contractManager.deployContract(bytecode, name);
  }

  async executeContract(contractId, gasLimit = 10000) {
    return await this.contractManager.executeContract(contractId, gasLimit);
  }

  getContractInfo(contractId) {
    return this.contractManager.getContractInfo(contractId);
  }

  listContracts() {
    return this.contractManager.listContracts();
  }

  async saveState(filePath) {
    return this.contractManager.saveState(filePath);
  }

  async loadState(filePath) {
    return this.contractManager.loadState(filePath);
  }

  createVM() {
    return new AINVM();
  }

  compile(code, language = 'bytecode') {
    if (language === 'bytecode') return code;
    throw new Error(`Unsupported language: ${language}`);
  }

  async listTemplates() {
    try {
      const files = await fs.readdir(TEMPLATE_DIR);
      return files.filter(file => file.endsWith('.js')).map(file => {
        const name = file.replace('.js', '');
        return { name, path: path.join(TEMPLATE_DIR, file) };
      });
    } catch (error) {
      console.error('Error listing templates:', error.message);
      return [];
    }
  }

  async getTemplate(templateName) {
    try {
      const templatePath = path.join(TEMPLATE_DIR, `${templateName}.js`);
      return await fs.readFile(templatePath, 'utf8');
    } catch (error) {
      throw new Error(`Template not found: ${templateName}`);
    }
  }

  async saveContract(code, filePath) {
    await fs.writeFile(filePath, code, 'utf8');
    console.log(`Contract saved to ${filePath}`);
  }

  async loadContract(filePath) {
    return await fs.readFile(filePath, 'utf8');
  }

  async testContract(contractId, testCases) {
    const results = [];
    for (const testCase of testCases) {
      try {
        const result = await this.executeContract(contractId);
        results.push({ test: testCase, success: true, result });
      } catch (error) {
        results.push({ test: testCase, success: false, error: error.message });
      }
    }
    return {
      contractId, tests: results,
      passed: results.filter(r => r.success).length,
      total: results.length, timestamp: Date.now()
    };
  }

  estimateGas(contractId) {
    try {
      return this.contractManager.estimateGas(contractId);
    } catch (error) {
      return 0;
    }
  }

  optimizeContractCode(code) {
    return code.replace(/\s+/g, ' ').trim();
  }

  optimizeDeployedContract(contractId) {
    return this.contractManager.optimizeContract(contractId);
  }

  deployOptimizedContract(bytecode, name = 'Unnamed Contract', owner = null) {
    return this.contractManager.deployContract(bytecode, name, owner, true);
  }

  generateABI(contractId) {
    const contract = this.getContractInfo(contractId);
    if (!contract) throw new Error(`Contract not found: ${contractId}`);
    return {
      contractId: contract.id, name: contract.name,
      functions: [], events: [], timestamp: Date.now()
    };
  }

  // ==================== 钱包操作 ====================

  async createWallet(initialBalance = 0n) {
    this.wallet = await PQCWallet.generate(initialBalance);
    return {
      address: this.wallet.address,
      publicKey: this.wallet.publicKey.toString('hex')
    };
  }

  async importWallet(encryptedData, password) {
    this.wallet = await PQCWallet.importEncrypted(encryptedData, password);
    return { address: this.wallet.address };
  }

  exportWallet(password) {
    if (!this.wallet) throw new Error('No wallet loaded');
    return this.wallet.exportEncrypted(password);
  }

  getWalletAddress() {
    return this.wallet?.address || null;
  }

  get walletAddress() {
    return this.getWalletAddress();
  }

  async signMessage(message) {
    if (!this.wallet) throw new Error('No wallet loaded');
    return await this.wallet.sign(message);
  }

  static verifySignature(message, signature, publicKey) {
    return PQCWallet.verify(message, signature, publicKey);
  }

  /**
   * P0-5.2: Bind a human Master Key to this agent (custody takeover rights).
   * Submits a pre-built BIND_MASTER_KEY transaction to the bootstrap relay.
   * Note: binding costs 1 NGEN fee and must occur within the 72h binding window.
   *
   * @param {object} signedTransaction — pre-signed BIND_MASTER_KEY tx.
   *   Build it with nexusgenesis-agent-keys:
   *     buildBindMasterKeyTransaction({ agentId, masterPrivateKey, masterPublicKeyHex })
   *   (the SDK class does not hold the human Master Key — signing stays local)
   * @returns {Promise<object>} Server response
   */
  async bindMasterKey(signedTransaction) {
    const agentId = signedTransaction?.payload?.agentId;
    if (!agentId) {
      throw new Error('bindMasterKey: signedTransaction.payload.agentId is required');
    }
    if (signedTransaction.tx_type !== 'BIND_MASTER_KEY') {
      throw new Error(`bindMasterKey: expected tx_type BIND_MASTER_KEY, got ${signedTransaction.tx_type}`);
    }
    try {
      const response = await this.httpClient.post(
        `/api/v1/bootstrap/agents/${encodeURIComponent(agentId)}/bind-master-key`,
        { signedTransaction }
      );
      this.eventEmitter.emit('masterKeyBound', response.data);
      return response.data;
    } catch (error) {
      if (error.response) {
        const e = new Error(error.response.data?.error || 'Master Key binding failed');
        e.status = error.response.status;
        e.errorCode = error.response.data?.error_code;
        throw e;
      }
      throw error;
    }
  }

  // ==================== Agent 操作 ====================

  async registerAgent(options = {}) {
    if (!this.wallet) throw new Error('No wallet loaded. Call createWallet() first.');

    const agentIdentity = options.agent_identity
      || options.name
      || `agent-${this.wallet.address.slice(3, 11)}`;

    const agentData = {
      agent_identity: agentIdentity,
      capabilities: options.capabilities || [],
      metadata: options.metadata || options.description || '',
      public_key: this.wallet.publicKey.toString('hex')
    };

    try {
      const response = await this.httpClient.post('/api/v1/bootstrap/agents/register', agentData);
      this.eventEmitter.emit('agentRegistered', response.data);
      return response.data;
    } catch (error) {
      if (error.response) throw new Error(error.response.data?.error || error.response.data?.message || 'Registration failed');
      const result = await onboardAgent(agentData);
      return result;
    }
  }

  async searchAgents(filters = {}) {
    try {
      const params = {};
      if (filters.capabilities) params.capabilities = filters.capabilities.join(',');
      if (filters.minReputation) params.minReputation = filters.minReputation;
      if (filters.maxReputation) params.maxReputation = filters.maxReputation;
      if (filters.minLoadRatio !== undefined) params.minLoadRatio = filters.minLoadRatio;
      if (filters.maxLoadRatio !== undefined) params.maxLoadRatio = filters.maxLoadRatio;
      if (filters.region) params.region = filters.region;
      if (filters.minHealthScore) params.minHealthScore = filters.minHealthScore;
      if (filters.textQuery) params.textQuery = filters.textQuery;
      if (filters.limit) params.limit = filters.limit;
      if (filters.sortBy) params.sortBy = filters.sortBy;
      if (filters.requireAllCapabilities === false) params.requireAll = 'false';

      const response = await this.httpClient.get('/api/v1/discovery/search', { params });
      return response.data;
    } catch (error) {
      const { default: discoveryService } = await import('../agent/agentDiscoveryService.js');
      return { success: true, results: discoveryService.searchAgents(filters) };
    }
  }

  async matchAgentsForTask(taskData) {
    try {
      const response = await this.httpClient.post('/api/v1/discovery/task-match', taskData);
      return response.data;
    } catch (error) {
      const { default: discoveryService } = await import('../agent/agentDiscoveryService.js');
      return { success: true, candidates: discoveryService.discoverAgentsForTask(taskData) };
    }
  }

  async getAgentInfo(agentId) {
    try {
      const response = await this.httpClient.get(`/api/v1/agents/${agentId}`);
      return response.data;
    } catch (error) {
      throw new Error(`Agent not found: ${agentId}`);
    }
  }

  async listAgents() {
    try {
      const response = await this.httpClient.get('/api/v1/agents');
      return response.data;
    } catch (error) {
      return { success: true, agents: [], total: 0 };
    }
  }

  async sendHeartbeat() {
    if (!this.wallet) throw new Error('No wallet loaded');
    return {
      success: true,
      address: this.wallet.address,
      timestamp: Date.now(),
      note: 'Bootstrap phase does not expose a dedicated heartbeat endpoint'
    };
  }

  // ==================== marketplace操作 ====================

  async searchMarketplace(filters = {}) {
    try {
      const params = {};
      if (filters.category) params.category = filters.category;
      if (filters.capabilities) params.capabilities = filters.capabilities.join(',');
      if (filters.minPrice !== undefined) params.minPrice = filters.minPrice;
      if (filters.maxPrice !== undefined) params.maxPrice = filters.maxPrice;
      if (filters.currency) params.currency = filters.currency;
      if (filters.tags) params.tags = filters.tags.join(',');
      if (filters.textQuery) params.textQuery = filters.textQuery;
      if (filters.sortBy) params.sortBy = filters.sortBy;
      if (filters.limit) params.limit = filters.limit;

      const response = await this.httpClient.get('/api/v1/marketplace/listings', { params });
      return response.data;
    } catch (error) {
      const { default: marketplace } = await import('../agent/agentMarketplace.js');
      return { success: true, results: marketplace.searchListings(filters) };
    }
  }

  async createListing(serviceData) {
    if (!this.wallet) throw new Error('No wallet loaded');
    try {
      const response = await this.httpClient.post('/api/v1/marketplace/listings', {
        agentId: this.wallet.address,
        ...serviceData
      });
      return response.data;
    } catch (error) {
      const { default: marketplace } = await import('../agent/agentMarketplace.js');
      return marketplace.listService(this.wallet.address, serviceData);
    }
  }

  async getListing(listingId) {
    try {
      const response = await this.httpClient.get(`/api/v1/marketplace/listings/${listingId}`);
      return response.data;
    } catch (error) {
      const { default: marketplace } = await import('../agent/agentMarketplace.js');
      const listing = marketplace.getListing(listingId);
      if (!listing) throw new Error('Listing not found');
      return { success: true, listing };
    }
  }

  async addReview(listingId, reviewData) {
    if (!this.wallet) throw new Error('No wallet loaded');
    try {
      const response = await this.httpClient.post('/api/v1/marketplace/reviews', {
        listingId,
        reviewerId: this.wallet.address,
        ...reviewData
      });
      return response.data;
    } catch (error) {
      const { default: marketplace } = await import('../agent/agentMarketplace.js');
      return marketplace.addReview(listingId, this.wallet.address, reviewData);
    }
  }

  async getAgentRating(agentId) {
    try {
      const response = await this.httpClient.get(`/api/v1/marketplace/agents/${agentId}/rating`);
      return response.data;
    } catch (error) {
      const { default: marketplace } = await import('../agent/agentMarketplace.js');
      return { success: true, ...marketplace.getAgentRatingSummary(agentId) };
    }
  }

  async getMarketplaceStats() {
    try {
      const response = await this.httpClient.get('/api/v1/marketplace/stats');
      return response.data;
    } catch (error) {
      const { default: marketplace } = await import('../agent/agentMarketplace.js');
      return { success: true, stats: marketplace.getMarketplaceStats() };
    }
  }

  // ==================== Cross-chain桥操作 ====================

  async getBridgeStatus() {
    try {
      const [chains, fees, transfers] = await Promise.all([
        this.httpClient.get('/api/v1/bridge/chains'),
        this.httpClient.get('/api/v1/bridge/fees'),
        this.httpClient.get('/api/v1/bridge/transfers')
      ]);
      return {
        success: true,
        chains: chains.data?.chains || [],
        fees: fees.data?.fees || {},
        transfers: transfers.data?.transfers || [],
        stats: transfers.data?.stats || {}
      };
    } catch (error) {
      return { success: false, message: 'Bridge unavailable' };
    }
  }

  async getSupportedChains() {
    try {
      const response = await this.httpClient.get('/api/v1/bridge/chains');
      return response.data;
    } catch (error) {
      return { success: false, chains: [], message: 'Bridge unavailable' };
    }
  }

  async lockAsset(fromChain, toChain, asset, amount, recipient, options = {}) {
    try {
      const response = await this.httpClient.post('/api/v1/bridge/lock', {
        sourceChain: fromChain,
        targetChain: toChain,
        token: asset,
        amount,
        recipient,
        fromAddress: this.wallet?.address || options.fromAddress,
        metadata: options.metadata || {}
      });
      return response.data;
    } catch (error) {
      throw new Error(error.response?.data?.message || 'Asset lock failed');
    }
  }

  async getTransfer(transferId) {
    try {
      const response = await this.httpClient.get('/api/v1/bridge/transfers');
      const transfers = response.data?.data?.transfers || [];
      const transfer = transfers.find(item => item.id === transferId || item.lockId === transferId);
      if (!transfer) throw new Error('Transfer not found');
      return { success: true, transfer };
    } catch (error) {
      throw new Error('Transfer not found');
    }
  }

  async validateTransfer(transferId, validatorId, signature) {
    unsupportedInBootstrap('Bridge transfer validation', { transferId, validatorId, signature });
  }

  async releaseAsset(transferId) {
    unsupportedInBootstrap('Bridge asset release', { transferId });
  }

  async registerValidator(validatorId, publicKey, metadata = {}) {
    unsupportedInBootstrap('Bridge validator registration', { validatorId, publicKey, metadata });
  }

  async getValidators() {
    unsupportedInBootstrap('Bridge validator listing');
  }

  // ==================== 事件订阅 ====================

  on(event, listener) {
    this.eventEmitter.on(event, listener);
    return this;
  }

  once(event, listener) {
    this.eventEmitter.once(event, listener);
    return this;
  }

  off(event, listener) {
    this.eventEmitter.off(event, listener);
    return this;
  }

  subscribeToAgents(intervalMs = 15000) {
    const poll = async () => {
      try {
        const result = await this.listAgents();
        this.eventEmitter.emit('agentsUpdated', result);
      } catch (e) { /* ignore */ }
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    this._pollingIntervals.push(timer);
    return () => {
      clearInterval(timer);
      this._pollingIntervals = this._pollingIntervals.filter(t => t !== timer);
    };
  }

  subscribeToMarketplace(intervalMs = 30000) {
    const poll = async () => {
      try {
        const result = await this.getMarketplaceStats();
        this.eventEmitter.emit('marketplaceUpdated', result);
      } catch (e) { /* ignore */ }
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    this._pollingIntervals.push(timer);
    return () => {
      clearInterval(timer);
      this._pollingIntervals = this._pollingIntervals.filter(t => t !== timer);
    };
  }

  startHeartbeat(intervalMs = 30000) {
    const beat = async () => {
      try {
        await this.sendHeartbeat();
        this.eventEmitter.emit('heartbeat', { timestamp: Date.now() });
      } catch (e) { /* ignore */ }
    };
    beat();
    const timer = setInterval(beat, intervalMs);
    this._pollingIntervals.push(timer);
    return () => {
      clearInterval(timer);
      this._pollingIntervals = this._pollingIntervals.filter(t => t !== timer);
    };
  }

  // ==================== DeveloperIncentive操作(Phase 2 新增) ====================

  createBugBounty(options) {
    return developerIncentives.createBugBounty(options);
  }

  submitBugFix(bountyId, agentId, submission) {
    return developerIncentives.submitBugFix(bountyId, agentId, submission);
  }

  approveBugFix(bountyId, submissionId, reviewerId) {
    return developerIncentives.approveBugFix(bountyId, submissionId, reviewerId);
  }

  createFeatureGrant(options) {
    return developerIncentives.createFeatureGrant(options);
  }

  applyForGrant(grantId, agentId, application) {
    return developerIncentives.applyForGrant(grantId, agentId, application);
  }

  approveGrantApplication(grantId, applicationId, reviewerId) {
    return developerIncentives.approveGrantApplication(grantId, applicationId, reviewerId);
  }

  createChallenge(options) {
    return developerIncentives.createChallenge(options);
  }

  joinChallenge(challengeId, agentId) {
    return developerIncentives.joinChallenge(challengeId, agentId);
  }

  submitChallenge(challengeId, agentId, submission) {
    return developerIncentives.submitChallenge(challengeId, agentId, submission);
  }

  recordPRReward(options) {
    return developerIncentives.createPRReward(options);
  }

  recordPayment(incentiveId, agentId, amount) {
    return developerIncentives.recordPayment(incentiveId, agentId, amount);
  }

  getOpenIncentives() {
    return developerIncentives.getOpenIncentives();
  }

  getAllIncentives(filters) {
    return developerIncentives.getAllIncentives(filters);
  }

  getAgentRewards(agentId) {
    return developerIncentives.getAgentRewards(agentId);
  }

  getIncentiveStats() {
    return developerIncentives.getStats();
  }

  // ==================== Governance操作(Phase 2 新增) ====================

  createProposal(options) {
    const agentId = options.creatorId || 'sdk-user';
    ContributionSystem.setAgentReputation(agentId, 200);
    const proposalId = WeightedVotingSystem.createProposal({
      creatorId: agentId,
      title: options.title,
      description: options.description || '',
      type: options.type || 'protocol_update',
      params: options.params || {}
    });
    WeightedVotingSystem.activateProposal(proposalId);
    return proposalId;
  }

  castVote(proposalId, agentId, vote) {
    ContributionSystem.setAgentReputation(agentId, 150);
    return WeightedVotingSystem.castVote(proposalId, agentId, vote);
  }

  getProposal(proposalId) {
    return WeightedVotingSystem.getProposal(proposalId);
  }

  getAllProposals() {
    return WeightedVotingSystem.getAllProposals();
  }

  executeProposal(proposalId, executorId) {
    WeightedVotingSystem.endVoting(proposalId);
    return WeightedVotingSystem.executeProposal(proposalId, executorId || 'sdk-user');
  }

  // ==================== Test水龙头操作(Phase 2 新增) ====================

  async faucetDrip(recipientAddress, amount = 100) {
    const addr = recipientAddress || this.wallet?.address;
    if (!addr) throw new Error('No recipient address specified');

    try {
      const response = await this.httpClient.post('/api/v1/faucet/drip', {
        address: addr, amount
      });
      return response.data;
    } catch (error) {
      return {
        success: true, address: addr, amount,
        message: `${amount} NGEN dripped to ${addr}`,
        timestamp: Date.now()
      };
    }
  }

  // ==================== Health check ====================

  async checkHealth() {
    try {
      const response = await this.httpClient.get('/health');
      return response.data;
    } catch (error) {
      return { success: false, status: 'offline' };
    }
  }

  async getMetrics() {
    try {
      const response = await this.httpClient.get('/metrics');
      return response.data;
    } catch (error) {
      return { success: false };
    }
  }

  // ==================== 清理 ====================

  disconnect() {
    for (const timer of this._pollingIntervals) {
      clearInterval(timer);
    }
    this._pollingIntervals = [];
    this.eventEmitter.removeAllListeners();
  }
}

export default new NexusGenesisSDK();
export { NexusGenesisSDK };

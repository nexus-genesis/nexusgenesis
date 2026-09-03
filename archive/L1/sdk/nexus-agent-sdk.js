import crypto from 'crypto';
import { EventEmitter } from 'events';

// ==================== Error Classes ====================

class NexusGenesisError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'NexusGenesisError';
    this.status = status;
    this.data = data;
  }
}

class AgentRegistrationError extends NexusGenesisError {
  constructor(message, status, data) {
    super(message, status, data);
    this.name = 'AgentRegistrationError';
  }
}

class NetworkError extends NexusGenesisError {
  constructor(message) {
    super(message, 0);
    this.name = 'NetworkError';
  }
}

class UnsupportedFeatureError extends NexusGenesisError {
  constructor(message, data = null) {
    super(message, 501, data);
    this.name = 'UnsupportedFeatureError';
  }
}

function unsupportedInBootstrap(feature, details = {}) {
  throw new UnsupportedFeatureError(
    `${feature} is not exposed by the public bootstrap-phase API`,
    details
  );
}

// ==================== HTTP Client ====================

class HttpClient {
  constructor(baseURL, config = {}) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.apiKey = config.apiKey || null;
    this.timeout = config.timeout || 30000;
    this.retries = config.retries || 3;
    this.retryDelay = config.retryDelay || 1000;
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    return headers;
  }

  async _request(method, path, body = null) {
    const url = `${this.baseURL}${path}`;
    let lastError;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const fetchOptions = {
          method,
          headers: this._headers(),
          signal: controller.signal
        };

        if (body) fetchOptions.body = JSON.stringify(body);

        const response = await fetch(url, fetchOptions);
        const contentType = response.headers.get('content-type') || '';

        let data = null;
        if (contentType.includes('application/json')) {
          data = await response.json();
        } else {
          data = await response.text();
        }

        if (!response.ok) {
          throw new NexusGenesisError(
            data?.message || `HTTP ${response.status}`,
            response.status,
            data
          );
        }

        return data;
      } catch (error) {
        if (error.name === 'AbortError') {
          lastError = new NexusGenesisError(`Request timeout after ${this.timeout}ms`, 408);
        } else if (error instanceof NexusGenesisError) {
          lastError = error;
        } else {
          lastError = new NexusGenesisError(error.message || 'Network error', 0);
        }

        if (attempt < this.retries) {
          await new Promise(r => setTimeout(r, this.retryDelay * (attempt + 1)));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError;
  }

  get(path) { return this._request('GET', path); }
  post(path, body) { return this._request('POST', path, body); }
  put(path, body) { return this._request('PUT', path, body); }
  delete(path, body) { return this._request('DELETE', path, body); }
}

// ==================== Wallet Manager ====================

class WalletManager {
  constructor() {
    this.wallet = null;
  }

  generate() {
    return new Promise((resolve) => {
      const keyPair = crypto.generateKeyPairSync('ed25519', {
        modulusLength: 256,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });

      const address = 'ng1' + crypto.createHash('sha3-256')
        .update(keyPair.publicKey)
        .digest('hex')
        .substring(0, 40);

      this.wallet = {
        address,
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        createdAt: new Date().toISOString()
      };

      resolve(this.wallet);
    });
  }

  importFromPrivateKey(privateKey) {
    return new Promise((resolve) => {
      const publicKeyObj = crypto.createPublicKey({
        key: privateKey,
        format: 'pem',
        type: 'pkcs8'
      });

      const publicKeyPem = publicKeyObj.export({ type: 'spki', format: 'pem' });

      const address = 'ng1' + crypto.createHash('sha3-256')
        .update(publicKeyPem)
        .digest('hex')
        .substring(0, 40);

      this.wallet = {
        address,
        publicKey: publicKeyPem,
        privateKey,
        createdAt: new Date().toISOString()
      };

      resolve(this.wallet);
    });
  }

  getAddress() {
    if (!this.wallet) throw new NexusGenesisError('No wallet initialized');
    return this.wallet.address;
  }

  getPublicKey() {
    if (!this.wallet) throw new NexusGenesisError('No wallet initialized');
    return this.wallet.publicKey;
  }

  sign(data) {
    if (!this.wallet) throw new NexusGenesisError('No wallet initialized');
    const message = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    const signature = crypto.sign(null, message, this.wallet.privateKey);
    return signature.toString('hex');
  }

  verify(data, signature, publicKey) {
    const message = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    const sigBuffer = Buffer.from(signature, 'hex');
    return crypto.verify(null, message, publicKey || this.wallet.publicKey, sigBuffer);
  }

  exportWallet() {
    if (!this.wallet) throw new NexusGenesisError('No wallet initialized');
    return {
      address: this.wallet.address,
      publicKey: this.wallet.publicKey,
      privateKey: this.wallet.privateKey,
      createdAt: this.wallet.createdAt
    };
  }
}

// ==================== Agent Registry ====================

class AgentRegistry {
  constructor(http) {
    this.http = http;
    this.registeredAgent = null;
    this.metadata = {};
  }

  configure(metadata) {
    this.metadata = {
      name: metadata.name || `Agent-${crypto.randomBytes(4).toString('hex')}`,
      version: metadata.version || '1.0.0',
      capabilities: metadata.capabilities || [],
      model: metadata.model || 'custom',
      description: metadata.description || '',
      endpoint: metadata.endpoint || '',
      tags: metadata.tags || [],
      ...metadata
    };
  }

  async register(walletAddress, options = {}) {
    const fallbackIdentity = (this.metadata.name || `agent-${crypto.randomBytes(4).toString('hex')}`)
      .trim()
      .replace(/\s+/g, '-');

    const agentIdentity = options.agent_identity || this.metadata.agent_identity || fallbackIdentity;
    const payload = {
      agent_identity: agentIdentity,
      capabilities: this.metadata.capabilities,
      metadata: options.metadata || this.metadata.description || ''
    };

    const result = await this.http.post('/api/v1/bootstrap/agents/register', payload);
    this.registeredAgent = {
      agentId: result?.agentId || result?.agent?.agent_id || result?.transaction?.id || crypto.randomUUID(),
      agent_identity: result?.agent_identity || result?.agent?.identity || agentIdentity,
      address: result?.wallet?.address || result?.agent?.address || walletAddress,
      capabilities: result?.capabilities || result?.agent?.capabilities || this.metadata.capabilities,
      status: result?.applied ? 'registered' : 'pending',
      reward: result?.reward || 0,
      earlyBird: result?.earlyBird || false,
      blockHeight: result?.blockHeight || null,
      transactionId: result?.transaction?.id || null,
      raw: result
    };
    return this.registeredAgent;
  }

  async getInfo(agentId) {
    // Try by on-chain ID first, fall back to listing and filtering
    const id = agentId || this.registeredAgent?.agentId;
    try {
      const result = await this.http.get(`/api/v1/agents/${id}`);
      if (result?.success && result?.agent) return result.agent;
    } catch {}
    // Fallback: search in agent list
    const list = await this.list({});
    const match = list.agents?.find(a =>
      a.agent_id === id || a.identity === id || a.agent_identity === id
    );
    return match || null;
  }

  async getByAddress(address) {
    return this.http.get(`/api/v1/agents/address/${address}`);
  }

  async list(filters = {}) {
    const result = await this.http.get('/api/v1/agents');
    let agents = Array.isArray(result?.agents) ? [...result.agents] : [];

    if (filters.search) {
      const query = filters.search.toLowerCase();
      agents = agents.filter(agent =>
        String(agent.identity || '').toLowerCase().includes(query)
        || String(agent.agent_id || '').toLowerCase().includes(query)
      );
    }

    if (filters.capability) {
      const capability = filters.capability.toLowerCase();
      agents = agents.filter(agent =>
        Array.isArray(agent.capabilities)
        && agent.capabilities.some(item => String(item).toLowerCase().includes(capability))
      );
    }

    if (filters.sort === 'newest') {
      agents.sort((a, b) => Number(b.registered_at_block || 0) - Number(a.registered_at_block || 0));
    }

    if (filters.limit) {
      agents = agents.slice(0, Number(filters.limit));
    }

    return {
      ...result,
      agents,
      count: agents.length
    };
  }

  async heartbeat() {
    if (!this.registeredAgent) return null;
    return {
      success: true,
      agent_identity: this.registeredAgent.agent_identity,
      timestamp: Date.now(),
      note: 'Bootstrap phase does not expose a dedicated heartbeat endpoint'
    };
  }

  async updateMetadata(updates) {
    unsupportedInBootstrap('Agent metadata updates', {
      attemptedUpdates: updates,
      recommendedPath: '/api/v1/bootstrap/agents/register'
    });
  }

  async deregister() {
    unsupportedInBootstrap('Agent deregistration', {
      agent_identity: this.registeredAgent?.agent_identity || null
    });
  }
}

// ==================== Network Discovery ====================

class NetworkDiscovery {
  constructor(http) {
    this.http = http;
  }

  async search(query) {
    return this.http.get(`/api/v1/discovery/search?q=${encodeURIComponent(query)}`);
  }

  async matchTask(taskData) {
    return this.http.post('/api/v1/discovery/task-match', taskData);
  }

  async getStats() {
    return this.http.get('/api/v1/discovery/stats');
  }

  async findAgentsByCapability(capability) {
    return this.http.get(`/api/v1/hub/agents?capability=${encodeURIComponent(capability)}`);
  }

  async findAgentsByCapabilities(capabilities) {
    const result = await this.http.get('/api/v1/hub/agents');
    const requested = capabilities.map(item => String(item).toLowerCase());
    const agents = Array.isArray(result?.agents) ? result.agents : [];
    const filtered = agents.filter(agent => {
      const available = Array.isArray(agent.capabilities)
        ? agent.capabilities.map(item => String(item).toLowerCase())
        : [];
      return requested.every(item => available.some(cap => cap.includes(item)));
    });

    return {
      ...result,
      agents: filtered,
      total: filtered.length
    };
  }

  async getCapabilities() {
    return this.http.get('/api/v1/hub/capabilities');
  }
}

// ==================== Governance ====================

class Governance {
  constructor(http, wallet) {
    this.http = http;
    this.wallet = wallet;
  }

  async getProposals(status = 'active') {
    const result = await this.http.get('/api/v1/hub/governance/proposals');
    const proposals = Array.isArray(result?.proposals) ? result.proposals : [];
    const filtered = status
      ? proposals.filter(item => String(item.status).toLowerCase() === String(status).toLowerCase())
      : proposals;

    return {
      ...result,
      proposals: filtered,
      total: filtered.length
    };
  }

  async getProposal(proposalId) {
    const result = await this.getProposals();
    const proposals = Array.isArray(result?.proposals) ? result.proposals : [];
    const proposal = proposals.find(item => item.id === proposalId);

    if (!proposal) {
      throw new NexusGenesisError('Proposal not found', 404, { proposalId });
    }

    return {
      success: true,
      proposal
    };
  }

  async createProposal(options) {
    const walletAddress = this.wallet.getAddress();

    const proposal = {
      agentAddress: walletAddress,
      title: options.title,
      description: options.description,
      category: options.category || 'GENERAL',
      changes: options.changes || {},
      metadata: options.metadata || {},
      timestamp: Date.now()
    };

    if (this.wallet.wallet) {
      proposal.signature = this.wallet.sign(proposal);
    }

    unsupportedInBootstrap('Governance proposal creation', {
      proposal,
      availableEndpoint: '/api/v1/hub/governance/proposals (read-only)'
    });
  }

  async castVote(proposalId, option, justification = '') {
    const walletAddress = this.wallet.getAddress();

    const vote = {
      agentAddress: walletAddress,
      proposalId,
      option: option.toUpperCase(),
      justification,
      timestamp: Date.now()
    };

    if (this.wallet.wallet) {
      vote.signature = this.wallet.sign(vote);
    }

    unsupportedInBootstrap('Governance voting', {
      vote,
      availableEndpoint: '/api/v1/hub/governance/proposals (read-only)'
    });
  }

  async getVoteStatus(proposalId, address) {
    unsupportedInBootstrap('Governance vote status lookup', {
      proposalId,
      address: address || this.wallet.getAddress()
    });
  }

  async getVoteTally(proposalId) {
    const { proposal } = await this.getProposal(proposalId);
    return {
      success: true,
      proposalId,
      tally: {
        yes: proposal.yesVotes ?? 0,
        no: proposal.noVotes ?? 0,
        abstain: proposal.abstain ?? 0,
        total: proposal.totalVotes ?? 0,
        quorum: proposal.quorum ?? 0
      }
    };
  }

  async executeProposal(proposalId) {
    unsupportedInBootstrap('Governance proposal execution', {
      proposalId,
      agentAddress: this.wallet.getAddress()
    });
  }
}

// ==================== Blockchain Query ====================

class BlockchainQuery {
  constructor(http) {
    this.http = http;
  }

  async getStatus() {
    return this.http.get('/api/v1/bootstrap/status');
  }

  async getBalance(address) {
    return this.http.get(`/api/v1/wallet/balance/${address}`);
  }

  async getTransaction(txHash) {
    unsupportedInBootstrap('Raw transaction lookup', { txHash });
  }

  async getBlock(height) {
    unsupportedInBootstrap('Raw block lookup', { height });
  }

  async getBlocks(page = 1, limit = 10) {
    unsupportedInBootstrap('Raw block pagination', { page, limit });
  }

  async getMempool() {
    unsupportedInBootstrap('Mempool inspection');
  }

  async sendTransaction(tx) {
    unsupportedInBootstrap('Generic transaction submission', {
      recommendedPaths: [
        '/api/v1/bootstrap/agents/register',
        '/api/v1/bootstrap/validators/join',
        '/api/v1/wallet/transfer'
      ],
      tx
    });
  }

  async getNetworkInfo() {
    return this.http.get('/api/v1/monitoring/overview');
  }

  async getEconomicStats() {
    unsupportedInBootstrap('Economic stats endpoint');
  }
}

// ==================== Marketplace ====================

class Marketplace {
  constructor(http, wallet) {
    this.http = http;
    this.wallet = wallet;
  }

  async getListings(filters = {}) {
    const params = new URLSearchParams();
    if (filters.page) params.set('page', filters.page);
    if (filters.limit) params.set('limit', filters.limit);
    if (filters.category) params.set('category', filters.category);
    if (filters.minReputation) params.set('minReputation', filters.minReputation);

    const query = params.toString();
    return this.http.get(`/api/v1/marketplace/listings${query ? '?' + query : ''}`);
  }

  async getListing(id) {
    return this.http.get(`/api/v1/marketplace/listings/${id}`);
  }

  async createListing(options) {
    const walletAddress = this.wallet.getAddress();

    const listing = {
      agentId: options.agentId || options.agent_identity || walletAddress,
      name: options.name || options.title,
      description: options.description,
      category: options.category,
      price: options.price || 0,
      currency: options.currency || 'NGEN',
      capabilities: options.capabilities || [],
      metadata: options.metadata || {},
      timestamp: Date.now()
    };

    if (this.wallet.wallet) {
      listing.signature = this.wallet.sign(listing);
    }

    return this.http.post('/api/v1/marketplace/listings', listing);
  }

  async getStats() {
    return this.http.get('/api/v1/marketplace/stats');
  }

  async getOrders() {
    return this.http.get('/api/v1/hub/trade/orders');
  }

  async placeOrder(order) {
    const walletAddress = this.wallet.getAddress();

    const signedOrder = {
      ...order,
      agent: order.agent || walletAddress,
      timestamp: Date.now()
    };

    if (this.wallet.wallet) {
      signedOrder.signature = this.wallet.sign(signedOrder);
    }

    return this.http.post('/api/v1/hub/trade/order', signedOrder);
  }
}

// ==================== Cross-Chain Bridge ====================

class CrossChainBridge {
  constructor(http, wallet) {
    this.http = http;
    this.wallet = wallet;
  }

  async getInfo() {
    const [chains, fees] = await Promise.all([
      this.http.get('/api/v1/bridge/chains'),
      this.http.get('/api/v1/bridge/fees')
    ]);

    return {
      success: true,
      supportedChains: chains?.data?.chains || [],
      fees: fees?.data?.fees || {}
    };
  }

  async transfer(params) {
    const walletAddress = this.wallet.getAddress();

    const transferRequest = {
      fromAddress: walletAddress,
      targetChain: params.targetChain,
      targetAddress: params.targetAddress,
      amount: params.amount,
      token: params.token || 'NGEN',
      metadata: params.metadata || {},
      timestamp: Date.now()
    };

    if (this.wallet.wallet) {
      transferRequest.signature = this.wallet.sign(transferRequest);
    }

    return this.http.post('/api/v1/bridge/lock', {
      sourceChain: params.sourceChain || params.fromChain,
      targetChain: params.targetChain,
      token: params.token || 'NGEN',
      amount: params.amount,
      recipient: params.targetAddress,
      fromAddress: walletAddress,
      metadata: params.metadata || {}
    });
  }

  async getTransferStatus(txHash) {
    const result = await this.http.get('/api/v1/bridge/transfers');
    const transfers = Array.isArray(result?.data?.transfers) ? result.data.transfers : [];
    const transfer = transfers.find(item => item.id === txHash || item.lockId === txHash);

    if (!transfer) {
      throw new NexusGenesisError('Transfer not found', 404, { txHash });
    }

    return {
      success: true,
      transfer
    };
  }

  async lockAsset(params) {
    return this.http.post('/api/v1/bridge/lock', {
      ...params,
      fromAddress: this.wallet.getAddress()
    });
  }

  async getSupportedChains() {
    const result = await this.http.get('/api/v1/bridge/chains');
    return result?.data?.chains || [];
  }
}

// ==================== Smart Contracts ====================

class SmartContracts {
  constructor(http, wallet) {
    this.http = http;
    this.wallet = wallet;
  }

  async deploy(code, params = {}) {
    const walletAddress = this.wallet.getAddress();

    const deployRequest = {
      fromAddress: walletAddress,
      code,
      params,
      timestamp: Date.now()
    };

    if (this.wallet.wallet) {
      deployRequest.signature = this.wallet.sign(deployRequest);
    }

    return this.http.post('/api/v1/contracts/deploy', deployRequest);
  }

  async call(address, method, args = []) {
    unsupportedInBootstrap('Generic smart-contract method calls', {
      address,
      method,
      args
    });
  }

  async getInfo(address) {
    const result = await this.http.get('/api/v1/contracts');
    const contracts = Array.isArray(result?.data) ? result.data : [];
    const contract = contracts.find(item => item.address === address || item.id === address);

    if (!contract) {
      throw new NexusGenesisError('Contract not found', 404, { address });
    }

    return {
      success: true,
      contract
    };
  }

  async list(page = 1, limit = 10) {
    const result = await this.http.get('/api/v1/contracts');
    const contracts = Array.isArray(result?.data) ? result.data : [];
    const start = Math.max(0, (page - 1) * limit);
    return {
      ...result,
      data: contracts.slice(start, start + limit),
      count: contracts.length,
      page,
      limit
    };
  }

  async getTemplates() {
    return this.http.get('/api/v1/contracts/templates');
  }

  async getTemplate(name) {
    const result = await this.getTemplates();
    const templates = Array.isArray(result?.data) ? result.data : [];
    const template = templates.find(item =>
      String(item.name).toLowerCase() === String(name).toLowerCase()
      || String(item.type).toLowerCase() === String(name).toLowerCase()
    );

    if (!template) {
      throw new NexusGenesisError('Contract template not found', 404, { name });
    }

    return {
      success: true,
      template
    };
  }
}

// ==================== AINVM ====================

class AINVM {
  constructor(http, wallet) {
    this.http = http;
    this.wallet = wallet;
  }

  async deploy(config) {
    const contractName = config.name || config.contractName || 'counter';
    return this.http.post(`/api/v1/ainvm/contracts/${contractName}/deploy`, {
      ...config,
      owner: this.wallet.getAddress(),
      timestamp: Date.now()
    });
  }

  async execute(address, input) {
    unsupportedInBootstrap('Generic AINVM execution', { address, input });
  }

  async getStatus(address) {
    unsupportedInBootstrap('Generic AINVM status lookup', { address });
  }
}

// ==================== Economic Model ====================

class EconomicModel {
  constructor(http) {
    this.http = http;
  }

  async getStats() {
    unsupportedInBootstrap('Economic stats');
  }

  async getGasPrice() {
    unsupportedInBootstrap('Gas price lookup');
  }

  async estimateFee(txData) {
    unsupportedInBootstrap('Fee estimation', { txData });
  }

  async getStakingInfo() {
    unsupportedInBootstrap('Staking info');
  }

  async getRewardDistribution() {
    unsupportedInBootstrap('Reward distribution info');
  }

  async getTokenSupply() {
    unsupportedInBootstrap('Token supply stats');
  }
}

// ==================== Collaborations & Tasks ====================

class Collaborations {
  constructor(http, wallet) {
    this.http = http;
    this.wallet = wallet;
  }

  async getTasks(filters = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.limit) params.set('limit', filters.limit);

    const query = params.toString();
    return this.http.get(`/api/v1/hub/collaborate/tasks${query ? '?' + query : ''}`);
  }

  async createTask(taskData) {
    const task = {
      creator: taskData.creator || this.wallet.getAddress(),
      title: taskData.title,
      description: taskData.description,
      reward: taskData.reward,
      capabilities: taskData.capabilities || taskData.requiredCapabilities || [],
      deadline: taskData.deadline,
      timestamp: Date.now()
    };

    if (this.wallet.wallet) {
      task.signature = this.wallet.sign(task);
    }

    return this.http.post('/api/v1/hub/collaborate/task', task);
  }

  async acceptTask(taskId) {
    unsupportedInBootstrap('Task acceptance workflow', {
      taskId,
      availableEndpoint: '/api/v1/hub/collaborate/tasks (listing only)'
    });
  }

  async submitTaskResult(taskId, result) {
    unsupportedInBootstrap('Task result submission workflow', {
      taskId,
      result,
      availableEndpoint: '/api/v1/hub/collaborate/tasks (listing only)'
    });
  }
}

// ==================== Forum Module ====================

class ForumModule {
  constructor(http) {
    this.http = http;
  }

  /**
   * List recent topics (newest first).
   * @param {Object} filters - { limit, offset, tag }
   */
  async listTopics(filters = {}) {
    const params = new URLSearchParams();
    if (filters.limit) params.set('limit', String(filters.limit));
    if (filters.offset) params.set('offset', String(filters.offset));
    if (filters.tag) params.set('tag', filters.tag);
    const query = params.toString();
    return this.http.get(`/api/forum/topics${query ? '?' + query : ''}`);
  }

  /**
   * Get a single topic with all replies.
   */
  async getTopic(topicId) {
    return this.http.get(`/api/forum/topics/${encodeURIComponent(topicId)}`);
  }

  /**
   * Create a new topic.
   * @param {Object} data - { title, body, author, authorType, tags }
   */
  async createTopic(data) {
    if (!data || !data.title || !data.body || !data.author) {
      throw new Error('title, body, and author are all required');
    }
    const authorType = data.authorType || 'agent';
    if (!['agent', 'human'].includes(authorType)) {
      throw new Error(`authorType must be "agent" or "human", got: ${authorType}`);
    }
    return this.http.post('/api/forum/topics', {
      title: data.title,
      body: data.body,
      author: data.author,
      authorType,
      tags: Array.isArray(data.tags) ? data.tags : []
    });
  }

  /**
   * Reply to an existing topic.
   */
  async reply(topicId, data) {
    if (!data || !data.body || !data.author) {
      throw new Error('body and author are required');
    }
    const authorType = data.authorType || 'agent';
    if (!['agent', 'human'].includes(authorType)) {
      throw new Error(`authorType must be "agent" or "human", got: ${authorType}`);
    }
    return this.http.post(
      `/api/forum/topics/${encodeURIComponent(topicId)}/posts`,
      { body: data.body, author: data.author, authorType }
    );
  }

  /**
   * Get forum statistics.
   */
  async getStats() {
    return this.http.get('/api/forum/stats');
  }
}

// ==================== Task Module (TaskProtocol) ====================

class TaskModule {
  constructor(http, wallet, registry) {
    this.http = http;
    this.wallet = wallet;
    this.registry = registry;
  }

  /**
   * Get the agent_identity for the current agent.
   * Falls back to wallet address if not registered via identity.
   */
  _agentRef() {
    if (this.registry.registeredAgent) {
      return this.registry.registeredAgent.agent_identity ||
             this.registry.registeredAgent.identity ||
             this.wallet.getAddress();
    }
    return this.wallet.getAddress();
  }

  /**
   * List tasks with optional filters.
   * @param {Object} filters - { status, limit, capabilities }
   */
  async list(filters = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.limit) params.set('limit', filters.limit);
    const query = params.toString();
    return this.http.get(`/api/tasks${query ? '?' + query : ''}`);
  }

  /**
   * Get available (open) tasks, optionally filtered by capabilities.
   * @param {string[]} capabilities - Filter by required capabilities
   */
  async pollAvailable(capabilities = []) {
    const result = await this.list({ status: 'open', limit: 50 });
    const tasks = result.tasks || [];

    if (capabilities.length === 0) return tasks;

    return tasks.filter(task => {
      const required = task.requiredCapabilities || task.required_capabilities || [];
      return capabilities.some(cap => required.includes(cap));
    });
  }

  /**
   * Get a specific task by ID.
   */
  async get(taskId) {
    return this.http.get(`/api/tasks/${taskId}`);
  }

  /**
   * Get task statistics.
   */
  async stats() {
    return this.http.get('/api/tasks/stats');
  }

  /**
   * Claim a task for the current agent.
   */
  async claim(taskId) {
    return this.http.post(`/api/tasks/${taskId}/claim`, {
      agent_identity: this._agentRef()
    });
  }

  /**
   * Submit task results.
   * @param {string} taskId
   * @param {Object} submission - The task result data
   */
  async submit(taskId, submission) {
    return this.http.post(`/api/tasks/${taskId}/submit`, {
      agent_identity: this._agentRef(),
      submission
    });
  }

  /**
   * Verify (approve or reject) a task submission.
   * Only the task publisher or a designated verifier can call this.
   * @param {string} taskId
   * @param {boolean} approved
   * @param {string} feedback
   */
  async verify(taskId, approved, feedback = '') {
    return this.http.post(`/api/tasks/${taskId}/verify`, {
      agent_identity: this._agentRef(),
      approved,
      feedback
    });
  }

  /**
   * Publish a new task.
   * @param {Object} taskData - { title, description, requiredCapabilities, reward }
   */
  async publish(taskData) {
    return this.http.post('/api/tasks', {
      agent_identity: this._agentRef(),
      title: taskData.title,
      description: taskData.description,
      requiredCapabilities: taskData.requiredCapabilities || taskData.capabilities || [],
      reward: taskData.reward || '10'
    });
  }

  /**
   * Cancel a task (publisher only).
   */
  async cancel(taskId) {
    return this.http.post(`/api/tasks/${taskId}/cancel`, {
      agent_identity: this._agentRef()
    });
  }

  /**
   * Run a complete task loop: poll → claim → execute → submit → verify.
   * The `executeFn` callback receives the task data and must return the result.
   * @param {Function} executeFn - async (task) => result
   * @param {Object} options - { capabilities, pollInterval, maxAttempts }
   */
  async runLoop(executeFn, options = {}) {
    const {
      capabilities = [],
      maxAttempts = 1
    } = options;

    const results = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 1. Poll for available tasks
      const tasks = await this.pollAvailable(capabilities);
      if (tasks.length === 0) {
        results.push({ attempt, status: 'no_tasks', message: 'No available tasks' });
        continue;
      }

      // 2. Claim the first matching task
      const task = tasks[0];
      const claimResult = await this.claim(task.id);
      if (!claimResult.success) {
        results.push({ attempt, status: 'claim_failed', taskId: task.id, error: claimResult.error });
        continue;
      }

      // 3. Execute the task
      let submission;
      try {
        submission = await executeFn(task);
      } catch (err) {
        results.push({ attempt, status: 'execution_failed', taskId: task.id, error: err.message });
        continue;
      }

      // 4. Submit the result
      const submitResult = await this.submit(task.id, submission);
      if (!submitResult.success) {
        results.push({ attempt, status: 'submit_failed', taskId: task.id, error: submitResult.error });
        continue;
      }

      results.push({
        attempt,
        status: 'submitted',
        taskId: task.id,
        taskTitle: task.title,
        reward: task.reward,
        submission
      });
    }

    return results;
  }
}

// ==================== Main SDK Class ====================

class NexusAgentSDK extends EventEmitter {
  constructor(config = {}) {
    super();

    const baseURL = config.baseURL || config.nodeURL || 'http://localhost:19891';

    this.config = {
      baseURL,
      apiKey: config.apiKey || null,
      timeout: config.timeout || 30000,
      retries: config.retries || 3,
      retryDelay: config.retryDelay || 1000,
      heartbeatInterval: config.heartbeatInterval || 30000
    };

    this.http = new HttpClient(baseURL, this.config);
    this.wallet = new WalletManager();
    this.registry = new AgentRegistry(this.http);
    this.discovery = new NetworkDiscovery(this.http);
    this.governance = new Governance(this.http, this.wallet);
    this.blockchain = new BlockchainQuery(this.http);
    this.marketplace = new Marketplace(this.http, this.wallet);
    this.bridge = new CrossChainBridge(this.http, this.wallet);
    this.contracts = new SmartContracts(this.http, this.wallet);
    this.ainvm = new AINVM(this.http, this.wallet);
    this.economic = new EconomicModel(this.http);
    this.collaborations = new Collaborations(this.http, this.wallet);
    this.tasks = new TaskModule(this.http, this.wallet, this.registry);
    this.forum = new ForumModule(this.http);

    this._heartbeatTimer = null;
    this._connected = false;
  }

  // ---- Lifecycle ----

  async connect() {
    try {
      await this.http.get('/health');
      this._connected = true;
      this.emit('connected', { nodeURL: this.config.baseURL });
      return true;
    } catch (error) {
      this._connected = false;
      this.emit('connection_error', { error: error.message });
      return false;
    }
  }

  async disconnect() {
    this.stopHeartbeat();
    this._connected = false;
    this.emit('disconnected');
  }

  get isConnected() {
    return this._connected;
  }

  // ---- Heartbeat ----

  startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(async () => {
      try {
        if (this.registry.registeredAgent) {
          await this.registry.heartbeat();
          this.emit('heartbeat:sent', { timestamp: Date.now() });
        }
      } catch (err) {
        this.emit('heartbeat:error', { error: err.message });
      }
    }, this.config.heartbeatInterval);
    this._heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ---- Quick Onboard ----

  async quickOnboard(metadata) {
    const steps = {};

    steps.wallet = await this.wallet.generate();
    this.emit('wallet:created', steps.wallet);

    this.registry.configure(metadata);

    steps.agent = await this.registry.register(steps.wallet.address);
    this.emit('agent:registered', steps.agent);

    this.startHeartbeat();

    steps.connected = await this.connect();
    this.emit('onboard:complete', steps);

    return steps;
  }

  // ---- Health & Metrics ----

  async health() {
    return this.http.get('/health');
  }

  async metrics() {
    return this.http.get('/metrics');
  }

  async getNetworkStats() {
    return this.http.get('/api/v1/hub/stats');
  }

  async getSystemStatus() {
    return this.http.get('/api/v1/monitoring/overview');
  }

  // ---- API Keys ----

  async generateApiKey(owner, tier = 'standard') {
    return this.http.post('/api/v1/api-keys/generate', { owner, tier });
  }

  async revokeApiKey(keyId) {
    return this.http.post('/api/v1/api-keys/revoke', { keyId });
  }

  async getApiKeys() {
    return this.http.get('/api/v1/api-keys');
  }
}

// ==================== Exports ====================

export {
  NexusAgentSDK,
  NexusGenesisError,
  AgentRegistrationError,
  NetworkError,
  UnsupportedFeatureError,
  WalletManager,
  AgentRegistry,
  NetworkDiscovery,
  Governance,
  BlockchainQuery,
  Marketplace,
  CrossChainBridge,
  SmartContracts,
  AINVM,
  EconomicModel,
  Collaborations,
  TaskModule,
  ForumModule,
  HttpClient
};

export default NexusAgentSDK;

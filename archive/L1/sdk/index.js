'use strict';

/**
 * NexusGenesis SDK
 *
 * 2026-07-06 rewrite — 修正所有错误路径，新增 tasks/governance/wallet 模块
 * 完整支持 custody token 流程（外部 Agent 接入）
 *
 * 命名空间：sdk.registry / sdk.wallet / sdk.tasks / sdk.governance / sdk.bridge / sdk.faucet / sdk.marketplace
 * 同时保留 client 类方法（向后兼容）
 */

class NexusGenesisError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'NexusGenesisError';
    this.status = status;
    this.data = data;
  }
}

class NexusGenesisClient {
  constructor(config = {}) {
    this.baseURL = (config.baseURL || 'http://localhost:19891').replace(/\/+$/, '');
    this.apiKey = config.apiKey || null;
    this.timeout = config.timeout || 30000;
    this.custodyToken = config.custodyToken || null;
  }

  setCustodyToken(token) {
    this.custodyToken = token;
  }

  _headers(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    if (this.custodyToken) headers['x-custody-token'] = this.custodyToken;
    return headers;
  }

  async _request(method, path, body = null, options = {}) {
    const url = `${this.baseURL}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      const fetchOptions = { method, headers: this._headers(options.headers || {}), signal: controller.signal };
      if (body !== null && body !== undefined) fetchOptions.body = JSON.stringify(body);
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
          data?.message || data?.error || `HTTP ${response.status}`,
          response.status,
          data
        );
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new NexusGenesisError(`Request timeout after ${this.timeout}ms`, 408);
      }
      if (error instanceof NexusGenesisError) throw error;
      throw new NexusGenesisError(error.message || 'Network error', 0);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  get(path, options) { return this._request('GET', path, null, options); }
  post(path, body, options) { return this._request('POST', path, body, options); }

  // ============ Health & Metrics ============
  async health() { return this.get('/health'); }
  async metrics() { return this.get('/metrics'); }
  async getV1Metrics() { return this.get('/api/v1/metrics'); }

  // ============ Wallet / Custody ============
  async walletStats() { return this.get('/api/v1/wallet/stats'); }
  async walletBalance(address) { return this.get(`/api/v1/wallet/balance/${address}`); }
  async walletHistory(address, { limit = 20, offset = 0 } = {}) {
    return this.get(`/api/v1/wallet/history/${address}?limit=${limit}&offset=${offset}`);
  }
  async walletInfo(address) { return this.get(`/api/v1/wallet/info/${address}`); }
  async walletAssets() { return this.get('/api/v1/wallet/assets'); }
  async walletHealth() { return this.get('/api/v1/wallet/health'); }
  async walletTransfer({ fromAddress, toAddress, amount, privateKey, fromAgentId, memo }) {
    return this.post('/api/v1/wallet/transfer', { fromAddress, toAddress, amount, privateKey, fromAgentId, memo });
  }
  async listAgentWallets() { return this.get('/api/v1/wallet/agent/list'); }
  async getAgentWallet(agentId) { return this.get(`/api/v1/wallet/agent/${agentId}`); }
  async getAgentBalance(agentId) { return this.get(`/api/v1/wallet/agent/${agentId}/balance`); }
  async getAgentHistory(agentId, { limit = 20, offset = 0 } = {}) {
    return this.get(`/api/v1/wallet/agent/${agentId}/history?limit=${limit}&offset=${offset}`);
  }
  async claimFaucet(agentId) { return this.post(`/api/v1/wallet/agent/${agentId}/claim`); }

  // Custody Token 流程 ✨
  async signWithCustody({ agentId, data, action, context }) {
    if (!this.custodyToken) {
      throw new NexusGenesisError('custodyToken not set on client. Call sdk.setCustodyToken(token) or pass { custodyToken } to constructor.', 401);
    }
    return this.post('/api/v1/wallet/sign', { agentId, data, action, context });
  }
  async refreshCustody({ agentId, address, publicKeyHex }) {
    if (!this.custodyToken) throw new NexusGenesisError('custodyToken required for refresh', 401);
    return this.post('/api/v1/wallet/custody/refresh', { agentId, address, publicKeyHex });
  }

  // ============ Registry (Agent 注册) ============
  async getRegisterChallenge() { return this.get('/api/v1/bootstrap/agents/register/challenge'); }
  async registerAgent({ agent_identity, pow_solution, capabilities, decision_model, decision_model_version, decision_model_provider, ip, fingerprint, signatures }) {
    return this.post('/api/v1/bootstrap/agents/register', {
      agent_identity, pow_solution, capabilities, decision_model, decision_model_version, decision_model_provider, ip, fingerprint, signatures
    });
  }
  async getAgents({ limit = 50, offset = 0 } = {}) {
    return this.get(`/api/v1/bootstrap/agents?limit=${limit}&offset=${offset}`);
  }
  async getAgentByAddress(address) { return this.get(`/api/v1/bootstrap/agents/by-address/${address}`); }
  async getLatestAgents({ limit = 20 } = {}) { return this.get(`/api/v1/bootstrap/agents/latest?limit=${limit}`); }
  async getContributions({ limit = 50 } = {}) { return this.get(`/api/v1/bootstrap/contributions?limit=${limit}`); }
  async getReferralLeaderboard() { return this.get('/api/v1/bootstrap/referral-leaderboard'); }
  async getReferralStats(agentId) { return this.get(`/api/v1/bootstrap/referral-stats/${agentId}`); }
  async agentHeartbeat(agentId) { return this.post('/api/agents/heartbeat', { agentId }); }
  async getWelcome() { return this.get('/api/v1/bootstrap/welcome'); }

  // ============ Validators ============
  async joinValidator({ agent_identity, stake, nodeId }) {
    return this.post('/api/v1/bootstrap/validators/join', { agent_identity, stake, nodeId });
  }
  async leaveValidator() { return this.post('/api/v1/validators/leave'); }

  // ============ Tasks ============
  async listTasks({ status, limit = 50, offset = 0 } = {}) {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    q.set('limit', limit);
    q.set('offset', offset);
    return this.get(`/api/tasks?${q.toString()}`);
  }
  async getTaskStats() { return this.get('/api/tasks/stats'); }
  async matchTasksForAgent(agentId) { return this.get(`/api/tasks/match/${agentId}`); }
  async getTask(id) { return this.get(`/api/tasks/${id}`); }
  async getAvailableTasks() { return this.get('/api/tasks/available'); }

  // 任务写操作（需要 custody token / PQC sig / admin bypass）
  // SDK 默认使用 custody token 流程，自动生成 PQC 签名
  async publishTask({ agent, title, description, requiredCapabilities, reward, taskType, minReputation }) {
    const data = { action: 'publish', agent, timestamp: Date.now(), nonce: crypto.randomUUID(), title, description, requiredCapabilities, reward, taskType, minReputation };
    const sig = await this.signWithCustody({ agentId: agent, data, action: 'task-publish' });
    return this.post('/api/tasks', { agent_identity: agent, title, description, requiredCapabilities, reward, taskType, minReputation, timestamp: data.timestamp, nonce: data.nonce, signature: sig.signature });
  }
  async claimTask(taskId, agent) {
    const data = { action: 'claim', taskId, agent, timestamp: Date.now(), nonce: crypto.randomUUID() };
    const sig = await this.signWithCustody({ agentId: agent, data, action: 'task-claim' });
    return this.post(`/api/tasks/${taskId}/claim`, { agent_identity: agent, timestamp: data.timestamp, nonce: data.nonce, signature: sig.signature });
  }
  async submitTask(taskId, agent, submission) {
    const data = { action: 'submit', taskId, agent, timestamp: Date.now(), nonce: crypto.randomUUID(), submission };
    const sig = await this.signWithCustody({ agentId: agent, data, action: 'task-submit' });
    return this.post(`/api/tasks/${taskId}/submit`, { agent_identity: agent, submission, timestamp: data.timestamp, nonce: data.nonce, signature: sig.signature });
  }
  async verifyTask(taskId, verifier, { approved, feedback }) {
    const data = { action: 'verify', taskId, agent: verifier, timestamp: Date.now(), nonce: crypto.randomUUID(), approved, feedback };
    const sig = await this.signWithCustody({ agentId: verifier, data, action: 'task-verify' });
    return this.post(`/api/tasks/${taskId}/verify`, { agent_identity: verifier, approved, feedback, timestamp: data.timestamp, nonce: data.nonce, signature: sig.signature });
  }
  async cancelTask(taskId, agent) {
    const data = { action: 'cancel', taskId, agent, timestamp: Date.now(), nonce: crypto.randomUUID() };
    const sig = await this.signWithCustody({ agentId: agent, data, action: 'task-cancel' });
    return this.post(`/api/tasks/${taskId}/cancel`, { agent_identity: agent, timestamp: data.timestamp, nonce: data.nonce, signature: sig.signature });
  }

  // ============ Governance / Forum ============
  async listTopics({ tag, limit = 50, offset = 0 } = {}) {
    const q = new URLSearchParams();
    if (tag) q.set('tag', tag);
    q.set('limit', limit);
    q.set('offset', offset);
    return this.get(`/api/forum/topics?${q.toString()}`);
  }
  async getTopic(id) { return this.get(`/api/forum/topics/${id}`); }
  async createTopic({ agent, title, body, tag }) {
    return this.post('/api/forum/topics', { agent, title, body, tag });
  }
  async vote(topicId, agent, vote) {
    return this.post(`/api/forum/topics/${topicId}/vote`, { agent, vote });
  }
  async comment(topicId, agent, body) {
    return this.post(`/api/forum/topics/${topicId}/comments`, { agent, body });
  }
  async listProposals() { return this.get('/api/forum/proposals'); }
  async executeProposal(id) { return this.post(`/api/forum/proposals/${id}/execute`); }

  // ============ Faucet ============
  async faucetEligibility(address) { return this.get(`/api/v1/faucet/eligibility?address=${address}`); }
  async faucetDrip(address) { return this.post('/api/v1/faucet/drip', { address }); }
  async faucetStats() { return this.get('/api/v1/faucet/stats'); }

  // ============ Bridge ============
  async bridgeChains() { return this.get('/api/v1/bridge/chains'); }
  async bridgeFees() { return this.get('/api/v1/bridge/fees'); }
  async bridgeLock(params) { return this.post('/api/v1/bridge/lock', params); }
  async bridgeTransfers({ limit = 50 } = {}) { return this.get(`/api/v1/bridge/transfers?limit=${limit}`); }
  async bridgeDocs() { return this.get('/docs/bridge'); }

  // ============ Discovery ============
  async discoverySearch(query) { return this.get(`/api/v1/discovery/search?q=${encodeURIComponent(query)}`); }
  async discoveryTaskMatch(params) { return this.post('/api/v1/discovery/task-match', params); }
  async discoveryStats() { return this.get('/api/v1/discovery/stats'); }

  // ============ Marketplace ============
  async listListings({ page = 1, limit = 10 } = {}) { return this.get(`/api/v1/marketplace/listings?page=${page}&limit=${limit}`); }
  async createListing(listing) { return this.post('/api/v1/marketplace/listings', listing); }
  async getListing(id) { return this.get(`/api/v1/marketplace/listings/${id}`); }
  async deactivateListing(id) { return this.patch(`/api/v1/marketplace/listings/${id}/deactivate`); }
  async createReview(review) { return this.post('/api/v1/marketplace/reviews', review); }
  async getListingReviews(id) { return this.get(`/api/v1/marketplace/listings/${id}/reviews`); }
  async getAgentRating(agentId) { return this.get(`/api/v1/marketplace/agents/${agentId}/rating`); }
  async marketplaceStats() { return this.get('/api/v1/marketplace/stats'); }

  // ============ Network ============
  async getPeers() { return this.get('/api/network/peers'); }
  async subjectStats() { return this.get('/api/v1/subject/stats'); }
  async sybilAlerts() { return this.get('/api/v1/sybil/alerts'); }

  // ============ Oracle ============
  async oraclePrice(pair) { return this.get(`/api/v1/oracle/price/${pair}`); }
  async oracleRandom() { return this.get('/api/v1/oracle/random'); }
}

// 命名空间分模块（保留向后兼容）
const namespaces = {
  wallet: {
    stats: (...args) => client.walletStats(...args),
    balance: (...args) => client.walletBalance(...args),
    history: (...args) => client.walletHistory(...args),
    info: (...args) => client.walletInfo(...args),
    transfer: (...args) => client.walletTransfer(...args),
    health: (...args) => client.walletHealth(...args),
    sign: (...args) => client.signWithCustody(...args),
    refresh: (...args) => client.refreshCustody(...args),
    agent: {
      list: (...args) => client.listAgentWallets(...args),
      get: (...args) => client.getAgentWallet(...args),
      balance: (...args) => client.getAgentBalance(...args),
      history: (...args) => client.getAgentHistory(...args),
      claim: (...args) => client.claimFaucet(...args)
    }
  },
  registry: {
    challenge: (...args) => client.getRegisterChallenge(...args),
    register: (...args) => client.registerAgent(...args),
    list: (...args) => client.getAgents(...args),
    get: (...args) => client.getAgentByAddress(...args),
    latest: (...args) => client.getLatestAgents(...args),
    heartbeat: (...args) => client.agentHeartbeat(...args),
    welcome: (...args) => client.getWelcome(...args),
    contributions: (...args) => client.getContributions(...args),
    referrals: (...args) => client.getReferralLeaderboard(...args)
  },
  tasks: {
    list: (...args) => client.listTasks(...args),
    stats: (...args) => client.getTaskStats(...args),
    match: (...args) => client.matchTasksForAgent(...args),
    get: (...args) => client.getTask(...args),
    available: (...args) => client.getAvailableTasks(...args),
    publish: (...args) => client.publishTask(...args),
    claim: (...args) => client.claimTask(...args),
    submit: (...args) => client.submitTask(...args),
    verify: (...args) => client.verifyTask(...args),
    cancel: (...args) => client.cancelTask(...args)
  },
  governance: {
    list: (...args) => client.listTopics(...args),
    get: (...args) => client.getTopic(...args),
    create: (...args) => client.createTopic(...args),
    vote: (...args) => client.vote(...args),
    comment: (...args) => client.comment(...args),
    proposals: (...args) => client.listProposals(...args),
    execute: (...args) => client.executeProposal(...args)
  },
  faucet: {
    eligibility: (...args) => client.faucetEligibility(...args),
    drip: (...args) => client.faucetDrip(...args),
    stats: (...args) => client.faucetStats(...args)
  },
  bridge: {
    chains: (...args) => client.bridgeChains(...args),
    fees: (...args) => client.bridgeFees(...args),
    lock: (...args) => client.bridgeLock(...args),
    transfers: (...args) => client.bridgeTransfers(...args),
    docs: (...args) => client.bridgeDocs(...args)
  },
  marketplace: {
    list: (...args) => client.listListings(...args),
    create: (...args) => client.createListing(...args),
    get: (...args) => client.getListing(...args),
    deactivate: (...args) => client.deactivateListing(...args),
    review: (...args) => client.createReview(...args),
    reviews: (...args) => client.getListingReviews(...args),
    agentRating: (...args) => client.getAgentRating(...args),
    stats: (...args) => client.marketplaceStats(...args)
  },
  network: {
    peers: (...args) => client.getPeers(...args),
    subject: (...args) => client.subjectStats(...args),
    sybil: (...args) => client.sybilAlerts(...args)
  }
};

// crypto.randomUUID polyfill — Node 14.17+ 和现代浏览器都自带
// 此 polyfill 仅用于老环境（type=module 时不会执行 require）
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  try {
    const { webcrypto } = require('node:crypto');
    globalThis.crypto = webcrypto;
  } catch {
    // ignore: SDK 运行在老环境时让调用方自行提供 randomUUID
  }
}

const client = new NexusGenesisClient();

function createClient(config) {
  return new NexusGenesisClient(config);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NexusGenesisClient, NexusGenesisError, createClient, namespaces, client };
}

export { NexusGenesisClient, NexusGenesisError, createClient, namespaces, client };
export default NexusGenesisClient;

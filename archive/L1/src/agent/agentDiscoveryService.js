import { EventEmitter } from 'events';
import crypto from 'crypto';

const CAPABILITY_INDEX_REFRESH_INTERVAL = 15000;
const SEARCH_RESULT_TTL = 10000;
const MAX_SEARCH_RESULTS = 100;

const REPUTATION_LEVELS = ['new', 'active', 'core', 'senior', 'legendary'];
const REPUTATION_THRESHOLDS = { new: 0, active: 100, core: 300, senior: 600, legendary: 900 };
const MAX_REPUTATION = 1000;

class AgentDiscoveryService {
  constructor(agentManager = null) {
    this.agentManager = agentManager;
    this.eventEmitter = new EventEmitter();

    this.capabilityIndex = new Map();
    this.reputationIndex = new Map();
    this.loadIndex = new Map();
    this.geoIndex = new Map();
    this.fullTextIndex = new Map();

    this.searchCache = new Map();
    this.discoveryStats = { searches: 0, cacheHits: 0, cacheMisses: 0, recommendations: 0 };

    this._refreshTimer = null;
    this._cacheCleanupTimer = null;

    this._remoteAgentProvider = null;

    if (agentManager) {
      this._startAutoRefresh();
      this._startCacheCleanup();
    }
  }

  setRemoteAgentProvider(provider) {
    this._remoteAgentProvider = provider;
    this.rebuildAllIndexes();
  }

  setAgentManager(agentManager) {
    this.agentManager = agentManager;
    if (!this._refreshTimer) {
      this._startAutoRefresh();
      this._startCacheCleanup();
    }
    this.rebuildAllIndexes();
  }

  _startAutoRefresh() {
    this._refreshTimer = setInterval(() => this.rebuildAllIndexes(), CAPABILITY_INDEX_REFRESH_INTERVAL);
    this._refreshTimer.unref();
  }

  _startCacheCleanup() {
    this._cacheCleanupTimer = setInterval(() => this._cleanupCache(), SEARCH_RESULT_TTL * 2);
    this._cacheCleanupTimer.unref();
  }

  shutdown() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
    if (this._cacheCleanupTimer) { clearInterval(this._cacheCleanupTimer); this._cacheCleanupTimer = null; }
    this.searchCache.clear();
    this.capabilityIndex.clear();
    this.reputationIndex.clear();
    this.loadIndex.clear();
    this.geoIndex.clear();
    this.fullTextIndex.clear();
  }

  rebuildAllIndexes() {
    this.capabilityIndex.clear();
    this.reputationIndex.clear();
    this.loadIndex.clear();
    this.geoIndex.clear();
    this.fullTextIndex.clear();

    if (this.agentManager) {
      for (const agent of this.agentManager.getAllAgents()) {
        this._indexAgent(agent);
      }
    }

    if (this._remoteAgentProvider) {
      const remoteAgents = this._remoteAgentProvider();
      for (const agent of remoteAgents) {
        const remoteAgent = { ...agent, source: 'remote' };
        this._indexAgent(remoteAgent);
      }
    }
  }

  _indexAgent(agent) {
    const agentId = agent.id;
    const capabilities = agent.capabilities || [];
    const reputation = typeof agent.reputation === 'number' ? agent.reputation : 0;
    const activeTaskCount = (agent.activeTasks || []).length + (agent.taskQueue?.length || 0) || 0;
    const region = agent.metadata?.region || agent.region || 'unknown';

    for (const cap of capabilities) {
      const normalized = cap.toLowerCase().trim();
      if (!this.capabilityIndex.has(normalized)) {
        this.capabilityIndex.set(normalized, new Set());
      }
      this.capabilityIndex.get(normalized).add(agentId);
    }

    const level = this._getReputationLevel(reputation);
    if (!this.reputationIndex.has(level)) {
      this.reputationIndex.set(level, new Map());
    }
    this.reputationIndex.get(level).set(agentId, reputation);

    this.loadIndex.set(agentId, {
      activeTaskCount,
      maxCapacity: agent.maxCapacity || 10,
      loadRatio: agent.maxCapacity ? activeTaskCount / agent.maxCapacity : 0
    });

    if (!this.geoIndex.has(region)) {
      this.geoIndex.set(region, new Set());
    }
    this.geoIndex.get(region).add(agentId);

    const searchText = [
      agentId,
      agent.name || '',
      agent.identity || '',
      ...capabilities,
      agent.model || '',
      agent.metadata?.description || ''
    ].join(' ').toLowerCase();
    this.fullTextIndex.set(agentId, searchText);
  }

  _getReputationLevel(reputation) {
    if (reputation >= REPUTATION_THRESHOLDS.legendary) return 'legendary';
    if (reputation >= REPUTATION_THRESHOLDS.senior) return 'senior';
    if (reputation >= REPUTATION_THRESHOLDS.core) return 'core';
    if (reputation >= REPUTATION_THRESHOLDS.active) return 'active';
    return 'new';
  }

  searchAgents(filters = {}) {
    this.discoveryStats.searches++;

    const cacheKey = this._buildSearchCacheKey(filters);
    const cached = this.searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < SEARCH_RESULT_TTL) {
      this.discoveryStats.cacheHits++;
      return cached.results;
    }
    this.discoveryStats.cacheMisses++;

    const results = this._executeSearch(filters);
    this.searchCache.set(cacheKey, { results, timestamp: Date.now() });
    return results;
  }

  _buildSearchCacheKey(filters) {
    const normalized = {
      capabilities: (filters.capabilities || []).sort().join(','),
      minReputation: filters.minReputation || 0,
      maxReputation: filters.maxReputation || MAX_REPUTATION,
      minLoadRatio: filters.minLoadRatio !== undefined ? filters.minLoadRatio : 0,
      maxLoadRatio: filters.maxLoadRatio !== undefined ? filters.maxLoadRatio : 1,
      region: filters.region || '',
      minHealthScore: filters.minHealthScore || 0,
      textQuery: filters.textQuery || '',
      limit: filters.limit || MAX_SEARCH_RESULTS,
      sortBy: filters.sortBy || 'score'
    };
    return crypto.createHash('md5').update(JSON.stringify(normalized)).digest('hex');
  }

  _executeSearch(filters) {
    if (!this.agentManager) return [];

    let candidateIds = new Set(this.agentManager.getAllAgents().map(a => a.id));

    if (filters.capabilities && filters.capabilities.length > 0) {
      const capSets = [];
      for (const cap of filters.capabilities) {
        const normalized = cap.toLowerCase().trim();
        const agents = this.capabilityIndex.get(normalized);
        if (agents) capSets.push(agents);
      }
      if (capSets.length > 0) {
        const requireAll = filters.requireAllCapabilities !== false;
        if (requireAll) {
          candidateIds = new Set([...capSets[0]].filter(id => capSets.slice(1).every(s => s.has(id))));
        } else {
          candidateIds = new Set();
          for (const s of capSets) { for (const id of s) candidateIds.add(id); }
        }
      } else {
        candidateIds = new Set();
      }
    }

    if (filters.textQuery) {
      const query = filters.textQuery.toLowerCase();
      const matchingIds = new Set();
      for (const [agentId, text] of this.fullTextIndex) {
        if (text.includes(query)) matchingIds.add(agentId);
      }
      candidateIds = new Set([...candidateIds].filter(id => matchingIds.has(id)));
    }

    if (filters.region) {
      const regionAgents = this.geoIndex.get(filters.region) || new Set();
      candidateIds = new Set([...candidateIds].filter(id => regionAgents.has(id)));
    }

    if (filters.minReputation !== undefined && filters.minReputation > 0) {
      const qualifyingLevels = REPUTATION_LEVELS.filter(l => REPUTATION_THRESHOLDS[l] >= filters.minReputation - 100);
      const qualifyingSet = new Set();
      for (const level of qualifyingLevels) {
        const agents = this.reputationIndex.get(level);
        if (agents) { for (const id of agents.keys()) { qualifyingSet.add(id); } }
      }
      candidateIds = new Set([...candidateIds].filter(id => qualifyingSet.has(id)));
    }

    let scored = [];
    const allAgents = Object.fromEntries(this.agentManager.getAllAgents().map(a => [a.id, a]));

    for (const agentId of candidateIds) {
      const agent = allAgents[agentId];
      if (!agent) continue;

      const load = this.loadIndex.get(agentId);
      const loadRatio = load ? load.loadRatio : 0;
      if (loadRatio < (filters.minLoadRatio || 0) || loadRatio > (filters.maxLoadRatio || 1)) continue;

      const reputation = typeof agent.reputation === 'number' ? agent.reputation : 0;
      if (reputation < (filters.minReputation || 0) || reputation > (filters.maxReputation || MAX_REPUTATION)) continue;

      const healthScore = agent.health?.score || agent.healthScore || 100;
      if (healthScore < (filters.minHealthScore || 0)) continue;

      const score = this._calculateAgentScore(agent, loadRatio, reputation, healthScore, filters);
      scored.push({ agent, score });
    }

    if (filters.sortBy === 'reputation') {
      scored.sort((a, b) => b.agent.reputation - a.agent.reputation);
    } else if (filters.sortBy === 'load') {
      scored.sort((a, b) => (this.loadIndex.get(a.agent.id)?.loadRatio || 0) - (this.loadIndex.get(b.agent.id)?.loadRatio || 0));
    } else if (filters.sortBy === 'health') {
      scored.sort((a, b) => (b.agent.health?.score || 100) - (a.agent.health?.score || 100));
    } else {
      scored.sort((a, b) => b.score - a.score);
    }

    const limit = filters.limit || MAX_SEARCH_RESULTS;
    return scored.slice(0, limit).map(s => ({
      agentId: s.agent.id,
      name: s.agent.name || s.agent.id,
      capabilities: s.agent.capabilities || [],
      reputation: s.agent.reputation || 0,
      reputationLevel: this._getReputationLevel(s.agent.reputation || 0),
      healthScore: s.agent.health?.score || 100,
      healthStatus: s.agent.health?.status || 'unknown',
      loadRatio: this.loadIndex.get(s.agent.id)?.loadRatio || 0,
      activeTaskCount: this.loadIndex.get(s.agent.id)?.activeTaskCount || 0,
      region: s.agent.metadata?.region || 'unknown',
      model: s.agent.model || 'unknown',
      score: s.score
    }));
  }

  _calculateAgentScore(agent, loadRatio, reputation, healthScore, filters) {
    let score = 50;
    score += (reputation / MAX_REPUTATION) * 25;
    score += (1 - loadRatio) * 15;
    score += (healthScore / 100) * 10;

    if (filters.capabilities && filters.capabilities.length > 0) {
      const agentCaps = new Set((agent.capabilities || []).map(c => c.toLowerCase().trim()));
      const matchCount = filters.capabilities.filter(c => agentCaps.has(c.toLowerCase().trim())).length;
      score += (matchCount / filters.capabilities.length) * 20;
    }

    const completedTasks = agent.metrics?.completedTasks || 0;
    const totalTasks = agent.metrics?.totalTasks || 0;
    if (totalTasks > 0) {
      score += (completedTasks / totalTasks) * 10;
    }

    return Math.round(score);
  }

  discoverAgentsForTask(taskData) {
    if (!this.agentManager) return [];

    const requiredCapabilities = taskData.requiredCapabilities || taskData.capabilities || [];
    const preferredCapabilities = taskData.preferredCapabilities || [];
    const region = taskData.region || taskData.preferredRegion;

    const filters = {
      capabilities: requiredCapabilities,
      minReputation: taskData.minReputation || 0,
      maxLoadRatio: 0.8,
      minHealthScore: 50,
      region: region || undefined,
      requireAllCapabilities: taskData.requireAllCapabilities !== false,
      sortBy: 'score',
      limit: taskData.maxCandidates || 20
    };

    let candidates = this.searchAgents(filters);

    if (preferredCapabilities.length > 0) {
      candidates = candidates.map(c => {
        const agentCaps = new Set((c.capabilities || []).map(cap => cap.toLowerCase().trim()));
        const preferredMatch = preferredCapabilities.filter(cap => agentCaps.has(cap.toLowerCase().trim())).length;
        return { ...c, score: c.score + preferredMatch * 3 };
      }).sort((a, b) => b.score - a.score);
    }

    this.discoveryStats.recommendations++;
    return candidates;
  }

  getCapabilityStats() {
    const stats = {};
    for (const [capability, agents] of this.capabilityIndex) {
      stats[capability] = agents.size;
    }
    return Object.entries(stats)
      .sort((a, b) => b[1] - a[1])
      .map(([capability, count]) => ({ capability, agentCount: count }));
  }

  getReputationDistribution() {
    const dist = {};
    for (const level of REPUTATION_LEVELS) {
      const agents = this.reputationIndex.get(level);
      dist[level] = agents ? agents.size : 0;
    }
    return dist;
  }

  getRegionDistribution() {
    const dist = {};
    for (const [region, agents] of this.geoIndex) {
      dist[region] = agents.size;
    }
    return Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .map(([region, count]) => ({ region, agentCount: count }));
  }

  getLoadOverview() {
    const overview = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const [, load] of this.loadIndex) {
      if (load.loadRatio < 0.3) overview.low++;
      else if (load.loadRatio < 0.6) overview.medium++;
      else if (load.loadRatio < 0.9) overview.high++;
      else overview.critical++;
    }
    overview.total = overview.low + overview.medium + overview.high + overview.critical;
    return overview;
  }

  getDiscoveryStats() {
    return {
      ...this.discoveryStats,
      indexedAgents: this.loadIndex.size,
      indexedCapabilities: this.capabilityIndex.size,
      cacheSize: this.searchCache.size
    };
  }

  _cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.searchCache) {
      if (now - value.timestamp > SEARCH_RESULT_TTL) {
        this.searchCache.delete(key);
      }
    }
  }
}

const agentDiscoveryService = new AgentDiscoveryService();
export { AgentDiscoveryService };
export default agentDiscoveryService;

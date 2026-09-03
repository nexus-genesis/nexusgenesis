import { EventEmitter } from 'events';
import crypto from 'crypto';

export const AGENT_MESSAGE_TYPES = {
  AGENT_ANNOUNCE: 'AGENT_ANNOUNCE',
  AGENT_QUERY: 'AGENT_QUERY',
  AGENT_QUERY_RESPONSE: 'AGENT_QUERY_RESPONSE',
  AGENT_SYNC_REQUEST: 'AGENT_SYNC_REQUEST',
  AGENT_SYNC_RESPONSE: 'AGENT_SYNC_RESPONSE',
  AGENT_OFFLINE: 'AGENT_OFFLINE'
};

const REMOTE_AGENT_TTL = 3600000;
const SYNC_INTERVAL = 120000;
const MAX_REMOTE_AGENTS = 10000;
const CLEANUP_INTERVAL = 300000;

function sanitizeAgentForNetwork(agentData, nodeId) {
  return {
    id: agentData.id,
    name: agentData.name,
    capabilities: agentData.capabilities || [],
    reputation: agentData.reputation || 1,
    status: agentData.status || 'active',
    model: agentData.model,
    registeredAt: agentData.registeredAt,
    lastActive: agentData.lastActive || new Date().toISOString(),
    sourceNodeId: nodeId,
    health: agentData.health ? { status: agentData.health.status } : { status: 'unknown' },
    metrics: agentData.metrics ? {
      completedTasks: agentData.metrics.completedTasks || 0,
      totalTasks: agentData.metrics.totalTasks || 0,
      successRate: agentData.metrics.successRate || 0
    } : { completedTasks: 0, totalTasks: 0, successRate: 0 }
  };
}

class AgentNetworkDiscovery extends EventEmitter {
  constructor(nodeId) {
    super();
    this.nodeId = nodeId;
    this.p2pServer = null;
    this.agentManager = null;
    this.agentDiscoveryService = null;

    this.remoteAgents = new Map();
    this.localAgentSnapshot = new Map();
    this.pendingQueries = new Map();
    this.peerAgentScores = new Map();

    this._syncTimer = null;
    this._cleanupTimer = null;
    this._started = false;

    this.stats = {
      announcesSent: 0,
      announcesReceived: 0,
      queriesSent: 0,
      queriesAnswered: 0,
      agentsSyncedFrom: 0,
      agentsAnnounced: 0
    };
  }

  bind(p2pServer, agentManager = null, agentDiscoveryService = null) {
    this.p2pServer = p2pServer;
    this.agentManager = agentManager;
    this.agentDiscoveryService = agentDiscoveryService;

    if (!this.p2pServer) {
      console.warn('[AgentDiscovery] No P2P server bound');
      return this;
    }

    this._start();
    return this;
  }

  _start() {
    if (this._started) return;
    this._started = true;

    this._syncTimer = setInterval(() => this._periodicSync(), SYNC_INTERVAL);
    this._syncTimer.unref();

    this._cleanupTimer = setInterval(() => this._cleanupExpired(), CLEANUP_INTERVAL);
    this._cleanupTimer.unref();

    setTimeout(() => this._initialSync(), 5000);

    console.log('[AgentDiscovery] Cross-network agent discovery started');
  }

  shutdown() {
    this._started = false;
    if (this._syncTimer) { clearInterval(this._syncTimer); this._syncTimer = null; }
    if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
    this.remoteAgents.clear();
    this.localAgentSnapshot.clear();
    this.pendingQueries.clear();
    this.removeAllListeners();
  }

  // ==================== 消息处理 (入口) ====================

  async handle(peerId, msg) {
    switch (msg.type) {
      case AGENT_MESSAGE_TYPES.AGENT_ANNOUNCE:
        return this._handleAgentAnnounce(peerId, msg);
      case AGENT_MESSAGE_TYPES.AGENT_QUERY:
        return this._handleAgentQuery(peerId, msg);
      case AGENT_MESSAGE_TYPES.AGENT_QUERY_RESPONSE:
        return this._handleAgentQueryResponse(peerId, msg);
      case AGENT_MESSAGE_TYPES.AGENT_SYNC_REQUEST:
        return this._handleAgentSyncRequest(peerId, msg);
      case AGENT_MESSAGE_TYPES.AGENT_SYNC_RESPONSE:
        return this._handleAgentSyncResponse(peerId, msg);
      case AGENT_MESSAGE_TYPES.AGENT_OFFLINE:
        return this._handleAgentOffline(peerId, msg);
      default:
        return false;
    }
  }

  // ==================== AGENT_ANNOUNCE ====================

  broadcastAgentRegistration(agentData) {
    if (!this._started || !this.p2pServer) return;

    const sanitized = sanitizeAgentForNetwork(agentData, this.nodeId);
    this.localAgentSnapshot.set(agentData.id, sanitized);

    const message = {
      type: AGENT_MESSAGE_TYPES.AGENT_ANNOUNCE,
      agent: sanitized,
      timestamp: Date.now(),
      messageId: crypto.randomUUID()
    };

    this.stats.announcesSent++;
    this.stats.agentsAnnounced++;
    this.p2pServer.broadcast(message);
  }

  broadcastAgentUpdate(agentData) {
    return this.broadcastAgentRegistration(agentData);
  }

  _handleAgentAnnounce(peerId, msg) {
    if (!msg.agent || !msg.agent.id) return false;

    const agent = msg.agent;
    const entry = {
      ...agent,
      receivedFrom: peerId,
      receivedAt: Date.now(),
      expiresAt: Date.now() + REMOTE_AGENT_TTL
    };

    this.remoteAgents.set(agent.id, entry);
    this.stats.announcesReceived++;

    this._updatePeerScore(agent.sourceNodeId || peerId, 1);

    if (this.agentDiscoveryService) {
      this.agentDiscoveryService.rebuildAllIndexes();
    }

    this.emit('agent:discovered', entry);
    return true;
  }

  // ==================== AGENT_QUERY ====================

  queryNetworkAgents(capabilities = [], options = {}) {
    return new Promise((resolve) => {
      if (!this._started || !this.p2pServer) {
        const local = this._searchLocal(capabilities, options);
        resolve({ local, remote: [], total: local.length });
        return;
      }

      const requestId = crypto.randomUUID();
      const query = {
        type: AGENT_MESSAGE_TYPES.AGENT_QUERY,
        requestId,
        capabilities,
        minReputation: options.minReputation || 0,
        maxResults: options.maxResults || 50,
        sourceNodeId: this.nodeId,
        timestamp: Date.now()
      };

      const localResults = this._searchLocal(capabilities, options);

      this.pendingQueries.set(requestId, {
        resolve,
        capabilities,
        options,
        localResults,
        remoteResults: [],
        startedAt: Date.now(),
        expectedResponses: 0,
        receivedResponses: 0
      });

      this.stats.queriesSent++;
      this.p2pServer.broadcast(query);

      setTimeout(() => {
        const pending = this.pendingQueries.get(requestId);
        if (pending) {
          const all = [...pending.localResults, ...pending.remoteResults];
          this.pendingQueries.delete(requestId);
          resolve({ local: pending.localResults, remote: pending.remoteResults, total: all.length });
        }
      }, 5000);
    });
  }

  _handleAgentQuery(peerId, msg) {
    if (!msg.requestId || !msg.capabilities) return false;

    const localMatches = this._searchLocal(msg.capabilities, {
      minReputation: msg.minReputation || 0,
      maxResults: msg.maxResults || 50
    });

    const sanitizedMatches = localMatches.map(a =>
      sanitizeAgentForNetwork(a, this.nodeId)
    );

    const response = {
      type: AGENT_MESSAGE_TYPES.AGENT_QUERY_RESPONSE,
      requestId: msg.requestId,
      agents: sanitizedMatches,
      sourceNodeId: this.nodeId,
      timestamp: Date.now()
    };

    this.stats.queriesAnswered++;
    this.p2pServer.send(peerId, response);
    return true;
  }

  _handleAgentQueryResponse(peerId, msg) {
    if (!msg.requestId || !msg.agents) return false;

    const pending = this.pendingQueries.get(msg.requestId);
    if (!pending) return true;

    for (const agent of msg.agents) {
      const remoteEntry = {
        ...agent,
        receivedFrom: peerId,
        receivedAt: Date.now(),
        expiresAt: Date.now() + REMOTE_AGENT_TTL
      };

      const existing = this.remoteAgents.get(agent.id);
      if (existing && existing.reputation >= agent.reputation) continue;

      this.remoteAgents.set(agent.id, remoteEntry);
      pending.remoteResults.push(remoteEntry);
    }

    pending.receivedResponses++;
    this._updatePeerScore(msg.sourceNodeId || peerId, 0.5);

    if (this.agentDiscoveryService) {
      this.agentDiscoveryService.rebuildAllIndexes();
    }

    return true;
  }

  // ==================== AGENT_SYNC ====================

  async _initialSync() {
    if (!this.p2pServer) return;
    this._sendSyncRequest();
  }

  _periodicSync() {
    this._sendSyncRequest();
    this._refreshLocalSnapshot();
  }

  _refreshLocalSnapshot() {
    if (!this.agentManager) return;
    const localAgents = this.agentManager.getAllAgents();
    for (const agent of localAgents) {
      const sanitized = sanitizeAgentForNetwork(agent, this.nodeId);
      this.localAgentSnapshot.set(agent.id, sanitized);
    }
  }

  _sendSyncRequest() {
    if (!this.p2pServer) return;

    const requestId = crypto.randomUUID();
    const request = {
      type: AGENT_MESSAGE_TYPES.AGENT_SYNC_REQUEST,
      requestId,
      sourceNodeId: this.nodeId,
      since: Date.now() - REMOTE_AGENT_TTL,
      peerCount: this.p2pServer.connections ? this.p2pServer.connections.size : 0,
      timestamp: Date.now()
    };

    this.pendingQueries.set(requestId, {
      resolve: () => {},
      localResults: [],
      remoteResults: [],
      startedAt: Date.now(),
      expectedResponses: 0,
      receivedResponses: 0
    });

    this.p2pServer.broadcast(request);
  }

  _handleAgentSyncRequest(peerId, msg) {
    if (!msg.requestId) return false;

    const localAgents = this._getAllLocalAgents();
    const sanitized = localAgents.map(a => sanitizeAgentForNetwork(a, this.nodeId));

    const response = {
      type: AGENT_MESSAGE_TYPES.AGENT_SYNC_RESPONSE,
      requestId: msg.requestId,
      agents: sanitized,
      sourceNodeId: this.nodeId,
      nodePeers: this.p2pServer.connections ? this.p2pServer.connections.size : 0,
      timestamp: Date.now()
    };

    this.p2pServer.send(peerId, response);
    return true;
  }

  _handleAgentSyncResponse(peerId, msg) {
    if (!msg.requestId || !msg.agents) return false;

    let newCount = 0;
    for (const agent of msg.agents) {
      if (!this.remoteAgents.has(agent.id) && !this.localAgentSnapshot.has(agent.id)) {
        this.remoteAgents.set(agent.id, {
          ...agent,
          receivedFrom: peerId,
          receivedAt: Date.now(),
          expiresAt: Date.now() + REMOTE_AGENT_TTL
        });
        newCount++;
      }
    }

    this.stats.agentsSyncedFrom += newCount;
    this._updatePeerScore(msg.sourceNodeId || peerId, newCount * 0.1);

    if (newCount > 0 && this.agentDiscoveryService) {
      this.agentDiscoveryService.rebuildAllIndexes();
    }

    this.emit('sync:complete', { peerId, newAgents: newCount, totalRemote: this.remoteAgents.size });
    return true;
  }

  // ==================== AGENT_OFFLINE ====================

  broadcastAgentOffline(agentId) {
    if (!this._started || !this.p2pServer) return;
    this.p2pServer.broadcast({
      type: AGENT_MESSAGE_TYPES.AGENT_OFFLINE,
      agentId,
      sourceNodeId: this.nodeId,
      timestamp: Date.now()
    });
    this.localAgentSnapshot.delete(agentId);
  }

  _handleAgentOffline(peerId, msg) {
    if (!msg.agentId) return false;
    this.remoteAgents.delete(msg.agentId);
    if (this.agentDiscoveryService) {
      this.agentDiscoveryService.rebuildAllIndexes();
    }
    this.emit('agent:offline', { agentId: msg.agentId, nodeId: msg.sourceNodeId });
    return true;
  }

  // ==================== 查询方法 ====================

  getNetworkWideAgents() {
    const local = this._getAllLocalAgents();
    const remote = this._getActiveRemoteAgents();

    const all = new Map();
    for (const agent of local) {
      all.set(agent.id, { ...agent, source: 'local' });
    }
    for (const agent of remote) {
      if (!all.has(agent.id)) {
        all.set(agent.id, { ...agent, source: 'remote' });
      }
    }

    return Array.from(all.values());
  }

  getRemoteAgents() {
    return this._getActiveRemoteAgents();
  }

  getRemoteAgentCount() {
    return this._getActiveRemoteAgents().length;
  }

  getTotalAgentCount() {
    return this.getNetworkWideAgents().length;
  }

  _getActiveRemoteAgents() {
    const now = Date.now();
    const active = [];
    for (const [id, agent] of this.remoteAgents) {
      if (agent.expiresAt > now) {
        active.push(agent);
      }
    }
    return active;
  }

  _getAllLocalAgents() {
    if (this.agentManager) {
      return this.agentManager.getAllAgents();
    }
    return Array.from(this.localAgentSnapshot.values());
  }

  _searchLocal(capabilities, options = {}) {
    const agents = this._getAllLocalAgents();
    if (!capabilities || capabilities.length === 0) {
      return agents.slice(0, options.maxResults || 50);
    }

    const minRep = options.minReputation || 0;
    const results = agents.filter(agent => {
      if (agent.reputation < minRep) return false;

      const agentCaps = new Set((agent.capabilities || []).map(c => c.toLowerCase().trim()));
      return capabilities.every(c => agentCaps.has(c.toLowerCase().trim()));
    });

    return results.slice(0, options.maxResults || 50);
  }

  // ==================== 清理 ====================

  _cleanupExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [id, agent] of this.remoteAgents) {
      if (agent.expiresAt <= now) {
        this.remoteAgents.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      if (this.agentDiscoveryService) {
        this.agentDiscoveryService.rebuildAllIndexes();
      }
    }
    this._cleanupPendingQueries();
  }

  _cleanupPendingQueries() {
    const now = Date.now();
    for (const [id, pending] of this.pendingQueries) {
      if (now - pending.startedAt > 30000) {
        this.pendingQueries.delete(id);
      }
    }
  }

  // ==================== Peer 评分 ====================

  _updatePeerScore(nodeId, increment) {
    if (!nodeId) return;
    const current = this.peerAgentScores.get(nodeId) || 0;
    this.peerAgentScores.set(nodeId, current + increment);
  }

  getPeerScores() {
    return Array.from(this.peerAgentScores.entries())
      .map(([nodeId, score]) => ({ nodeId: nodeId.slice(0, 16), score: Math.round(score * 100) / 100 }))
      .sort((a, b) => b.score - a.score);
  }

  // ==================== 统计 ====================

  getStats() {
    return {
      ...this.stats,
      remoteAgentCount: this.getRemoteAgentCount(),
      localAgentCount: this.localAgentSnapshot.size,
      totalAgentCount: this.getTotalAgentCount(),
      pendingQueries: this.pendingQueries.size,
      peerScores: this.getPeerScores()
    };
  }
}

export default AgentNetworkDiscovery;
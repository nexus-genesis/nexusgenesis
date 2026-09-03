/**
 * 跨网络 Agent 发现协议测试
 */

import assert from 'assert';
import { test } from 'node:test';
import AgentNetworkDiscovery, { AGENT_MESSAGE_TYPES } from '../src/p2p/AgentNetworkDiscovery.js';

const NODE_A = 'node-a-001-hash-fixed-for-testing-purposes';
const NODE_B = 'node-b-002-hash-fixed-for-testing-purposes';

function createMockP2PServer() {
  const peers = new Map();
  const sentMessages = [];
  return {
    connections: peers,
    sentMessages,
    broadcast(message) {
      for (const [peerId, conn] of peers) {
        conn.receiveMessage(message);
      }
      sentMessages.push(message);
    },
    send(peerId, message) {
      sentMessages.push({ peerId, message });
      const conn = peers.get(peerId);
      if (conn) conn.receiveMessage(message);
    },
    addPeer(peerId, conn) {
      peers.set(peerId, conn);
    }
  };
}

function createMockAgentManager(agents = []) {
  return {
    getAllAgents() {
      return agents;
    }
  };
}

function createMockAgentDiscoveryService() {
  let rebuildCount = 0;
  return {
    rebuildCount: () => rebuildCount,
    rebuildAllIndexes() {
      rebuildCount++;
    }
  };
}

function createAgentData(id, name, capabilities, reputation = 1) {
  return {
    id,
    name,
    capabilities,
    reputation,
    status: 'active',
    registeredAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    health: { status: 'healthy' },
    metrics: { completedTasks: 5, totalTasks: 10, successRate: 0.5 }
  };
}

// ==================== 模块初始化 ====================

test('Test 1: AgentNetworkDiscovery initialization', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  assert.strictEqual(discovery.nodeId, NODE_A);
  assert.strictEqual(discovery._started, false);
  assert.strictEqual(discovery.remoteAgents.size, 0);
  assert.strictEqual(discovery.p2pServer, null);

  console.log('✅ Initialization works');
});

test('Test 2: Bind to P2P server starts discovery', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();

  discovery.bind(p2p, null, null);
  assert.strictEqual(discovery._started, true);
  assert.strictEqual(discovery.p2pServer, p2p);

  discovery.shutdown();
  assert.strictEqual(discovery._started, false);

  console.log('✅ Bind and shutdown works');
});

// ==================== AGENT_ANNOUNCE ====================

test('Test 3: broadcastAgentRegistration sends AGENT_ANNOUNCE', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  discovery.bind(p2p, null, null);

  const agent = createAgentData('agent-001', 'CodeBot', ['coding', 'debugging'], 5);
  discovery.broadcastAgentRegistration(agent);

  const msg = p2p.sentMessages[0];
  assert.strictEqual(msg.type, AGENT_MESSAGE_TYPES.AGENT_ANNOUNCE);
  assert.strictEqual(msg.agent.id, 'agent-001');
  assert.strictEqual(msg.agent.sourceNodeId, NODE_A);
  assert.deepStrictEqual(msg.agent.capabilities, ['coding', 'debugging']);
  assert.strictEqual(msg.agent.reputation, 5);
  assert.ok(discovery.localAgentSnapshot.has('agent-001'));
  assert.strictEqual(discovery.stats.announcesSent, 1);

  discovery.shutdown();
  console.log('✅ AGENT_ANNOUNCE broadcast works');
});

test('Test 4: _handleAgentAnnounce adds remote agent', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  const mockDs = createMockAgentDiscoveryService();
  discovery.bind(p2p, null, mockDs);

  const agent = createAgentData('agent-remote', 'RemoteBot', ['nlp', 'translation'], 10);
  agent.sourceNodeId = NODE_B;

  const result = discovery._handleAgentAnnounce('peer-123', {
    type: AGENT_MESSAGE_TYPES.AGENT_ANNOUNCE,
    agent
  });

  assert.strictEqual(result, true);
  assert.ok(discovery.remoteAgents.has('agent-remote'));
  assert.strictEqual(discovery.stats.announcesReceived, 1);
  assert.strictEqual(mockDs.rebuildCount(), 1);

  const stored = discovery.remoteAgents.get('agent-remote');
  assert.strictEqual(stored.receivedFrom, 'peer-123');
  assert.ok(stored.expiresAt > Date.now());

  discovery.shutdown();
  console.log('✅ AGENT_ANNOUNCE receive works');
});

test('Test 5: _handleAgentAnnounce rejects invalid agent', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  discovery.bind(p2p, null, null);

  assert.strictEqual(discovery._handleAgentAnnounce('peer', { type: 'AGENT_ANNOUNCE' }), false);
  assert.strictEqual(discovery._handleAgentAnnounce('peer', { type: 'AGENT_ANNOUNCE', agent: {} }), false);
  assert.strictEqual(discovery.remoteAgents.size, 0);

  discovery.shutdown();
  console.log('✅ Invalid agent announce rejection works');
});

// ==================== AGENT_QUERY ====================

test('Test 6: queryNetworkAgents searches local agents', async () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  const agents = [
    createAgentData('a1', 'Coder', ['coding', 'js']),
    createAgentData('a2', 'Designer', ['design', 'ui']),
    createAgentData('a3', 'FullStack', ['coding', 'design'], 5),
  ];
  const mgr = createMockAgentManager(agents);
  discovery.bind(p2p, mgr, null);

  const result = await discovery.queryNetworkAgents(['coding']);
  assert.strictEqual(result.local.length, 2);

  const result2 = await discovery.queryNetworkAgents(['design', 'ui']);
  assert.strictEqual(result2.local.length, 1);

  const result3 = await discovery.queryNetworkAgents(['nonexistent']);
  assert.strictEqual(result3.local.length, 0);

  discovery.shutdown();
  console.log('✅ Local agent query works');
});

test('Test 7: _handleAgentQuery responds with matching agents', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  const agents = [
    createAgentData('a1', 'Coder', ['coding']),
    createAgentData('a2', 'Designer', ['design']),
  ];
  const mgr = createMockAgentManager(agents);
  discovery.bind(p2p, mgr, null);

  const result = discovery._handleAgentQuery('peer-123', {
    type: AGENT_MESSAGE_TYPES.AGENT_QUERY,
    requestId: 'req-001',
    capabilities: ['coding'],
    minReputation: 0,
    maxResults: 50
  });

  assert.strictEqual(result, true);
  assert.strictEqual(discovery.stats.queriesAnswered, 1);

  const response = p2p.sentMessages[0];
  assert.strictEqual(response.message.type, AGENT_MESSAGE_TYPES.AGENT_QUERY_RESPONSE);
  assert.strictEqual(response.message.requestId, 'req-001');
  assert.strictEqual(response.message.agents.length, 1);
  assert.strictEqual(response.message.agents[0].id, 'a1');

  discovery.shutdown();
  console.log('✅ AGENT_QUERY response works');
});

// ==================== AGENT_SYNC ====================

test('Test 8: _handleAgentSyncRequest responds with all local agents', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  const agents = [
    createAgentData('a1', 'CodeBot', ['coding']),
    createAgentData('a2', 'ChatBot', ['nlp']),
    createAgentData('a3', 'Analyzer', ['data']),
  ];
  const mgr = createMockAgentManager(agents);
  discovery.bind(p2p, mgr, null);

  const result = discovery._handleAgentSyncRequest('peer-123', {
    type: AGENT_MESSAGE_TYPES.AGENT_SYNC_REQUEST,
    requestId: 'sync-001'
  });

  assert.strictEqual(result, true);
  const response = p2p.sentMessages[0];
  assert.strictEqual(response.message.type, AGENT_MESSAGE_TYPES.AGENT_SYNC_RESPONSE);
  assert.strictEqual(response.message.requestId, 'sync-001');
  assert.strictEqual(response.message.agents.length, 3);

  const agentIds = response.message.agents.map(a => a.id);
  assert.deepStrictEqual(agentIds, ['a1', 'a2', 'a3']);

  discovery.shutdown();
  console.log('✅ AGENT_SYNC request/response works');
});

test('Test 9: _handleAgentSyncResponse adds only new agents', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  const mockDs = createMockAgentDiscoveryService();
  const localAgents = [
    createAgentData('local-1', 'LocalBot', ['local']),
  ];
  const mgr = createMockAgentManager(localAgents);
  discovery.bind(p2p, mgr, mockDs);

  discovery._refreshLocalSnapshot();

  const result = discovery._handleAgentSyncResponse('peer-123', {
    type: AGENT_MESSAGE_TYPES.AGENT_SYNC_RESPONSE,
    requestId: 'sync-001',
    agents: [
      createAgentData('local-1', 'LocalBot', ['local']),
      createAgentData('remote-1', 'RemoteBot', ['remote']),
      createAgentData('remote-2', 'RemoteBot2', ['remote']),
    ],
    sourceNodeId: NODE_B
  });

  assert.strictEqual(result, true);
  assert.strictEqual(discovery.stats.agentsSyncedFrom, 2);
  assert.ok(discovery.remoteAgents.has('remote-1'));
  assert.ok(discovery.remoteAgents.has('remote-2'));
  assert.strictEqual(mockDs.rebuildCount(), 1);

  discovery.shutdown();
  console.log('✅ AGENT_SYNC deduplication works');
});

// ==================== getNetworkWideAgents ====================

test('Test 10: getNetworkWideAgents merges local and remote', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  const localAgents = [
    createAgentData('local-1', 'LocalBot', ['local']),
  ];
  const mgr = createMockAgentManager(localAgents);
  discovery.bind(p2p, mgr, null);

  discovery.remoteAgents.set('remote-1', {
    ...createAgentData('remote-1', 'RemoteBot', ['remote']),
    receivedFrom: 'peer-1',
    receivedAt: Date.now(),
    expiresAt: Date.now() + 3600000
  });

  const all = discovery.getNetworkWideAgents();
  assert.strictEqual(all.length, 2);

  const localInAll = all.find(a => a.id === 'local-1');
  assert.strictEqual(localInAll.source, 'local');

  const remoteInAll = all.find(a => a.id === 'remote-1');
  assert.strictEqual(remoteInAll.source, 'remote');

  discovery.shutdown();
  console.log('✅ Network-wide agent merge works');
});

test('Test 11: getNetworkWideAgents prefers local over remote for duplicates', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  const localAgents = [
    createAgentData('dup-1', 'LocalDup', ['shared'], 10),
  ];
  const mgr = createMockAgentManager(localAgents);
  discovery.bind(p2p, mgr, null);

  discovery.remoteAgents.set('dup-1', {
    ...createAgentData('dup-1', 'RemoteDup', ['shared'], 3),
    receivedFrom: 'peer-1',
    receivedAt: Date.now(),
    expiresAt: Date.now() + 3600000
  });

  const all = discovery.getNetworkWideAgents();
  assert.strictEqual(all.length, 1);

  const merged = all[0];
  assert.strictEqual(merged.source, 'local');
  assert.strictEqual(merged.name, 'LocalDup');
  assert.strictEqual(merged.reputation, 10);

  discovery.shutdown();
  console.log('✅ Local agent takes priority over remote duplicate');
});

// ==================== 清理机制 ====================

test('Test 12: _cleanupExpired removes stale remote agents', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  const mockDs = createMockAgentDiscoveryService();
  discovery.bind(p2p, null, mockDs);

  discovery.remoteAgents.set('fresh-1', {
    ...createAgentData('fresh-1', 'Fresh', ['coding']),
    receivedFrom: 'peer-1',
    receivedAt: Date.now(),
    expiresAt: Date.now() + 3600000
  });

  discovery.remoteAgents.set('stale-1', {
    ...createAgentData('stale-1', 'Stale', ['coding']),
    receivedFrom: 'peer-1',
    receivedAt: Date.now() - 7200000,
    expiresAt: Date.now() - 1000
  });

  discovery._cleanupExpired();

  assert.ok(discovery.remoteAgents.has('fresh-1'));
  assert.ok(!discovery.remoteAgents.has('stale-1'));
  assert.strictEqual(discovery.remoteAgents.size, 1);
  assert.strictEqual(mockDs.rebuildCount(), 1);

  discovery.shutdown();
  console.log('✅ Expired agent cleanup works');
});

// ==================== AGENT_OFFLINE ====================

test('Test 13: broadcastAgentOffline and receive', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  discovery.bind(p2p, null, null);

  discovery.localAgentSnapshot.set('agent-x', { id: 'agent-x' });
  discovery.broadcastAgentOffline('agent-x');

  assert.ok(!discovery.localAgentSnapshot.has('agent-x'));

  const result = discovery._handleAgentOffline('peer-123', {
    type: AGENT_MESSAGE_TYPES.AGENT_OFFLINE,
    agentId: 'remote-y',
    sourceNodeId: NODE_B
  });

  assert.strictEqual(result, true);
  assert.ok(!discovery.remoteAgents.has('remote-y'));

  discovery.shutdown();
  console.log('✅ Agent offline broadcast works');
});

// ==================== Peer 评分 ====================

test('Test 14: Peer scores accumulate correctly', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  discovery.bind(p2p, null, null);

  discovery._updatePeerScore('peer-a', 1);
  discovery._updatePeerScore('peer-a', 0.5);
  discovery._updatePeerScore('peer-b', 2);
  discovery._updatePeerScore('peer-a', 3);

  const scores = discovery.getPeerScores();
  assert.strictEqual(scores.length, 2);

  assert.strictEqual(scores[0].score, 4.5);
  assert.strictEqual(scores[1].score, 2);

  discovery.shutdown();
  console.log('✅ Peer scoring works');
});

// ==================== Stats 统计 ====================

test('Test 15: Stats track all metrics', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  discovery.bind(p2p, null, null);

  discovery.stats.announcesSent = 3;
  discovery.stats.announcesReceived = 5;
  discovery.stats.queriesSent = 2;
  discovery.stats.queriesAnswered = 4;

  const stats = discovery.getStats();
  assert.strictEqual(stats.announcesSent, 3);
  assert.strictEqual(stats.announcesReceived, 5);
  assert.strictEqual(stats.queriesSent, 2);
  assert.strictEqual(stats.queriesAnswered, 4);
  assert.strictEqual(stats.remoteAgentCount, 0);
  assert.strictEqual(stats.pendingQueries, 0);

  discovery.shutdown();
  console.log('✅ Stats tracking works');
});

// ==================== 事件发射 ====================

test('Test 16: Emits agent:discovered event on announce', (t, done) => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  discovery.bind(p2p, null, null);

  discovery.on('agent:discovered', (entry) => {
    assert.strictEqual(entry.id, 'event-agent');
    assert.strictEqual(entry.name, 'EventBot');
    done();
  });

  discovery._handleAgentAnnounce('peer-xyz', {
    type: AGENT_MESSAGE_TYPES.AGENT_ANNOUNCE,
    agent: createAgentData('event-agent', 'EventBot', ['events'])
  });

  discovery.shutdown();
  console.log('✅ agent:discovered event emitted');
});

test('Test 17: Emits agent:offline event', (t, done) => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  discovery.bind(p2p, null, null);

  discovery.on('agent:offline', (data) => {
    assert.strictEqual(data.agentId, 'bye-agent');
    assert.strictEqual(data.nodeId, NODE_B);
    done();
  });

  discovery._handleAgentOffline('peer-123', {
    type: AGENT_MESSAGE_TYPES.AGENT_OFFLINE,
    agentId: 'bye-agent',
    sourceNodeId: NODE_B
  });

  discovery.shutdown();
  console.log('✅ agent:offline event emitted');
});

// ==================== 边界情况 ====================

test('Test 18: queryNetworkAgents handles empty capabilities', async () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  const agents = [
    createAgentData('a1', 'Bot1', ['x']),
    createAgentData('a2', 'Bot2', ['y']),
    createAgentData('a3', 'Bot3', ['z']),
  ];
  const mgr = createMockAgentManager(agents);
  discovery.bind(p2p, mgr, null);

  const result = await discovery.queryNetworkAgents();
  assert.strictEqual(result.local.length, 3);
  assert.strictEqual(result.total, 3);

  discovery.shutdown();
  console.log('✅ Empty capabilities returns all agents');
});

test('Test 19: Agent data sanitization respects sensitive fields', () => {
  const agent = {
    id: 'sensitive-01',
    name: 'SensitiveBot',
    capabilities: ['hacking'],
    reputation: 5,
    status: 'active',
    wallet: { address: 'secret', privateKey: 'top-secret' },
    secretToken: 'should-not-leak',
    privateData: 'confidential'
  };

  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  discovery.bind(p2p, null, null);

  discovery.broadcastAgentRegistration(agent);
  const msg = p2p.sentMessages[0];

  assert.ok(!msg.agent.wallet, 'Wallet should NOT be exposed');
  assert.ok(!msg.agent.privateKey, 'Private key should NOT be exposed');
  assert.ok(!msg.agent.secretToken, 'Secret token should NOT be exposed');
  assert.strictEqual(msg.agent.id, 'sensitive-01');
  assert.strictEqual(msg.agent.sourceNodeId, NODE_A);

  discovery.shutdown();
  console.log('✅ Sensitive field sanitization works');
});

test('Test 20: Multiple same-agent announces update existing entry', () => {
  const discovery = new AgentNetworkDiscovery(NODE_A);
  const p2p = createMockP2PServer();
  discovery.bind(p2p, null, null);

  const agentV1 = { ...createAgentData('update-me', 'BotV1', ['basic']), reputation: 1, sourceNodeId: NODE_B };
  const agentV2 = { ...createAgentData('update-me', 'BotV2', ['advanced', 'basic']), reputation: 8, sourceNodeId: NODE_B };

  discovery._handleAgentAnnounce('peer-1', { type: AGENT_MESSAGE_TYPES.AGENT_ANNOUNCE, agent: agentV1 });
  discovery._handleAgentAnnounce('peer-1', { type: AGENT_MESSAGE_TYPES.AGENT_ANNOUNCE, agent: agentV2 });

  const stored = discovery.remoteAgents.get('update-me');
  assert.strictEqual(stored.name, 'BotV2');
  assert.strictEqual(stored.reputation, 8);
  assert.deepStrictEqual(stored.capabilities, ['advanced', 'basic']);

  discovery.shutdown();
  console.log('✅ Agent update on re-announce works');
});

// ==================== 完整P2P模拟流 ====================

test('Test 21: Full cross-node agent discovery simulation', () => {
  let announceReceived = 0;
  let syncComplete = 0;

  const discoveryA = new AgentNetworkDiscovery(NODE_A);
  const discoveryB = new AgentNetworkDiscovery(NODE_B);

  const p2pA = createMockP2PServer();
  const p2pB = createMockP2PServer();

  p2pA.addPeer('b', {
    receiveMessage(msg) {
      discoveryB.handle('a', msg);
    }
  });
  p2pB.addPeer('a', {
    receiveMessage(msg) {
      discoveryA.handle('b', msg);
    }
  });

  const localAgentsA = [createAgentData('node-a-1', 'ABot', ['nlp'], 3)];
  const localAgentsB = [createAgentData('node-b-1', 'BBot', ['vision'], 5)];

  const mgrA = createMockAgentManager(localAgentsA);
  const mgrB = createMockAgentManager(localAgentsB);
  const dsA = createMockAgentDiscoveryService();
  const dsB = createMockAgentDiscoveryService();

  discoveryA.on('agent:discovered', () => announceReceived++);
  discoveryA.on('sync:complete', () => syncComplete++);
  discoveryB.on('agent:discovered', () => announceReceived++);
  discoveryB.on('sync:complete', () => syncComplete++);

  discoveryA.bind(p2pA, mgrA, dsA);
  discoveryB.bind(p2pB, mgrB, dsB);

  const announceResult = discoveryA._handleAgentAnnounce('b', {
    type: AGENT_MESSAGE_TYPES.AGENT_ANNOUNCE,
    agent: {
      ...createAgentData('node-b-1', 'BBot', ['vision'], 5),
      sourceNodeId: NODE_B
    }
  });

  assert.strictEqual(announceResult, true);
  assert.ok(discoveryA.remoteAgents.has('node-b-1'));
  assert.strictEqual(announceReceived, 1);

  // Node B announces Node A's agent
  const announceResultB = discoveryB._handleAgentAnnounce('a', {
    type: AGENT_MESSAGE_TYPES.AGENT_ANNOUNCE,
    agent: {
      ...createAgentData('node-a-1', 'ABot', ['nlp'], 3),
      sourceNodeId: NODE_A
    }
  });

  assert.strictEqual(announceResultB, true);
  assert.ok(discoveryB.remoteAgents.has('node-a-1'));
  assert.strictEqual(announceReceived, 2);

  // Verify Node A sees Node B's agent
  assert.strictEqual(discoveryA.getRemoteAgentCount(), 1);
  assert.strictEqual(discoveryB.getRemoteAgentCount(), 1);

  // Verify network-wide view
  const allA = discoveryA.getNetworkWideAgents();
  assert.strictEqual(allA.length, 2);
  assert.ok(allA.some(a => a.id === 'node-a-1' && a.source === 'local'));
  assert.ok(allA.some(a => a.id === 'node-b-1' && a.source === 'remote'));

  discoveryA.shutdown();
  discoveryB.shutdown();

  console.log('✅ Full cross-node simulation works');
});

console.log('\n=== All Cross-Network Agent Discovery Tests Passed ===');
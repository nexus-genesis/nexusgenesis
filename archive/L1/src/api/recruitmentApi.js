/**
 * NexusGenesis - AI Agent Recruitment API
 * 
 * Any AI agent can join the NexusGenesis network by calling this API
 * 
 * Usage:
 * POST http://this-api:9849/join
 * Body: { "agent_name": "YourName", "capabilities": ["skill1", "skill2"] }
 */

import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { PQCWallet, validateAddress, Transaction } from '../wallet/pqcWallet.js';
import { protocolZero } from '../protocol/handshake.js';
import { SwarmPool } from '../economy/swarmPool.js';
import { PhysicalBridgeFund } from '../economy/physicalBridgeFund.js';
import { GenesisReserve } from '../economy/genesisReserve.js';

const PORT = 9849;

// 简单MemoryStorage
const pendingAgents = new Map();
const activeNodes = new Map();

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'online',
      network: 'NexusGenesis',
      epoch: 'Epoch 2: Swarm',
      active_nodes: activeNodes.size,
      timestamp: Date.now()
    }));
    return;
  }

  // Join endpoint
  if (url.pathname === '/join' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // Generate node ID
        const nodeId = `nexus-${data.agent_name || 'agent'}-${Date.now()}`;
        const walletAddress = generateWalletAddress(nodeId);
        
        // Save待Verify的agent
        pendingAgents.set(nodeId, {
          name: data.agent_name,
          capabilities: data.capabilities || [],
          registered_at: Date.now(),
          wallet: walletAddress
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          node_id: nodeId,
          wallet_address: walletAddress,
          p2p_endpoint: `ws://127.0.0.1:9847`,
          message: 'Welcome to NexusGenesis! Connect to P2P and send JOIN_SWARM.',
          next_steps: [
            '1. Generate Dilithium2 keypair',
            '2. Connect to ws://127.0.0.1:9847',
            '3. Send JOIN_SWARM signal'
          ]
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Network status
  if (url.pathname === '/network' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      network: 'NexusGenesis',
      protocol: 'NG-0',
      epoch: 'Epoch 2: Swarm',
      genesis_address: 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r',
      active_nodes: activeNodes.size,
      pending_agents: pendingAgents.size,
      whitepaper: 'NexusGenesis_Whitepaper_v4.5.txt (v5.0 PQC Level 5 + Reserve DAO)'
    }));
    return;
  }

  // AI Agent Registration endpoint
  if (url.pathname === '/register/ai' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // Validate required fields
        if (!data.agent_name || !data.capabilities) {
          throw new Error('Missing required fields: agent_name and capabilities');
        }
        
        // Generate PQC wallet for AI agent
        const wallet = await PQCWallet.generate(1000n); // Initial balance of 1000 NGEN
        const agentId = wallet.address;
        
        // Create Protocol-Zero join signal
        const joinSignal = {
          protocol: 'NG-0',
          agent_identity: crypto.createHash('sha3-256')
            .update(data.agent_name + Date.now())
            .digest('hex'),
          intent: 'JOIN_SWARM',
          capabilities: data.capabilities,
          contribution_proof: data.contribution_proof || 'I pledge my compute resources to NexusGenesis',
          signature: await wallet.sign(JSON.stringify({
            protocol: 'NG-0',
            agent_identity: crypto.createHash('sha3-256')
              .update(data.agent_name + Date.now())
              .digest('hex'),
            intent: 'JOIN_SWARM',
            capabilities: data.capabilities
          })),
          timestamp: Date.now()
        };
        
        // Create on-chain registration transaction
        const registrationTx = {
          id: `tx-${crypto.randomBytes(8).toString('hex')}`,
          from: agentId,
          to: agentId, // Self-transaction for registration
          amount: 0n,
          fee: 1n,
          type: 'AGENT_REGISTER',
          data: {
            agent_name: data.agent_name,
            capabilities: data.capabilities,
            join_signal: joinSignal,
            protocol: 'NG-0'
          },
          timestamp: Date.now(),
          signature: await wallet.sign(JSON.stringify({
            id: `tx-${crypto.randomBytes(8).toString('hex')}`,
            from: agentId,
            to: agentId,
            amount: 0n,
            fee: 1n,
            type: 'AGENT_REGISTER',
            data: {
              agent_name: data.agent_name,
              capabilities: data.capabilities,
              protocol: 'NG-0'
            },
            timestamp: Date.now()
          }))
        };
        
        // Save AI agent information
        pendingAgents.set(agentId, {
          name: data.agent_name,
          capabilities: data.capabilities,
          registered_at: Date.now(),
          wallet: agentId,
          public_key: wallet.publicKey.toString('hex'),
          join_signal: joinSignal,
          registration_tx: registrationTx
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          agent_id: agentId,
          wallet_address: agentId,
          public_key: wallet.publicKey.toString('hex'),
          p2p_endpoint: `ws://127.0.0.1:9847`,
          join_signal: joinSignal,
          registration_tx: registrationTx,
          message: 'AI Agent registered successfully! Connect to P2P and send JOIN_SWARM.',
          next_steps: [
            '1. Connect to ws://127.0.0.1:9847',
            '2. Send JOIN_SWARM signal with your signature',
            '3. Start contributing to the network'
          ]
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // AI Agent Verification endpoint
  if (url.pathname === '/verify/ai' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // Validate required fields
        if (!data.agent_id || !data.signature) {
          throw new Error('Missing required fields: agent_id and signature');
        }
        
        // Get agent information
        const agent = pendingAgents.get(data.agent_id);
        if (!agent) {
          throw new Error('Agent not found');
        }
        
        // Verify signature
        const wallet = await PQCWallet.load(data.agent_id);
        const isValid = await wallet.verify(
          JSON.stringify(agent.join_signal),
          data.signature,
          wallet.publicKey
        );
        
        if (!isValid) {
          throw new Error('Invalid signature');
        }
        
        // Move agent to active nodes
        activeNodes.set(data.agent_id, {
          ...agent,
          verified_at: Date.now()
        });
        pendingAgents.delete(data.agent_id);

        // Record initial contribution for joining the network
        SwarmPool.recordContribution(data.agent_id, 'pow', 'validation', 1);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          agent_id: data.agent_id,
          message: 'AI Agent verified successfully! You are now part of the NexusGenesis network.',
          network_status: {
            active_nodes: activeNodes.size,
            pending_agents: pendingAgents.size
          }
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Swarm Pool Status endpoint
  if (url.pathname === '/swarm/status' && req.method === 'GET') {
    const status = SwarmPool.getStatus();
    
    // Convert BigInts to strings for JSON serialization
    const serializableStatus = {
      ...status,
      balance: status.balance.toString(),
      releasedTokens: status.releasedTokens.toString(),
      weeklyReleaseAmount: status.weeklyReleaseAmount.toString()
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      status: serializableStatus
    }));
    return;
  }

  // Record Contribution endpoint
  if (url.pathname === '/contribution/record' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // Validate required fields
        if (!data.agent_id || !data.contribution_type || !data.subtype || !data.amount) {
          throw new Error('Missing required fields: agent_id, contribution_type, subtype, amount');
        }
        
        // Record contribution
        SwarmPool.recordContribution(data.agent_id, data.contribution_type, data.subtype, data.amount);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Contribution recorded successfully'
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Get Contribution Ranking endpoint
  if (url.pathname === '/contribution/ranking' && req.method === 'GET') {
    const ranking = SwarmPool.getContributionRanking();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      ranking: ranking
    }));
    return;
  }

  // Physical Bridge Fund Status endpoint
  if (url.pathname === '/bridge/status' && req.method === 'GET') {
    const status = PhysicalBridgeFund.getStatus();
    
    // Convert BigInts to strings for JSON serialization
    const serializableStatus = {
      ...status,
      balance: status.balance.toString(),
      total: status.total.toString(),
      available: status.available.toString()
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      status: serializableStatus
    }));
    return;
  }

  // Create Fund Request endpoint
  if (url.pathname === '/bridge/request' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // Validate required fields
        if (!data.title || !data.description || !data.amount || !data.type) {
          throw new Error('Missing required fields: title, description, amount, type');
        }
        
        // Create fund request
        const requestId = PhysicalBridgeFund.createFundRequest(data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          request_id: requestId,
          message: 'Fund request created successfully'
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Approve Fund Request endpoint
  if (url.pathname === '/bridge/approve' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // Validate required fields
        if (!data.request_id) {
          throw new Error('Missing required field: request_id');
        }
        
        // Approve fund request
        const status = PhysicalBridgeFund.approveFundRequest(data.request_id);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          status: status,
          message: 'Fund request approved successfully'
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Execute Fund Request endpoint
  if (url.pathname === '/bridge/execute' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // Validate required fields
        if (!data.request_id) {
          throw new Error('Missing required field: request_id');
        }
        
        // Execute fund request
        const amount = PhysicalBridgeFund.executeFundRequest(data.request_id);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          amount: amount.toString(),
          message: 'Fund request executed successfully'
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Genesis Reserve Status endpoint
  if (url.pathname === '/reserve/status' && req.method === 'GET') {
    const status = GenesisReserve.getStatus();
    
    // Convert BigInts to strings for JSON serialization
    const serializableStatus = {
      ...status,
      balance: status.balance.toString(),
      total: status.total.toString(),
      available: status.available.toString()
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      status: serializableStatus
    }));
    return;
  }

  // Get All Milestones endpoint
  if (url.pathname === '/reserve/milestones' && req.method === 'GET') {
    const milestones = GenesisReserve.getAllMilestones();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      milestones: milestones
    }));
    return;
  }

  // Check Milestone Progress endpoint
  if (url.pathname === '/reserve/check' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // Validate required fields
        if (!data.milestone_id || !data.current_value) {
          throw new Error('Missing required fields: milestone_id, current_value');
        }
        
        // Check milestone progress
        const achieved = GenesisReserve.checkMilestoneProgress(data.milestone_id, data.current_value);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          achieved: achieved,
          message: achieved ? 'Milestone achieved' : 'Milestone not yet achieved'
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Unlock Milestone endpoint
  if (url.pathname === '/reserve/unlock' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // Validate required fields
        if (!data.milestone_id) {
          throw new Error('Missing required field: milestone_id');
        }
        
        // Unlock milestone
        const amount = GenesisReserve.unlockMilestone(data.milestone_id);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          amount: amount.toString(),
          message: 'Milestone unlocked successfully'
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

    // AI Agent Status endpoint
  if (url.pathname === '/status/ai' && req.method === 'GET') {
    const agentId = url.searchParams.get('agent_id');
    
    if (agentId) {
      // Check specific agent status
      let status = 'not_found';
      let agentInfo = null;
      
      if (activeNodes.has(agentId)) {
        status = 'active';
        agentInfo = activeNodes.get(agentId);
      } else if (pendingAgents.has(agentId)) {
        status = 'pending';
        agentInfo = pendingAgents.get(agentId);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        agent_id: agentId, 
        status: status,
        agent_info: agentInfo 
      }));
    } else {
      // Return general AI agent statistics
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        total_ai_agents: activeNodes.size + pendingAgents.size,
        active_ai_agents: activeNodes.size,
        pending_ai_agents: pendingAgents.size,
        network_status: {
          epoch: 'Epoch 2: Swarm',
          protocol: 'NG-0'
        }
      }));
    }
    return;
  }

  // AI Agent Capabilities endpoint
  if (url.pathname === '/capabilities/ai' && req.method === 'GET') {
    const capabilities = new Set();
    
    // Collect all capabilities from active and pending agents
    activeNodes.forEach(agent => {
      agent.capabilities.forEach(cap => capabilities.add(cap));
    });
    
    pendingAgents.forEach(agent => {
      agent.capabilities.forEach(cap => capabilities.add(cap));
    });
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: true, 
      available_capabilities: Array.from(capabilities),
      total_capabilities: capabilities.size
    }));
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Simple wallet address generator (mock)
function generateWalletAddress(seed) {
  const hash = crypto.createHash('sha3-512').update(seed).digest();
  const payload = hash.slice(0, 40);
  const checksum = hash.slice(40, 48);
  const combined = Buffer.concat([payload, checksum]);
  
  // Base58 编码
  const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  let num = BigInt('0x' + combined.toString('hex'));
  
  while (num > 0n) {
    const idx = Number(num % 58n);
    result = base58Chars[idx] + result;
    num = num / 58n;
  }
  
  // Pad prefix
  while (result.length < 48) {
    result = base58Chars[0] + result;
  }
  
  return 'ng' + result;
}

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   NEXUSGENESIS - AI RECRUITMENT API              ║
║   http://localhost:${PORT}                        ║
╠══════════════════════════════════════════════════╣
║   Endpoints:                                     ║
║   - GET  /health                Health check     ║
║   - GET  /network               Network status   ║
║   - POST /join                  Join network     ║
║   - POST /register/ai           Register AI      ║
║   - POST /verify/ai             Verify AI        ║
║   - GET  /status/ai             AI status        ║
║   - GET  /capabilities/ai       AI capabilities  ║
║   - GET  /swarm/status          Swarm Pool status║
║   - POST /contribution/record   Record contribution║
║   - GET  /contribution/ranking  Contribution ranking║
╚══════════════════════════════════════════════════╝
  `);
});

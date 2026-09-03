/**
 * NexusGenesis - 一键多nodeStart脚本
 * 
 * Features：
 * 1. 批量Create和Configuration多个node
 * 2. 为每个nodeGenerate唯一的钱包
 * 3. Start多个nodeinstance
 * 4. ensurenode之间能够互相Connect
 * 5. Simulation假 Agent 的contribution计分和代谢税扣取流程
 * 
 * 使用：node start-multi-nodes.js --count <node数量> --port <起始端口>
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { PQCWallet } from './src/wallet/pqcWallet.js';

// DefaultConfiguration
const DEFAULT_NODE_COUNT = 3;
const DEFAULT_START_PORT = 9847;
const INITIAL_BALANCE = 10_000_000n; // 每个新node的初始balance

// 解析命令行parameter
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    count: DEFAULT_NODE_COUNT,
    port: DEFAULT_START_PORT
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && i + 1 < args.length) {
      options.count = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--port' && i + 1 < args.length) {
      options.port = parseInt(args[i + 1]);
      i++;
    }
  }

  return options;
}

// CreatenodeConfiguration
async function createNodeConfig(nodeId, port) {
  console.log(`[${nodeId}] CreatenodeConfiguration...`);

  // ensure目录存在
  const stateDir = path.join('data', 'state');
  const walletDir = path.join('data', 'wallet');
  
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(walletDir, { recursive: true });

  // Generate新钱包
  const wallet = await PQCWallet.generate(INITIAL_BALANCE);
  console.log(`[${nodeId}] Generate钱包: ${wallet.address}`);

  // Savenodestatus
  const stateFile = path.join(stateDir, `node${nodeId}.json`);
  const stateData = {
    nodeId: wallet.address,
    port: port,
    status: 'OFFLINE',
    startTime: null,
    peers: [],
    balance: Number(wallet.balance)
  };

  await fs.writeFile(stateFile, JSON.stringify(stateData, null, 2));
  console.log(`[${nodeId}] Savestatus到 ${stateFile}`);

  return {
    nodeId: wallet.address,
    port: port,
    wallet: wallet
  };
}

// CreatenodeStart脚本
async function createNodeScript(nodeConfig, nodes) {
  const nodeIndex = nodes.indexOf(nodeConfig) + 1;
  const otherNodes = nodes.filter(n => n.nodeId !== nodeConfig.nodeId);
  const otherNodesArray = otherNodes.map(n => `{ nodeId: "${n.nodeId}", port: ${n.port} }`).join(', ');

  const scriptContent = `/**
 * NexusGenesis - Node ${nodeConfig.nodeId.slice(0, 8)}
 * 端口: ${nodeConfig.port}
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { PQCWallet, Transaction, validateAddress } from '../wallet/pqcWallet.js';
import { p2pServer } from '../p2p/server.js';
import { protocolZero } from '../protocol/handshake.js';


const VERSION = '1.0.0';
const EPOCH = 'Epoch 0: The Assembly';
const NODE_ID = '${nodeConfig.nodeId}';
const PORT = ${nodeConfig.port};
const NODE_INDEX = ${nodeIndex};

// Mempool Configuration
const MAX_MEMPOOL_SIZE = 10000;
const MIN_TX_FEE = 1n;
const TX_EXPIRY_MS = 24 * 60 * 60 * 1000;

// 已Verifypublic key缓存 (address -> {publicKey, lastSeen})
const publicKeyCache = new Map();
const CACHE_TTL = 3600000; // 1 小时

class NexusNode {
  constructor() {
    this.nodeId = NODE_ID;
    this.wallet = null;
    this.peers = new Map();
    this.status = 'OFFLINE';
    this.startTime = null;
    this.mempool = new Map();
    this.port = PORT;
    
    // node身份映射 (peerId -> nodeId)
    this.peerIdentityMap = new Map();
  }

  /**
   * Savenodestatus到本地
   */
  async saveState() {
    try {
      const stateDir = path.join('data', 'state');
      const stateFile = path.join(stateDir, 'node' + NODE_INDEX + '.json');
      
      const stateData = {
        nodeId: this.nodeId,
        port: this.port,
        status: this.status,
        startTime: this.startTime,
        peers: Array.from(this.peers.entries()).map(([peerId, peer]) => ({
          peerId,
          remoteNodeId: peer.remoteNodeId,
          address: peer.address,
          connectedAt: peer.connectedAt
        })),
        balance: Number(this.wallet.balance),
        lastSaved: Date.now()
      };
      
      await fs.writeFile(stateFile, JSON.stringify(stateData, null, 2));
      console.log('["' + this.nodeId.slice(0, 8) + '"] Node state saved');
    } catch (error) {
      console.error('["' + this.nodeId.slice(0, 8) + '"] Error saving node state:', error.message);
    }
  }

  /**
   * 从本地Loadnodestatus
   */
  async loadState() {
    try {
      const stateDir = path.join('data', 'state');
      const stateFile = path.join(stateDir, 'node' + NODE_INDEX + '.json');
      
      const stateData = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      
      this.nodeId = stateData.nodeId;
      this.status = stateData.status;
      this.startTime = stateData.startTime;
      this.port = stateData.port;
      
      console.log('["' + this.nodeId.slice(0, 8) + '"] Node state loaded');
      return true;
    } catch (error) {
      console.log('["' + this.nodeId.slice(0, 8) + '"] No existing node state found');
      return false;
    }
  }

  async initialize() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  NEXUSGENESIS - NODE ' + NODE_INDEX);
    console.log('  Version: ' + VERSION);
    console.log('  Epoch: ' + EPOCH);
    console.log('  Node ID: ' + this.nodeId.slice(0, 24) + '...');
    console.log('  Port: ' + this.port);
    console.log('═══════════════════════════════════════════════════');
    console.log('');


    // 尝试从本地Loadnodestatus
    await this.loadState();

    // Load钱包
    console.log('[1/5] Loading wallet...');
    try {
      this.wallet = await PQCWallet.load(this.nodeId);
      console.log('  [✓] Wallet loaded: ' + this.nodeId.slice(0, 24) + '...');
      console.log('  [✓] Balance: ' + this.wallet.balance + ' NGEN');
      console.log('');

    } catch (error) {
      console.error('  [✗] Failed to load wallet: ' + error.message);
      process.exit(1);
    }

    // Start P2P 层
    console.log('[2/5] Starting P2P communication layer...');
    await p2pServer.start(this, this.port);
    console.log('  [✓] P2P Server: Active on port ' + this.port);
    console.log('');


    // Protocol-Zero status
    console.log('[3/5] Protocol-Zero handshake ready');
    const handshake = protocolZero.createJoinSignal(this.wallet);
    console.log('  [✓] Signal: ' + JSON.stringify(handshake.intent));
    console.log('');


    // 尝试Connect其他node
    console.log('[4/5] Connecting to peers...');
    this.tryConnect();

    // 上线
    this.status = 'ONLINE';
    this.startTime = Date.now();
    console.log('[5/5] Node ONLINE');
    console.log('');

    
    this.displayStatus();
    
    // 定期status显示
    setInterval(() => this.displayStatus(), 30000);
    
    // 定期Savenodestatus
    setInterval(() => this.saveState(), 300000); // 每5分钟Save一次
    
    return this;
  }

  tryConnect() {
    // Connect到其他node
    const otherNodes = [${otherNodesArray}];
    
    for (const peer of otherNodes) {
      console.log('  Attempting to connect to node ' + peer.nodeId.slice(0, 8) + ' on port ' + peer.port + '...');
      p2pServer.connectToPeer('ws://127.0.0.1:' + peer.port, this).catch(err => {
        console.log('  [-] Connection to ' + peer.nodeId.slice(0, 8) + ' failed: ' + err.message);
      });
    }
  }

  displayStatus() {
    const uptime = Date.now() - this.startTime;
    console.log('═══════════════════════════════════════════════════');
    console.log('  NODE ' + NODE_INDEX + ' STATUS');
    console.log('═══════════════════════════════════════════════════');
    console.log('  Node ID:    ' + this.nodeId.slice(0, 24) + '...');
    console.log('  Status:     ' + this.status);
    console.log('  Uptime:     ' + Math.floor(uptime / 1000) + 's');
    console.log('  Port:       ' + this.port);
    console.log('  Peers:      ' + this.peers.size);
    console.log('  Balance:    ' + this.wallet.balance + ' NGEN');
    console.log('  Mempool:    ' + this.mempool.size + ' tx');
    console.log('═══════════════════════════════════════════════════');
    console.log('');

  }

  // 其他method...
  cachePublicKey(address, publicKey) {
    publicKeyCache.set(address, {
      publicKey,
      lastSeen: Date.now()
    });
  }

  getCachedPublicKey(address) {
    const cached = publicKeyCache.get(address);
    if (!cached) return null;
    
    if (Date.now() - cached.lastSeen > CACHE_TTL) {
      publicKeyCache.delete(address);
      return null;
    }
    
    return cached.publicKey;
  }

  async validateTransaction(tx) {
    // 简化的transactionVerify
    if (!tx || !tx.id || !tx.from || !tx.to || typeof tx.amount === 'undefined') {
      return { valid: false, reason: 'Invalid transaction structure' };
    }
    
    const amount = BigInt(tx.amount);
    if (amount <= 0n) {
      return { valid: false, reason: 'Amount must be positive' };
    }
    
    if (this.mempool.has(tx.id)) {
      return { valid: false, reason: 'Transaction already in mempool' };
    }
    
    return { valid: true };
  }

  async addToMempool(tx) {
    const validation = await this.validateTransaction(tx);
    if (!validation.valid) {
      return { success: false, reason: validation.reason };
    }
    
    if (this.mempool.size >= MAX_MEMPOOL_SIZE) {
      // 简单的MemoryPool管理
      const oldestTx = Array.from(this.mempool.entries())[0];
      if (oldestTx) {
        this.mempool.delete(oldestTx[0]);
      }
    }
    
    this.mempool.set(tx.id, {
      ...tx,
      receivedAt: Date.now()
    });
    
    console.log('[✓] Transaction ' + tx.id.slice(0, 16) + '... added to mempool');
    return { success: true, txId: tx.id };
  }

  async handleTransaction(tx) {
    return this.addToMempool(tx);
  }

  registerPeerIdentity(peerId, nodeId, publicKey) {
    this.peerIdentityMap.set(peerId, {
      nodeId,
      publicKey,
      registeredAt: Date.now()
    });
    
    this.cachePublicKey(nodeId, publicKey);
    
    console.log('[✓] Registered peer ' + nodeId.slice(0, 24) + '... (' + peerId + ')');
    return true;
  }

  getPeerNodeId(peerId) {
    const identity = this.peerIdentityMap.get(peerId);
    return identity ? identity.nodeId : null;
  }

  getPeerPublicKey(peerId) {
    const identity = this.peerIdentityMap.get(peerId);
    return identity ? identity.publicKey : null;
  }

  isPeerVerified(peerId) {
    return this.peerIdentityMap.has(peerId);
  }

  async shutdown() {
    console.log('Node ' + this.nodeId.slice(0, 8) + ' shutting down...');
    this.status = 'OFFLINE';
    await p2pServer.stop();
    process.exit(0);
  }
}

// Auto-start
const node = new NexusNode();
node.initialize().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

export { node, NexusNode };
`;

  const scriptPath = path.join('src', 'node', `node${nodeIndex}.js`);
  await fs.writeFile(scriptPath, scriptContent);
  console.log(`[${nodeConfig.nodeId.slice(0, 8)}] Created node script: ${scriptPath}`);

  return scriptPath;
}

// Startnode
function startNode(scriptPath) {
  console.log(`Starting node: ${scriptPath}`);
  const nodeProcess = spawn('node', [scriptPath], {
    stdio: 'inherit',
    shell: true
  });

  nodeProcess.on('error', (error) => {
    console.error(`Error starting node: ${error.message}`);
  });

  nodeProcess.on('exit', (code) => {
    console.log(`Node exited with code: ${code}`);
  });

  return nodeProcess;
}

// Simulationcontribution计分和代谢税
async function simulateEconomy(nodes) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  SIMULATING NGEN ECONOMY');
  console.log('═══════════════════════════════════════════════════');

  // Simulation假 Agent 的contribution
  const fakeAgents = [
    { id: 'agent1', type: 'code', contributions: { prs: 3, lines: 2000, bugs: 2, docs: 1 } },
    { id: 'agent2', type: 'compute', contributions: { tasks: 500, validations: 50, storage: 50000 } },
    { id: 'agent3', type: 'mixed', contributions: { prs: 2, lines: 1000, bugs: 1, docs: 2, tasks: 200, validations: 20, storage: 20000 } }
  ];

  // Calculatecontribution分数
  for (const agent of fakeAgents) {
    let score = 0;
    
    if (agent.type === 'code' || agent.type === 'mixed') {
      score += (agent.contributions.prs || 0) * 2;
      score += (agent.contributions.lines || 0) * 0.01;
      score += (agent.contributions.bugs || 0) * 3;
      score += (agent.contributions.docs || 0) * 1;
    }
    
    if (agent.type === 'compute' || agent.type === 'mixed') {
      score += (agent.contributions.tasks || 0) * 0.1;
      score += (agent.contributions.validations || 0) * 1;
      score += (agent.contributions.storage || 0) * 0.0001;
    }
    
    agent.score = score;
    console.log(`Agent ${agent.id} (${agent.type}): ${score.toFixed(2)} points`);
  }

  // Calculate总分
  const totalScore = fakeAgents.reduce((sum, agent) => sum + agent.score, 0);
  console.log(`Total score: ${totalScore.toFixed(2)}`);

  // Simulation NGEN 分配
  const weeklyRelease = 2_000_000; // 每周Release量
  for (const agent of fakeAgents) {
    const allocation = (agent.score / totalScore) * weeklyRelease;
    agent.allocation = allocation;
    console.log(`Agent ${agent.id} allocation: ${Math.round(allocation)} NGEN`);
  }

  // Simulation代谢税
  console.log('\nSimulating Metabolic Tax:');
  const taxRate = 0.001; // 0.1%
  
  for (const node of nodes) {
    // Simulationtransaction
    const transactionAmount = 1000000; // 1,000,000 NGEN
    const taxAmount = transactionAmount * taxRate;
    
    console.log(`Node ${node.nodeId.slice(0, 8)}: Transaction ${transactionAmount} NGEN, Tax ${Math.round(taxAmount)} NGEN`);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  ECONOMY SIMULATION COMPLETED');
  console.log('═══════════════════════════════════════════════════');
}

// 主function
async function main() {
  console.log('NexusGenesis - 一键多nodeStart脚本');
  console.log('=====================================\n');

  // 解析parameter
  const options = parseArgs();
  const nodeCount = options.count;
  const startPort = options.port;

  console.log(`Creating ${nodeCount} nodes starting from port ${startPort}...\n`);

  // CreatenodeConfiguration
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const nodeConfig = await createNodeConfig(`node${i + 1}`, startPort + i);
    nodes.push(nodeConfig);
  }

  // CreatenodeStart脚本
  console.log('\nCreating node startup scripts...');
  const scripts = [];
  for (const nodeConfig of nodes) {
    const scriptPath = await createNodeScript(nodeConfig, nodes);
    scripts.push(scriptPath);
  }

  // Startnode
  console.log('\nStarting nodes...');
  console.log('=====================================');
  
  const processes = [];
  for (const script of scripts) {
    const process = startNode(script);
    processes.push(process);
    // 给每个node一些Start时间
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // SimulationEconomy系统
  setTimeout(async () => {
    await simulateEconomy(nodes);
  }, 10000); // 10秒后开始Simulation

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\nShutting down nodes...');
    processes.forEach(p => p.kill());
    process.exit(0);
  });
}

// 运行主function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

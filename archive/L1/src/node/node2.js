/**
 * NexusGenesis - Node ng118gyP
 * port: 9848
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { PQCWallet, Transaction, validateAddress } from '../wallet/pqcWallet.js';
import { p2pServer } from '../p2p/server.js';
import { protocolZero } from '../protocol/handshake.js';


const VERSION = '1.0.0';
const EPOCH = 'Epoch 2: Bloom';
const NODE_ID = 'ng118gyPVRmgbcexGf2Js7w4NM2gNm4HuWSAV';
const PORT = 9849;
const NODE_INDEX = 2;

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
   * SaveNode status到本地
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
   * 从本地LoadNode status
   */
  async loadState() {
    try {
      const stateDir = path.join('data', 'state');
      const stateFile = path.join(stateDir, 'node' + NODE_INDEX + '.json');
      
      const stateData = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      
      this.nodeId = stateData.nodeId;
      this.status = stateData.status;
      this.startTime = stateData.startTime;
      this.port = stateData.port || PORT;
      
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


    // 尝试从本地LoadNode status
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
    
    // 定期SaveNode status
    setInterval(() => this.saveState(), 300000); // 每5分钟Save一次
    
    return this;
  }

  tryConnect() {
    const seedPorts = [9847, 9848, 9850];
    
    for (const port of seedPorts) {
      console.log('  Connecting to peer on port ' + port + '...');
      p2pServer.connectToPeer('ws://127.0.0.1:' + port, this).catch(err => {
        console.log('  [-] Connection to port ' + port + ' failed: ' + err.message);
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
      const missing = [];
      if (!tx) return { valid: false, reason: 'Invalid transaction: tx is null/undefined' };
      if (!tx.id) missing.push('id');
      if (!tx.from) missing.push('from');
      if (!tx.to) missing.push('to');
      if (typeof tx.amount === 'undefined') missing.push('amount');
      return { valid: false, reason: `Invalid transaction structure: missing required field(s): ${missing.join(', ')}` };
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
      // 简单的memoryPool管理
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

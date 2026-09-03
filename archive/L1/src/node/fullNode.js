/**
 * Full Node - 全节点实现 (Phase 2 增强版)
 *
 * 全节点维护完整的区块链状态副本，支持 P2P 连接、状态同步、
 * 区块生产和交易转发。不参与共识投票，但可响应查询请求。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { PQCWallet } from '../wallet/pqcWallet.js';
import { getNetworkConfig, getSeedNodes, getMainnetConfig } from '../config/mainnetConfig.js';
import { Block, createGenesisBlock } from '../blockchain/block.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

class FullNode {
  constructor(options = {}) {
    this.nodeId = crypto.randomBytes(32).toString('hex');
    this.config = getMainnetConfig();
    this.networkConfig = getNetworkConfig();
    this.wallet = null;
    this.peers = new Map();
    this.peerNodeIdMap = new Map(); // peerId -> nodeId
    this.blockchain = [];
    this.txPool = new Map();
    this.state = null;
    this.isRunning = false;
    this.startTime = null;
    this.lastBlockHeight = 0;
    this.knownPeers = new Set();
    this._syncInProgress = false;
    this._lastSyncRequestAt = 0;
    this.syncBatchDelay = 100; // ms between sync batches

    // 可选的 HTTP 服务器（用于查询 API）
    this.httpServer = null;
    this.queryHandlers = new Map();

    // 数据目录（可用于测试隔离）
    this._dataDir = options.dataDir || resolve(PROJECT_ROOT, 'data');

    // 从持久化文件加载区块链（如果存在）
    this._loadBlockchainFromFile();
  }

  // ==================== 初始化 ====================

  async initialize() {
    console.log(`[FULL_NODE] Initializing full node: ${this.nodeId.slice(0, 16)}...`);

    // 生成钱包（用于签名交易）
    this.wallet = await PQCWallet.generate();
    console.log(`[FULL_NODE] Wallet generated: ${this.wallet.address.slice(0, 24)}...`);

    // 初始化区块链状态
    this.state = this._initState();

    // 如果有持久化的区块链，使用它；否则创建创世区块
    if (this.blockchain.length === 0) {
      const genesis = createGenesisBlock();
      this.blockchain.push(genesis);
      this.lastBlockHeight = 0;
      this.state.blockHeight = 0;
      this.state.lastBlockHash = genesis.hash;
      await this._saveBlockchainToFile();
    }

    this.startTime = Date.now();
    this.isRunning = true;

    console.log(`[FULL_NODE] Chain ID: ${this.networkConfig.chainId}`);
    console.log(`[FULL_NODE] Network ID: ${this.networkConfig.networkId}`);
    console.log(`[FULL_NODE] Environment: ${this.networkConfig.environment}`);
    console.log(`[FULL_NODE] Blockchain height: ${this.lastBlockHeight}`);

    return this;
  }

  _initState() {
    const statePath = resolve(PROJECT_ROOT, 'data', 'state', 'fullnode_state.json');
    try {
      if (existsSync(statePath)) {
        const saved = JSON.parse(readFileSync(statePath, 'utf8'));
        return {
          blockHeight: saved.blockHeight || 0,
          lastBlockHash: saved.lastBlockHash || null,
          syncStatus: 'synced',
          peerCount: 0
        };
      }
    } catch (err) {
      console.warn(`[FULL_NODE] Could not load state: ${err.message}`);
    }
    return {
      blockHeight: this.blockchain.length - 1,
      lastBlockHash: this.blockchain.length > 0 ? this.blockchain[0].hash : null,
      syncStatus: 'synced',
      peerCount: 0
    };
  }

  // ==================== 持久化 ====================

  _loadBlockchainFromFile() {
    const blockPath = resolve(this._dataDir, 'blockchain.json');
    try {
      if (existsSync(blockPath)) {
        const data = JSON.parse(readFileSync(blockPath, 'utf8'));
        if (Array.isArray(data) && data.length > 0) {
          this.blockchain = data.map(b => Block.fromJSON(b));
          this.lastBlockHeight = this.blockchain.length - 1;
          console.log(`[FULL_NODE] Loaded ${this.blockchain.length} blocks from file`);
        }
      }
    } catch (err) {
      console.warn(`[FULL_NODE] Could not load blockchain: ${err.message}`);
    }
  }

  async _saveBlockchainToFile() {
    try {
      const blockPath = resolve(this._dataDir, 'blockchain.json');
      const dir = dirname(blockPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = this.blockchain.map(b => b.toJSON());
      writeFileSync(blockPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[FULL_NODE] Failed to save blockchain: ${err.message}`);
    }
  }

  // ==================== P2P 连接 ====================

  async connectToNetwork() {
    const seeds = getSeedNodes();
    console.log(`[FULL_NODE] Connecting to ${seeds.length} seed nodes...`);

    for (const seedUrl of seeds) {
      try {
        await this.connectToPeer(seedUrl);
      } catch (err) {
        console.warn(`[FULL_NODE] Failed to connect to seed ${seedUrl}: ${err.message}`);
      }
    }
  }

  async connectToPeer(peerUrl) {
    return new Promise((resolve, reject) => {
      // Dynamic import WebSocket to avoid ESM issues in Node.js
      import('ws').then(({ default: WebSocket }) => {
        const ws = new WebSocket(peerUrl);

        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 10000);

        ws.on('open', () => {
          clearTimeout(timeout);
          const peerId = crypto.randomUUID();

          this.peers.set(peerId, {
            ws,
            url: peerUrl,
            connectedAt: Date.now(),
            lastHeartbeat: Date.now(),
            status: 'handshaking'
          });

          this.sendHello(peerId);

          ws.on('message', (data) => {
            this.handleMessage(peerId, data);
          });

          ws.on('close', () => {
            console.log(`[FULL_NODE] Peer disconnected: ${peerUrl}`);
            this.peers.delete(peerId);
          });

          ws.on('error', (err) => {
            console.error(`[FULL_NODE] Peer error ${peerUrl}: ${err.message}`);
            this.peers.delete(peerId);
          });

          resolve(peerId);
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    });
  }

  sendHello(peerId) {
    const conn = this.peers.get(peerId);
    if (!conn || conn.ws.readyState !== 1) return; // 1 = OPEN

    const message = {
      type: 'HELLO',
      nodeId: this.nodeId,
      publicKey: this.wallet.publicKey.toString('hex'),
      version: '1.0.0',
      epoch: this.networkConfig.epoch || 'Epoch 2: Network',
      role: 'full_node',
      capabilities: ['query', 'forward', 'state_sync', 'block_production'],
      chainId: this.networkConfig.chainId,
      blockHeight: this.lastBlockHeight,
      timestamp: Date.now()
    };

    conn.ws.send(JSON.stringify(message));
  }

  // ==================== 消息处理 ====================

  handleMessage(peerId, data) {
    try {
      const message = JSON.parse(data.toString());
      const conn = this.peers.get(peerId);
      if (!conn) return;

      switch (message.type) {
        case 'HELLO_ACK':
          conn.status = 'connected';
          conn.remoteNodeId = message.nodeId;
          this.peerNodeIdMap.set(peerId, message.nodeId);
          this.knownPeers.add(message.nodeId);
          console.log(`[FULL_NODE] Connected to ${message.nodeId?.slice(0, 16)}...`);
          // 握手完成后启动状态同步
          this.requestStateSync(peerId);
          break;

        case 'BLOCK':
          this.processBlock(message.block);
          break;

        case 'STATE_SYNC_RESPONSE':
          this.processStateSyncResponse(peerId, message);
          break;

        case 'TRANSACTION':
          this.processTransaction(message.transaction);
          break;

        case 'HEARTBEAT':
          conn.lastHeartbeat = Date.now();
          break;

        default:
          console.log(`[FULL_NODE] Unknown message type: ${message.type}`);
          break;
      }
    } catch (err) {
      console.error(`[FULL_NODE] Message handling error: ${err.message}`);
    }
  }

  // ==================== 状态同步协议 ====================

  /**
   * 向指定 peer 发起状态同步请求
   * 协议: STATE_SYNC_REQUEST -> STATE_SYNC_RESPONSE -> 应用区块 -> 继续请求
   */
  requestStateSync(peerId) {
    const conn = this.peers.get(peerId);
    if (!conn || conn.status !== 'connected') {
      console.log(`[FULL_NODE] Cannot sync with peer ${peerId}: not connected`);
      return;
    }

    // 节流: 避免在短时间内重复请求
    const now = Date.now();
    if (now - this._lastSyncRequestAt < 2000) {
      console.log(`[FULL_NODE] Sync throttled (${now - this._lastSyncRequestAt}ms since last request)`);
      return;
    }

    const message = {
      type: 'STATE_SYNC_REQUEST',
      fromHeight: this.lastBlockHeight + 1,
      maxBlocks: 50,
      requestId: crypto.randomUUID(),
      timestamp: now
    };

    this._lastSyncRequestAt = now;
    this._syncInProgress = true;

    console.log(
      `[FULL_NODE] Requesting state sync from height ${message.fromHeight} ` +
      `(current height=${this.lastBlockHeight})`
    );

    conn.ws.send(JSON.stringify(message));
  }

  /**
   * 处理收到的 STATE_SYNC_RESPONSE
   * 应用区块，如果未同步完则继续请求下一批
   */
  async processStateSyncResponse(peerId, message) {
    const blocks = message.blocks || [];

    if (blocks.length === 0) {
      console.log(`[FULL_NODE] Already up to date (tip=${this.lastBlockHeight})`);
      this._syncInProgress = false;
      this.state.syncStatus = 'synced';
      return;
    }

    console.log(
      `[FULL_NODE] Received ${blocks.length} blocks ` +
      `(${message.fromHeight}-${message.toHeight}), synced=${message.synced}`
    );

    // 应用区块
    let applied = 0;
    let skipped = 0;

    for (const blockData of blocks) {
      const block = Block.fromJSON(blockData);

      // 跳过已存在的区块
      if (block.header.height <= this.lastBlockHeight) {
        skipped++;
        continue;
      }

      // 验证区块
      if (!block.validate()) {
        console.error(`[FULL_NODE] Invalid block #${block.header.height} in sync, aborting`);
        break;
      }

      // 检查父链链接
      if (block.header.height !== this.lastBlockHeight + 1) {
        console.error(
          `[FULL_NODE] Block #${block.header.height} does not link to tip #${this.lastBlockHeight}, aborting`
        );
        break;
      }

      // 应用到状态
      this._applyBlockToState(block);
      this.blockchain.push(block);
      this.lastBlockHeight = block.header.height;
      applied++;
    }

    // 持久化
    if (applied > 0) {
      await this._saveBlockchainToFile();
      this.state.blockHeight = this.lastBlockHeight;
      this.state.lastBlockHash = this.blockchain[this.lastBlockHeight].hash;
    }

    console.log(
      `[FULL_NODE] Sync applied ${applied} blocks (skipped ${skipped}), ` +
      `new height: ${this.lastBlockHeight}`
    );

    // 如果未完全同步，继续请求下一批
    if (!message.synced && applied > 0) {
      const nextFrom = this.lastBlockHeight + 1;
      const conn = this.peers.get(peerId);
      if (conn && conn.ws.readyState === 1) {
        setTimeout(() => {
          this._sendSyncRequest(peerId, nextFrom);
        }, this.syncBatchDelay);
      } else {
        this._syncInProgress = false;
      }
    } else {
      this._syncInProgress = false;
      this.state.syncStatus = 'synced';
    }
  }

  /**
   * 发送同步请求（带 fromHeight 参数）
   */
  _sendSyncRequest(peerId, fromHeight) {
    const conn = this.peers.get(peerId);
    if (!conn || conn.ws.readyState !== 1) return;

    const message = {
      type: 'STATE_SYNC_REQUEST',
      fromHeight,
      maxBlocks: 50,
      requestId: crypto.randomUUID(),
      timestamp: Date.now()
    };

    this._lastSyncRequestAt = Date.now();
    conn.ws.send(JSON.stringify(message));
    console.log(`[FULL_NODE] Requesting next batch from height ${fromHeight}`);
  }

  /**
   * 将区块应用到本地状态
   */
  _applyBlockToState(block) {
    if (!block.body || !block.body.transactions) return;

    for (const tx of block.body.transactions) {
      // 处理转账交易
      if (tx.type === 'TRANSFER' || tx.tx_type === 'TRANSFER') {
        const from = tx.from || tx.sender;
        const to = tx.to || tx.recipient;
        const amount = Number(tx.amount) || 0;
        const fee = Number(tx.fee) || 0;

        // 扣款方
        if (from) {
          const fromBalance = this.state.balances?.[from] || 0n;
          if (this.state.balances) {
            this.state.balances[from] = fromBalance - BigInt(amount) - BigInt(fee);
          }
        }

        // 收款方
        if (to) {
          const toBalance = this.state.balances?.[to] || 0n;
          if (this.state.balances) {
            this.state.balances[to] = toBalance + BigInt(amount);
          }
        }
      }
    }
  }

  // ==================== 区块处理 ====================

  processBlock(blockData) {
    const block = Block.fromJSON(blockData);
    const blockHash = block.hash;

    // 去重
    if (this.blockchain.find(b => b.hash === blockHash)) {
      return;
    }

    // 验证
    if (!block.validate()) {
      console.error(`[FULL_NODE] Invalid block received: ${blockHash.slice(0, 16)}...`);
      return;
    }

    // 检查父链
    if (block.header.height !== this.lastBlockHeight + 1) {
      console.warn(
        `[FULL_NODE] Block #${block.header.height} does not link to tip #${this.lastBlockHeight}`
      );
      return;
    }

    // 应用
    this._applyBlockToState(block);
    this.blockchain.push(block);
    this.lastBlockHeight = block.header.height;
    this.state.blockHeight = block.header.height;
    this.state.lastBlockHash = blockHash;

    console.log(`[FULL_NODE] Block received: ${blockHash.slice(0, 16)}... height=${block.header.height}`);
  }

  // ==================== 交易处理 ====================

  processTransaction(txData) {
    const tx = typeof txData === 'string' ? JSON.parse(txData) : txData;
    const txHash = crypto.createHash('sha3-256').update(JSON.stringify(tx)).digest('hex');

    // 去重
    if (this.txPool.has(txHash)) {
      return;
    }

    // 验证交易
    if (!this._validateTransaction(tx)) {
      console.log(`[FULL_NODE] Invalid transaction: ${txHash.slice(0, 16)}...`);
      return;
    }

    // 加入交易池
    this.txPool.set(txHash, {
      ...tx,
      hash: txHash,
      receivedAt: Date.now()
    });

    console.log(`[FULL_NODE] Transaction added to pool: ${txHash.slice(0, 16)}...`);

    // 转发给 peer
    this.forwardTransaction(tx);
  }

  _validateTransaction(tx) {
    // 基本验证
    if (!tx.from || !tx.to || !tx.amount) return false;
    if (typeof tx.amount !== 'string' && typeof tx.amount !== 'number') return false;
    return true;
  }

  forwardTransaction(tx) {
    const message = {
      type: 'TRANSACTION',
      transaction: tx,
      forwardedBy: this.nodeId,
      timestamp: Date.now()
    };

    this.broadcast(message);
  }

  // ==================== P2P 工具方法 ====================

  sendToPeer(peerId, message) {
    const conn = this.peers.get(peerId);
    if (conn && conn.ws.readyState === 1) {
      conn.ws.send(JSON.stringify(message));
    }
  }

  broadcast(message) {
    for (const [peerId, conn] of this.peers) {
      if (conn.ws.readyState === 1) {
        conn.ws.send(JSON.stringify(message));
      }
    }
  }

  /**
   * 生产新区块（即使 txPool 为空也生产空块）
   */
  async produceBlock() {
    const transactions = [];
    let totalFees = 0n;

    // 从交易池取交易
    for (const [hash, tx] of this.txPool) {
      transactions.push(tx);
      totalFees += BigInt(tx.fee || 0);
      if (transactions.length >= 100) break;
      this.txPool.delete(hash);
    }

    const prevBlock = this.blockchain[this.blockchain.length - 1];
    const block = new Block(prevBlock.hash, this.lastBlockHeight + 1, Date.now(), transactions);

    // 存储到本地
    this.blockchain.push(block);
    this.lastBlockHeight = block.header.height;
    this.state.blockHeight = block.header.height;
    this.state.lastBlockHash = block.hash;

    await this._saveBlockchainToFile();

    console.log(`[FULL_NODE] Produced block #${block.header.height} with ${transactions.length} txs`);

    // 广播给 peer
    this.broadcast({
      type: 'BLOCK',
      block: block.toJSON(),
      timestamp: Date.now()
    });

    return block;
  }

  // ==================== 心跳 ====================

  startHeartbeat() {
    setInterval(() => {
      this.broadcast({
        type: 'HEARTBEAT',
        nodeId: this.nodeId,
        blockHeight: this.lastBlockHeight,
        peerCount: this.peers.size,
        txPoolSize: this.txPool.size,
        timestamp: Date.now()
      });
    }, 30000);
  }

  // ==================== 查询 API ====================

  /**
   * 注册查询处理器
   * @param {string} path - URL 路径前缀
   * @param {Function} handler - (req, res) => {}
   */
  registerQueryHandler(path, handler) {
    this.queryHandlers.set(path, handler);
  }

  /**
   * 处理查询请求
   */
  async handleQuery(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    for (const [prefix, handler] of this.queryHandlers) {
      if (path.startsWith(prefix)) {
        return handler(url, req, res);
      }
    }

    // 默认查询
    if (path === '/api/v1/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: this.getStatus() }));
    } else if (path === '/api/v1/blocks') {
      const height = parseInt(url.searchParams.get('height')) || this.lastBlockHeight;
      const block = this.blockchain[height];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: !!block,
        data: block ? block.toJSON() : null
      }));
    } else if (path === '/api/v1/peers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: Array.from(this.peers.values()).map(p => ({
          url: p.url,
          status: p.status,
          connectedAt: p.connectedAt
        }))
      }));
    } else if (path === '/api/v1/mempool') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: Array.from(this.txPool.values())
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
    }
  }

  // ==================== 状态 ====================

  getStatus() {
    return {
      nodeId: this.nodeId,
      role: 'full_node',
      isRunning: this.isRunning,
      uptime: Date.now() - (this.startTime || Date.now()),
      chainId: this.networkConfig.chainId,
      networkId: this.networkConfig.networkId,
      blockHeight: this.lastBlockHeight,
      syncStatus: this._syncInProgress ? 'syncing' : this.state.syncStatus,
      peerCount: this.peers.size,
      knownPeers: this.knownPeers.size,
      txPoolSize: this.txPool.size,
      blockchainSize: this.blockchain.length,
      walletAddress: this.wallet?.address,
      capabilities: ['query', 'forward', 'state_sync', 'block_production']
    };
  }

  /**
   * 请求指定 peer 从某个高度开始的区块
   * 供 GenesisNode 的 handleBlocksResponse 回调使用
   */
  requestBlocksFromPeer(peerNodeId, fromHeight, toHeight) {
    // 通过 peerId 查找连接
    for (const [peerId, nodeId] of this.peerNodeIdMap) {
      if (nodeId === peerNodeId) {
        this._sendSyncRequest(peerId, fromHeight);
        return;
      }
    }
    console.warn(`[FULL_NODE] Peer node ${peerNodeId} not found`);
  }

  // ==================== 生命周期 ====================

  async shutdown() {
    console.log(`[FULL_NODE] Shutting down...`);
    this.isRunning = false;

    // 保存状态
    try {
      const statePath = resolve(PROJECT_ROOT, 'data', 'state', 'fullnode_state.json');
      const stateDir = dirname(statePath);
      if (!existsSync(stateDir)) {
        mkdirSync(stateDir, { recursive: true });
      }
      writeFileSync(statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error(`[FULL_NODE] Failed to save state: ${err.message}`);
    }

    for (const [peerId, conn] of this.peers) {
      try { conn.ws.close(); } catch (_) { /* ignore */ }
    }
    this.peers.clear();

    console.log(`[FULL_NODE] Shutdown complete`);
  }
}

export default FullNode;

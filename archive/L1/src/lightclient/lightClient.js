/**
 * NexusGenesis - 轻客户端实现
 * supportBlock header同步和默克尔证明Verify
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PQCWallet, validateAddress } from '../wallet/pqcWallet.js';
import { verifySignature } from '../crypto/pqc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data/lightclient');

class LightClient {
  constructor() {
    this.nodeId = null;
    this.wallet = null;
    this.peer = null;
    this.blockHeaders = [];
    this.bestBlockHeight = 0;
    this.bestBlockHash = null;
    this.status = 'OFFLINE';
    this.requests = new Map(); // 请求ID -> 回调function
    this.validatorSet = []; // Verify者集合
    this.checkpoint = null; // Check点
    this.forkHeads = []; // 分叉链头
  }

  /**
   * Initialize轻客户端
   * @param {string} peerAddress - 全nodeaddress
   * @returns {Promise<LightClient>}
   */
  async initialize(peerAddress) {
    console.log('═══════════════════════════════════════════════════');
    console.log('  NEXUSGENESIS - LIGHT CLIENT');
    console.log('  Version: 1.0.0');
    console.log('  Protocol: NG-0 (Protocol-Zero)');
    console.log('═══════════════════════════════════════════════════\n');

    // Ensure data directory exists
    this.ensureDataDir();
    
    // 尝试LoadSaved的status
    this.loadState();

    // Generate或Load钱包
    try {
      this.wallet = await PQCWallet.generate(0n); // 轻客户端初始balance为0
      this.nodeId = this.wallet.address;
      console.log(`[✓] Wallet initialized: ${this.nodeId.slice(0, 24)}...`);
    } catch (error) {
      console.error('Failed to initialize wallet:', error.message);
      throw error;
    }

    // Connect到全node
    await this.connectToFullNode(peerAddress);

    // 同步Block header
    await this.syncBlockHeaders();

    this.status = 'ONLINE';
    console.log('[✓] Light client ONLINE');

    // 定期Savestatus
    setInterval(() => this.saveState(), 60000);

    return this;
  }

  /**
   * Connect到全node
   * @param {string} peerAddress - 全nodeaddress
   * @returns {Promise<void>}
   */
  async connectToFullNode(peerAddress) {
    return new Promise((resolve, reject) => {
      console.log(`Connecting to full node: ${peerAddress}`);
      
      const ws = new WebSocket(peerAddress);
      
      ws.on('open', () => {
        console.log('[✓] Connected to full node');
        this.peer = ws;
        
        // Send握手Message
        this.send({
          type: 'LIGHT_CLIENT_HELLO',
          nodeId: this.nodeId,
          publicKey: this.wallet.publicKey.toString('hex'),
          version: '1.0.0',
          capabilities: ['block_headers', 'merkle_proofs', 'transaction_status']
        });
        
        resolve();
      });
      
      ws.on('message', (data) => {
        this.handleMessage(data);
      });
      
      ws.on('close', () => {
        console.log('Disconnected from full node');
        this.status = 'OFFLINE';
        this.peer = null;
      });
      
      ws.on('error', (error) => {
        console.error('Connection error:', error.message);
        reject(error);
      });
    });
  }

  /**
   * Send message到全node
   * @param {object} message - Message对象
   * @param {function} callback - 回调function
   */
  send(message, callback = null) {
    if (!this.peer || this.peer.readyState !== WebSocket.OPEN) {
      console.error('Not connected to full node');
      return;
    }

    // 添加请求ID
    const requestId = crypto.randomUUID();
    message.requestId = requestId;
    
    if (callback) {
      this.requests.set(requestId, callback);
      
      // SetTimeout
      setTimeout(() => {
        if (this.requests.has(requestId)) {
          this.requests.delete(requestId);
          callback({ error: 'Request timeout' });
        }
      }, 10000);
    }

    this.peer.send(JSON.stringify(message));
  }

  /**
   * Processing来自全node的Message
   * @param {Buffer} data - Messagedata
   */
  handleMessage(data) {
    try {
      let messageStr = data.toString();
      let message;
      
      // Processing压缩Message
      try {
        message = JSON.parse(messageStr);
        if (message.type === 'COMPRESSED_MESSAGE') {
          const compressedData = Buffer.from(message.data, 'base64');
          const decompressed = zlib.gunzipSync(compressedData);
          messageStr = decompressed.toString();
          message = JSON.parse(messageStr);
          console.log(`Decompressed message: ${message.originalSize} -> ${message.compressedSize} bytes`);
        }
      } catch (err) {
        console.error('Message parse error:', err.message);
        return;
      }
      
      switch (message.type) {
        case 'LIGHT_CLIENT_HELLO_ACK':
          console.log('[✓] Handshake with full node successful');
          break;
          
        case 'BLOCK_HEADERS':
          this.handleBlockHeaders(message);
          break;
          
        case 'MERKLE_PROOF':
          this.handleMerkleProof(message);
          break;
          
        case 'TRANSACTION_STATUS':
          this.handleTransactionStatus(message);
          break;
          
        case 'ADDRESS_BALANCE':
          console.log(`Address balance: ${message.address} -> ${message.balance}`);
          break;
          
        case 'TRANSACTION_ACCEPTED':
          console.log(`Transaction accepted: ${message.txId}`);
          break;
          
        case 'TRANSACTION_REJECTED':
          console.log(`Transaction rejected: ${message.txId}, reason: ${message.reason}`);
          break;
          
        case 'CROSS_CHAIN_RESPONSE':
          console.log('Cross-chain response received');
          break;
          
        case 'ERROR':
          console.error('Error from full node:', message.message);
          break;
          
        default:
          // 忽略其他Messagetype
          break;
      }
      
      // Processing响应
      if (message.requestId && this.requests.has(message.requestId)) {
        const callback = this.requests.get(message.requestId);
        this.requests.delete(message.requestId);
        callback(message);
      }
    } catch (error) {
      console.error('Error handling message:', error.message);
    }
  }

  /**
   * 同步Block header
   * @returns {Promise<void>}
   */
  async syncBlockHeaders() {
    return new Promise((resolve) => {
      this.send({
        type: 'GET_BLOCK_HEADERS',
        startHeight: 0,
        count: 100
      }, (response) => {
        if (response.headers) {
          this.blockHeaders = response.headers;
          if (response.headers.length > 0) {
            const bestHeader = response.headers[response.headers.length - 1];
            this.bestBlockHeight = bestHeader.height;
            this.bestBlockHash = bestHeader.hash;
            console.log(`[✓] Synced ${response.headers.length} block headers, best block: #${this.bestBlockHeight}`);
          }
        }
        resolve();
      });
    });
  }

  /**
   * ProcessingBlock header响应
   * @param {object} message - Block headerMessage
   */
  handleBlockHeaders(message) {
    if (message.headers && message.headers.length > 0) {
      let validHeaders = [];
      
      // Verifyevery 个Block header
      for (const header of message.headers) {
        if (this.validateBlockHeader(header)) {
          validHeaders.push(header);
        } else {
          console.error(`✗ Rejecting invalid header at height ${header.height}`);
        }
      }
      
      // Processing分叉
      this.handleForks(validHeaders);
      
      // 添加有效的Block header
      this.blockHeaders = [...this.blockHeaders, ...validHeaders];
      
      if (validHeaders.length > 0) {
        const bestHeader = validHeaders[validHeaders.length - 1];
        this.bestBlockHeight = bestHeader.height;
        this.bestBlockHash = bestHeader.hash;
        console.log(`[✓] Received ${validHeaders.length}/${message.headers.length} valid headers, best block: #${this.bestBlockHeight}`);
      }
    }
  }

  /**
   * 请求默克尔证明
   * @param {string} txId - transaction ID
   * @returns {Promise<object>}
   */
  async getMerkleProof(txId) {
    return new Promise((resolve) => {
      this.send({
        type: 'GET_MERKLE_PROOF',
        txId
      }, (response) => {
        resolve(response);
      });
    });
  }

  /**
   * Processing默克尔证明响应
   * @param {object} message - 默克尔证明Message
   */
  handleMerkleProof(message) {
    if (message.proof) {
      console.log(`[✓] Received merkle proof for transaction ${message.txId.slice(0, 16)}...`);
      // Verify默克尔证明
      const isValid = this.verifyMerkleProof(message.proof, message.txId, message.blockHash);
      console.log(`Merkle proof verification: ${isValid ? 'VALID' : 'INVALID'}`);
    }
  }

  /**
   * Verify默克尔证明
   * @param {object} proof - 默克尔证明
   * @param {string} txId - transaction ID
   * @param {string} blockHash - block hash
   * @returns {boolean}
   */
  verifyMerkleProof(proof, txId, blockHash) {
    // 简化的默克尔证明Verify
    let currentHash = txId;
    
    for (const step of proof.steps) {
      if (step.left) {
        currentHash = this.hashPair(step.left, currentHash);
      } else {
        currentHash = this.hashPair(currentHash, step.right);
      }
    }
    
    return currentHash === proof.root && proof.root === blockHash;
  }

  /**
   * Calculate两个hash的组合hash
   * @param {string} left - 左hash
   * @param {string} right - 右hash
   * @returns {string}
   */
  hashPair(left, right) {
    const combined = left + right;
    return crypto.createHash('sha256').update(combined).digest('hex');
  }

  /**
   * 请求transactionstatus
   * @param {string} txId - transaction ID
   * @returns {Promise<object>}
   */
  async getTransactionStatus(txId) {
    return new Promise((resolve) => {
      this.send({
        type: 'GET_TRANSACTION_STATUS',
        txId
      }, (response) => {
        resolve(response);
      });
    });
  }

  /**
   * Processingtransactionstatus响应
   * @param {object} message - transactionstatusMessage
   */
  handleTransactionStatus(message) {
    if (message.status) {
      console.log(`[✓] Transaction ${message.txId.slice(0, 16)}... status: ${message.status}`);
      if (message.confirmations) {
        console.log(`Confirmations: ${message.confirmations}`);
      }
    }
  }

  /**
   * Checkaddressbalance
   * @param {string} address - address
   * @returns {Promise<object>}
   */
  async getAddressBalance(address) {
    return new Promise((resolve) => {
      this.send({
        type: 'GET_ADDRESS_BALANCE',
        address
      }, (response) => {
        resolve(response);
      });
    });
  }

  /**
   * Sendtransaction
   * @param {object} transaction - transaction对象
   * @returns {Promise<object>}
   */
  async sendTransaction(transaction) {
    return new Promise((resolve) => {
      this.send({
        type: 'SEND_TRANSACTION',
        transaction
      }, (response) => {
        resolve(response);
      });
    });
  }

  /**
   * Ensure data directory exists
   */
  ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * Savestatus到磁盘
   */
  saveState() {
    try {
      const state = {
        blockHeaders: this.blockHeaders,
        bestBlockHeight: this.bestBlockHeight,
        bestBlockHash: this.bestBlockHash,
        validatorSet: this.validatorSet,
        checkpoint: this.checkpoint,
        forkHeads: this.forkHeads,
        savedAt: Date.now()
      };
      
      fs.writeFileSync(path.join(DATA_DIR, 'state.json'), JSON.stringify(state, null, 2));
      console.log('[✓] State saved to disk');
    } catch (error) {
      console.error('[✗ Failed to save state:', error.message);
    }
  }

  /**
   * Load from diskstatus
   */
  loadState() {
    try {
      const statePath = path.join(DATA_DIR, 'state.json');
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        this.blockHeaders = state.blockHeaders || [];
        this.bestBlockHeight = state.bestBlockHeight || 0;
        this.bestBlockHash = state.bestBlockHash || null;
        this.validatorSet = state.validatorSet || [];
        this.checkpoint = state.checkpoint || null;
        this.forkHeads = state.forkHeads || [];
        console.log(`[✓] Loaded state from disk, ${this.blockHeaders.length} headers, best block #${this.bestBlockHeight}`);
      }
    } catch (error) {
      console.error('[✗] Failed to load state:', error.message);
    }
  }

  /**
   * Verify单个Block header
   * @param {object} header - Block header
   * @returns {boolean}
   */
  validateBlockHeader(header) {
    // VerifyhashVerify
    const headerHash = this.computeBlockHash(header);
    if (headerHash !== header.hash) {
      console.error(`✗ Invalid block hash at height ${header.height}`);
      return false;
    }
    
    // Verifyprevious blockhash
    if (header.height > 0) {
      const prevHeader = this.getHeaderByHeight(header.height - 1);
      if (prevHeader && prevHeader.hash !== header.prevHash) {
        console.error(`✗ Invalid previous hash at height ${header.height}`);
        return false;
      }
    }
    
    // VerifySign(如果有)
    if (header.signature && header.proposer) {
      try {
        const isValid = verifySignature(
          header.signature,
          Buffer.from(header.proposer, 'hex'),
          Buffer.from(header.proposerPublicKey, 'hex')
        );
        if (!isValid) {
          console.error(`✗ Invalid signature at height ${header.height}`);
          return false;
        }
      } catch (error) {
        console.error(`✗ Signature verification failed:`, error.message);
      }
    }
    
    return true;
  }

  /**
   * Calculateblock hash
   * @param {object} header - Block header
   * @returns {string}
   */
  computeBlockHash(header) {
    const headerCopy = { ...header };
    delete headerCopy.hash;
    delete headerCopy.signature;
    const headerStr = JSON.stringify(headerCopy, Object.keys(headerCopy).sort());
    return crypto.createHash('sha256').update(headerStr).digest('hex');
  }

  /**
   * via高度getBlock header
   * @param {number} height - block height
   * @returns {object|null}
   */
  getHeaderByHeight(height) {
    return this.blockHeaders.find(h => h.height === height) || null;
  }

  /**
   * viahashgetBlock header
   * @param {string} hash - block hash
   * @returns {object|null}
   */
  getHeaderByHash(hash) {
    return this.blockHeaders.find(h => h.hash === hash) || null;
  }

  /**
   * Verifyblock包含关系
   * @param {string} txId - transaction ID
   * @param {number} blockHeight - block height
   * @returns {Promise<boolean>}
   */
  async verifyTransactionInclusion(txId, blockHeight) {
    const proof = await this.getMerkleProof(txId);
    if (!proof || !proof.proof) {
      return false;
    }
    
    const header = this.getHeaderByHeight(blockHeight);
    if (!header) {
      return false;
    }
    
    return this.verifyMerkleProof(proof.proof, txId, header.txRoot);
  }

  /**
   * SetCheck点
   * @param {number} height - Check点高度
   * @param {string} hash - Check点hash
   */
  setCheckpoint(height, hash) {
    this.checkpoint = { height, hash, timestamp: Date.now() };
    console.log(`[✓] Checkpoint set at height ${height}`);
    this.saveState();
  }

  /**
   * VerifyCheck点之后的链
   * @returns {boolean}
   */
  verifyCheckpointChain() {
    if (!this.checkpoint) {
      return true;
    }
    
    const header = this.getHeaderByHeight(this.checkpoint.height);
    if (!header || header.hash !== this.checkpoint.hash) {
      console.error('✗ Checkpoint mismatch');
      return false;
    }
    
    return true;
  }

  /**
   * get确认数
   * @param {number} blockHeight - block height
   * @returns {number}
   */
  getConfirmations(blockHeight) {
    if (this.bestBlockHeight < blockHeight) {
      return 0;
    }
    return this.bestBlockHeight - blockHeight + 1;
  }

  /**
   * 同步Validator集合
   * @returns {Promise<void>}
   */
  async syncValidatorSet() {
    return new Promise((resolve) => {
      this.send({
        type: 'GET_VALIDATOR_SET'
      }, (response) => {
          if (response.validators) {
            this.validatorSet = response.validators;
            console.log(`[✓] Synced ${this.validatorSet.length} validators`);
          }
          resolve();
        });
    });
  }

  /**
   * Processing分叉检测与选择
   * @param {Array<object>} newHeaders - 新的Block header
   */
  handleForks(newHeaders) {
    // 简单的分叉检测
    for (const header of newHeaders) {
      const existing = this.getHeaderByHeight(header.height);
      if (existing && existing.hash !== header.hash) {
        // 发现分叉
        console.log(`[!] Fork detected at height ${header.height}`);
        
        // Storage分叉头
        this.forkHeads.push({
          height: header.height,
          hash: header.hash,
          prevHash: header.prevHash,
          timestamp: Date.now()
        });
        
        // 这里can实现更复杂的分叉选择Logic
        // 比如选择累计难度最高的链
      }
    }
  }

  /**
   * 关闭轻客户端
   */
  async close() {
    // Savestatus
    this.saveState();
    
    if (this.peer) {
      this.peer.close();
    }
    this.status = 'OFFLINE';
    console.log('Light client closed');
  }

  /**
   * 显示status
   */
  displayStatus() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  LIGHT CLIENT STATUS');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Node ID:          ${this.nodeId ? this.nodeId.slice(0, 24) + '...' : 'None'}`);
    console.log(`  Status:           ${this.status}`);
    console.log(`  Peer:             ${this.peer ? 'Connected' : 'Disconnected'}`);
    console.log(`  Block Height:     ${this.bestBlockHeight}`);
    console.log(`  Best Block:       ${this.bestBlockHash ? this.bestBlockHash.slice(0, 16) + '...' : 'None'}`);
    console.log(`  Headers Synced:   ${this.blockHeaders.length}`);
    console.log(`  Validators:       ${this.validatorSet.length}`);
    console.log(`  Checkpoint:       ${this.checkpoint ? `#${this.checkpoint.height}` : 'None'}`);
    console.log(`  Fork Heads:       ${this.forkHeads.length}`);
    console.log('═══════════════════════════════════════════════════\n');
  }
}

// Auto-start only when this module is run directly
if (import.meta.url.includes(process.argv[1].replace(/\\/g, '/')) || import.meta.url === `file://${process.argv[1]}`) {
  console.log('Starting Light Client...');
  const client = new LightClient();
  client.initialize('ws://localhost:9847').then(() => {
    console.log('Light Client initialized successfully');
    client.displayStatus();
    
    // 定期显示status
    setInterval(() => client.displayStatus(), 30000);
  }).catch(err => {
    console.error('Fatal error:', err);
    console.error('Error stack:', err.stack);
    process.exit(1);
  });
  
  // 防止进程退出
  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    client.close().catch(err => console.error('Error during shutdown:', err));
  });
  
  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    client.close().catch(err => console.error('Error during shutdown:', err));
  });
}

export { LightClient };
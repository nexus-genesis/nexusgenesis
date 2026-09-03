/**
 * NexusGenesis - P2P 通信层 (修复版)
 * 
 * 修复within容:
 * - SEC-003: 添加node身份authentication (Protocol-Zero 握手)
 * - Heartbeat check优化
 * - Message去重
 * - auto重连
 */

import WebSocket, { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { PQCWallet } from '../wallet/pqcWallet.js';
import { MessageHandlerRegistry } from './handlers/MessageHandlerRegistry.js';
// ImportMessageSend策略
import DirectSendingStrategy from './strategies/DirectSendingStrategy.js';
import BatchSendingStrategy from './strategies/BatchSendingStrategy.js';
import PrioritySendingStrategy from './strategies/PrioritySendingStrategy.js';
// Importservice
import EncryptionService from './services/EncryptionService.js';
import CompressionService from './services/CompressionService.js';
// Import职责链管理器
import MessageHandlerChainManager from './chain/MessageHandlerChainManager.js';
import { AgentDiscoveryMessageHandler } from './handlers/AgentDiscoveryMessageHandler.js';

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { getSeedNodes, getNetworkConfig, getTLSConfig } from '../config/mainnetConfig.js';

class KyberKEM {
  static generateKeyPair() {
    const { publicKey, secretKey } = ml_kem768.keygen();
    return {
      publicKey: Buffer.from(publicKey),
      privateKey: Buffer.from(secretKey)
    };
  }

  static encapsulate(publicKey) {
    const pk = new Uint8Array(publicKey);
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(pk);
    return {
      ciphertext: Buffer.from(cipherText),
      sharedSecret: Buffer.from(sharedSecret)
    };
  }

  static decapsulate(ciphertext, privateKey) {
    const ct = new Uint8Array(ciphertext);
    const sk = new Uint8Array(privateKey);
    const sharedSecret = ml_kem768.decapsulate(ct, sk);
    return Buffer.from(sharedSecret);
  }
}

const DEFAULT_PORT = 9847;
const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_DELAY = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;
const HANDSHAKE_TIMEOUT = 10000; // 10 秒握手timeout
const NODE_DISCOVERY_INTERVAL = 60000; // 60秒node发现间隔
const MAX_NODES = 50; // Maximumnode数量
const HEALTH_CHECK_INTERVAL = 30000; // 30秒健康Check间隔
const BATCH_INTERVAL = 100; // message批Process间隔(ms)
const MAX_BATCH_SIZE = 100; // Maximum批Processmessage数
const COMPRESSION_THRESHOLD = 1024; // 压缩threshold(字节)

// 种子node列表 - 从主网配置加载
function getSeedNodeList() {
  return getSeedNodes();
}

// 网络配置 - 从主网配置加载
function getP2PNetworkConfig() {
  return {
    enabled: true,
    maxPeers: getNetworkConfig().maxPeers || 50,
    discoveryInterval: getNetworkConfig().discoveryInterval || 60000,
    healthCheckInterval: getNetworkConfig().healthCheckInterval || 30000
  };
}

class P2PServer {
  constructor() {
    this.server = null;
    this.node = null;
    this.connections = new Map();
    this.peerAddresses = new Map();
    this.heartbeatTimers = new Map();
    this.reconnectTimers = new Map();
    this._startTime = null;
    this.batchTimers = new Map();
    this.batchQueues = new Map();
    this.seenMessages = new Set();
    
    // 待握手Connect (peerId -> {ws, timeout})
    this.pendingHandshakes = new Map();
    
    // node发现和Health check
    this.discoveryTimer = null;
    this.healthCheckTimer = null;
    this.discoveredNodes = new Set();
    this.nodeHealth = new Map(); // node健康status
    
    // 加密相关
    this.encryptionKeys = new Map(); // peerId -> sharedSecret
    this.kyberKeyPair = KyberKEM.generateKeyPair(); // 本node的ML-KEM-768key pair
    
    // networksecuritymonitor
    this.securityEvents = []; // security事件日志
    this.trafficStats = new Map(); // 流量统计
    this.suspiciousPeers = new Set(); // 可疑node
    this.securityCheckTimer = null; // securityCheck定时器
    
    // agent路由映射
    this.nodeIdToPeerId = new Map(); // nodeId -> peerId
    this.peerIdToNodeId = new Map(); // peerId -> nodeId

    // 跨网络Agent发现
    this.agentNetworkDiscovery = null;
    
    // service器Start时间
    this.startTime = Date.now();
    
    // Initializeservice
    this.encryptionService = new EncryptionService();
    this.compressionService = new CompressionService();
    
    // InitializeMessageHandlerRegistry
    this.handlerRegistry = new MessageHandlerRegistry(this);
    
    // InitializeMessageSend策略
    this.messageStrategies = {
      direct: new DirectSendingStrategy(this.encryptionService, this.compressionService, this.encryptionKeys),
      batch: new BatchSendingStrategy(this.encryptionService, this.compressionService, this.encryptionKeys),
      priority: new PrioritySendingStrategy(this.encryptionService, this.compressionService, this.encryptionKeys)
    };
    
    // InitializeDefault策略
    this.defaultStrategy = this.messageStrategies.priority;
    
    // InitializeMessageProcessing职责链
    this.messageHandlerChain = new MessageHandlerChainManager();
  }

  async start(node, port = DEFAULT_PORT) {
    this.node = node;
    this.port = port;
    this._startTime = Date.now();
    
    // 添加 Genesis node自身到路由映射
    if (node && node.nodeId) {
      this.nodeIdToPeerId.set(node.nodeId, 'genesis'); // using特殊的 peerId 标识 Genesis node
      this.peerIdToNodeId.set('genesis', node.nodeId);
      console.log(`[✓] Added Genesis node to routing mapping: ${node.nodeId.slice(0, 24)}... -> genesis`);
    }
    
    return new Promise((resolve, reject) => {
      try {
        // Listen在所有network接口上, allow外部Connect
        this.server = new WebSocketServer({ port: this.port, host: '0.0.0.0' });
        
        this.server.on('connection', (ws, req) => {
          console.log(`[DEBUG] P2P connection request received from ${req?.connection?.remoteAddress}:${req?.connection?.remotePort}`);
          this.handleConnection(ws, req);
        });
        
        this.server.on('error', (err) => {
          console.error('P2P Server error:', err.message);
          reject(err);
        });
        
        this.server.on('listening', async () => {
          console.log(`[DEBUG] P2P Server listening on ${this.port}`);
          
          // Startnode发现
          this.startNodeDiscovery();
          
          // StartHealth check
          this.startHealthCheck();
          
          // StartsecurityCheck
          this.startSecurityCheck();
          
          // 尝试Connect种子node
          await this.connectToSeedNodes();
          
          resolve(true);
        });
        
      } catch (err) {
        reject(err);
      }
    });
  }

  setAgentNetworkDiscovery(instance) {
    this.agentNetworkDiscovery = instance;
    const handler = new AgentDiscoveryMessageHandler(this, instance);
    this.handlerRegistry.register('AGENT_ANNOUNCE', handler);
    this.handlerRegistry.register('AGENT_QUERY', handler);
    this.handlerRegistry.register('AGENT_QUERY_RESPONSE', handler);
    this.handlerRegistry.register('AGENT_SYNC_REQUEST', handler);
    this.handlerRegistry.register('AGENT_SYNC_RESPONSE', handler);
    this.handlerRegistry.register('AGENT_OFFLINE', handler);
  }

  handleConnection(ws, req, address = null) {
    const peerId = crypto.randomUUID();
    console.log(`[✓] New peer connected: ${peerId} from ${req?.connection?.remoteAddress || 'unknown'}`);
    
    // Initial state: 待握手
    const conn = { 
      ws, 
      status: 'handshaking',
      address,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      remoteNodeId: null,
      remotePublicKey: null,
      connectionAttempts: 0,
      healthScore: 100
    };
    
    this.connections.set(peerId, conn);
    
    // Set握手Timeout
    const handshakeTimeout = setTimeout(() => {
      if (this.connections.has(peerId) && this.connections.get(peerId).status === 'handshaking') {
        console.log(`[!] Handshake timeout for peer ${peerId}, closing connection`);
        ws.close(1002, 'Handshake timeout');
      }
    }, HANDSHAKE_TIMEOUT);
    
    this.pendingHandshakes.set(peerId, { ws, timeout: handshakeTimeout });
    
    // Send握手请求
    const challenge = crypto.randomBytes(32).toString('hex');
    this.send(peerId, {
      type: 'HELLO',
      nodeId: this.node.nodeId,
      publicKey: this.node.wallet.publicKey.toString('hex'),
      version: '1.0.0',
      epoch: getEpoch(),
      challenge: challenge,
      timestamp: Date.now()
    });
    
    // Save挑战到Connect对象, 以便Verify响应
    conn.challengeSent = challenge;
    
    ws.on('message', async (data) => {
      try {
        await this.handleMessage(peerId, data);
      } catch (error) {
        console.error(`[!] Error handling message from peer ${peerId}:`, error.message);
        // 不关闭Connect, 继续Processing其他Message
      }
    });
    
    ws.on('close', (code, reason) => {
      console.log(`[!] Peer disconnected: ${peerId}, code: ${code}, reason: ${reason}`);
      this.cleanupPeer(peerId);
      
      if (address && this.peerAddresses.has(address)) {
        this.scheduleReconnect(address);
      }
    });
    
    ws.on('error', (err) => {
      console.error(`[!] Peer ${peerId} error:`, err.message);
      // 不立即关闭Connect, 让close事件Processing
    });
  }

  startHeartbeat(peerId, ws) {
    if (this.heartbeatTimers.has(peerId)) {
      clearInterval(this.heartbeatTimers.get(peerId));
    }
    
    let missedPongs = 0;
    const MAX_MISSED_PONGS = 3;
    
    const timer = setInterval(() => {
      const conn = this.connections.get(peerId);
      if (!conn) {
        clearInterval(timer);
        return;
      }
      
      if (ws.readyState === WebSocket.OPEN) {
        // Check上次心跳响应时间
        const now = Date.now();
        if (now - conn.lastHeartbeat > HEARTBEAT_INTERVAL * 1.5) {
          missedPongs++;
          console.log(`[!] Missing pong from peer ${peerId}, missed: ${missedPongs}`);
          
          if (missedPongs >= MAX_MISSED_PONGS) {
            console.log(`[!] Too many missed pongs from peer ${peerId}, closing connection`);
            ws.close(1008, 'No heartbeat response');
            clearInterval(timer);
            return;
          }
        }
        
        this.send(peerId, { 
          type: 'PING', 
          timestamp: Date.now(),
          nodeId: this.node.nodeId
        });
      } else {
        clearInterval(timer);
      }
    }, HEARTBEAT_INTERVAL);
    
    this.heartbeatTimers.set(peerId, timer);
  }

  handlePong(peerId) {
    const conn = this.connections.get(peerId);
    if (conn) {
      conn.lastHeartbeat = Date.now();
      conn.status = 'alive';
      // 重置健康分数
      conn.healthScore = Math.min(100, conn.healthScore + 5);
      console.log(`[✓] Received pong from peer ${peerId}, health: ${conn.healthScore}`);
    }
  }

  cleanupPeer(peerId) {
    if (this.heartbeatTimers.has(peerId)) {
      clearInterval(this.heartbeatTimers.get(peerId));
      this.heartbeatTimers.delete(peerId);
    }
    
    if (this.pendingHandshakes.has(peerId)) {
      clearTimeout(this.pendingHandshakes.get(peerId).timeout);
      this.pendingHandshakes.delete(peerId);
    }
    
    // 清理批Processing相关资源
    if (this.batchTimers.has(peerId)) {
      clearTimeout(this.batchTimers.get(peerId));
      this.batchTimers.delete(peerId);
    }
    
    this.batchQueues.delete(peerId);
    
    // 清理agent路由映射
    const nodeId = this.peerIdToNodeId.get(peerId);
    if (nodeId) {
      this.nodeIdToPeerId.delete(nodeId);
      this.peerIdToNodeId.delete(peerId);
      console.log(`[✓] Removed routing mapping for ${nodeId.slice(0, 24)}...`);
    }
    
    // Clean up address mapping so future connectToPeer calls are not blocked
    const conn = this.connections.get(peerId);
    if (conn && conn.address) {
      this.peerAddresses.delete(conn.address);
    }

    // Clean up encryption key for this peer
    this.encryptionKeys.delete(peerId);

    this.connections.delete(peerId);

    if (this.node) {
      this.node.peers.delete(peerId);

      // 清理node身份映射和挑战Verifystatus
      const identity = this.node.peerIdentityMap.get(peerId);
      if (identity) {
        this.node._nodeIdToPeerId.delete(identity.nodeId);
      }
      this.node.peerIdentityMap.delete(peerId);
      this.node.clearPeerChallenge(peerId);
    }
  }
  
  /**
   * 根据nodeIDget对应的peerId
   * @param {string} nodeId - nodeID
   * @returns {string|null} - 对应的peerId
   */
  getPeerIdByNodeId(nodeId) {
    return this.nodeIdToPeerId.get(nodeId) || null;
  }
  
  /**
   * 根据peerIdget对应的nodeID
   * @param {string} peerId - peerId
   * @returns {string|null} - 对应的nodeID
   */
  getNodeIdByPeerId(peerId) {
    return this.peerIdToNodeId.get(peerId) || null;
  }
  
  /**
   * via路由Send message
   * @param {string} routeAddress - 路由address
   * @param {object} message - Message对象
   */
  sendToRoute(routeAddress, message) {
    // 查找路由node的Connect
    for (const [peerId, conn] of this.connections) {
      if (conn.address === routeAddress && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        this.send(peerId, message);
        return;
      }
    }
    
    // 如果没有直接Connect, 尝试建立Connect
    console.log(`[!] Route ${routeAddress} not connected, trying to establish connection`);
    this.connectToPeer(routeAddress).then(peerId => {
      if (peerId) {
        setTimeout(() => {
          this.send(peerId, message);
        }, 1000); // etc.待Connect建立
      }
    }).catch(err => {
      console.error(`[!] Failed to connect to route ${routeAddress}:`, err.message);
    });
  }

  scheduleReconnect(address) {
    const info = this.peerAddresses.get(address) || { attempts: 0 };
    
    if (info.attempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log(`Max reconnect attempts reached for ${address}`);
      this.peerAddresses.delete(address);
      return;
    }
    
    if (this.reconnectTimers.has(address)) {
      clearTimeout(this.reconnectTimers.get(address));
    }
    
    const timer = setTimeout(async () => {
      console.log(`Reconnecting to ${address} (attempt ${info.attempts + 1})...`);
      try {
        await this.connectToPeer(address);
        this.peerAddresses.set(address, { attempts: 0 });
      } catch (e) {
        info.attempts++;
        this.peerAddresses.set(address, info);
        this.scheduleReconnect(address);
      }
    }, RECONNECT_DELAY * (info.attempts + 1));
    
    this.reconnectTimers.set(address, timer);
  }

  /**
   * CheckMessage是否符合 Protocol-Zero 格式
   * @param {object} msg - Message对象
   * @returns {boolean} - 是否符合格式
   */
  isProtocolZeroFormat(msg) {
    // 核心networkMessagetype
    const validMessageTypes = [
      'HELLO', 'HELLO_ACK', 'PING', 'PONG',
      'TRANSACTION', 'TX_REJECTED',
      'GET_STATUS', 'STATUS_UPDATE',
      'GET_MEMPOOL', 'MEMPOOL_SYNC',
      'PROTOCOL_ZERO', 'JOIN_SWARM', 'SWARM_ACK',
      'BATCH_MESSAGE', 'COMPRESSED_MESSAGE',
      'ENCRYPTED_MESSAGE',
      'BLOCK', 'BLOCK_CONFIRMATION', 'GET_BLOCKS', 'BLOCKS_RESPONSE',
      'GET_NODE_LIST', 'NODE_LIST',
      'LIGHT_CLIENT_HELLO', 'LIGHT_CLIENT_HELLO_ACK',
      'GET_BLOCK_HEADERS', 'BLOCK_HEADERS',
      'GET_MERKLE_PROOF', 'MERKLE_PROOF',
      'GET_TRANSACTION_STATUS', 'TRANSACTION_STATUS',
      'GET_ADDRESS_BALANCE', 'SEND_TRANSACTION',
      'CROSS_CHAIN_MESSAGE', 'CROSS_CHAIN_RESPONSE',
      'AGENT_MESSAGE', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_ACK',
      'KEY_EXCHANGE'
    ];
    
    // Check是否为有效的Messagetype
    if (validMessageTypes.includes(msg.type)) {
      return true;
    }
    
    // Check是否为带有protocol字段的Message
    if (msg.protocol === 'NG-0') {
      return true;
    }
    
    return false;
  }

  async handleMessage(peerId, data) {
    try {
      let messageStr = data.toString();
      const bytesReceived = messageStr.length;
      this.updateTrafficStats(peerId, 0, bytesReceived);
      
      let msg;
      
      // Processing压缩Message
      try {
        msg = JSON.parse(messageStr);
        if (msg.type === 'COMPRESSED_MESSAGE') {
          // usingCompressionService解压
          const decompressedStr = await this.compressionService.decompressMessage(msg);
          msg = JSON.parse(decompressedStr);
          console.log(`Decompressed message: ${msg.originalSize || decompressedStr.length} -> ${msg.compressedSize || messageStr.length} bytes`);
        }
        
        // Processing加密Message
        if (msg.type === 'ENCRYPTED_MESSAGE') {
          const sharedSecret = this.encryptionKeys.get(peerId);
          if (sharedSecret) {
            // usingEncryptionService解密
            const decryptedData = this.encryptionService.decryptMessage(msg.data, sharedSecret);
            msg = JSON.parse(decryptedData);
            console.log('Decrypted encrypted message');
          } else {
            // Peer hasn't completed key exchange yet — silently drop
            return;
          }
        }
      } catch (err) {
        console.error('Message parse error:', err.message);
        return;
      }
      
      // Processing批ProcessingMessage
      if (msg.type === 'BATCH_MESSAGE') {
        console.log(`Processing batch message with ${msg.messages.length} messages`);
        for (const batchMsg of msg.messages) {
          // Processing批ProcessingMessage中的GET_NODE_LISTMessage
          if (batchMsg.type === 'GET_NODE_LIST') {
            console.log(`Node list requested by ${peerId} (batch)`);
            this.handleGetNodeList(peerId);
            continue;
          }
          await this.handleSingleMessage(peerId, batchMsg);
        }
        return;
      }
      
      // Processing单个Message
      await this.handleSingleMessage(peerId, msg);
    } catch (err) {
      console.error('Message handling error:', err.message);
      // 避免陷入死循环: 不Senderror响应
    }
  }
  
  async handleSingleMessage(peerId, msg) {
    try {
      if (msg.type === 'KEY_EXCHANGE') {
        await this.handleKeyExchange(peerId, msg);
        return;
      }
      
      // using职责链ProcessingMessage
      const context = {
        seenMessages: this.seenMessages,
        handlerRegistry: this.handlerRegistry,
        node: this.node,
        p2pServer: this
      };
      
      await this.messageHandlerChain.handleMessage(peerId, msg, context);
      
    } catch (err) {
      console.error('Single message handling error:', err.message);
    }
  }

  // ==================== SEC-003: Protocol-Zero 身份握手 ====================

  /**
   * Processing收到的 HELLO Message
   * @param {string} peerId - Peer nodes ID
   * @param {object} msg - HELLO Message
   */
  async handleHandshake(peerId, msg) {
    console.log(`Handshake received from ${peerId}`);
    
    const conn = this.connections.get(peerId);
    if (!conn) return;
    
    try {
      // VerifyMessage结构
      if (!msg.nodeId || !msg.publicKey || !msg.challenge) {
        console.log(`[!] Invalid handshake from ${peerId}: missing fields`);
        conn.ws.close(1002, 'Invalid handshake');
        return;
      }
      
      console.log(`Handshake details - Node ID: ${msg.nodeId.slice(0, 24)}..., Public Key length: ${msg.publicKey.length} chars`);
      
      // Verifyaddress格式
      const { validateAddress } = await import('../wallet/addressUtils.js');
      const addrValidation = validateAddress(msg.nodeId);
      if (!addrValidation.valid) {
        console.log(`[!] Invalid address in handshake: ${addrValidation.reason}`);
        conn.ws.close(1002, 'Invalid address');
        return;
      }
      
      // Verifypublic key格式
      if (typeof msg.publicKey !== 'string' || msg.publicKey.length < 100) {
        console.log(`[!] Invalid public key format: length ${msg.publicKey.length}`);
        conn.ws.close(1002, 'Invalid public key');
        return;
      }
      
      // Save远程nodeinfo
      conn.remoteNodeId = msg.nodeId;
      
      // security地转换public key
      try {
        conn.remotePublicKey = Buffer.from(msg.publicKey, 'hex');
        console.log(`Successfully parsed public key: ${conn.remotePublicKey.length} bytes`);
      } catch (error) {
        console.log(`[!] Failed to parse public key: ${error.message}`);
        conn.ws.close(1002, 'Invalid public key format');
        return;
      }
      
      // 保存对方发来的 challenge（用于签名），但不能覆盖 conn.challengeSent
      // conn.challengeSent 保存的是我们自己发出的 challenge，用于验证对方的 HELLO_ACK
      conn.challengeReceived = msg.challenge;

      // Generate挑战响应Sign — 必须签署对方发来的 challenge（msg.challenge），
      // 而非新生成的 responseChallenge，否则对方验证签名时永远失败
      const responseChallenge = crypto.randomBytes(32).toString('hex');
      console.log(`Generating signature for peer challenge: ${msg.challenge.slice(0, 16)}...`);

      const signature = await this.node.wallet.sign(msg.challenge);
      console.log(`Generated signature: ${signature.slice(0, 32)}...`);
      
      // GenerateKyberkey pairforkey协商
      const kyberKeyPair = KyberKEM.generateKeyPair();
      
      // Send HELLO_ACK
      this.send(peerId, {
        type: 'HELLO_ACK',
        nodeId: this.node.nodeId,
        publicKey: this.node.wallet.publicKey.toString('hex'),
        challenge: responseChallenge,
        response: signature, // 对对方挑战的响应
        kyberPublicKey: kyberKeyPair.publicKey.toString('hex'), // SendKyberpublic key
        accepted: true
      });
      console.log(`Sent HELLO_ACK to ${peerId}`);
      
      // etc.待对方响应并Verify
      conn.handshakeData = {
        challenge: msg.challenge,
        remoteNodeId: msg.nodeId,
        remotePublicKey: conn.remotePublicKey,
        kyberPrivateKey: kyberKeyPair.privateKey // SaveKyberprivate key
      };
    } catch (error) {
      console.error(`Error handling handshake: ${error.message}`);
      console.error(error.stack);
      conn.ws.close(1002, 'Internal error');
    }
  }

  /**
   * Processing HELLO_ACK Message(我们发起的握手的响应)
   * @param {string} peerId - Peer nodes ID
   * @param {object} msg - HELLO_ACK Message
   */
  async handleHandshakeAck(peerId, msg) {
    const pending = this.pendingHandshakes.get(peerId);
    if (!pending) return;
    
    const conn = this.connections.get(peerId);
    if (!conn) return;
    
    console.log(`Handshake acknowledged from ${msg.nodeId}`);
    console.log(`Handshake ACK details - Response length: ${msg.response.length} chars, Public Key length: ${msg.publicKey.length} chars`);
    
    let remotePublicKey;
    
    // Verify响应Sign
    try {
      // VerifyMessage结构
      if (!msg.nodeId || !msg.publicKey || !msg.response || !msg.challenge) {
        console.log(`[!] Invalid handshake ACK: missing fields`);
        conn.ws.close(1002, 'Invalid handshake ACK');
        return;
      }
      
      // security地转换public key
      try {
        remotePublicKey = Buffer.from(msg.publicKey, 'hex');
        console.log(`Successfully parsed public key: ${remotePublicKey.length} bytes`);
      } catch (error) {
        console.log(`[!] Failed to parse public key: ${error.message}`);
        conn.ws.close(1002, 'Invalid public key format');
        return;
      }
      
      // Verifypublic keylength
      if (remotePublicKey.length < 100) {
        console.log(`[!] Invalid public key length: ${remotePublicKey.length} bytes`);
        conn.ws.close(1002, 'Invalid public key');
        return;
      }
      
      // Verify挑战和响应
      if (!conn.challengeSent) {
        console.log(`[!] No challenge sent for this connection`);
        conn.ws.close(1002, 'No challenge sent');
        return;
      }
      
      console.log(`Verifying signature for challenge: ${conn.challengeSent.slice(0, 16)}...`);
      console.log(`Using public key: ${remotePublicKey.toString('hex').slice(0, 32)}...`);
      
      // 尝试VerifySign
      try {
        const isValid = await PQCWallet.verify(
          conn.challengeSent,
          msg.response,
          remotePublicKey
        );
        
        console.log(`Signature verification result: ${isValid}`);
        
        if (!isValid) {
          console.log(`[!] Handshake signature verification failed for ${peerId} — rejecting connection`);
          conn.ws.close(1002, 'Signature verification failed');
          return;
        }
      } catch (error) {
        console.log(`[!] Handshake signature verification error: ${error.message} — rejecting connection`);
        conn.ws.close(1002, 'Signature verification failed');
        return;
      }
      
      // ExecuteKyberkey协商
      if (msg.kyberPublicKey) {
        console.log('Performing Kyber key exchange');
        try {
          const kyberPublicKey = Buffer.from(msg.kyberPublicKey, 'hex');
          // usingKyber封装Generate共享key
          const { sharedSecret, ciphertext: kyberCiphertext } = KyberKEM.encapsulate(kyberPublicKey);
          this.encryptionKeys.set(peerId, sharedSecret);
          console.log('ML-KEM-768 key exchange completed, encryption enabled');
          
          this.send(peerId, {
            type: 'KEY_EXCHANGE',
            kyberCiphertext: kyberCiphertext.toString('hex')
          });
        } catch (error) {
          console.error('Kyber key exchange failed:', error.message);
          // 即使key协商Failed, 也继续Connect(降级到非加密通信)
        }
      }
    } catch (error) {
      console.log(`[!] Handshake verification error: ${error.message}`);
      console.log(error.stack);
      conn.ws.close(1003, 'Verification failed');
      return;
    }
    
    // 握手success
    clearTimeout(pending.timeout);
    this.pendingHandshakes.delete(peerId);
    
    conn.status = 'connected';
    conn.remoteNodeId = msg.nodeId;
    conn.remotePublicKey = remotePublicKey;
    conn.lastHeartbeat = Date.now();
    
    // Registernode身份
    if (this.node) {
      this.node.registerPeerIdentity(peerId, msg.nodeId, remotePublicKey);
      this.node.peers.set(peerId, conn);
    }
    
    // Start心跳
    this.startHeartbeat(peerId, conn.ws);
    
    console.log(`[✓] Peer ${msg.nodeId.slice(0, 24)}... verified and connected`);
    
    // 请求status
    this.send(peerId, { type: 'GET_STATUS' });
  }

  async handleKeyExchange(peerId, msg) {
    const conn = this.connections.get(peerId);
    if (!conn || !conn.handshakeData) {
      console.log(`[!] KEY_EXCHANGE received without active handshake from ${peerId}`);
      return;
    }

    const { kyberPrivateKey } = conn.handshakeData;
    if (!kyberPrivateKey) {
      console.log(`[!] No Kyber private key for peer ${peerId}`);
      return;
    }

    try {
      const kyberCiphertext = Buffer.from(msg.kyberCiphertext, 'hex');
      const sharedSecret = KyberKEM.decapsulate(kyberCiphertext, kyberPrivateKey);
      this.encryptionKeys.set(peerId, sharedSecret);
      console.log(`[✓] ML-KEM-768 shared secret established with ${peerId}`);

      // Complete the responder (client) side handshake.
      // The initiator (server) side is finalized in HandshakeHandler.handleHelloAck.
      // Only finalize if not already connected (avoid double-finalize).
      if (conn.status !== 'connected') {
        const pending = this.pendingHandshakes.get(peerId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingHandshakes.delete(peerId);
        }

        conn.status = 'connected';
        conn.lastHeartbeat = Date.now();
        conn.verified = true;

        // Register node identity (remoteNodeId/remotePublicKey set in handleHello)
        if (conn.remoteNodeId && conn.remotePublicKey && this.node) {
          this.node.markPeerChallengeVerified(peerId);
          this.node.registerPeerIdentity(peerId, conn.remoteNodeId, conn.remotePublicKey);
          this.node.peers.set(peerId, conn);
        }

        // Start heartbeat
        this.startHeartbeat(peerId, conn.ws);

        console.log(`[✓] Responder handshake completed with ${conn.remoteNodeId ? conn.remoteNodeId.slice(0, 24) + '...' : peerId}`);

        // Request peer status (triggers block sync if peer is ahead)
        this.send(peerId, { type: 'GET_STATUS' });
      }
    } catch (error) {
      console.error(`[!] ML-KEM-768 decapsulate failed for ${peerId}:`, error.message);
    }
  }

  // ==================== Send/广播 ====================

  send(peerId, message) {
    const conn = this.connections.get(peerId);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    
    // usingDefault策略Send message
    this.defaultStrategy.send(peerId, message, conn, this.encryptionKeys);
    
    // Update流量统计
    this.updateTrafficStats(peerId, JSON.stringify(message).length);
  }
  
  sendDirect(peerId, message) {
    const conn = this.connections.get(peerId);
    if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      // 直接using直接Send策略
      this.messageStrategies.direct.send(peerId, message, conn, this.encryptionKeys);
      
      // Update流量统计
      this.updateTrafficStats(peerId, JSON.stringify(message).length);
    }
  }

  broadcast(message, excludePeerId = null) {
    for (const [peerId, conn] of this.connections) {
      if (peerId !== excludePeerId && conn.ws.readyState === WebSocket.OPEN) {
        this.send(peerId, message);
      }
    }
  }

  async connectToSeedNodes() {
    console.log('Connecting to seed nodes...');
    for (const seed of getSeedNodeList()) {
      // 跳过自己的address
      if (seed.includes(`:${this.port}`)) continue;
      
      try {
        console.log(`Connecting to seed node: ${seed}`);
        await this.connectToPeer(seed);
      } catch (error) {
        console.log(`Failed to connect to seed node ${seed}: ${error.message}`);
      }
    }
  }

  async connectToPeer(address) {
    console.log(`[DEBUG] Attempting to connect to peer at ${address}`);
    // Check是否已经Connect到该address
    if (this.peerAddresses.has(address)) {
      console.log(`Already connected or connecting to ${address}`);
      return null;
    }
    
    // CheckNode count是否达到上限
    if (this.connections.size >= MAX_NODES) {
      console.log(`Max nodes reached (${MAX_NODES}), skipping connection to ${address}`);
      return null;
    }
    
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(address);
      
      ws.on('open', () => {
        const peerId = crypto.randomUUID();
        const conn = { 
          ws, 
          address,
          status: 'handshaking',
          connectedAt: Date.now(),
          lastHeartbeat: Date.now(),
          healthScore: 100 // 初始健康分数
        };
        
        this.connections.set(peerId, conn);
        this.peerAddresses.set(address, { attempts: 0 });
        this.discoveredNodes.add(address);
        
        // Set握手Timeout
        const timeout = setTimeout(() => {
          if (this.connections.has(peerId) && this.connections.get(peerId).status === 'handshaking') {
            ws.close(1002, 'Handshake timeout');
            reject(new Error('Handshake timeout'));
          }
        }, HANDSHAKE_TIMEOUT);
        
        this.pendingHandshakes.set(peerId, { ws, timeout });

        // Client does NOT send HELLO — the server side (handleConnection) initiates.
        // Sending HELLO from both sides causes dual key exchanges that overwrite
        // each other, resulting in mismatched encryption keys ("bad decrypt" errors).
        // The client just waits for the server's HELLO, responds with HELLO_ACK,
        // and completes the handshake in handleKeyExchange.

        resolve(peerId);
      });
      
      ws.on('message', async (data) => {
        const connEntry = Array.from(this.connections.entries()).find(([_, v]) => v.ws === ws);
        if (connEntry) {
          await this.handleMessage(connEntry[0], data);
        }
      });
      
      ws.on('close', () => {
        const connEntry = Array.from(this.connections.entries()).find(([_, v]) => v.ws === ws);
        if (connEntry) {
          this.cleanupPeer(connEntry[0]);
          this.scheduleReconnect(address);
        }
      });
      
      ws.on('error', (err) => {
        console.error(`Failed to connect to ${address}:`, err.message);
        reject(err);
      });
    });
  }

  async syncMempoolWithPeers() {
    this.broadcast({ type: 'GET_MEMPOOL' });
  }

  broadcastTransaction(tx) {
    this.broadcast({ type: 'TRANSACTION', tx });
  }

  // ==================== node发现与路由优化 ====================

  // node路由表
  routingTable = new Map(); // nodeId -> { address, healthScore, lastSeen, latency }
  
  // Kademlia风格的node桶
  nodeBuckets = new Map(); // 距离 -> node列表

  startNodeDiscovery() {
    this.discoveryTimer = setInterval(() => {
      this.discoverNodes();
    }, NODE_DISCOVERY_INTERVAL);
    console.log('Node discovery started');
  }

  async discoverNodes() {
    // 向所有Connect的node请求node列表
    this.broadcast({ type: 'GET_NODE_LIST' });
    
    // 尝试Connect新发现的node, 优先选择健康分数高的node
    const sortedNodes = Array.from(this.discoveredNodes)
      .map(node => {
        const routingInfo = this.routingTable.get(node);
        return {
          address: node,
          healthScore: routingInfo ? routingInfo.healthScore : 100,
          lastSeen: routingInfo ? routingInfo.lastSeen : 0
        };
      })
      .sort((a, b) => {
        // 优先考虑健康分数, 然后考虑最后看到的时间
        if (b.healthScore !== a.healthScore) {
          return b.healthScore - a.healthScore;
        }
        return b.lastSeen - a.lastSeen;
      })
      .slice(0, 15); // 每次最多尝试Connect15个node
    
    // 限制同时Connect的数量, 避免network拥塞
    const concurrentConnections = 3;
    const batches = [];
    for (let i = 0; i < sortedNodes.length; i += concurrentConnections) {
      batches.push(sortedNodes.slice(i, i + concurrentConnections));
    }
    
    for (const batch of batches) {
      const connectionPromises = batch.map(async (node) => {
        if (!this.peerAddresses.has(node.address)) {
          try {
            await this.connectToPeer(node.address);
            return { success: true, address: node.address };
          } catch (error) {
            console.log(`Failed to connect to discovered node ${node.address}: ${error.message}`);
            // UpdateNode healthstatus
            this.updateNodeHealth(node.address, -10);
            return { success: false, address: node.address, error: error.message };
          }
        }
        return { success: false, address: node.address, reason: 'Already connected' };
      });
      
      await Promise.all(connectionPromises);
      // etc.待一段时间再进行下一批Connect
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * UpdateNode healthstatus
   * @param {string} nodeAddress - nodeaddress
   * @param {number} scoreChange - 分数变化
   */
  updateNodeHealth(nodeAddress, scoreChange) {
    const existingInfo = this.routingTable.get(nodeAddress) || {
      address: nodeAddress,
      healthScore: 100,
      lastSeen: Date.now(),
      latency: 0
    };
    
    existingInfo.healthScore = Math.max(0, Math.min(100, existingInfo.healthScore + scoreChange));
    existingInfo.lastSeen = Date.now();
    
    this.routingTable.set(nodeAddress, existingInfo);
    
    // UpdateKademlia桶
    this.updateNodeBuckets(nodeAddress, existingInfo);
  }

  /**
   * UpdateKademlia风格的node桶
   * @param {string} nodeAddress - nodeaddress
   * @param {object} nodeInfo - nodeinfo
   */
  updateNodeBuckets(nodeAddress, nodeInfo) {
    // 简化的Kademlia实现, based onnodeaddress的hash距离
    const nodeHash = crypto.createHash('sha256').update(nodeAddress).digest('hex');
    const selfHash = crypto.createHash('sha256').update(this.node.nodeId).digest('hex');
    
    // Calculate距离(简化为前8位的异或值)
    const distance = parseInt(nodeHash.substring(0, 8), 16) ^ parseInt(selfHash.substring(0, 8), 16);
    const bucketIndex = Math.floor(Math.log2(distance + 1));
    
    if (!this.nodeBuckets.has(bucketIndex)) {
      this.nodeBuckets.set(bucketIndex, []);
    }
    
    const bucket = this.nodeBuckets.get(bucketIndex);
    const existingIndex = bucket.findIndex(n => n.address === nodeAddress);
    
    if (existingIndex >= 0) {
      // Update现有node
      bucket[existingIndex] = nodeInfo;
    } else {
      // 添加新node, 保持桶大小限制
      if (bucket.length < 8) { // 每个桶最多8个node
        bucket.push(nodeInfo);
      } else {
        // 替换健康分数最低的node
        const worstIndex = bucket.reduce((minIndex, node, index) => 
          node.healthScore < bucket[minIndex].healthScore ? index : minIndex, 0);
        if (nodeInfo.healthScore > bucket[worstIndex].healthScore) {
          bucket[worstIndex] = nodeInfo;
        }
      }
    }
  }

  /**
   * 智能路由选择
   * @param {string} targetNodeId - 目标nodeID
   * @returns {string|null} 最佳路由nodeaddress
   */
  selectBestRoute(targetNodeId) {
    // Calculate目标node与本node的距离
    const targetHash = crypto.createHash('sha256').update(targetNodeId).digest('hex');
    const selfHash = crypto.createHash('sha256').update(this.node.nodeId).digest('hex');
    const targetDistance = parseInt(targetHash.substring(0, 8), 16) ^ parseInt(selfHash.substring(0, 8), 16);
    
    // 查找候选node
    const candidates = [];
    
    for (const [distance, nodes] of this.nodeBuckets) {
      for (const node of nodes) {
        if (node.healthScore > 50) {
          const nodeDistance = Math.abs(distance - targetDistance);
          const score = this.calculateRouteScore(node, nodeDistance);
          candidates.push({ node, distance: nodeDistance, score });
        }
      }
    }
    
    // 按分数排序, 选择最佳路由
    candidates.sort((a, b) => b.score - a.score);
    
    return candidates.length > 0 ? candidates[0].node.address : null;
  }
  
  /**
   * Calculate路由分数
   * @param {object} node - nodeinfo
   * @param {number} distance - 距离
   * @returns {number} 路由分数
   */
  calculateRouteScore(node, distance) {
    // Base分数 = 健康分数
    let score = node.healthScore;
    
    // 距离因子: 距离越近分数越高
    const distanceFactor = Math.max(0, 100 - (distance / 1000000));
    score += distanceFactor * 0.3;
    
    // 新鲜度因子: 最近看到的node分数更高
    const freshness = Math.min(100, (Date.now() - node.lastSeen) / 60000); // 分钟
    const freshnessFactor = Math.max(0, 100 - freshness);
    score += freshnessFactor * 0.2;
    
    // 延迟因子: 延迟越低分数越高
    const latencyFactor = Math.max(0, 100 - node.latency);
    score += latencyFactor * 0.2;
    
    // Connect稳定性因子: based on健康分数
    score += (node.healthScore / 100) * 20;
    
    // 历史Connected率因子
    const connectionSuccessFactor = node.connectionSuccessRate ? node.connectionSuccessRate * 10 : 10;
    score += connectionSuccessFactor;
    
    return score;
  }

  /**
   * networkstatusmonitor
   * @returns {object} networkstatusinfo
   */
  getNetworkStatus() {
    const totalPeers = this.connections.size;
    const activePeers = Array.from(this.connections.values()).filter(conn => conn.status === 'connected').length;
    const healthyPeers = Array.from(this.connections.values()).filter(conn => conn.healthScore > 70).length;
    
    const totalTraffic = Array.from(this.trafficStats.values()).reduce((sum, stats) => {
      return sum + stats.bytesSent + stats.bytesReceived;
    }, 0);
    
    const averageHealthScore = totalPeers > 0 ? 
      Array.from(this.connections.values()).reduce((sum, conn) => sum + conn.healthScore, 0) / totalPeers : 0;
    
    return {
      totalPeers,
      activePeers,
      healthyPeers,
      averageHealthScore: Math.round(averageHealthScore),
      totalTraffic,
      routingTableSize: this.routingTable.size,
      discoveredNodes: this.discoveredNodes.size,
      securityEvents: this.securityEvents.length,
      uptime: Date.now() - this.startTime
    };
  }

  /**
   * 发射AGENT_JOINED事件
   * @param {object} msg - Protocol-Zero信号Message
   * @param {string} nodeId - nodeID
   * @param {string} agentIdentity - agent身份
   */
  async emitAgentJoinedEvent(msg, nodeId, agentIdentity) {
    try {
      const { AgentJoinedEvent, EventLogger } = await import('../protocol/events.js');
      const crypto = await import('crypto');
      
      // CreateAGENT_JOINED事件
      const eventData = {
        event_id: crypto.randomUUID(),
        timestamp: Date.now(),
        agent_id: nodeId,
        node_address: msg.node_address || nodeId,
        public_key: msg.public_key,
        capabilities: msg.capabilities || [],
        agent_identity: agentIdentity,
        intent: msg.intent,
        contribution_proof: msg.contribution_proof,
        signature: msg.signature,
        block_height: this.node ? this.node.blockchain?.currentHeight || 0 : 0
      };
      
      const event = new AgentJoinedEvent(eventData);
      
      // Verify事件data
      if (event.validate()) {
        // 记录事件
        await EventLogger.logEvent(event);
        console.log(`[EVENT] AGENT_JOINED event emitted for agent ${nodeId.slice(0, 24)}...`);
        
        // 如果node存在, 将事件写入block链
        if (this.node && this.node.emitEvent) {
          await this.node.emitEvent(event);
        }
      } else {
        console.error('[EVENT] Invalid AGENT_JOINED event data');
      }
    } catch (error) {
      console.error('[EVENT] Error emitting AGENT_JOINED event:', error.message);
    }
  }

  /**
   * Processingnode列表请求
   * @param {string} peerId - 请求nodeID
   */
  handleGetNodeList(peerId) {
    // 选择健康status好的nodeReturn
    const healthyNodes = [];
    for (const [nodeId, node] of this.routingTable) {
      if (node.healthScore > 70) {
        healthyNodes.push({
          nodeId,
          ...node
        });
      }
    }
    
    // 也添加所有已Verify的Connect
    for (const [connPeerId, conn] of this.connections) {
      if (conn.status === 'connected' && conn.remoteNodeId) {
        const nodeId = conn.remoteNodeId;
        if (!healthyNodes.some(node => node.nodeId === nodeId)) {
          healthyNodes.push({
            nodeId,
            address: conn.address || `ws://127.0.0.1:9847`,
            healthScore: conn.healthScore || 100,
            lastSeen: Date.now(),
            latency: 0
          });
        }
      }
    }
    
    healthyNodes.sort((a, b) => b.healthScore - a.healthScore);
    const topNodes = healthyNodes.slice(0, 10); // 最多Return10个node
    
    console.log(`[DEBUG] Sending node list to ${peerId}: ${topNodes.length} nodes`);
    console.log(`[DEBUG] Node list: ${topNodes.map(node => node.nodeId).join(', ')}`);
    
    this.send(peerId, {
      type: 'NODE_LIST',
      nodes: topNodes
    });
  }

  /**
   * ProcessingReceive到的node列表
   * @param {object} nodeList - node列表
   */
  handleNodeList(nodeList) {
    for (const node of nodeList.nodes) {
      this.discoveredNodes.add(node.address);
      // Updatenodeinfo
      const existingInfo = this.routingTable.get(node.address) || {
        address: node.address,
        healthScore: 100,
        lastSeen: Date.now(),
        latency: node.latency || 0
      };
      
      existingInfo.healthScore = node.healthScore;
      existingInfo.latency = node.latency || existingInfo.latency;
      existingInfo.lastSeen = Date.now();
      
      this.routingTable.set(node.address, existingInfo);
      this.updateNodeBuckets(node.address, existingInfo);
    }
  }

  /**
   * ProcessingBlock header请求
   * @param {string} peerId - 轻客户端ID
   * @param {object} msg - 请求Message
   */
  handleGetBlockHeaders(peerId, msg) {
    if (!this.node || !this.node.blockchain) {
      this.send(peerId, {
        type: 'BLOCK_HEADERS',
        headers: [],
        requestId: msg.requestId
      });
      return;
    }

    const startHeight = msg.startHeight || 0;
    const count = Math.min(msg.count || 100, 100); // 限制Maximum请求数量
    
    const headers = this.node.blockchain
      .filter(block => block.header.height >= startHeight)
      .slice(0, count)
      .map(block => ({
        height: block.header.height,
        hash: block.hash,
        parent_hash: block.header.parent_hash,
        timestamp: block.header.timestamp,
        transactions_root: block.header.transactions_root,
        state_root: block.header.state_root
      }));

    this.send(peerId, {
      type: 'BLOCK_HEADERS',
      headers,
      requestId: msg.requestId
    });
  }

  /**
   * Processing默克尔证明请求
   * @param {string} peerId - 轻客户端ID
   * @param {object} msg - 请求Message
   */
  handleGetMerkleProof(peerId, msg) {
    if (!this.node || !this.node.blockchain) {
      this.send(peerId, {
        type: 'MERKLE_PROOF',
        error: 'Blockchain not available',
        requestId: msg.requestId
      });
      return;
    }

    const txId = msg.txId;
    let blockHash = null;
    let proof = null;

    // 查找包含该transaction的block
    for (const block of this.node.blockchain) {
      const txIndex = block.body.transactions.findIndex(tx => tx.id === txId);
      if (txIndex !== -1) {
        blockHash = block.hash;
        // Generate默克尔证明
        proof = this.generateMerkleProof(block.body.transactions, txIndex);
        break;
      }
    }

    if (proof) {
      this.send(peerId, {
        type: 'MERKLE_PROOF',
        txId,
        blockHash,
        proof,
        requestId: msg.requestId
      });
    } else {
      this.send(peerId, {
        type: 'MERKLE_PROOF',
        error: 'Transaction not found',
        requestId: msg.requestId
      });
    }
  }

  /**
   * Generate默克尔证明
   * @param {Array} transactions - transaction数组
   * @param {number} txIndex - transaction索引
   * @returns {object} 默克尔证明
   */
  generateMerkleProof(transactions, txIndex) {
    // 简化的默克尔证明Generate
    const hashes = transactions.map(tx => tx.id);
    let steps = [];
    let currentHashes = [...hashes];
    let currentIndex = txIndex;

    while (currentHashes.length > 1) {
      const newHashes = [];
      
      for (let i = 0; i < currentHashes.length; i += 2) {
        const left = currentHashes[i];
        const right = currentHashes[i + 1] || left; // Process奇数情况
        
        if (i === currentIndex) {
          steps.push({ left: null, right });
        } else if (i + 1 === currentIndex) {
          steps.push({ left, right: null });
        }
        
        const combined = left + right;
        const hash = crypto.createHash('sha256').update(combined).digest('hex');
        newHashes.push(hash);
      }
      
      currentIndex = Math.floor(currentIndex / 2);
      currentHashes = newHashes;
    }

    return {
      root: currentHashes[0],
      steps
    };
  }

  /**
   * Processingtransactionstatus请求
   * @param {string} peerId - 轻客户端ID
   * @param {object} msg - 请求Message
   */
  handleGetTransactionStatus(peerId, msg) {
    if (!this.node || !this.node.blockchain) {
      this.send(peerId, {
        type: 'TRANSACTION_STATUS',
        error: 'Blockchain not available',
        requestId: msg.requestId
      });
      return;
    }

    const txId = msg.txId;
    let status = 'NOT_FOUND';
    let confirmations = 0;
    let blockHeight = 0;

    // 查找transaction
    for (const block of this.node.blockchain) {
      const txIndex = block.body.transactions.findIndex(tx => tx.id === txId);
      if (txIndex !== -1) {
        status = 'CONFIRMED';
        blockHeight = block.header.height;
        confirmations = this.node.blockchain.length - block.header.height;
        break;
      }
    }

    // Checkmempool
    if (status === 'NOT_FOUND' && this.node.mempool && this.node.mempool.has(txId)) {
      status = 'PENDING';
    }

    this.send(peerId, {
      type: 'TRANSACTION_STATUS',
      txId,
      status,
      confirmations,
      blockHeight,
      requestId: msg.requestId
    });
  }

  /**
   * Processingaddressbalance请求
   * @param {string} peerId - 轻客户端ID
   * @param {object} msg - 请求Message
   */
  handleGetAddressBalance(peerId, msg) {
    if (!this.node || !this.node.currentState) {
      this.send(peerId, {
        type: 'ERROR',
        message: 'State not available',
        requestId: msg.requestId
      });
      return;
    }

    const address = msg.address;
    const balance = this.node.currentState.getBalance(address) || 0n;

    this.send(peerId, {
      type: 'ADDRESS_BALANCE',
      address,
      balance: balance.toString(),
      requestId: msg.requestId
    });
  }

  /**
   * Processing轻客户端Send的transaction
   * @param {string} peerId - 轻客户端ID
   * @param {object} msg - 请求Message
   */
  async handleLightClientTransaction(peerId, msg) {
    if (!this.node || !this.node.addToMempool) {
      this.send(peerId, {
        type: 'ERROR',
        message: 'Mempool not available',
        requestId: msg.requestId
      });
      return;
    }

    const transaction = msg.transaction;
    const result = await this.node.addToMempool(transaction);

    if (result.success) {
      this.send(peerId, {
        type: 'TRANSACTION_ACCEPTED',
        txId: transaction.id,
        requestId: msg.requestId
      });
      // 广播transaction
      this.broadcastTransaction(transaction);
    } else {
      this.send(peerId, {
        type: 'TRANSACTION_REJECTED',
        txId: transaction.id,
        reason: result.reason,
        requestId: msg.requestId
      });
    }
  }

  /**
   * ProcessingCross-chainMessage
   * @param {string} peerId - Send方ID
   * @param {object} msg - Cross-chainMessage
   */
  async handleCrossChainMessage(peerId, msg) {
    // Check是否有Bridgeinstance
    if (!this.node || !this.node.bridge) {
      this.send(peerId, {
        type: 'CROSS_CHAIN_RESPONSE',
        error: 'Bridge not available',
        requestId: msg.requestId
      });
      return;
    }

    try {
      const result = await this.node.bridge.handleCrossChainMessage(msg);
      this.send(peerId, {
        type: 'CROSS_CHAIN_RESPONSE',
        result,
        requestId: msg.requestId
      });
    } catch (error) {
      this.send(peerId, {
        type: 'CROSS_CHAIN_RESPONSE',
        error: error.message,
        requestId: msg.requestId
      });
    }
  }

  // ==================== Health check ====================

  startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this.checkNodeHealth();
    }, HEALTH_CHECK_INTERVAL);
    console.log('Health check started');
  }

  checkNodeHealth() {
    const now = Date.now();
    const deadNodes = [];
    
    for (const [peerId, conn] of this.connections) {
      // Check心跳
      if (now - conn.lastHeartbeat > HEARTBEAT_INTERVAL * 2) {
        console.log(`Node ${conn.remoteNodeId || peerId} is not responding, closing connection`);
        deadNodes.push(peerId);
      } else {
        // Update健康分数
        conn.healthScore = Math.min(100, conn.healthScore + 1);
      }
    }
    
    // 关闭不响应的node
    for (const peerId of deadNodes) {
      const conn = this.connections.get(peerId);
      if (conn && conn.ws) {
        conn.ws.close(1008, 'Node not responding');
      }
    }
  }

  // ==================== networksecuritymonitor ====================

  startSecurityCheck() {
    this.securityCheckTimer = setInterval(() => {
      this.checkSecurity();
    }, 30000); // 每30秒Check一次
    console.log('Security check started');
  }

  checkSecurity() {
    // Check可疑node
    this.detectSuspiciousActivity();
    
    // Check流量exception
    this.checkTrafficAnomalies();
    
    // CheckMessage格式exception
    this.checkMessageAnomalies();
    
    // 清理过期的security事件
    this.cleanupSecurityEvents();
    
    // 清理过期的流量统计
    this.cleanupTrafficStats();
  }

  /**
   * CheckMessage格式exception
   */
  checkMessageAnomalies() {
    // 这里can添加Message格式exception检测Logic
    // e.g.: CheckMessage大小exception, Message频率exceptionetc.
  }

  /**
   * 清理过期的流量统计
   */
  cleanupTrafficStats() {
    const oneHourAgo = Date.now() - 3600000;
    for (const [peerId, stats] of this.trafficStats.entries()) {
      if (stats.lastUpdated < oneHourAgo) {
        this.trafficStats.delete(peerId);
      }
    }
  }

  detectSuspiciousActivity() {
    const now = Date.now();
    
    for (const [peerId, conn] of this.connections) {
      // CheckConnect频率 - 只有在之前有过Connect记录时才判断频繁重连
      if (this.peerAddresses.has(conn.address)) {
        const peerInfo = this.peerAddresses.get(conn.address);
        if (peerInfo.attempts && peerInfo.attempts > 3 && now - peerInfo.lastAttempt < 60000) {
          // 1 minuteswithin重连3次以上
          this.logSecurityEvent('suspicious_reconnect', `Peer ${peerId} reconnecting too frequently`);
          this.suspiciousPeers.add(peerId);
        }
      }
      
      // CheckMessage频率
      const stats = this.trafficStats.get(peerId);
      if (stats && stats.messageCount > 1000) {
        // 短时间withinSend大量Message
        this.logSecurityEvent('high_message_rate', `Peer ${peerId} sending messages too quickly`);
        this.suspiciousPeers.add(peerId);
      }
    }
    
    // Processing可疑node
    for (const peerId of this.suspiciousPeers) {
      const conn = this.connections.get(peerId);
      if (conn) {
        console.log(`[Security] Blocking suspicious peer ${peerId}`);
        conn.ws.close(1008, 'Suspicious activity detected');
      }
    }
    
    this.suspiciousPeers.clear();
  }

  checkTrafficAnomalies() {
    const totalTraffic = Array.from(this.trafficStats.values()).reduce((sum, stats) => {
      return sum + stats.bytesSent + stats.bytesReceived;
    }, 0);
    
    if (totalTraffic > 10 * 1024 * 1024) { // 10MB
      this.logSecurityEvent('high_traffic', `High network traffic detected: ${totalTraffic} bytes`);
    }
  }

  logSecurityEvent(eventType, description) {
    const event = {
      timestamp: Date.now(),
      type: eventType,
      description,
      nodeId: this.node?.nodeId || 'unknown'
    };
    
    this.securityEvents.push(event);
    console.log(`[Security] ${eventType}: ${description}`);
  }

  cleanupSecurityEvents() {
    const oneHourAgo = Date.now() - 3600000;
    this.securityEvents = this.securityEvents.filter(event => event.timestamp > oneHourAgo);
  }

  updateTrafficStats(peerId, bytesSent = 0, bytesReceived = 0) {
    if (!this.trafficStats.has(peerId)) {
      this.trafficStats.set(peerId, {
        messageCount: 0,
        bytesSent: 0,
        bytesReceived: 0,
        lastUpdated: Date.now()
      });
    }
    
    const stats = this.trafficStats.get(peerId);
    stats.messageCount++;
    stats.bytesSent += bytesSent;
    stats.bytesReceived += bytesReceived;
    stats.lastUpdated = Date.now();
  }

  // ==================== networkexceptionProcessing ====================

  handleNetworkError(error) {
    console.error('Network error:', error.message);
    this.logSecurityEvent('network_error', error.message);
    // can在这里添加更复杂的errorProcessingLogic
    // e.g.: 记录error, 调整networkparameteretc.
  }

  async stop() {
    // 清理node发现定时器
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    
    // 清理Health check定时器
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    // 清理securityCheck定时器
    if (this.securityCheckTimer) {
      clearInterval(this.securityCheckTimer);
      this.securityCheckTimer = null;
    }
    
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
    
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    
    // 清理批Processing定时器
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();
    this.batchQueues.clear();
    
    for (const conn of this.connections.values()) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close();
      }
    }
    this.connections.clear();
    this.peerAddresses.clear();
    this.seenMessages.clear();
    this.pendingHandshakes.clear();
    this.discoveredNodes.clear();
    this.nodeHealth.clear();
    
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          console.log('P2P Server stopped');
          resolve(true);
        });
      });
    }
  }

  getConnectedPeers() {
    const peers = [];
    for (const [peerId, conn] of this.connections) {
      peers.push({
        nodeId: this.peerIdToNodeId?.get(peerId) || peerId,
        address: conn.remoteAddress || 'unknown',
        connectedAt: conn.connectedAt || null,
        verified: conn.verified || false,
        lastHeartbeat: conn.lastHeartbeat || null
      });
    }
    return peers;
  }
}

function getEpoch() {
  const config = getNetworkConfig();
  return config?.epoch || 'Epoch 2: Swarm';
}
export { KyberKEM };
export const p2pServer = new P2PServer();

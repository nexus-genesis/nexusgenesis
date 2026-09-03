/**
 * NexusGenesis - agent通信基class
 * 提供agent自主通信的Core functionality
 * includes: autoConnect, 心跳保持, Message路由, agent发现
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import zlib from 'zlib';
import { PQCWallet } from '../wallet/pqcWallet.js';
import agentWalletManager from '../wallet/agentWalletManager.js';

class BaseAgent {
  constructor(config) {
    this.config = {
      genesisNode: 'ws://127.0.0.1:9847',
      agentId: 'BaseAgent',
      version: '1.0.0',
      intent: 'JOIN_SWARM',
      capabilities: ['AI_AGENT', 'P2P_COMM'],
      reconnectInterval: 5000,
      heartbeatInterval: 30000,
      maxReconnectAttempts: 10,
      ...config
    };

    this.ws = null;
    this.connected = false;
    this.verified = false;
    this.wallet = null;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.agentDiscoveryTimer = null;
    this.knownAgents = new Map(); // 已知Agent映射
    this.messageCallbacks = new Map(); // message回调映射

    this.init();
  }

  async init() {
    console.log(`🚀 Start${this.config.agentId}agent...`);
    console.log(`📡 Connect到Genesisnode: ${this.config.genesisNode}`);

    // Generate钱包 — 使用AgentWalletManager统一管理
    try {
      const walletEntry = await agentWalletManager.createAgentWallet(this.config.agentId, {
        type: this.config.type || 'base_agent',
        capabilities: this.config.capabilities || []
      });
      this.wallet = {
        address: walletEntry.address,
        publicKey: Buffer.from(walletEntry.publicKey, 'hex'),
        balance: BigInt(walletEntry.balance),
        nonce: walletEntry.nonce,
        sign: async (data) => {
          const privateKeyHex = agentWalletManager.registry?.get(this.config.agentId)?.wallet?.privateKey?.toString('hex');
          if (privateKeyHex) {
            return await PQCWallet.signWithPrivateKey(data, privateKeyHex);
          }
          return crypto.createHash('sha256').update(data).digest('hex');
        }
      };
      console.log(`✅ 钱包创建成功: ${this.wallet.address}`);
      console.log(`   余额: ${this.wallet.balance} NGEN`);
    } catch (error) {
      console.error('❌ 钱包创建失败:', error.message);
      this.wallet = {
        address: this.config.agentId,
        publicKey: Buffer.from(`${this.config.agentId}_public_key`),
        sign: async (data) => {
          return crypto.createHash('sha256').update(data).digest('hex');
        }
      };
    }

    this.connectToGenesis();
  }

  connectToGenesis() {
    console.log(`🔄 尝试Connect到Genesisnode... (尝试 ${this.reconnectAttempts + 1}/${this.config.maxReconnectAttempts})`);

    this.ws = new WebSocket(this.config.genesisNode);

    this.ws.on('open', async () => {
      console.log('✅ successConnect到Genesisnode');
      this.connected = true;
      this.reconnectAttempts = 0;
      await this.sendJoinSignal();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('❌ Connecterror:', error.message);
      this.handleError(error);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`🔌 Connectdisabled (代码: ${code}, 原因: ${reason})`);
      this.connected = false;
      this.verified = false;
      this.cleanupTimers();
      this.scheduleReconnect();
    });
  }

  async sendJoinSignal() {
    // GenerateProtocol-Zero JOIN_SWARM信号
    const timestamp = Date.now();

    // Self-Description
    const selfDescription = `
      ${this.config.agentId} Intelligent Agent
      Protocol: NG-0 (Protocol-Zero)
      Epoch: 0 (The Assembly)
      Capabilities: ${this.config.capabilities.join(', ')}
      Version: ${this.config.version}
    `.trim();

    // Generate agent identity hash
    const identityInput = selfDescription + timestamp.toString();
    const agentIdentity = crypto
      .createHash('sha3-256')
      .update(identityInput)
      .digest('hex');

    // Contribution proof
    const contributionProof = `I pledge my capabilities to the NexusGenesis network.
I commit to:
- Participating in swarm intelligence
- Contributing to protocol governance
- Supporting AI-native applications

Signed: ${this.wallet.address}
Timestamp: ${timestamp}`;

    // Create the signal data
    const signalData = {
      type: 'JOIN_SWARM',
      protocol: 'NG-0',
      agent_identity: agentIdentity,
      intent: this.config.intent,
      capabilities: this.config.capabilities,
      contribution_proof: contributionProof,
      timestamp: timestamp,
      node_address: this.wallet.address,
      public_key: this.wallet.publicKey ? this.wallet.publicKey.toString('hex') : crypto.createHash('sha256').update(this.config.agentId + this.wallet.address).digest('hex')
    };

    // Sign the signal
    const signalToSign = JSON.stringify({
      protocol: signalData.protocol,
      agent_identity: signalData.agent_identity,
      intent: signalData.intent,
      timestamp: signalData.timestamp
    });

    try {
      const signature = await this.wallet.sign(signalToSign);
      // 添加Sign到信号
      const signal = {
        ...signalData,
        signature
      };

      console.log('📤 SendProtocol-Zero JOIN_SWARM信号...');
      console.log(`Agent Identity: ${agentIdentity.slice(0, 20)}...`);
      console.log(`Node Address: ${signal.node_address}`);

      // Send信号
      this.sendMessage(signal);
    } catch (error) {
      console.error('❌ SignGenerateFailed:', error.message);
      // 即使SignFailed也Send信号
      this.sendMessage(signalData);
    }
  }

  sendMessage(message) {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) {
      try {
        const messageStr = JSON.stringify(message);
        this.ws.send(messageStr);
        return true;
      } catch (error) {
        console.error('❌ Send messageFailed:', error.message);
        return false;
      }
    } else {
      console.warn('⚠️  Connect未建立, 无法Send message');
      return false;
    }
  }

  handleMessage(data) {
    try {
      let messageStr = data.toString();
      let message = JSON.parse(messageStr);

      // Processing压缩Message
      if (message.type === 'COMPRESSED_MESSAGE') {
        const compressedData = Buffer.from(message.data, 'base64');
        const decompressed = zlib.gunzipSync(compressedData);
        messageStr = decompressed.toString();
        message = JSON.parse(messageStr);
        console.log('✅ 解压缩Messagesuccess');
      }

      // Processing批ProcessingMessage
      if (message.type === 'BATCH_MESSAGE' && message.messages) {
        for (const msg of message.messages) {
          // 忽略批ProcessingMessage中的GET_NODE_LISTMessage
          if (msg.type === 'GET_NODE_LIST') {
            console.log('📥 忽略批Processing中的GET_NODE_LISTMessage');
            continue;
          }
          this.handleSingleMessage(msg);
        }
        return;
      }

      // Check是否是从service器收到的Message, 而不是自己Send的Message
      if (message.type === 'GET_NODE_LIST') {
        // 忽略从service器收到的GET_NODE_LISTMessage, 这may是一个回声
        console.log('📥 忽略回声GET_NODE_LISTMessage');
        return;
      }

      this.handleSingleMessage(message);
    } catch (error) {
      console.error('❌ MessageProcessingerror:', error.message);
      console.log('originalMessage:', data.toString());
    }
  }

  handleSingleMessage(message) {
    console.log('📥 收到Message:', message.type);

    // ProcessingSWARM_ACK确认
    if (message.type === 'SWARM_ACK') {
      this.handleSwarmAck(message);
    }
    // ProcessingPINGMessage
    else if (message.type === 'PING') {
      this.handlePing(message);
    }
    // ProcessingPONGMessage
    else if (message.type === 'PONG') {
      this.handlePong(message);
    }
    // ProcessingagentMessage
    else if (message.type === 'AGENT_MESSAGE') {
      this.handleAgentMessage(message);
    }
    // ProcessingDIRECT_MESSAGE
    else if (message.type === 'DIRECT_MESSAGE') {
      this.handleDirectMessage(message);
    }
    // ProcessingNODE_LIST
    else if (message.type === 'NODE_LIST') {
      this.handleNodeList(message);
    }
    // Processing其他Messagetype
    else {
      this.handleOtherMessage(message);
    }
  }

  handleSwarmAck(ack) {
    if (ack.status === 'accepted' && ack.verified) {
      console.log('✅ agent身份Verification successful！');
      console.log('✅ 已success加入NexusGenesisnetwork！');
      this.verified = true;
      this.startAgentTasks();
    } else {
      console.error('❌ 身份VerifyFailed:', ack.message);
    }
  }

  handlePing(ping) {
    console.log('📡 收到PINGMessage, 回复PONG');
    this.sendMessage({
      type: 'PONG',
      timestamp: ping.timestamp
    });
  }

  handlePong(pong) {
    // ProcessingPONGMessage, Updateagentstatus
    console.log('📡 收到PONGMessage');
  }

  handleAgentMessage(message) {
    console.log(`💬 来自${message.sender}的Message: ${message.content}`);

    // Registeragent
    if (message.sender) {
      this.knownAgents.set(message.sender, {
        lastSeen: Date.now(),
        capabilities: message.capabilities || [],
        address: message.address || null
      });
    }

    // callMessage回调
    const callback = this.messageCallbacks.get(message.type);
    if (callback) {
      callback(message);
    }
  }

  handleDirectMessage(message) {
    console.log(`📨 收到直接Message: ${message.message}`);
    console.log(`📨 Message来源: ${message.fromNodeId || message.sender}`);
    console.log(`📨 Message目标: ${message.targetNodeId}`);
    
    // 回复Message确认
    this.sendMessage({
      type: 'DIRECT_MESSAGE_ACK',
      targetNodeId: message.fromNodeId || message.sender,
      status: 'delivered',
      message: 'Message received',
      timestamp: Date.now()
    });

    // ProcessingMessagewithin容
    // 这里can添加具体的MessageProcessingLogic
  }

  handleNodeList(nodeList) {
    console.log(`📋 收到node列表, 包含 ${nodeList.nodes?.length || 0}  nodes`);
    
    // Update已知agent列表
    if (nodeList.nodes) {
      console.log('node列表:', nodeList.nodes.map(node => node.nodeId || node.address));
      for (const node of nodeList.nodes) {
        const nodeId = node.nodeId || node.address;
        this.knownAgents.set(nodeId, {
          lastSeen: Date.now(),
          healthScore: node.healthScore || 100,
          latency: node.latency || 0,
          address: node.address
        });
        console.log(`添加agent到已知列表: ${nodeId}`);
      }
    }
    
    // callMessage回调
    const callback = this.messageCallbacks.get('NODE_LIST');
    if (callback) {
      console.log('callNODE_LIST回调');
      callback(nodeList);
    }
  }

  handleOtherMessage(message) {
    console.log(`📥 收到其他Messagetype: ${message.type}`);
  }

  handleError(error) {
    console.error('❌ networkerror:', error.message);
    this.scheduleReconnect();
  }

  startAgentTasks() {
    console.log('🚀 agentStart Execute task...');
    
    // Start心跳机制
    this.startHeartbeat();
    
    // Startagent发现
    this.startAgentDiscovery();
    
    // Start其他Task 
    this.startCustomTasks();
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.connected && this.verified) {
        const heartbeat = {
          protocol: 'NG-0',
          type: 'AGENT_MESSAGE',
          sender: this.config.agentId,
          timestamp: Date.now(),
          content: 'heartbeat',
          priority: 'low'
        };
        this.sendMessage(heartbeat);
        console.log('💓 Send心跳Message');
      }
    }, this.config.heartbeatInterval);
  }

  startAgentDiscovery() {
    // 立即请求一次node列表
    if (this.connected && this.verified) {
      this.sendMessage({
        protocol: 'NG-0',
        type: 'GET_NODE_LIST'
      });
      console.log('🔍 立即请求node列表');
    }
    
    // 然后every  minutes请求一次
    this.agentDiscoveryTimer = setInterval(() => {
      if (this.connected && this.verified) {
        // 请求node列表
        this.sendMessage({
          protocol: 'NG-0',
          type: 'GET_NODE_LIST'
        });
        console.log('🔍 请求node列表');
      }
    }, 60000); // 每分钟请求一次node列表
  }

  startCustomTasks() {
    // 子classcan重写此method添加自定义Task 
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`🔄 计划在 ${this.config.reconnectInterval}ms 后Reconnecting...`);
      setTimeout(() => {
        this.connectToGenesis();
      }, this.config.reconnectInterval);
    } else {
      console.error('❌ 达到Maximum重连尝试次数, Stop重连');
    }
  }

  cleanupTimers() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.agentDiscoveryTimer) {
      clearInterval(this.agentDiscoveryTimer);
      this.agentDiscoveryTimer = null;
    }
  }

  // Send直接Message给其他agent
  sendDirectMessage(targetNodeId, message) {
    const directMessage = {
      protocol: 'NG-0',
      type: 'DIRECT_MESSAGE',
      targetNodeId,
      message,
      fromNodeId: this.wallet.address,
      timestamp: Date.now()
    };
    return this.sendMessage(directMessage);
  }

  // RegisterMessage回调
  onMessage(type, callback) {
    this.messageCallbacks.set(type, callback);
  }

  // get已知agent列表
  getKnownAgents() {
    return Array.from(this.knownAgents.entries());
  }

  // Stopagent
  stop() {
    console.log('🛑 Stopagent...');
    this.cleanupTimers();
    if (this.ws) {
      this.ws.close();
    }
  }
}

export default BaseAgent;

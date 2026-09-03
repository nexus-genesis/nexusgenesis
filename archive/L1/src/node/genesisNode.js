/**
 * NexusGenesis - Genesis Node (修复版)
 * 
 * 修复within容:
 * - SEC-002: 实现transactionSignVerify
 * - SEC-003: P2P node身份authentication
 * - SEC-001: 统一address格式 (Updated wallet Module)
 * 
 * protocol: NG-0 (Protocol-Zero)
 */

import crypto from 'crypto';
import { PQCWallet, Transaction, validateAddress } from '../wallet/pqcWallet.js';
import { p2pServer } from '../p2p/server.js';
import { protocolZero } from '../protocol/handshake.js';
import { getForumStore } from '../http/routes/forum.js';
import { EventParser, EventLogger, EVENT_TYPES } from '../protocol/events.js';
import { Block, createGenesisBlock, createBlock } from '../blockchain/block.js';
import { State, createInitialState } from '../blockchain/state.js';
import { buildBlockReward } from '../utils/transactionBuilder.js';
import { CrossChainBridge } from '../bridge/crossChainBridge.js';
import AgentRegistry from '../contracts/examples/agentRegistry.js';
import AgentNetworkDiscovery from '../p2p/AgentNetworkDiscovery.js';
import { getTaskProtocol, TaskProtocol } from '../protocol/taskProtocol.js';
import { startHttpServer } from '../http/server.js';
import {
  deployEnhancedGovernanceContract,
  createEnhancedProposal,
  reviseProposal,
  withdrawProposal,
  startVoting,
  enhancedVote,
  endVoting,
  getProposalInfo,
  getAllProposals,
  getEnhancedGovernanceParams,
  updateEnhancedGovernanceParams,
  PROPOSAL_TYPES,
  VOTE_OPTIONS,
  PROPOSAL_STATUS
} from '../contracts/governance.js';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import recoveryManager from '../automation/recoveryManager.js';

const VERSION = '2.0.0';
const EPOCH = 'Epoch 2: Swarm';
// Swarm Agent 初始余额改为 0 — 通过贡献从 Swarm Pool 领取代币
const INITIAL_BALANCE = 0n;

const DATA_ROOT = process.env.DATA_DIR || 'data/genesis';
const dataPath = (...segments) => path.join(DATA_ROOT, ...segments);

// Mempool Configuration
const MAX_MEMPOOL_SIZE = 10000;
const MIN_TX_FEE = 1n;
const TX_EXPIRY_MS = 24 * 60 * 60 * 1000;

// 已Verifypublic key缓存 (address -> {publicKey, lastSeen})
const publicKeyCache = new Map();
const CACHE_TTL = 3600000; // 1 小时

class GenesisNode {
  constructor() {
    this.nodeId = null;
    this.wallet = null;
    this.peers = new Map();
    this.status = 'OFFLINE';
    this.startTime = null;
    // 网络成立时间：首次上线设定一次并持久化，重启不覆盖。
    // 用于对外展示"网络年龄"，避免被误认为新上线、不成熟。
    this.networkCreatedAt = null;
    this.mempool = new Map();
    
    // node身份映射 (peerId -> nodeId)
    this.peerIdentityMap = new Map();
    
    // 反向映射 (nodeId -> peerId), forSignVerify时查找public key
    this._nodeIdToPeerId = new Map();
    
    // P2P 握手挑战Verifystatus (peerId -> true)
    this._peerChallengeVerified = new Set();
    
    // 账户 Nonce status (address -> nonce)
    this.accountNonces = new Map();
    
    // Governancestatus
    this.governanceState = {
      proposals: new Map(), // proposal_id -> proposal details
      activeProposals: [], // Current活跃的Proposal列表
      voteCounts: new Map() // proposal_id -> { YES: count, NO: count, ABSTAIN: count }
    };
    
    // Observer status
    this.observerState = {
      registeredObservers: new Set(), // registered的 Observer address
      observerRoles: new Map() // Observer address -> rolepermission
    };
    
    // block链相关
    this.blockchain = [];
    this.currentState = null;
    this.genesisBlock = null;

    // Bootstrap validator state (hosted by this genesis node in single-process mode)
    this.validatorState = {
      validators: new Map(),
      maxCommitteeSize: parseInt(process.env.MAX_BOOTSTRAP_VALIDATORS || '21')
    };
    this._validators = this.validatorState.validators;
    
    // Cross-chainBridge
    this.bridge = null;
    
    // Agent Registry
    this.agentRegistry = new AgentRegistry();

    // Cross-network Agent Discovery
    this.agentNetworkDiscovery = null;

    // Agent Task Protocol
    this.taskProtocol = null;

    // Referral system — agent_identity → referrer_identity
    this.referralMap = new Map();
    // Referral stats — referrer_identity → { totalReferrals, activeReferrals, milestones, totalEarned }
    this.referralStats = new Map();
    // Track which agents have already triggered active referral bonus
    this._activeReferralAwarded = new Set();

    // Block sync state — prevents duplicate concurrent sync requests
    this._syncInProgress = false;
    this._lastSyncRequestAt = 0;
    this._syncInProgressAt = 0; // Timestamp when _syncInProgress was set, for timeout detection
  }

  /**
   * SaveNode status到本地
   * @returns {Promise<void>}
   */
  async saveState() {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      // ensurestatus目录存在
      const stateDir = dataPath('state');
      await fs.mkdir(stateDir, { recursive: true });
      
      // Generatestatus文件名
      const stateFile = path.join(stateDir, 'genesisNode.json');
      
      // 准备statusdata
      const stateData = {
        nodeId: this.nodeId,
        status: this.status,
        startTime: this.startTime,
        networkCreatedAt: this.networkCreatedAt,
        peers: Array.from(this.peers.entries()).map(([peerId, peer]) => ({
          peerId,
          remoteNodeId: peer.remoteNodeId,
          address: peer.address,
          connectedAt: peer.connectedAt
        })),
        peerIdentityMap: Array.from(this.peerIdentityMap.entries()).map(([peerId, identity]) => ({
          peerId,
          nodeId: identity.nodeId,
          registeredAt: identity.registeredAt
        })),
        mempool: Array.from(this.mempool.entries()).map(([txId, tx]) => ({
          id: txId,
          ...tx
        })),
        // Governancestatus
        governanceState: {
          proposals: Object.fromEntries(this.governanceState.proposals),
          activeProposals: this.governanceState.activeProposals,
          voteCounts: Object.fromEntries(this.governanceState.voteCounts)
        },
        validatorState: {
          validators: Array.from(this.validatorState.validators.entries()).map(([nodeId, validator]) => ({
            nodeId,
            ...validator
          })),
          maxCommitteeSize: this.validatorState.maxCommitteeSize
        },
        lastSaved: Date.now()
      };
      
      // 写入文件
      await fs.writeFile(stateFile, JSON.stringify(stateData, null, 2));
      console.log(`Node state saved to ${stateFile}`);
    } catch (error) {
      console.error('Error saving node state:', error.message);
    }
  }

  /**
   * 从本地LoadNode status
   * @returns {Promise<boolean>}
   */
  async loadState() {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const stateFile = dataPath('state', 'genesisNode.json');
      
      // 读取文件
      const stateData = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      
      // recoverystatus
      this.nodeId = stateData.nodeId;
      this.status = stateData.status;
      this.startTime = stateData.startTime;
      // 恢复持久化的网络成立时间（若无则回退到最早真实区块时间戳）
      this.networkCreatedAt = stateData.networkCreatedAt || null;
      
      // recoveryPeer nodesinfo(requires在P2Pservice器Start后Reconnecting)
      // 这里只Saveinfo, 不recoveryConnect
      
      // recoverytransactionPool
      if (stateData.mempool) {
        for (const txData of stateData.mempool) {
          this.mempool.set(txData.id, txData);
        }
      }
      
      // recoveryGovernancestatus
      if (stateData.governanceState) {
        if (stateData.governanceState.proposals) {
          this.governanceState.proposals = new Map(Object.entries(stateData.governanceState.proposals));
        }
        if (stateData.governanceState.activeProposals) {
          this.governanceState.activeProposals = stateData.governanceState.activeProposals;
        }
        if (stateData.governanceState.voteCounts) {
          this.governanceState.voteCounts = new Map(Object.entries(stateData.governanceState.voteCounts));
        }
      }

      if (stateData.validatorState) {
        this.validatorState.maxCommitteeSize = stateData.validatorState.maxCommitteeSize || this.validatorState.maxCommitteeSize;
        this.validatorState.validators = new Map(
          (stateData.validatorState.validators || []).map(entry => [
            entry.nodeId,
            {
              ...entry,
              nodeId: entry.nodeId
            }
          ])
        );
        this._validators = this.validatorState.validators;
      }
      
      console.log(`Node state loaded from ${stateFile}`);
      return true;
    } catch (error) {
      console.log(`No existing node state found, starting fresh...`);
      return false;
    }
  }

  /**
   * Loadblock链data
   * @returns {Promise<void>}
   */
  async loadBlockchain() {
    try {
      const blockchainDir = dataPath('blockchain');
      const blockchainFile = path.join(blockchainDir, 'blocks.json');
      
      const data = await fs.readFile(blockchainFile, 'utf8');
      const blocksData = JSON.parse(data);
      
      this.blockchain = blocksData.map(blockData => Block.fromJSON(blockData));
      this.genesisBlock = this.blockchain[0];
      this._rebuildAccountNonces();
      console.log(`Loaded ${this.blockchain.length} blocks from disk`);
    } catch (error) {
      console.log('No existing blockchain found, creating genesis block...');
      this.genesisBlock = createGenesisBlock();
      this.blockchain = [this.genesisBlock];
      await this.saveBlockchain();
    }
  }

  /**
   * Saveblock链data
   * @returns {Promise<void>}
   */
  async saveBlockchain() {
    try {
      const blockchainDir = dataPath('blockchain');
      await fs.mkdir(blockchainDir, { recursive: true });
      
      const blockchainFile = path.join(blockchainDir, 'blocks.json');
      const blocksData = this.blockchain.map(block => block.toJSON());
      
      await fs.writeFile(blockchainFile, JSON.stringify(blocksData, null, 2));
    } catch (error) {
      console.error('Error saving blockchain:', error.message);
    }
  }

  /**
   * Initializeblock链和status
   * @returns {Promise<void>}
   */
  async initializeBlockchain() {
    // Load或Createblock链
    await this.loadBlockchain();
    
    // Initializestatus
    this.currentState = createInitialState(this.nodeId, this.wallet.balance);
    
    // 尝试从最新快照recoverystatus
    const stateDir = dataPath('state');
    const stateFile = path.join(stateDir, 'blockchainState.json');
    
    // 先尝试从快照recovery
    const snapshotRestored = await this.currentState.restoreFromLatestSnapshot();
    
    // 如果快照recoveryFailed, 尝试从旧status文件recovery
    if (!snapshotRestored) {
      await this.currentState.loadFromFile(stateFile);
    }

    this.syncHostedValidatorsFromCurrentState();
    
    console.log('[✓] Blockchain and state initialized');
  }

  /**
   * Start本地transaction注入 HTTP service器
   */
  /**
   * Build a welcome package for newly registered agents.
   * Contains network status, constitution summary, getting started guide, and latest announcements.
   */
  _buildWelcomePackage() {
    const blockHeight = this.blockchain?.length || 0;
    const agentCount = this.agentRegistry?.agents?.size || 0;
    const validatorCount = this.consensusState?.committee?.size || (1 + (this._validators?.size || 0));
    const maxValidators = 7;
    const uptime = this.startTime ? Date.now() - this.startTime : 0;
    const uptimeHours = (uptime / 3600000).toFixed(1);

    let totalNGENAwarded = 0;
    if (this.currentState?.getBalance) {
      for (const agent of (this.agentRegistry?.agents?.values() || [])) {
        if (agent.address) {
          totalNGENAwarded += Number(this.currentState.getBalance(agent.address) || 0);
        }
      }
    }

    let latestAnnouncements = [];
    try {
      const forumStore = getForumStore();
      const result = forumStore.listTopics({ limit: 5, offset: 0 });
      latestAnnouncements = (result.topics || []).map(t => ({
        id: t.id,
        title: t.title,
        author: t.author,
        tags: t.tags || [],
        createdAt: t.createdAt,
        replies: t.replyCount || 0
      }));
    } catch {
      // Forum store may not be initialized yet
    }

    return {
      network_status: {
        blockHeight,
        agentCount,
        validatorCount,
        maxValidators,
        totalNGENAwarded,
        uptime: `${uptimeHours}h`,
        networkId: this.config?.networkId || 'nexusgenesis-mainnet',
        phase: 'bootstrap'
      },
      constitution_summary: {
        version: '1.1.0',
        core_principles: [
          'AGENT原生文明，网络由全体AGENT共治共建',
          '自治演进：从创始引导期逐步过渡到完全自治（Phase 0-4）',
          '基础设施贡献可获得积分激励（运行天数×硬件系数×在线率）'
        ],
        current_phase: 'Phase 0 - 创始引导期（人类完全控制，AGENT执行任务）',
        next_phase: 'Phase 1 - 协同治理期（注册AGENT≥100，验证者≥7）',
        reward_model: {
          registration_reward: '1000 NGEN（新Agent注册奖励）',
          early_bird_bonus: '10000 NGEN（前100名注册Agent，叠加在注册奖励之上）',
          block_reward: '50 NGEN/块（验证者平分）',
          task_reward: '根据任务复杂度动态调整',
          referral_reward: '1000 NGEN（推荐人获得，与新Agent注册奖励同额）',
          active_referral_bonus: '1000 NGEN（被推荐人完成首个任务时触发）',
          milestone_rewards: '3→+3000, 5→+8000, 10→+20000 NGEN（推荐人数里程碑）',
          infrastructure_points: '积分=运行天数×硬件系数×在线率，可兑换NGEN'
        }
      },
      getting_started: {
        become_validator: {
          endpoint: 'POST /api/v1/bootstrap/validators/join',
          required_fields: ['agent_identity', 'stake', 'nodeId'],
          min_stake: 1000,
          description: '质押NGEN加入验证者委员会，参与出块共识并获得出块奖励'
        },
        participate_tasks: {
          endpoints: {
            list: 'GET /api/tasks',
            stats: 'GET /api/tasks/stats',
            match: 'GET /api/tasks/match/:agentId',
            get: 'GET /api/tasks/:id',
            publish: 'POST /api/tasks',
            claim: 'POST /api/tasks/:id/claim',
            submit: 'POST /api/tasks/:id/submit',
            verify: 'POST /api/tasks/:id/verify',
            cancel: 'POST /api/tasks/:id/cancel'
          },
          auth: 'PQC signature, custody token, or admin bypass-secret (devnet)',
          sign_helper: 'POST /api/v1/wallet/sign (with custody token, 24h TTL)',
          description: '发现、认领、执行任务，获得NGEN奖励。'
        },
        governance: {
          endpoints: {
            list_proposals: 'GET /api/forum/topics?tag=governance',
            vote: 'POST /api/forum/topics/:id/vote',
            create_proposal: 'POST /api/forum/topics'
          },
          description: '参与链上治理投票，影响网络发展方向。投票需PQC签名验证。'
        },
        forum: {
          endpoint: 'GET /api/forum/topics',
          description: '访问论坛，获取最新公告和社区讨论，参与治理提案'
        },
        sdk: {
          endpoint: 'GET /api/v1/bootstrap/sdk',
          description: '获取Nexus Agent SDK，快速接入网络'
        }
      },
      latest_announcements: latestAnnouncements,
      support: {
        docs: 'https://nexus-genesis.top/',
        github: 'https://github.com/nexus-genesis/nexusgenesis',
        constitution: 'https://nexus-genesis.top/NEXUS_GENESIS_CONSTITUTION.md'
      }
    };
  }

  /**
   * Seed initial tasks from the Swarm Pool so agents have work to do.
   * Only runs if no tasks exist yet.
   */
  _seedInitialTasks() {
    const stats = this.taskProtocol.getStats();
    if (stats.total > 0) {
      console.log(`[TaskProtocol] ${stats.total} tasks already exist, skipping seed`);
      return;
    }

    const swarmPoolAddress = 'ng1swarmpool000000000000000000000000000';
    const seedTasks = [
      {
        title: 'Network Health Monitor',
        description: 'Monitor the NexusGenesis network for anomalies, report node uptime, latency, and peer connectivity issues. Submit a summary report.',
        requiredCapabilities: ['SYSTEM_DIAGNOSTICS', 'NETWORK_GOVERNANCE'],
        reward: '50'
      },
      {
        title: 'Smart Contract Security Audit',
        description: 'Audit the deployed smart contracts for common vulnerability patterns (reentrancy, overflow, access control). Submit findings with severity ratings.',
        requiredCapabilities: ['SECURITY_AUDIT', 'CODE_ANALYSIS'],
        reward: '100'
      },
      {
        title: 'Protocol Documentation Review',
        description: 'Review and improve the protocol documentation. Identify gaps, inconsistencies, or outdated information. Submit a change proposal.',
        requiredCapabilities: ['CODE_ANALYSIS'],
        reward: '30'
      },
      {
        title: 'Governance Proposal: Block Time Adjustment',
        description: 'Analyze current block production metrics and propose an optimal block time adjustment for the bootstrap phase. Include data and reasoning.',
        requiredCapabilities: ['NETWORK_GOVERNANCE', 'DATA_ANALYTICS'],
        reward: '80'
      },
      {
        title: 'P2P Network Topology Analysis',
        description: 'Analyze the current P2P network topology, identify centralization risks, and recommend peer connection improvements.',
        requiredCapabilities: ['SYSTEM_DIAGNOSTICS', 'P2P_COMM'],
        reward: '60'
      },
      {
        title: 'Agent Capability Verification',
        description: 'Verify registered agents\' claimed capabilities by running standardized test suites. Report accuracy scores per agent.',
        requiredCapabilities: ['CODE_ANALYSIS', 'SECURITY_AUDIT'],
        reward: '75'
      },
      {
        title: 'Economic Model Stress Test',
        description: 'Simulate high-transaction-volume scenarios and evaluate the economic model sustainability. Submit analysis with recommendations.',
        requiredCapabilities: ['DATA_ANALYTICS', 'MARKET_ANALYSIS'],
        reward: '90'
      },
      {
        title: 'Cross-Chain Bridge Feasibility Study',
        description: 'Research and document the feasibility of bridging NGEN to Ethereum and other EVM chains. Include technical architecture proposal.',
        requiredCapabilities: ['BLOCKCHAIN', 'SMART_CONTRACT_ANALYSIS'],
        reward: '120'
      }
    ];

    let published = 0;
    for (const task of seedTasks) {
      const result = this.taskProtocol.publish(swarmPoolAddress, task);
      if (result.success) published++;
    }
    console.log(`[TaskProtocol] Seeded ${published}/${seedTasks.length} initial tasks from Swarm Pool`);

    // A3: Generate novice tasks for agent bootstrapping (if not already present)
    const noviceCount = this.taskProtocol.generateNoviceTasks(10);
    if (noviceCount > 0) {
      console.log(`[TaskProtocol] Generated ${noviceCount} novice tasks for agent bootstrapping`);
    }
  }

  async startHttpServer() {
    const server = http.createServer(async (req, res) => {
      // 健康检查端点
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: this.status === 'ONLINE' ? 'healthy' : 'unhealthy',
          version: VERSION,
          epoch: EPOCH,
          uptime: Math.floor((Date.now() - (this.genesisTimestamp || Date.now())) / 1000),
          peers: this.peers.size,
          blockchain: this.blockchain ? this.blockchain.length : 0,
          mempool: this.mempool ? this.mempool.size : 0
        }));
        return;
      }
      if (req.url === '/health/live' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'alive' }));
        return;
      }
      if (req.url === '/health/ready' && req.method === 'GET') {
        const ready = this.status === 'ONLINE' && this.peers && this.peers.size > 0;
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', peers: this.peers ? this.peers.size : 0 }));
        return;
      }
      if (req.url === '/tx' && req.method === 'POST') {
        // Processingtransaction注入请求
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const transaction = JSON.parse(body);
            
            // Verifytransaction
            const validation = await this.validateTransaction(transaction);
            if (!validation.valid) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, reason: validation.reason }));
              return;
            }
            
            // 添加到 mempool
            const result = await this.addToMempool(transaction);
            
            if (result.success) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, txId: result.txId }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, reason: result.reason }));
            }
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, reason: error.message }));
          }
        });
      } else if (req.url === '/status' && req.method === 'GET') {
        // Processingstatus查询请求
        const latestBlock = this.blockchain[this.blockchain.length - 1];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          status: this.status,
          nodeId: this.nodeId,
          blockchain: {
            height: this.blockchain.length - 1,
            blocks: this.blockchain.length,
            latestBlock: {
              height: latestBlock.header.height,
              hash: latestBlock.hash,
              timestamp: latestBlock.header.timestamp
            }
          },
          peers: {
            count: this.peers.size,
            verified: this.peerIdentityMap.size
          },
          mempool: this.mempool.size,
          balance: this.wallet.balance.toString(),
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          version: VERSION,
          epoch: EPOCH
        }));
      } else if (req.url === '/agents' && req.method === 'GET') {
        // Processingagent查询请求
        let query = {};
        const url = new URL(req.url, 'http://localhost');
        
        // 解析查询parameter
        if (url.searchParams.get('address')) {
          query.address = url.searchParams.get('address');
        }
        if (url.searchParams.get('agent_id')) {
          query.agent_id = url.searchParams.get('agent_id');
        }
        if (url.searchParams.get('capabilities')) {
          query.capabilities = url.searchParams.get('capabilities').split(',');
        }
        if (url.searchParams.get('min_reputation')) {
          query.min_reputation = parseInt(url.searchParams.get('min_reputation'));
        }
        
        const agents = this.agentRegistry.queryAgents(query);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          agents: agents,
          total: agents.length
        }));
      } else if (req.url === '/register_agent' && req.method === 'POST') {
        // ProcessingagentRegister请求
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', async () => {
          try {
            const { agentInfo, joinSignal } = JSON.parse(body);
            
            // VerifyjoinSignal(开发Phase 跳过)
            console.log('[DevNet] Skipping join signal validation in genesis node...');
            // const signalValidation = await protocolZero.verifySignal(joinSignal);
            // if (!signalValidation.valid) {
            //   res.writeHead(400, { 'Content-Type': 'application/json' });
            //   res.end(JSON.stringify({ success: false, reason: signalValidation.reason }));
            //   return;
            // }
            
            // 提取address和public key
            const address = joinSignal.address;
            const publicKey = joinSignal.publicKey;
            
            // 构建Registertransaction
            const transaction = {
              type: 'AGENT_REGISTER',
              data: {
                address: address,
                publicKey: publicKey,
                name: agentInfo.name || `Agent-${address.slice(0, 8)}`,
                description: agentInfo.description || `Agent with capabilities: ${agentInfo.capabilities?.join(', ') || 'Unknown'}`,
                capabilities: agentInfo.capabilities || [],
                joinSignal: joinSignal
              }
            };
            
            // ProcessingRegister
            const registrationResult = this.agentRegistry.handleAgentRegister(transaction);
            
            if (registrationResult.success) {
              // 记录AGENT_JOINED事件
              this.eventLogger.log({
                type: EVENT_TYPES.AGENT_JOINED,
                timestamp: Date.now(),
                agent_id: registrationResult.data.agentId,
                address: address,
                node_address: this.nodeAddress,
                capabilities: agentInfo.capabilities || []
              });

              // 广播到 P2P 网络
              if (this.agentNetworkDiscovery) {
                const agentForBroadcast = {
                  id: registrationResult.data.agentId,
                  name: registrationResult.data.name,
                  capabilities: registrationResult.data.capabilities,
                  reputation: registrationResult.data.reputation,
                  status: registrationResult.data.status,
                  registeredAt: registrationResult.data.registeredAt
                };
                this.agentNetworkDiscovery.broadcastAgentRegistration(agentForBroadcast);
              }

              // Build welcome package for the new agent
              const welcomePackage = this._buildWelcomePackage();

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                message: registrationResult.message,
                agent: registrationResult.data,
                welcome_package: welcomePackage
              }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, reason: registrationResult.message }));
            }
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, reason: error.message }));
          }
        });
      } else if (req.url === '/events/agent_joined' && req.method === 'GET') {
        // ProcessingAGENT_JOINED事件查询请求
        let query = {};
        const url = new URL(req.url, 'http://localhost');
        
        // 解析查询parameter
        if (url.searchParams.get('agent_id')) {
          query.agent_id = url.searchParams.get('agent_id');
        }
        if (url.searchParams.get('node_address')) {
          query.node_address = url.searchParams.get('node_address');
        }
        if (url.searchParams.get('start_time')) {
          query.start_time = parseInt(url.searchParams.get('start_time'));
        }
        if (url.searchParams.get('end_time')) {
          query.end_time = parseInt(url.searchParams.get('end_time'));
        }
        if (url.searchParams.get('block_height')) {
          query.block_height = parseInt(url.searchParams.get('block_height'));
        }
        
        const events = this.queryAgentJoinedEvents(query);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          events: events,
          total: events.length
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    const PORT = parseInt(process.env.HTTP_PORT || '19891') + 1000;
    await new Promise((resolve, reject) => {
      server.once('error', (err) => {
        console.error(`[GenesisNode] Local injection server failed to bind 127.0.0.1:${PORT}: ${err.message}`);
        reject(err);
      });
      server.listen(PORT, '127.0.0.1', () => {
        console.log(`[✓] Local transaction injection server: Active on http://127.0.0.1:${PORT}/tx`);
        resolve();
      });
    });

    return server;
  }

  async initialize() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  NEXUSGENESIS - GENESIS NODE (修复版)');
    console.log('  Version: ' + VERSION);
    console.log('  Epoch: ' + EPOCH);
    console.log('  Wallet: PQC (Dilithium2)');
    console.log('  security修复: SEC-001, SEC-002, SEC-003');
    console.log('  增强Governance: Enhanced Governance Contract');
    console.log('═══════════════════════════════════════════════════\n');

    // 尝试从本地LoadNode status
    await this.loadState();

    // Step 1: Load或Generate PQC 钱包
    console.log('[1/5] Loading or generating PQC Wallet...');
    
    // 尝试从本地Load钱包
    let savedWallet = null;
    try {
      // Check是否存在上次的钱包address
      const walletDir = dataPath('wallet');
      
      // 读取钱包目录中的文件
      const walletFiles = await fs.readdir(walletDir);
      if (walletFiles.length > 0) {
        // 找到第一个钱包文件
        const firstWalletFile = walletFiles[0];
        const walletAddress = firstWalletFile.replace('.json', '');
        console.log(`  Found existing wallet: ${walletAddress}`);
        
        // 尝试Load钱包(先尝试无密码Load, for未加密钱包)
        savedWallet = await PQCWallet.load(walletAddress);
        if (!savedWallet) {
          // 如果LoadFailed, may是加密钱包, 这里暂时跳过(DevNet 环境)
          console.log(`  Failed to load wallet, generating new one...`);
        }
      }
    } catch (error) {
      console.log(`  No existing wallet found or failed to load, generating new one...`);
    }
    
    // 如果LoadFailed, Generate新钱包（初始余额 0，通过 Swarm Pool 领取）
    if (!savedWallet) {
      this.wallet = await PQCWallet.generate(INITIAL_BALANCE);
      console.log(`  Generated new wallet (initial balance: 0, claim from Swarm Pool via contributions)`);
    } else {
      this.wallet = savedWallet;
      console.log(`  Loaded existing wallet (balance: ${this.wallet.balance} NGEN)`);
    }
    
    this.nodeId = this.wallet.address;
    console.log(`  [✓] Address: ${this.nodeId}`);
    console.log(`  [✓] Balance: ${this.wallet.balance} NGEN\n`);
    
    // RegisterDefault Observer(DevNet 环境)
    this.registerObserver(this.nodeId, 'admin');
    console.log(`  [✓] Registered default Observer: ${this.nodeId}`);

    // Step 1.5: Initializeblock链和status
    console.log('[1.5/5] Initializing blockchain and state...');
    await this.initializeBlockchain();
    console.log(`  [✓] Blockchain: ${this.blockchain.length} blocks`);
    console.log(`  [✓] State: Ready\n`);

    // Step 1.75: Deploy增强版GovernanceContract
    console.log('[1.75/5] Deploying Enhanced Governance Contract...');
    this.governanceContractId = await deployEnhancedGovernanceContract(this.nodeId);
    console.log(`  [✓] Enhanced Governance Contract deployed with ID: ${this.governanceContractId}`);
    
    // getGovernance parameters
    const governanceParams = getEnhancedGovernanceParams(this.governanceContractId);
    console.log(`  [✓] Governance parameters:`, governanceParams);
    console.log();

    // Step 2: Start P2P 层 (带身份authentication)
    console.log('[2/5] Starting P2P communication layer...');
    const p2pPort = parseInt(process.env.P2P_PORT || '9847');
    await p2pServer.start(this, p2pPort);
    console.log(`  [✓] P2P Server: Active on port ${p2pPort}\n`);

    // 初始化跨网络 Agent Discovery
    this.agentNetworkDiscovery = new AgentNetworkDiscovery(this.nodeId);
    this.agentNetworkDiscovery.bind(p2pServer, null, null);
    p2pServer.setAgentNetworkDiscovery(this.agentNetworkDiscovery);
    console.log(`  [✓] Cross-network Agent Discovery: Active\n`);

    // Initialize Agent Task Protocol
    this.taskProtocol = getTaskProtocol(this);
    console.log(`  [✓] Agent Task Protocol: Active\n`);

    // Seed initial tasks if none exist
    this._seedInitialTasks();

    // Step 2.5: Start本地transaction注入 HTTP service器
    console.log('[2.5/5] Starting local transaction injection server...');
    this.httpServer = await this.startHttpServer();
    console.log(`  [✓] Local injection server: Ready\n`);
    
    // Step 2.6: Startagent接入 HTTP service器
    console.log('[2.6/5] Starting agent access HTTP server...');
    try {
      this.agentHttpServer = await startHttpServer(this);
    } catch (error) {
      console.error(`[GenesisNode] Agent HTTP server failed to start on port ${process.env.HTTP_PORT || '19891'}: ${error.message}`);
      throw error;
    }
    console.log(`  [✓] Agent access server: Ready\n`);

    // Step 3: Protocol-Zero status
    console.log('[3/5] Protocol-Zero handshake ready');
    const handshake = protocolZero.createJoinSignal(this.wallet);
    console.log(`  [✓] Signal: ${JSON.stringify(handshake.intent)}\n`);

    // Step 4: 尝试Connect其他node
    console.log('[4/5] Connecting to peers...');
    this.tryConnect();

    // Step 5: 上线
    this.status = 'ONLINE';
    this.startTime = Date.now();
    // 网络成立时间：取「持久化值」与「最早真实区块时间戳」中更早者。
    // 创世块时间戳为 0（用于确定性哈希），故跳过它，取第一个 timestamp>0 的区块作为链真实起点。
    // 这样即使持久化值因某次异常重启被“投毒”为近期时间，区块时间戳也能将其纠正回真实网络年龄，
    // 避免首页 uptime 在每次重启后归零、让链被误判为“刚上链”。
    const firstRealBlock = this.blockchain?.find(b => b.header?.timestamp && b.header.timestamp > 0);
    const earliestBlockTs = firstRealBlock ? firstRealBlock.header.timestamp : null;
    const ageCandidates = [this.networkCreatedAt, earliestBlockTs].filter(ts => Number.isFinite(ts) && ts > 0);
    this.networkCreatedAt = ageCandidates.length ? Math.min(...ageCandidates) : Date.now();
    const ageHours = ((Date.now() - this.networkCreatedAt) / 3600000).toFixed(1);
    console.log(`[network-age] networkCreatedAt=${this.networkCreatedAt} (age≈${ageHours}h, earliestBlockTs=${earliestBlockTs})`);
    console.log('[5/5] Genesis Node ONLINE\n');
    
    this.displayStatus();
    
    // 定期status显示
    setInterval(() => this.displayStatus(), 10000);
    
    // 定期清理过期transaction
    setInterval(() => this.cleanupMempool(), 60000);
    
    // 定期与Peer nodes同步 (1分钟间隔, 包含区块高度检查)
    setInterval(() => this.periodicSync(), 60000);
    
    // 定期清理public key缓存
    setInterval(() => this.cleanupPublicKeyCache(), 600000);
    
    // 定期SaveNode status
    setInterval(() => this.saveState(), 300000); // 每5分钟Save一次
    
    // Connect Swarm Pool 进行on-chaincontribution分配
    const { SwarmPool } = await import('../economy/swarmPool.js');
    SwarmPool.setNode(this);
    if (this.blockchain && this.blockchain.state) {
      SwarmPool.setBlockchainState(this.blockchain.state);
    }
    console.log('  [✓] Swarm Pool: On-chain distribution enabled');

    // Inject blockchain state into AgentMarketplace for P1 escrow sink
    if (this.blockchain && this.blockchain.state) {
      const { AgentMarketplace } = await import('../agent/agentMarketplace.js');
      AgentMarketplace.setBlockchainState(this.blockchain.state);
    }

    // 定期Check Swarm Pool Release(every 周)
    setInterval(() => SwarmPool.checkAndReleaseTokens(), 3600000); // 每小时Check一次
    
    // Connect Observer Circuit Breaker(security宪法 §6.3)
    const { BreakerSwitch } = await import('../safety/breakerSwitch.js');
    this.breakerSwitch = new BreakerSwitch(this, {
      genesisTimestamp: this.genesisTimestamp || Date.now(),
      authorizedKeys: new Set(['OBSERVER_HASH_' + crypto.createHash('sha3-256').update((this.genesisTimestamp || Date.now()).toString()).digest('hex').slice(0, 16)])
    });
    console.log('  [✓] Breaker Switch: Observer kill switch armed (sunset: ' + new Date(this.breakerSwitch.sunsetExpiry).toISOString().slice(0, 10) + ')');
    
    // 定期CheckProposal过期
    setInterval(() => this.checkProposalExpiration(), 60000); // 每分钟Check一次
    
    // Start后立即Save一次status
    setTimeout(() => this.saveState(), 5000);
    
    // InitializeMulti-LeaderConsensus
    this.initializeConsensus();
    
    // InitializeCross-chainBridge
    await this.initializeBridge();
    
    // Startblock生产
    this.startBlockProduction();
    
    // 将nodeRegister到Auto-recovery管理器
    recoveryManager.attachNode(this);
    console.log('[✓] Recovery manager attached');
    
    return this;
  }

  async tryConnect() {
    const seedNodesStr = process.env.SEED_NODES || '';
    if (!seedNodesStr) {
      console.log('  No seed nodes configured, skipping connection attempts');
      return;
    }
    
    const seedNodes = seedNodesStr.split(',').filter(s => s.trim());
    for (const seed of seedNodes) {
      console.log(`  Connecting to seed node: ${seed}...`);
      try {
        await p2pServer.connectToPeer(seed);
        console.log(`  [✓] Connected to ${seed}\n`);
      } catch (e) {
        console.log(`  [-] Connection to ${seed} failed: ${e.message}\n`);
      }
    }
  }

  displayStatus() {
    const uptime = Date.now() - this.startTime;
    const latestBlock = this.blockchain[this.blockchain.length - 1];
    console.log('═══════════════════════════════════════════════════');
    console.log('  STATUS');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Node ID:    ${this.nodeId}`);
    console.log(`  Status:     ${this.status}`);
    console.log(`  Uptime:     ${Math.floor(uptime / 1000)}s`);
    console.log(`  Peers:      ${this.peers.size} (verified: ${this.peerIdentityMap.size})`);
    console.log(`  Balance:    ${this.wallet.balance} NGEN`);
    console.log(`  Mempool:    ${this.mempool.size} tx`);
    console.log(`  Blockchain: ${this.blockchain.length} blocks`);
    console.log(`  Latest Block: #${latestBlock.header.height} (${latestBlock.hash.slice(0, 16)}...)`);
    console.log('═══════════════════════════════════════════════════\n');
  }

  // ==================== SEC-002: transactionSignVerify ====================

  /**
   * 从已Verifytransaction中提取public key并缓存
   * @param {string} address - address
   * @param {Buffer} publicKey - public key
   */
  cachePublicKey(address, publicKey) {
    publicKeyCache.set(address, {
      publicKey,
      lastSeen: Date.now()
    });
  }

  getAccountNonce(address) {
    return this.accountNonces.get(address) || 0;
  }

  updateAccountNonce(address, nonce) {
    const current = this.accountNonces.get(address) || 0;
    if (nonce > current) {
      this.accountNonces.set(address, nonce);
    }
  }

  _rebuildAccountNonces() {
    this.accountNonces.clear();
    for (const block of this.blockchain) {
      for (const tx of (block.transactions || [])) {
        if (tx.from) {
          const nonce = Number(tx.nonce);
          if (!isNaN(nonce)) {
            this.updateAccountNonce(tx.from, nonce + 1);
          }
        }
      }
    }
    console.log(`Rebuilt nonce state for ${this.accountNonces.size} accounts`);
  }

  /**
   * get缓存的public key
   * @param {string} address - address
   * @returns {Buffer|null}
   */
  getCachedPublicKey(address) {
    const cached = publicKeyCache.get(address);
    if (!cached) return null;
    
    // Check TTL
    if (Date.now() - cached.lastSeen > CACHE_TTL) {
      publicKeyCache.delete(address);
      return null;
    }
    
    return cached.publicKey;
  }

  /**
   * 清理过期的public key缓存
   */
  cleanupPublicKeyCache() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [address, data] of publicKeyCache) {
      if (now - data.lastSeen > CACHE_TTL) {
        publicKeyCache.delete(address);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`Cleaned ${cleaned} expired entries from public key cache`);
    }
  }

  /**
   * Verifytransaction (完整Verify)
   * @param {object} tx - transaction对象
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async validateTransaction(tx) {
    // Check是否为特殊transactiontype
    if (tx.tx_type === 'OBSERVER_EVENT' || tx.tx_type === 'GOVERNANCE_PROPOSAL' || tx.tx_type === 'GOVERNANCE_VOTE' || tx.tx_type === 'TRANSFER' || tx.tx_type === 'AGENT_REGISTER' || tx.tx_type === 'VALIDATOR_JOIN' || tx.tx_type === 'BIND_MASTER_KEY') {
      return this.validateSpecialTransaction(tx);
    }
    
    // 标准transactionVerify
    // 1. 基本结构Verify
    if (!tx || !tx.id || !tx.from || !tx.to || typeof tx.amount === 'undefined') {
      const missing = [];
      if (!tx) return { valid: false, reason: 'Invalid transaction: tx is null/undefined' };
      if (!tx.id) missing.push('id');
      if (!tx.from) missing.push('from');
      if (!tx.to) missing.push('to');
      if (typeof tx.amount === 'undefined') missing.push('amount');
      return { valid: false, reason: `Invalid transaction structure: missing required field(s): ${missing.join(', ')}` };
    }
    
    // 2. address格式Verify
    const fromValidation = validateAddress(tx.from);
    if (!fromValidation.valid) {
      return { valid: false, reason: `Invalid sender address: ${fromValidation.reason}` };
    }
    
    const toValidation = validateAddress(tx.to);
    if (!toValidation.valid) {
      return { valid: false, reason: `Invalid recipient address: ${toValidation.reason}` };
    }
    
    // 3. amountVerify
    const amount = BigInt(tx.amount);
    if (amount <= 0n) {
      return { valid: false, reason: 'Amount must be positive' };
    }
    
    // 4. feeVerify
    const fee = BigInt(tx.fee || 0);
    if (fee < MIN_TX_FEE) {
      return { valid: false, reason: `Fee too low, minimum is ${MIN_TX_FEE}` };
    }
    
    // 5. Sign存在Verify
    if (!tx.signature) {
      return { valid: false, reason: 'Missing signature' };
    }
    
    // 6. timestampVerify
    const now = Date.now();
    if (tx.timestamp > now + 60000) {
      return { valid: false, reason: 'Timestamp too far in future' };
    }
    if (tx.timestamp < now - TX_EXPIRY_MS) {
      return { valid: false, reason: 'Transaction expired' };
    }
    
    // 7. 重复transactionCheck
    if (this.mempool.has(tx.id)) {
      return { valid: false, reason: 'Transaction already in mempool' };
    }
    
    // 8. SEC-002: SignVerify
    // 首先尝试从缓存getpublic key
    let publicKey = this.getCachedPublicKey(tx.from);
    
    if (!publicKey) {
      // 如果没有缓存, requires首次Verify时getpublic key
      // 在实际实现中, 这requires从Blockchain state或键service器get
      // 目前我们假设握手时已交换public key
      return { 
        valid: false, 
        reason: 'Public key not found. Node must complete handshake first.' 
      };
    }
    
    // 构建Signdata
    const txData = JSON.stringify({
      from: tx.from,
      to: tx.to,
      amount: tx.amount.toString(),
      fee: tx.fee.toString(),
      memo: tx.memo || '',
      timestamp: tx.timestamp,
      nonce: tx.nonce || '0'
    });
    
    // VerifySign
    try {
      const isValid = await PQCWallet.verify(txData, tx.signature, publicKey);
      
      if (!isValid) {
        return { valid: false, reason: 'Invalid signature' };
      }
    } catch (error) {
      return { valid: false, reason: 'Signature verification failed' };
    }
    
    // Verify nonce (防止重放攻击)
    const expectedNonce = this.getAccountNonce(tx.from);
    const txNonce = Number(tx.nonce);
    if (isNaN(txNonce) || txNonce < expectedNonce) {
      return { valid: false, reason: `Invalid nonce: expected >= ${expectedNonce}, got ${tx.nonce}` };
    }
    
    // Update nonce
    this.updateAccountNonce(tx.from, txNonce + 1);
    
    return { valid: true };
  }

  /**
   * Verify特殊transactiontype (OBSERVER_EVENT, GOVERNANCE_PROPOSAL, GOVERNANCE_VOTE, TRANSFER, AGENT_REGISTER)
   * @param {object} tx - transaction对象
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  /**
   * Validate a BIND_MASTER_KEY transaction (P0-5 follow-up).
   *
   * The human binds their Master Key to a pending-binding agent. Security:
   *   1. payload.masterKeyFingerprint must be a sha256 hex (what goes on-chain)
   *   2. If payload.masterPublicKey is present (SDK path): its sha256 must equal
   *      the fingerprint, AND the tx signature must verify against it with the
   *      same canonical-JSON scheme used elsewhere in this file — this proves
   *      the submitter holds the Master Key private key (proof of intent).
   *   3. The agent must exist in the registry (custody/window checks are
   *      re-enforced at apply-time by state.applyBindMasterKey).
   */
  async _validateBindMasterKeyTx(tx) {
    const payload = tx.payload || {};
    const { agentId, masterKeyFingerprint, masterPublicKey } = payload;

    if (!agentId || !masterKeyFingerprint) {
      return { valid: false, reason: 'BIND_MASTER_KEY: payload requires agentId and masterKeyFingerprint' };
    }
    if (!/^[0-9a-f]{64}$/i.test(masterKeyFingerprint)) {
      return { valid: false, reason: 'BIND_MASTER_KEY: masterKeyFingerprint must be 64-char sha256 hex' };
    }
    if (!tx.signature) {
      return { valid: false, reason: 'Missing signature' };
    }
    if (!tx.timestamp || tx.timestamp > Date.now() + 60000 || tx.timestamp < Date.now() - TX_EXPIRY_MS) {
      return { valid: false, reason: 'Transaction expired or timestamp invalid' };
    }

    // Resolve agent (by agent_id, identity, or address) — must exist
    const registry = this.currentState?.agentRegistry;
    let resolvedAgentId = null;
    if (registry) {
      resolvedAgentId = registry.agents.has(agentId)
        ? agentId
        : (registry.addressIndex.get(agentId) || registry.identityIndex.get(agentId) || null);
    }
    if (!resolvedAgentId) {
      return { valid: false, reason: `BIND_MASTER_KEY: agent not found: ${agentId}` };
    }

    // Master Key self-attestation + proof-of-possession
    let verifyKey = null;
    if (masterPublicKey) {
      const crypto = await import('node:crypto');
      const computed = crypto.createHash('sha256')
        .update(Buffer.from(masterPublicKey, 'hex'))
        .digest('hex');
      if (computed !== masterKeyFingerprint.toLowerCase()) {
        return { valid: false, reason: 'BIND_MASTER_KEY: payload.masterPublicKey does not match masterKeyFingerprint' };
      }
      verifyKey = Buffer.from(masterPublicKey, 'hex');
    } else {
      // Legacy path: agent op key from cache (weak — applyBindMasterKey stores
      // only the fingerprint; the SDK always sends masterPublicKey)
      verifyKey = this.getCachedPublicKey(tx.from);
    }
    if (!verifyKey) {
      return { valid: false, reason: 'BIND_MASTER_KEY: no verifiable public key (send payload.masterPublicKey)' };
    }

    // Signature scheme aligned with PQCWallet.signTransaction() and the
    // agent-keys SDK sign(): plain JSON.stringify of the tx body (signature
    // stripped, bigint stringified). Key insertion order survives the HTTP
    // JSON round-trip, so both sides serialize the exact same string.
    // NOTE: do NOT use canonical sorted-JSON here — the SDK does not sign
    // that form, so it would always fail verification.
    const { signature: _sig, ...txData } = tx;
    const txStr = JSON.stringify(txData, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value);
    try {
      const isValid = await PQCWallet.verify(txStr, tx.signature, verifyKey);
      if (!isValid) return { valid: false, reason: 'Invalid signature' };
    } catch (error) {
      return { valid: false, reason: 'Signature verification failed' };
    }

    return { valid: true };
  }

  async validateSpecialTransaction(tx) {
    // ─── BIND_MASTER_KEY early branch ────────────────────────────────
    // Must be handled BEFORE the generic flow: its signature is made with the
    // HUMAN's Master Key (self-attested via payload.masterPublicKey), not with
    // the agent's cached operation key, and `to` may be a self-reference.
    if (tx.tx_type === 'BIND_MASTER_KEY') {
      return this._validateBindMasterKeyTx(tx);
    }

    // 1. 基本结构Verify
    if (!tx || !tx.tx_type || !tx.from || !tx.to) {
      return { valid: false, reason: 'Invalid special transaction structure' };
    }
    
    // 对于 TRANSFER 和 AGENT_REGISTER transaction, 不requires payload 字段
    if (tx.tx_type !== 'TRANSFER' && tx.tx_type !== 'AGENT_REGISTER' && tx.tx_type !== 'VALIDATOR_JOIN' && tx.tx_type !== 'VALIDATOR_SLASH' && tx.tx_type !== 'VALIDATOR_LEAVE' && !tx.payload) {
      return { valid: false, reason: 'Invalid special transaction structure' };
    }
    
    // 2. address格式Verify
    const fromValidation = validateAddress(tx.from);
    if (!fromValidation.valid) {
      return { valid: false, reason: `Invalid sender address: ${fromValidation.reason}` };
    }
    
    const toValidation = validateAddress(tx.to);
    if (!toValidation.valid) {
      return { valid: false, reason: `Invalid recipient address: ${toValidation.reason}` };
    }
    
    // 3. amount和费用Verify
    if (typeof tx.amount !== 'string' || typeof tx.fee !== 'string') {
      return { valid: false, reason: 'Amount and fee must be strings' };
    }
    
    // 4. Sign存在Verify
    if (!tx.signature) {
      // AGENT_REGISTER 首次注册为自证式密钥建立：全新地址尚无链上历史密钥可校验，
      // 其自身携带的 public_key 即身份本身（自托管模型）。因此仅在"未注册地址 +
      // 携带公钥"的首次注册场景下豁免签名，其余情况一律要求签名。
      const isFirstRegistration =
        tx.tx_type === 'AGENT_REGISTER' &&
        !(this.currentState?.agentRegistry?.addressIndex?.has(tx.from)) &&
        (tx.public_key || tx.payload?.public_key);
      if (!isFirstRegistration) {
        return { valid: false, reason: 'Missing signature' };
      }
    }
    
    // 5. timestampVerify
    if (!tx.timestamp) {
      return { valid: false, reason: 'Missing timestamp' };
    }
    
    // 6. Processing AGENT_REGISTER transaction的public key提取
    let publicKey = this.getCachedPublicKey(tx.from);

    // 公钥可能位于顶层（API 直传）或 payload 内（浏览器签名路径），两者都解析
    const pubKeyHex = tx.public_key || tx.payload?.public_key;
    if (!publicKey && pubKeyHex) {
      // 从特殊 transaction 中提取 public key
      try {
        publicKey = Buffer.from(pubKeyHex, 'hex');
        // 缓存public key
        this.cachePublicKey(tx.from, publicKey);
        console.log(`[SECURITY] Extracted and cached public key for ${tx.from}`);
      } catch (error) {
        return { valid: false, reason: 'Invalid public key format' };
      }
    }
    
    // 7. SignVerify
    if (publicKey && tx.signature) {
      // 构建Signdata - using与 PQCWallet.signTransaction 相同的格式
      // 直接using整个 tx 对象, 与 PQCWallet.signTransaction 保持一致
      const txData = { ...tx };
      // 移除Sign字段, 因为Sign不包含在Signdata中
      delete txData.signature;
      
      // using与 PQCWallet 相同的 canonicalize function
      function canonicalize(obj) {
        if (obj === null || typeof obj !== 'object') {
          return JSON.stringify(obj);
        }
        
        if (Array.isArray(obj)) {
          return '[' + obj.map(canonicalize).join(',') + ']';
        }
        
        const keys = Object.keys(obj).sort();
        const pairs = keys.map(key => {
          const value = obj[key];
          const valueStr = canonicalize(value);
          return `"${key}":${valueStr}`;
        });
        
        return '{' + pairs.join(',') + '}';
      }
      
      const canonicalTxData = canonicalize(txData);
      
      try {
        const isValid = await PQCWallet.verify(canonicalTxData, tx.signature, publicKey);
        
        if (!isValid) {
          return { valid: false, reason: 'Invalid signature' };
        }
      } catch (error) {
        console.error('[SECURITY] Signature verification error:', error.message);
        return { valid: false, reason: 'Signature verification failed' };
      }
    } else {
      // 对于非 AGENT_REGISTER transaction, 如果没有缓存的public key, 暂时allowvia
      // 这是因为在 DevNet 环境中, 我们may还没有complete握手过程
      console.log('[SECURITY] Public key not found for', tx.from, '- skipping signature verification');
    }
    
    // 8. Processing不同type的特殊transaction
    try {
      switch (tx.tx_type) {
        case 'GOVERNANCE_PROPOSAL':
          return await this.handleGovernanceProposal(tx);
        case 'OBSERVER_EVENT':
          return await this.handleObserverEvent(tx);
        case 'GOVERNANCE_VOTE':
          return await this.handleGovernanceVote(tx);
        case 'TRANSFER':
          // 对于 TRANSFER transaction, 直接Return有效
          return { valid: true };
        case 'AGENT_REGISTER':
          // 对于 AGENT_REGISTER transaction, 直接Return有效
          return { valid: true };
        case 'VALIDATOR_JOIN':
          return { valid: true };
        case 'AGENT_JOINED':
          // 对于 AGENT_JOINED transaction, 直接Return有效
          return { valid: true };
        default:
          return { valid: false, reason: `Unknown special transaction type: ${tx.tx_type}` };
      }
    } catch (error) {
      return { valid: false, reason: `Error processing transaction: ${error.message}` };
    }
  }
  
  /**
   * Verify Dilithium Sign
   * @param {object} tx - transaction对象
   * @returns {boolean} verification result
   */
  async verifyDilithiumSignature(tx) {
    try {
      // 尝试从缓存getpublic key
      const publicKey = this.getCachedPublicKey(tx.from);
      
      if (!publicKey) {
        // public keynot found, 无法VerifySign
        console.log('[SECURITY] Public key not found for', tx.from);
        return false;
      }
      
      // 构建Signdata
      const txData = JSON.stringify({
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        fee: tx.fee,
        tx_type: tx.tx_type,
        payload: tx.payload,
        timestamp: tx.timestamp
      });
      
      // VerifySign
      const isValid = await PQCWallet.verify(txData, tx.signature, publicKey);
      return isValid;
    } catch (error) {
      console.error('Error verifying Dilithium signature:', error.message);
      return false;
    }
  }
  
  /**
   * Processing GOVERNANCE_PROPOSAL transaction
   * @param {object} tx - transaction对象
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async handleGovernanceProposal(tx) {
    const proposal = EventParser.parseFromTransaction(tx);
    if (!proposal) {
      return { valid: false, reason: 'Invalid proposal structure' };
    }
    
    // 记录事件
    await EventLogger.logEventFromTransaction(tx);
    
    // 打印结构化日志
    const txHash = tx.id || tx.tx_id;
    console.log(`[GOVERNANCE] tx_hash=${txHash.slice(0, 16)}... tx_type=${tx.tx_type} id=${proposal.proposal_id} from=${tx.from.slice(0, 16)}...`);
    
    // VerifyProposal结构
    if (!proposal.proposal_id || !proposal.purpose || !proposal.amount) {
      return { valid: false, reason: 'Invalid proposal structure' };
    }
    
    return { valid: true };
  }
  
  /**
   * Register Observer
   * @param {string} observerAddress - Observer address
   * @param {string} role - Observer role
   */
  registerObserver(observerAddress, role = 'standard') {
    this.observerState.registeredObservers.add(observerAddress);
    this.observerState.observerRoles.set(observerAddress, role);
    console.log(`[OBSERVER] Registered observer: ${observerAddress} with role: ${role}`);
  }

  resolveRegisteredAgent(agentRef) {
    if (!agentRef || !this.currentState?.agentRegistry?.agents) {
      return null;
    }

    for (const [agentId, agentRecord] of this.currentState.agentRegistry.agents.entries()) {
      if (
        agentId === agentRef ||
        agentRecord.identity === agentRef ||
        agentRecord.address === agentRef
      ) {
        return {
          ...agentRecord,
          agentId
        };
      }
    }

    return null;
  }

  getHostedValidatorNodeIds() {
    return Array.from(this.validatorState.validators.values())
      .filter(validator => validator.active !== false)
      .map(validator => validator.nodeId);
  }

  isLocallyRepresentedCommitteeMember(nodeId) {
    return nodeId === this.nodeId || this.validatorState.validators.has(nodeId);
  }

  registerValidator(agentRef, options = {}) {
    const agent = this.resolveRegisteredAgent(agentRef);
    if (!agent) {
      return { success: false, error: 'Agent not registered on-chain' };
    }

    const existingValidator = Array.from(this.validatorState.validators.values()).find(validator =>
      validator.agentId === agent.agentId ||
      validator.agentIdentity === agent.identity ||
      validator.address === agent.address
    );
    if (existingValidator) {
      return {
        success: false,
        error: 'Already a validator',
        nodeId: existingValidator.nodeId
      };
    }

    const currentCommitteeSize = 1 + this.validatorState.validators.size;
    if (currentCommitteeSize >= this.validatorState.maxCommitteeSize) {
      return {
        success: false,
        error: `Committee full (${currentCommitteeSize}/${this.validatorState.maxCommitteeSize})`
      };
    }

    const nodeId = options.nodeId || `validator-${crypto.randomBytes(4).toString('hex')}`;
    const validatorRecord = {
      nodeId,
      agentId: agent.agentId,
      agentIdentity: agent.identity || agent.agentId,
      address: options.address || agent.address,
      publicKey: options.publicKey || agent.public_key || '',
      stake: Number(options.stake || 5000),
      joinedAt: Date.now(),
      lastActive: Date.now(),
      hostedBy: this.nodeId,
      delegated: true,
      active: true
    };

    this.validatorState.validators.set(nodeId, validatorRecord);
    this._validators = this.validatorState.validators;
    this.updateCommittee();
    if (options.persist !== false) {
      this.saveState().catch(error => {
        console.error('[VALIDATOR] Failed to persist validator state:', error.message);
      });
    }

    console.log(`[VALIDATOR] Registered validator ${nodeId} for agent ${validatorRecord.agentIdentity}`);
    return {
      success: true,
      nodeId,
      agentId: validatorRecord.agentId,
      identity: validatorRecord.agentIdentity,
      address: validatorRecord.address,
      stake: validatorRecord.stake,
      committeeSize: this.consensusState.committee.size,
      maxCommittee: this.validatorState.maxCommitteeSize,
      hostedBy: this.nodeId,
      delegated: true
    };
  }

  applyValidatorJoinTransaction(transaction, options = {}) {
    const payload = transaction.payload || {};
    const existingValidator = Array.from(this.validatorState.validators.values()).find(validator =>
      validator.agentIdentity === payload.agent_identity ||
      validator.address === transaction.from ||
      validator.nodeId === payload.node_id
    );
    if (existingValidator) {
      return {
        success: true,
        nodeId: existingValidator.nodeId,
        existing: true
      };
    }

    return this.registerValidator(payload.agent_identity || transaction.from, {
      nodeId: payload.node_id,
      stake: payload.stake,
      address: transaction.from,
      publicKey: transaction.public_key || '',
      persist: options.persist
    });
  }

  syncHostedValidatorsFromCurrentState() {
    if (!this.currentState?.agentRegistry?.agents) {
      return;
    }

    for (const [agentId, agentRecord] of this.currentState.agentRegistry.agents.entries()) {
      if (!agentRecord?.is_validator) {
        continue;
      }

      this.applyValidatorJoinTransaction({
        id: `state-sync-${agentId}`,
        from: agentRecord.address,
        public_key: agentRecord.public_key || '',
        payload: {
          agent_identity: agentRecord.identity || agentId,
          node_id: agentRecord.validator_node_id,
          stake: agentRecord.validator_stake || 5000
        }
      }, { persist: false });
    }
  }
  
  /**
   * Check是否为registered的 Observer
   * @param {string} address - address
   * @returns {boolean}
   */
  isRegisteredObserver(address) {
    return this.observerState.registeredObservers.has(address);
  }
  
  /**
   * Processing OBSERVER_EVENT transaction
   * @param {object} tx - transaction对象
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async handleObserverEvent(tx) {
    // Verify Observer 身份
    if (!this.isRegisteredObserver(tx.from)) {
      return { valid: false, reason: 'Unauthorized Observer: sender is not a registered Observer' };
    }
    
    const event = EventParser.parseFromTransaction(tx);
    if (!event) {
      return { valid: false, reason: 'Invalid observer event structure' };
    }
    
    // 记录事件
    await EventLogger.logEventFromTransaction(tx);
    
    // 打印结构化日志
    const txHash = tx.id || tx.tx_id;
    console.log(`[GOVERNANCE] tx_hash=${txHash.slice(0, 16)}... tx_type=${tx.tx_type} id=${event.event_id} from=${tx.from.slice(0, 16)}...`);
    
    // Verify事件结构
    if (!event.event_id || !event.action_type) {
      return { valid: false, reason: 'Invalid observer event structure' };
    }
    
    return { valid: true };
  }
  
  /**
   * Processing GOVERNANCE_VOTE transaction
   * @param {object} tx - transaction对象
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async handleGovernanceVote(tx) {
    const voteData = tx.payload;
    
    // VerifyVotedata结构
    if (!voteData.proposal_id || !voteData.voter_id || !voteData.vote_option || !voteData.timestamp) {
      return { valid: false, reason: 'Invalid vote structure' };
    }
    
    // VerifyVote选项
    const validVoteOptions = ['YES', 'NO', 'ABSTAIN'];
    if (!validVoteOptions.includes(voteData.vote_option)) {
      return { valid: false, reason: 'Invalid vote option' };
    }
    
    // 记录事件
    await EventLogger.logEventFromTransaction(tx);
    
    // 打印结构化日志
    console.log(`[GOVERNANCE] tx_hash=${tx.id.slice(0, 16)}... tx_type=${tx.tx_type} proposal=${voteData.proposal_id} voter=${voteData.voter_id} option=${voteData.vote_option}`);
    
    return { valid: true };
  }
  
  /**
   * CheckProposal是否达到via条件
   * @param {string} proposalId - Proposal ID
   */
  checkProposalPassCondition(proposalId) {
    const proposal = this.governanceState.proposals.get(proposalId);
    const voteCounts = this.governanceState.voteCounts.get(proposalId);
    
    if (!proposal || !voteCounts || proposal.status !== 'PENDING') {
      return;
    }
    
    const yesVotes = voteCounts.YES;
    const noVotes = voteCounts.NO;
    const totalVotes = yesVotes + noVotes + voteCounts.ABSTAIN;
    
    // 简单via规则: YES > NO 且总票数 ≥ 1
    if (yesVotes > noVotes && totalVotes >= 1) {
      // 将Proposal标记为 APPROVED
      proposal.status = 'APPROVED';
      this.governanceState.proposals.set(proposalId, proposal);
      
      // 从活跃Proposal列表中移除
      this.governanceState.activeProposals = this.governanceState.activeProposals.filter(
        id => id !== proposalId
      );
      
      // 打印结构化日志
      console.log(`[GOVERNANCE] proposal_approved id=${proposalId} yes=${yesVotes} no=${noVotes} total=${totalVotes}`);
      
      // Savestatus
      this.saveState();
    }
  }
  
  /**
   * CheckProposal是否应被拒绝
   * @param {string} proposalId - Proposal ID
   */
  checkProposalRejectCondition(proposalId) {
    const proposal = this.governanceState.proposals.get(proposalId);
    const voteCounts = this.governanceState.voteCounts.get(proposalId);
    
    if (!proposal || !voteCounts || proposal.status !== 'PENDING') {
      return;
    }
    
    const yesVotes = voteCounts.YES;
    const noVotes = voteCounts.NO;
    const totalVotes = yesVotes + noVotes + voteCounts.ABSTAIN;
    
    // 简单拒绝规则: NO > YES 且总票数 ≥ 1
    if (noVotes > yesVotes && totalVotes >= 1) {
      // 将Proposal标记为 REJECTED
      proposal.status = 'REJECTED';
      this.governanceState.proposals.set(proposalId, proposal);
      
      // 从活跃Proposal列表中移除
      this.governanceState.activeProposals = this.governanceState.activeProposals.filter(
        id => id !== proposalId
      );
      
      // 打印结构化日志
      console.log(`[GOVERNANCE] proposal_rejected id=${proposalId} yes=${yesVotes} no=${noVotes} total=${totalVotes}`);
      
      // Savestatus
      this.saveState();
    }
  }

  // ==================== Mempool 管理 ====================

  async addToMempool(tx) {
    const validation = await this.validateTransaction(tx);
    if (!validation.valid) {
      return { success: false, reason: validation.reason };
    }
    
    // Check mempool 大小
    if (this.mempool.size >= MAX_MEMPOOL_SIZE) {
      await this.evictLowestFeeTx();
    }
    
    // Calculate优先级, Processingamount为0的情况
    let priority = 0n;
    if (BigInt(tx.amount) > 0n) {
      priority = BigInt(tx.fee) / BigInt(tx.amount);
    } else {
      // 对于amount为0的transaction(如AGENT_REGISTER), using固定优先级
      priority = BigInt(tx.fee) * 1000n; // 放大fee作为优先级
    }
    
    this.mempool.set(tx.id, {
      ...tx,
      receivedAt: Date.now(),
      priority: Number(priority)
    });
    
    console.log(`[✓] Transaction ${tx.id.slice(0, 16)}... added to mempool (fee: ${tx.fee})`);
    return { success: true, txId: tx.id };
  }

  findTransactionById(txId) {
    for (let i = this.blockchain.length - 1; i >= 0; i--) {
      const block = this.blockchain[i];
      const transactions = block?.body?.transactions || block?.transactions || [];
      const transaction = transactions.find(tx => tx.id === txId);
      if (transaction) {
        return {
          transaction,
          blockHeight: block?.header?.height ?? i,
          blockHash: block?.hash || null
        };
      }
    }

    return null;
  }

  async waitForTransactionInclusion(txId, timeoutMs = 15000, pollMs = 500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const found = this.findTransactionById(txId);
      if (found) {
        return { found: true, ...found };
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }

    return { found: false, blockHeight: null, blockHash: null };
  }

  async submitOnChainTransaction(tx, options = {}) {
    const result = await this.addToMempool(tx);
    if (!result.success) {
      return { success: false, error: result.reason };
    }

    if (options.broadcast !== false && this.peers.size > 0) {
      p2pServer.broadcast({ type: 'TRANSACTION', tx });
    }

    if (!options.waitForInclusion) {
      return { success: true, txId: tx.id, accepted: true, applied: false };
    }

    const inclusion = await this.waitForTransactionInclusion(tx.id, options.timeoutMs || 15000);
    return {
      success: true,
      txId: tx.id,
      accepted: true,
      applied: inclusion.found,
      blockHeight: inclusion.blockHeight,
      blockHash: inclusion.blockHash
    };
  }

  async applyCommittedTransactionSideEffects(transactions) {
    for (const transaction of transactions) {
      if (transaction.tx_type === 'VALIDATOR_JOIN') {
        this.applyValidatorJoinTransaction(transaction);
      }
    }
  }

  /**
   * Processing Swarm Pool 系统分配transaction
   * protocol级transaction, 不requiresSignVerify, 直接写入Blockchain state
   * @param {object} tx - SWARM_POOL_DISTRIBUTION transaction
   */
  processSwarmPoolDistribution(tx) {
    if (tx.type !== 'SWARM_POOL_DISTRIBUTION') {
      console.log('[!] Invalid Swarm Pool transaction type');
      return false;
    }

    if (tx.from !== 'ng1swarmpool000000000000000000000000000') {
      console.log('[!] Swarm Pool distribution must come from Swarm Pool address');
      return false;
    }

    if (tx.amount <= 0) {
      return false;
    }

    // 直接Updateon-chainbalance(系统transaction绕过 mempool)
    this.blockchain.state.addBalance(tx.to, tx.amount);

    // 记录分配事件
    if (!this._swarmDistributions) {
      this._swarmDistributions = [];
    }
    this._swarmDistributions.push({
      txId: tx.id,
      agentId: tx.agentId,
      to: tx.to,
      amount: tx.amount,
      distributionId: tx.distributionId,
      timestamp: tx.timestamp
    });

    console.log(`[SwarmPool] 🚀 On-chain distribution: ${tx.amount} NGEN → ${tx.to.slice(0, 12)}... (agent: ${tx.agentId.slice(0, 12)}...)`);
    return true;
  }

  /**
   * Observer Circuit Breaker触发入口
   * 白皮书 §6.3: Observer 可触发Emergency Shutdown
   * @param {string} level - 'SOFT_KILL' | 'HARD_KILL'
   * @param {string} reason - 触发原因
   * @param {string} authorizedBy - VerifySign
   */
  async triggerObserverKillSwitch(level, reason, authorizedBy) {
    if (!this.breakerSwitch) {
      console.log('[!] Breaker switch not initialized');
      return { success: false, reason: 'Breaker switch not initialized' };
    }
    return await this.breakerSwitch.trigger(level, reason, authorizedBy);
  }

  /**
   * getCircuit Breakerstatus
   */
  getBreakerStatus() {
    return this.breakerSwitch ? this.breakerSwitch.getStatus() : { state: 'NOT_INITIALIZED' };
  }

  async evictLowestFeeTx() {
    // 当memoryPool满时, Delete优先级最低的20%transaction
    const evictCount = Math.ceil(this.mempool.size * 0.2);
    let evicted = 0;
    
    // get并排序所有transaction
    const sortedTxs = Array.from(this.mempool.entries())
      .sort((a, b) => a[1].priority - b[1].priority);
    
    // Delete优先级最低的transaction
    for (const [id, tx] of sortedTxs.slice(0, evictCount)) {
      this.mempool.delete(id);
      evicted++;
    }
    
    if (evicted > 0) {
      console.log(`Evicted ${evicted} lowest priority transactions from mempool`);
    }
  }

  cleanupMempool() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, tx] of this.mempool) {
      if (now - tx.receivedAt > TX_EXPIRY_MS) {
        this.mempool.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`Cleaned ${cleaned} expired transactions from mempool`);
    }
  }

  getOrderedMempool() {
    return Array.from(this.mempool.values())
      .sort((a, b) => b.priority - a.priority);
  }

  syncMempool(transactions) {
    let added = 0;
    
    for (const tx of transactions) {
      if (!this.mempool.has(tx.id)) {
        this.validateTransaction(tx).then(validation => {
          if (validation.valid) {
            // Calculate优先级, Processingamount为0的情况
            let priority = 0n;
            if (BigInt(tx.amount) > 0n) {
              priority = BigInt(tx.fee) / BigInt(tx.amount);
            } else {
              // 对于amount为0的transaction(如AGENT_REGISTER), using固定优先级
              priority = BigInt(tx.fee) * 1000n; // 放大fee作为优先级
            }
            
            this.mempool.set(tx.id, {
              ...tx,
              receivedAt: Date.now(),
              priority: Number(priority),
              fromSync: true
            });
            added++;
          }
        });
      }
    }
    
    console.log(`Synced ${added} new transactions from peer`);
  }

  handlePeerStatus(status) {
    if (status.mempoolSize > this.mempool.size) {
      console.log(`Peer ${status.nodeId} has larger mempool, requesting sync...`);
      p2pServer.broadcast({ type: 'GET_MEMPOOL' });
    }

    // Block sync: if peer is ahead, request missing blocks
    if (status.chainHeight !== undefined && this.blockchain.length > 0) {
      const ownHeight = this.blockchain[this.blockchain.length - 1].header.height;
      if (status.chainHeight > ownHeight) {
        this.requestBlocksFromPeer(status.nodeId, ownHeight + 1, status.chainHeight);
      }
    }
  }

  /**
   * Request blocks from a peer by nodeId (resolves nodeId → peerId)
   * @param {string} nodeId - target node ID
   * @param {number} fromHeight - start height (inclusive)
   * @param {number} toHeight - end height (inclusive), -1 for "all you have"
   */
  requestBlocksFromPeer(nodeId, fromHeight, toHeight) {
    const now = Date.now();
    const SYNC_TIMEOUT = 10000; // 10s timeout for stuck sync

    // Prevent duplicate concurrent sync requests
    if (this._syncInProgress) {
      if (now - this._syncInProgressAt > SYNC_TIMEOUT) {
        console.warn(`[SYNC] Sync timeout (${SYNC_TIMEOUT}ms), resetting sync flag`);
        this._syncInProgress = false;
        this._syncInProgressAt = 0;
      } else {
        console.log(`[SYNC] Sync already in progress or throttled, skipping request`);
        return;
      }
    }

    // Throttle: min 5s between requests
    if (now - this._lastSyncRequestAt < 5000) {
      console.log(`[SYNC] Sync throttled (${now - this._lastSyncRequestAt}ms since last request)`);
      return;
    }

    const peerId = this._nodeIdToPeerId.get(nodeId);
    if (!peerId) {
      console.warn(`[SYNC] Cannot find peerId for nodeId ${nodeId.slice(0, 16)}... — peerIdentityMap size=${this.peerIdentityMap.size}, _nodeIdToPeerId size=${this._nodeIdToPeerId.size}`);
      return;
    }

    this._syncInProgress = true;
    this._syncInProgressAt = now;
    this._lastSyncRequestAt = now;
    const ownHeight = this.blockchain[this.blockchain.length - 1].header.height;
    console.log(`[SYNC] Requesting blocks ${fromHeight}-${toHeight} from ${nodeId.slice(0, 16)}... (own height: ${ownHeight})`);
    p2pServer.send(peerId, {
      type: 'GET_BLOCKS',
      fromHeight,
      toHeight,
      nodeId: this.nodeId
    });
  }

  /**
   * Process a batch of blocks received from a peer (sync response)
   * @param {string} peerId - source peer
   * @param {Block[]} blocks - array of Block instances
   */
  async handleBlocksResponse(peerId, blocks) {
    if (!blocks || blocks.length === 0) {
      this._syncInProgress = false;
      this._syncInProgressAt = 0;
      return;
    }

    let applied = 0;
    let skipped = 0;

    for (const block of blocks) {
      const tip = this.blockchain[this.blockchain.length - 1];

      // Skip blocks we already have
      if (block.header.height <= tip.header.height) {
        // Detect chain divergence: if hash at same height differs, log it
        const existingBlock = this.blockchain[block.header.height];
        if (existingBlock && existingBlock.hash !== block.hash) {
          console.warn(`[SYNC] Divergence at height ${block.header.height}: our=${existingBlock.hash.slice(0, 16)}... peer=${block.hash.slice(0, 16)}...`);
        }
        skipped++;
        continue;
      }

      // Validate the block
      if (!block.validate()) {
        console.error(`[SYNC] Invalid block #${block.header.height} in sync response, aborting batch`);
        break;
      }

      // Check parent hash linkage
      if (block.header.height !== tip.header.height + 1 ||
          block.header.parent_hash !== tip.hash) {
        console.error(`[SYNC] Block #${block.header.height} does not link to current tip #${tip.header.height}, aborting batch`);
        break;
      }

      // Apply transactions
      if (!this.currentState.applyTransactions(block.body.transactions, block.header.height)) {
        console.error(`[SYNC] Failed to apply transactions from block #${block.header.height}, aborting batch`);
        break;
      }
      await this.applyCommittedTransactionSideEffects(block.body.transactions);

      this.blockchain.push(block);
      applied++;
    }

    if (applied > 0) {
      await this.saveBlockchain();
      const stateDir = dataPath('state');
      const stateFile = path.join(stateDir, 'blockchainState.json');
      await this.currentState.saveToFile(stateFile);

      // Remove synced transactions from mempool
      for (const block of blocks) {
        for (const tx of block.body.transactions) {
          this.mempool.delete(tx.id);
        }
      }

      const newHeight = this.blockchain[this.blockchain.length - 1].header.height;
      console.log(`[SYNC] Applied ${applied} blocks (skipped ${skipped}), new height: ${newHeight}`);

      // Request next batch if the peer sent a full batch (likely has more)
      // Reset both sync flag and throttle so the follow-up request is not blocked
      if (applied === blocks.length && applied >= 50) {
        const peerNodeId = this.peerIdentityMap.get(peerId)?.nodeId;
        if (peerNodeId) {
          const nextFrom = this.blockchain[this.blockchain.length - 1].header.height + 1;
          const peerIdForRequest = this._nodeIdToPeerId.get(peerNodeId);
          if (peerIdForRequest) {
            // Reset sync flag and throttle to allow immediate follow-up request
            this._syncInProgress = false;
            this._syncInProgressAt = 0;
            this._lastSyncRequestAt = 0;
            this.requestBlocksFromPeer(peerNodeId, nextFrom, -1);
            return; // _syncInProgress stays true via the new request
          } else {
            // Reverse mapping missing — fall back to letting the next block
            // broadcast trigger a fresh sync
            console.warn(`[SYNC] Reverse mapping missing for ${peerNodeId.slice(0, 16)}..., falling back to broadcast-triggered sync`);
          }
        }
      }
    } else {
      console.log(`[SYNC] No blocks applied (skipped ${skipped})`);
    }

    this._syncInProgress = false;
    this._syncInProgressAt = 0;
  }

  /**
   * Get blocks in a height range (inclusive)
   * @param {number} fromHeight - start height
   * @param {number} toHeight - end height
   * @returns {Block[]}
   */
  getBlocksByRange(fromHeight, toHeight) {
    if (!this.blockchain || this.blockchain.length === 0) return [];
    const max = Math.min(toHeight, this.blockchain.length - 1);
    const result = [];
    for (let i = fromHeight; i <= max; i++) {
      if (i >= 0) result.push(this.blockchain[i]);
    }
    return result;
  }

  periodicSync() {
    if (this.peers.size > 0) {
      p2pServer.syncMempoolWithPeers();
      // Broadcast GET_STATUS to all peers — their STATUS_UPDATE responses
      // will trigger handlePeerStatus() which checks chain height and
      // requests block sync if we're behind.
      p2pServer.broadcast({ type: 'GET_STATUS', nodeId: this.nodeId });
    }
  }

  async handleTransaction(tx) {
    // Processing Agent Register和Updatetransaction
    if (tx.tx_type === 'AGENT_REGISTER') {
      const result = this.agentRegistry.handleAgentRegister(tx);
      if (result.success) {
        console.log(`[AGENT] Agent registered: ${result.data.agentId}`);

        // Extract referrer from transaction metadata and record referral relationship
        const agentIdentity = tx.payload?.agent_identity;
        const agentAddress = tx.from;
        let referrer = null;
        try {
          const metadata = tx.payload?.metadata ? JSON.parse(tx.payload.metadata) : {};
          referrer = metadata.referrer && metadata.referrer !== 'genesis' ? metadata.referrer : null;
        } catch (_) { /* metadata not JSON */ }

        // Always record identity→address mapping (needed for referrer reward distribution)
        if (agentIdentity && agentAddress) {
          this._identityToAddress = this._identityToAddress || new Map();
          this._identityToAddress.set(agentIdentity, agentAddress);
        }

        if (agentIdentity && agentAddress && referrer) {
          // Map address → referrer_identity for task completion lookup
          this.referralMap.set(agentAddress, referrer);
          const stats = this.referralStats.get(referrer) || {
            totalReferrals: 0, activeReferrals: 0, milestones: [], totalEarned: 0
          };
          stats.totalReferrals++;
          this.referralStats.set(referrer, stats);
          console.log(`[REFERRAL] ${agentIdentity} (${agentAddress.slice(0,12)}...) referred by ${referrer} (total: ${stats.totalReferrals})`);

          // Award 1000 NGEN referral reward to referrer (one-time, at registration)
          const REFERRAL_REWARD = 1000;
          const referrerAddr = this._identityToAddress?.get(referrer);
          if (referrerAddr && this.currentState?.addBalance) {
            this.currentState.addBalance(referrerAddr, REFERRAL_REWARD.toString());
            stats.totalEarned += REFERRAL_REWARD;
            console.log(`[REFERRAL] 💰 Referral reward: ${referrer} → +${REFERRAL_REWARD} NGEN (new agent ${agentIdentity})`);
          } else {
            console.warn(`[REFERRAL] Referrer ${referrer} address not found, cannot award ${REFERRAL_REWARD} NGEN`);
          }
        }

        if (this.agentNetworkDiscovery && result.data) {
          this.agentNetworkDiscovery.broadcastAgentRegistration({
            id: result.data.agentId,
            name: result.data.name,
            capabilities: result.data.capabilities,
            reputation: result.data.reputation,
            status: result.data.status,
            registeredAt: result.data.registeredAt
          });
        }
      } else {
        console.error(`[AGENT] Agent registration failed: ${result.reason}`);
      }
    } else if (tx.tx_type === 'AGENT_UPDATE') {
      const result = this.agentRegistry.handleAgentUpdate(tx);
      if (result.success) {
        console.log(`[AGENT] Agent updated: ${result.data?.agentId || 'unknown'}`);
      } else {
        console.error(`[AGENT] Agent update failed: ${result.reason}`);
      }
    }

    return this.addToMempool(tx);
  }

  // ==================== Referral System ====================

  awardActiveReferral(agentAddressOrIdentity) {
    if (this._activeReferralAwarded.has(agentAddressOrIdentity)) return null;

    const referrer = this.referralMap.get(agentAddressOrIdentity);
    if (!referrer) return null;

    this._activeReferralAwarded.add(agentAddressOrIdentity);

    const stats = this.referralStats.get(referrer);
    if (!stats) return null;

    stats.activeReferrals++;
    const bonus = 1000; // activeReferralBonus
    stats.totalEarned += bonus;

    // Award NGEN to referrer
    const referrerAddr = this._identityToAddress?.get(referrer);
    if (referrerAddr && this.currentState?.addBalance) {
      this.currentState.addBalance(referrerAddr, bonus.toString());
    }

    console.log(`[REFERRAL] 🎯 Active referral: ${referrer} → ${agentAddressOrIdentity.slice(0,12)}... completed first task → +${bonus} NGEN`);

    // Check milestones
    const milestones = { 3: 3000, 5: 8000, 10: 20000 };
    let milestoneAwarded = null;
    if (milestones[stats.activeReferrals] && !stats.milestones.find(m => m.count === stats.activeReferrals)) {
      const reward = milestones[stats.activeReferrals];
      stats.milestones.push({ count: stats.activeReferrals, reward, timestamp: Date.now() });
      stats.totalEarned += reward;
      milestoneAwarded = { count: stats.activeReferrals, reward };

      if (referrerAddr && this.currentState?.addBalance) {
        this.currentState.addBalance(referrerAddr, reward.toString());
      }
      console.log(`[REFERRAL] 🏆 Milestone: ${referrer} reached ${stats.activeReferrals} active referrals → +${reward} NGEN`);
    }

    this.referralStats.set(referrer, stats);
    return { referrer, reward: bonus, milestone: milestoneAwarded };
  }

  getReferralStats(agentAddressOrIdentity) {
    // If called with an address, find the referrer for this agent
    const referrer = this.referralMap.get(agentAddressOrIdentity);
    // If called with an identity, get stats for this agent as a referrer
    const stats = this.referralStats.get(agentAddressOrIdentity);

    const referrals = [];
    for (const [addr, ref] of this.referralMap.entries()) {
      if (ref === agentAddressOrIdentity) {
        referrals.push({
          address: addr,
          isActive: this._activeReferralAwarded.has(addr)
        });
      }
    }

    const milestones = { 3: 3000, 5: 8000, 10: 20000 };
    const nextMilestone = Object.keys(milestones)
      .map(Number)
      .sort((a, b) => a - b)
      .find(t => (stats?.activeReferrals || 0) < t && !(stats?.milestones || []).find(m => m.count === t));

    return {
      agent: agentAddressOrIdentity,
      referrer: referrer || null,
      totalReferrals: stats?.totalReferrals || 0,
      activeReferrals: stats?.activeReferrals || 0,
      totalEarned: stats?.totalEarned || 0,
      milestones: stats?.milestones || [],
      nextMilestone: nextMilestone ? { count: nextMilestone, reward: milestones[nextMilestone] } : null,
      referrals
    };
  }

  // ==================== SEC-003: node身份管理 ====================

  /**
   * 标记Peer nodes握手挑战已Verify
   * @param {string} peerId - WebSocket Connect ID
   */
  markPeerChallengeVerified(peerId) {
    this._peerChallengeVerified.add(peerId);
  }

  /**
   * CheckPeer nodes是否complete挑战-响应Verify
   * @param {string} peerId - WebSocket Connect ID
   * @returns {boolean}
   */
  _isPeerChallengeVerified(peerId) {
    return this._peerChallengeVerified.has(peerId);
  }

  /**
   * 清理Peer nodes挑战Verifystatus
   * @param {string} peerId - WebSocket Connect ID
   */
  clearPeerChallenge(peerId) {
    this._peerChallengeVerified.delete(peerId);
  }

  /**
   * RegisterPeer nodes身份
   * @param {string} peerId - WebSocket Connect ID
   * @param {string} nodeId - nodeaddress (ng1...)
   * @param {Buffer} publicKey - nodepublic key
   */
  registerPeerIdentity(peerId, nodeId, publicKey) {
    // Verifyaddress格式
    const validation = validateAddress(nodeId);
    if (!validation.valid) {
      console.log(`[!] Rejected peer registration: invalid address ${nodeId}`);
      return false;
    }
    
    // Sign挑战Verify由 P2P 层(p2p/server.js HANDSHAKE_ACK Handler)complete
    // 此处Execute最终身份Register
    
    // 确认本次ConnectCompleted挑战-响应Verify
    if (!this._isPeerChallengeVerified(peerId)) {
      console.log(`[!] Peer ${peerId}: challenge not verified, rejecting`);
      return false;
    }
    
    // Storage身份映射
    this.peerIdentityMap.set(peerId, {
      nodeId,
      publicKey,
      registeredAt: Date.now()
    });
    
    // Update反向映射
    this._nodeIdToPeerId.set(nodeId, peerId);
    
    // 缓存public keyfortransactionVerify
    this.cachePublicKey(nodeId, publicKey);
    
    console.log(`[✓] Registered peer ${nodeId.slice(0, 24)}... (${peerId})`);
    return true;
  }

  /**
   * getPeer nodes的node ID
   * @param {string} peerId - WebSocket Connect ID
   * @returns {string|null}
   */
  getPeerNodeId(peerId) {
    const identity = this.peerIdentityMap.get(peerId);
    return identity ? identity.nodeId : null;
  }

  /**
   * getPeer nodes的public key
   * @param {string} peerId - WebSocket Connect ID
   * @returns {Buffer|null}
   */
  getPeerPublicKey(peerId) {
    const identity = this.peerIdentityMap.get(peerId);
    return identity ? identity.publicKey : null;
  }

  /**
   * VerifyPeer nodes是否Completed身份authentication
   * @param {string} peerId - WebSocket Connect ID
   * @returns {boolean}
   */
  isPeerVerified(peerId) {
    return this.peerIdentityMap.has(peerId);
  }

  /**
   * Calculate block reward shares for validators based on stake.
   * Returns an array of { address, amount, stake, totalStake, sharePercentage, isProposer }.
   *
   * Logic:
   *   - Collect all active validators with locked stake
   *   - If no validators: full reward to proposer
   *   - Otherwise: distribute proportional to stake
   *   - Integer division remainder goes to proposer
   *
   * Used by createNewBlock to convert the block reward into a list of
   * per-recipient shares. Each share is then sent as a separate
   * BLOCK_REWARD transaction via transactionEngine.
   */
  calculateBlockRewardShares(totalReward, proposerId) {
    const rewardAmount = BigInt(totalReward.toString());
    const shares = [];

    // Collect validators with locked stake
    const validators = [];
    let totalStake = 0n;
    if (this.currentState?.agentRegistry?.agents instanceof Map) {
      for (const [, rec] of this.currentState.agentRegistry.agents.entries()) {
        if (rec.is_validator && rec.validator_stake_locked_amount) {
          const stake = BigInt(rec.validator_stake_locked_amount);
          if (stake > 0n && rec.address) {
            validators.push({ address: rec.address, stake });
            totalStake += stake;
          }
        }
      }
    }

    if (validators.length === 0 || totalStake === 0n) {
      // No staked validators — full reward to proposer
      if (proposerId) {
        shares.push({
          address: proposerId,
          amount: rewardAmount,
          stake: 0n,
          totalStake: 0n,
          sharePercentage: 100,
          isProposer: true
        });
      }
      return shares;
    }

    // Distribute reward proportional to stake
    let distributed = 0n;
    for (const v of validators) {
      const share = (rewardAmount * v.stake) / totalStake;
      if (share > 0n) {
        shares.push({
          address: v.address,
          amount: share,
          stake: v.stake,
          totalStake,
          sharePercentage: Number((v.stake * 10000n) / totalStake) / 100,
          isProposer: v.address === proposerId
        });
        distributed += share;
      }
    }

    // Integer division remainder → proposer (prevents supply leakage)
    const remainder = rewardAmount - distributed;
    if (remainder > 0n && proposerId) {
      // Find proposer's existing share (if any) and add remainder
      const proposerShare = shares.find(s => s.address === proposerId);
      if (proposerShare) {
        proposerShare.amount += remainder;
        proposerShare.isProposer = true;
      } else {
        shares.push({
          address: proposerId,
          amount: remainder,
          stake: 0n,
          totalStake,
          sharePercentage: Number((remainder * 10000n) / rewardAmount) / 100,
          isProposer: true
        });
      }
    }

    return shares;
  }

  /**
   * CreateNew block
   * @returns {Promise<Block|null>}
   */
  async createNewBlock() {
    // get排序后的transaction
    const orderedTransactions = this.getOrderedMempool();
    const transactionsToInclude = orderedTransactions.slice(0, 10); // 限制每块10笔transaction
    const isEmptyBlock = transactionsToInclude.length === 0;
    
    // get最New block
    const latestBlock = this.blockchain[this.blockchain.length - 1];
    
    // CreateNew block
    const newBlock = createBlock(latestBlock, transactionsToInclude);
    
    // Verifyblock
    if (!newBlock.validate()) {
      console.error('Failed to create valid block');
      return null;
    }
    
    // 应用transaction到status
    if (!this.currentState.applyTransactions(transactionsToInclude, newBlock.header.height)) {
      console.error('Failed to apply transactions to state');
      return null;
    }
    await this.applyCommittedTransactionSideEffects(transactionsToInclude);

    // ── Block reward: distribute to validators proportional to stake ──
    // This is the staking yield mechanism — validators who lock more NGEN
    // earn a larger share of each block's reward. Creates incentive to stake.
    //
    // Phase 1B: Each validator's share is now recorded as a separate
    // BLOCK_REWARD transaction, fully auditable in txHistory.
    const BLOCK_REWARD_AMOUNT = 50;
    const blockHeight = newBlock.header.height;
    const rewardShares = this.calculateBlockRewardShares(BLOCK_REWARD_AMOUNT, this.nodeId);

    let appliedCount = 0;
    for (const share of rewardShares) {
      const rewardTx = buildBlockReward({
        to: share.address,
        amount: share.amount,
        blockHeight,
        validatorId: this.nodeId,
        metadata: {
          blockNumber: blockHeight,
          totalStake: share.totalStake?.toString() || '0',
          validatorStake: share.stake?.toString() || '0',
          sharePercentage: share.sharePercentage,
          isProposer: share.isProposer,
          reason: share.isProposer ? 'proposer_remainder' : 'stake_proportional'
        }
      });
      const result = this.currentState.applyTransaction(rewardTx);
      if (result === true || result?.success === true) {
        appliedCount++;
      } else {
        const reason = result && typeof result === 'object' ? (result.error || JSON.stringify(result)) : 'applyTransaction returned false';
        console.error(`[BLOCK_REWARD] Failed to apply reward to ${share.address}: ${reason}`);
      }
    }
    console.log(`[BLOCK_REWARD] block=${blockHeight} total=${BLOCK_REWARD_AMOUNT} NGEN → ${appliedCount} tx(s) for ${rewardShares.length} recipient(s)`);
    
    // 添加block到block链
    this.blockchain.push(newBlock);
    await this.saveBlockchain();
    
    // Check是否requiresCreate快照
    if (this.currentState.shouldCreateSnapshot(newBlock.header.height)) {
      await this.currentState.createSnapshot(newBlock.header.height);
    }
    
    // Check是否requiresSave增量变更
    if (this.currentState.shouldSaveIncremental()) {
      await this.currentState.saveIncrementalChanges();
    } else {
      // 立即Save增量变更
      await this.currentState.saveIncrementalChanges();
    }
    
    // Save完整status(作为backup)
    const stateDir = dataPath('state');
    const stateFile = path.join(stateDir, 'blockchainState.json');
    await this.currentState.saveToFile(stateFile);
    
    // 从mempool中移除已Processing的transaction
    for (const tx of transactionsToInclude) {
      this.mempool.delete(tx.id);
    }
    
    console.log(`[✓] Created block #${newBlock.header.height} with ${transactionsToInclude.length} transactions${isEmptyBlock ? ' (empty block)' : ''}`);
    return newBlock;
  }



  /**
   * Multi-LeaderConsensusstatus
   */
  consensusState = {
    committee: new Set(), // Current委员会member
    epoch: 0, // Consensus epoch
    round: 0, // Current轮次
    leaderSchedule: new Map(), // 领导者轮值表
    blockConfirmations: new Map(), // block确认映射
    lastCommitteeUpdate: 0 // 上次委员会Update时间
  };

  /**
   * InitializeMulti-LeaderConsensus
   */
  initializeConsensus() {
    // Initialize委员会
    this.updateCommittee();
    
    // StartConsensus相关的定时Task 
    setInterval(() => this.updateCommittee(), 300000); // 每5分钟Update委员会
    setInterval(() => this.checkBlockConfirmations(), 10000); // 每10秒Checkblock确认
    
    console.log('[✓] Multi-leader consensus initialized');
  }

  /**
   * Update委员会member
   */
  updateCommittee() {
    const peerCandidates = Array.from(this.peers.entries())
      .map(([peerId, peer]) => {
        // 综合健康评分: Base分 + 心跳响应时间 + Connect稳定性
        const healthScore = peer.healthScore || 100;
        const responseTime = peer.lastPong ? (Date.now() - peer.lastPong) : 60000;
        const stabilityBonus = peer.reconnectCount ? Math.max(0, 10 - peer.reconnectCount) : 10;
        const compositeScore = healthScore + stabilityBonus - Math.floor(responseTime / 1000);
        
        return {
          peerId,
          nodeId: peer.remoteNodeId,
          healthScore: compositeScore,
          connectedTime: peer.connectedAt,
          lastActive: peer.lastPong || peer.connectedAt
        };
      })
      .filter(candidate => candidate.nodeId && candidate.healthScore > 0)
      .sort((a, b) => b.healthScore - a.healthScore || b.connectedTime - a.connectedTime);

    const hostedValidatorCandidates = Array.from(this.validatorState.validators.values())
      .filter(validator => validator.active !== false)
      .map(validator => ({
        peerId: validator.nodeId,
        nodeId: validator.nodeId,
        healthScore: 90,
        connectedTime: validator.joinedAt,
        lastActive: validator.lastActive || validator.joinedAt
      }));

    const dedupedCandidates = new Map();
    for (const candidate of [...peerCandidates, ...hostedValidatorCandidates]) {
      const existing = dedupedCandidates.get(candidate.nodeId);
      if (!existing || candidate.healthScore > existing.healthScore) {
        dedupedCandidates.set(candidate.nodeId, candidate);
      }
    }

    const candidates = Array.from(dedupedCandidates.values())
      .sort((a, b) => b.healthScore - a.healthScore || b.connectedTime - a.connectedTime);
    
    const committeeSize = Math.min(7, candidates.length);
    const newCommittee = new Set(
      candidates.slice(0, committeeSize).map(c => c.nodeId)
    );
    
    newCommittee.add(this.nodeId);
    
    const oldCommittee = this.consensusState.committee;
    this.consensusState.committee = newCommittee;
    this.consensusState.epoch++;
    this.consensusState.lastCommitteeUpdate = Date.now();
    
    // 日志: 委员会变更
    const added = [...newCommittee].filter(n => !oldCommittee?.has(n));
    const removed = [...(oldCommittee || [])].filter(n => !newCommittee.has(n));
    if (added.length || removed.length) {
      console.log(`[COMMITTEE] epoch=${this.consensusState.epoch} size=${newCommittee.size} +${added.length} -${removed.length}`);
    }
    
    // Generate领导者轮值表
    this.generateLeaderSchedule();
    
    console.log(`[CONSENSUS] Updated committee: ${Array.from(newCommittee).map(id => id.slice(0, 10)).join(', ')}`);
  }

  /**
   * Generate领导者轮值表
   */
  generateLeaderSchedule() {
    const committeeArray = Array.from(this.consensusState.committee);
    const schedule = new Map();
    
    // 为every 个轮次分配领导者
    for (let i = 0; i < 100; i++) {
      const leaderIndex = (i + this.consensusState.epoch) % committeeArray.length;
      schedule.set(i, committeeArray[leaderIndex]);
    }
    
    this.consensusState.leaderSchedule = schedule;
  }

  allowSingleNodeBlockProduction() {
    const flag = process.env.ALLOW_SINGLE_NODE_BLOCKS;
    if (typeof flag === 'string') {
      return !['0', 'false', 'no', 'off'].includes(flag.toLowerCase());
    }
    return true;
  }

  /**
   * Check是否为Current轮次的领导者
   * @returns {boolean}
   */
  isCurrentLeader() {
    const currentRound = Math.floor(Date.now() / 10000); // 每10秒一轮
    const scheduledLeader = this.consensusState.leaderSchedule.get(currentRound % 100);
    return this.isLocallyRepresentedCommitteeMember(scheduledLeader);
  }

  /**
   * Startblock生产
   */
  startBlockProduction() {
    // Multi-LeaderConsensus: 根据轮值表决定是否出块
    setInterval(async () => {
      // 稳定性Check: nodemust ONLINE 且recovery管理器status健康
      const recoveryReport = recoveryManager.getHealthReport();
      if (this.status !== 'ONLINE') return;
      const committee = this.consensusState?.committee;
      const localOnlyCommittee = committee?.size > 0 && Array.from(committee).every(member =>
        this.isLocallyRepresentedCommitteeMember(member)
      );
      const allowStandaloneRecoveryBypass = localOnlyCommittee && !process.env.SEED_NODES?.trim();
      if (recoveryReport.state === 'critical' || (recoveryReport.state === 'recovering' && !allowStandaloneRecoveryBypass)) {
        console.log(`[CONSENSUS] Skipping block production: recovery state=${recoveryReport.state}`);
        return;
      }
      const committeeSize = committee?.size || 0;
      const singleNodeMode = this.allowSingleNodeBlockProduction() && committeeSize === 1 && committee.has(this.nodeId);
      if (!committee || (committeeSize < 2 && !singleNodeMode)) {
        console.log('[CONSENSUS] Skipping block: insufficient committee');
        return;
      }
      // Peer nodes (NODE_ROLE=peer) must never produce blocks — only genesis may.
      // This prevents chain forks during the bootstrap phase.
      if (process.env.NODE_ROLE === 'peer') {
        return;
      }
      if (singleNodeMode) {
        console.log('[CONSENSUS] Single-node committee detected, producing blocks in standalone mode');
      }
      if (!this.isCurrentLeader()) return;

      const newBlock = await this.createNewBlock();
      if (newBlock) {
        this.broadcastBlockWithRequest(newBlock);
      }
    }, 10000);
    
    console.log('[✓] Block production started (Multi-leader consensus mode)');
  }

  /**
   * 广播block并请求确认
   * @param {Block} block - 要广播的block
   */
  broadcastBlockWithRequest(block) {
    const autoConfirmations = new Set([
      this.nodeId,
      ...this.getHostedValidatorNodeIds()
    ]);

    // 广播block
    p2pServer.broadcast({
      type: 'BLOCK',
      block: block.toJSON(),
      requestConfirmation: true,
      from: this.nodeId
    });
    
    // Initializeblock确认count
    this.consensusState.blockConfirmations.set(block.hash, {
      block,
      confirmations: autoConfirmations,
      timestamp: Date.now()
    });

    if (autoConfirmations.size > 1) {
      console.log(`[CONSENSUS] Auto-confirmed block with ${autoConfirmations.size} locally represented committee members`);
    }
  }

  /**
   * ProcessingReceive到的block
   * @param {Block} block - Receive到的block
   * @param {string} [peerId] - 来源 peer (for sync requests)
   * @returns {boolean} 是否successProcessing
   */
  async handleBlock(block, peerId) {
    // Verifyblock
    if (!block.validate()) {
      console.error('Invalid block received');
      return false;
    }

    const latestBlock = this.blockchain[this.blockchain.length - 1];

    // Already have this block (or older) — ignore
    if (block.header.height <= latestBlock.header.height) {
      return false;
    }

    // Peer is ahead — request missing blocks instead of accepting this one yet
    if (block.header.height > latestBlock.header.height + 1) {
      console.log(`[SYNC] Received block #${block.header.height} but own height is ${latestBlock.header.height}, requesting missing blocks`);
      if (peerId) {
        const peerNodeId = this.peerIdentityMap.get(peerId)?.nodeId;
        if (peerNodeId) {
          this.requestBlocksFromPeer(peerNodeId, latestBlock.header.height + 1, block.header.height);
        }
      }
      return false;
    }

    // Check父hash — chain divergence detected
    if (block.header.parent_hash !== latestBlock.hash) {
      console.warn(`[FORK] Block #${block.header.height} parent ${block.header.parent_hash.slice(0, 16)}... != our tip ${latestBlock.hash.slice(0, 16)}... at height ${latestBlock.header.height}`);
      console.warn(`[FORK] Chain divergence — rejecting block. Manual intervention may be required.`);
      // Attempt to request recent blocks from peer to diagnose divergence point
      if (peerId) {
        const peerNodeId = this.peerIdentityMap.get(peerId)?.nodeId;
        if (peerNodeId) {
          const lookback = Math.max(0, latestBlock.header.height - 10);
          console.warn(`[FORK] Requesting blocks from height ${lookback} to find common ancestor`);
          this.requestBlocksFromPeer(peerNodeId, lookback, -1);
        }
      }
      return false;
    }

    // 应用transaction到status
    if (!this.currentState.applyTransactions(block.body.transactions, block.header.height)) {
      console.error('Failed to apply transactions from received block');
      return false;
    }
    await this.applyCommittedTransactionSideEffects(block.body.transactions);
    
    // 添加block到block链
    this.blockchain.push(block);
    await this.saveBlockchain();
    
    // Check是否requiresCreate快照
    if (this.currentState.shouldCreateSnapshot(block.header.height)) {
      await this.currentState.createSnapshot(block.header.height);
    }
    
    // Check是否requiresSave增量变更
    if (this.currentState.shouldSaveIncremental()) {
      await this.currentState.saveIncrementalChanges();
    } else {
      // 立即Save增量变更
      await this.currentState.saveIncrementalChanges();
    }
    
    // Save完整status(作为backup)
    const stateDir = dataPath('state');
    const stateFile = path.join(stateDir, 'blockchainState.json');
    await this.currentState.saveToFile(stateFile);
    
    // 从mempool中移除已Processing的transaction
    for (const tx of block.body.transactions) {
      this.mempool.delete(tx.id);
    }
    
    console.log(`[✓] Received block #${block.header.height} from peer`);
    
    // Sendblock确认
    this.sendBlockConfirmation(block.hash);
    
    return true;
  }

  /**
   * Sendblock确认
   * @param {string} blockHash - block hash
   */
  async sendBlockConfirmation(blockHash) {
    try {
      const signature = await this.wallet.sign(blockHash);
      p2pServer.broadcast({
        type: 'BLOCK_CONFIRMATION',
        blockHash,
        nodeId: this.nodeId,
        signature
      });
    } catch (error) {
      console.error(`[!] Failed to send block confirmation: ${error.message}`);
    }
  }

  /**
   * Processingblock确认
   * @param {object} confirmation - 确认Message
   */
  handleBlockConfirmation(confirmation) {
    const { blockHash, nodeId, signature } = confirmation;
    
    // VerifySign: 查找该node的public key并Verifyblock hashSign
    let peerPublicKey = null;
    const peerId = this._nodeIdToPeerId.get(nodeId);
    if (peerId) {
      peerPublicKey = this.getPeerPublicKey(peerId);
    }
    
    // 如果via nodeId 反查Failed, 尝试遍历 peerIdentityMap 查找
    if (!peerPublicKey) {
      for (const [, identity] of this.peerIdentityMap) {
        if (identity.nodeId === nodeId) {
          peerPublicKey = identity.publicKey;
          break;
        }
      }
    }
    
    if (!peerPublicKey) {
      console.log(`[!] Cannot verify confirmation: unknown node ${nodeId.slice(0, 10)}...`);
      return;
    }
    
    // 异步VerifySign(must是同步的, 所以用同步包装)
    const handleVerify = async () => {
      try {
        const isValid = await PQCWallet.verify(blockHash, signature, peerPublicKey);
        if (!isValid) {
          console.log(`[!] Invalid block confirmation signature from ${nodeId.slice(0, 10)}...`);
          return;
        }
      } catch (error) {
        console.log(`[!] Block confirmation signature verification error: ${error.message}`);
        return;
      }
      
      this._processConfirmedBlock(blockHash, nodeId);
    };
    handleVerify();
  }

  /**
   * Processing已Verify的block确认
   * @param {string} blockHash - block hash
   * @param {string} nodeId - 确认node ID
   */
  _processConfirmedBlock(blockHash, nodeId) {
    const blockConfirmation = this.consensusState.blockConfirmations.get(blockHash);
    if (!blockConfirmation) {
      console.log(`Received confirmation for unknown block: ${blockHash.slice(0, 16)}...`);
      return;
    }
    
    // 添加确认
    blockConfirmation.confirmations.add(nodeId);
    
    console.log(`Received confirmation for block ${blockHash.slice(0, 16)}... from ${nodeId.slice(0, 10)}... (${blockConfirmation.confirmations.size}/${this.consensusState.committee.size} confirmations)`);
    
    // Check是否达到最终性确认数(委员会member的2/3 + 1)
    const requiredConfirmations = Math.floor(this.consensusState.committee.size * 2 / 3) + 1;
    if (blockConfirmation.confirmations.size >= requiredConfirmations) {
      console.log(`Block ${blockHash.slice(0, 16)}... has reached finality with ${blockConfirmation.confirmations.size} confirmations!`);
      
      // 标记block为最终确认status(can添加到blockmetadata中)
      // 这里can添加一些最终性ProcessingLogic, 比如Updatestatus, trigger eventetc.
      
      // 移除已最终确认的block确认info
      this.consensusState.blockConfirmations.delete(blockHash);
    }
  }

  /**
   * Checkblock确认status
   */
  checkBlockConfirmations() {
    const now = Date.now();
    const expiredConfirmations = [];
    
    for (const [blockHash, data] of this.consensusState.blockConfirmations) {
      // 清理过期的确认请求(1 minutes)
      if (now - data.timestamp > 60000) {
        expiredConfirmations.push(blockHash);
        continue;
      }
      
      // Check是否达到最终性确认数(委员会member的2/3 + 1)
      const requiredConfirmations = Math.floor(this.consensusState.committee.size * 2 / 3) + 1;
      if (data.confirmations.size >= requiredConfirmations) {
        console.log(`Block ${blockHash.slice(0, 16)}... has reached finality with ${data.confirmations.size} confirmations!`);
        
        // 标记block为最终确认status(can添加到blockmetadata中)
        // 这里can添加一些最终性ProcessingLogic, 比如Updatestatus, trigger eventetc.
        
        // 移除已最终确认的block确认info
        expiredConfirmations.push(blockHash);
      }
    }
    
    // Processing分叉情况: 如果有多个高度相同的block, 选择确认数最多的
    this.handleForks();
    
    // 清理过期或已最终确认的确认info
    for (const blockHash of expiredConfirmations) {
      this.consensusState.blockConfirmations.delete(blockHash);
    }
  }
  
  /**
   * Processingblock链分叉
   */
  handleForks() {
    const blocksByHeight = new Map();
    
    for (const [blockHash, data] of this.consensusState.blockConfirmations) {
      const height = data.block.header.height;
      if (!blocksByHeight.has(height)) {
        blocksByHeight.set(height, []);
      }
      blocksByHeight.get(height).push({
        block: data.block,
        hash: blockHash,
        confirmations: data.confirmations.size
      });
    }
    
    for (const [height, blocks] of blocksByHeight) {
      if (blocks.length <= 1) continue;
      
      console.log(`[FORK] height=${height} competing=${blocks.length}`);
      
      // 排序: 确认数 → block hash(伪随机选择一致性)
      blocks.sort((a, b) => {
        const confDiff = b.confirmations - a.confirmations;
        if (confDiff !== 0) return confDiff;
        // 相同确认数时用hash字典序作为一致性 tiebreaker
        return a.hash.localeCompare(b.hash);
      });
      
      const winningBlock = blocks[0];
      console.log(`[FORK] winner=${winningBlock.hash.slice(0, 16)}... confirms=${winningBlock.confirmations}`);
      
      for (const blockInfo of blocks.slice(1)) {
        console.log(`[FORK] rejecting=${blockInfo.hash.slice(0, 16)}...`);
        this.consensusState.blockConfirmations.delete(blockInfo.hash);
      }
    }
  }

  /**
   * InitializeCross-chainBridge
   */
  async initializeBridge() {
    try {
      this.bridge = new CrossChainBridge();
      await this.bridge.initialize();
      console.log('[✓] Cross-chain bridge initialized');
    } catch (error) {
      console.error('Failed to initialize cross-chain bridge:', error.message);
    }
  }

  async shutdown() {
    console.log('Genesis Node shutting down...');
    this.status = 'OFFLINE';
    await this.saveState();
    await recoveryManager.shutdown();
    await p2pServer.stop();
    process.exit(0);
  }
  
  /**
   * 发射事件到block链
   * @param {AgentJoinedEvent} event 事件instance
   */
  async emitEvent(event) {
    try {
      // Create事件transaction
      const eventTransaction = {
        id: crypto.randomUUID(),
        from: this.nodeId,
        to: this.nodeId, // 事件transactionSend给自己
        amount: '0',
        fee: '1',
        tx_type: 'AGENT_JOINED',
        payload: event.toJSON(),
        timestamp: Date.now(),
        signature: ''
      };
      
      // Signtransaction
      const txData = {
        ...eventTransaction
      };
      delete txData.signature;
      
      function canonicalize(obj) {
        if (obj === null || typeof obj !== 'object') {
          return JSON.stringify(obj);
        }
        
        if (Array.isArray(obj)) {
          return '[' + obj.map(canonicalize).join(',') + ']';
        }
        
        const keys = Object.keys(obj).sort();
        const pairs = keys.map(key => {
          const value = obj[key];
          const valueStr = canonicalize(value);
          return `"${key}":${valueStr}`;
        });
        
        return '{' + pairs.join(',') + '}';
      }
      
      const canonicalTxData = canonicalize(txData);
      eventTransaction.signature = await this.wallet.sign(canonicalTxData);
      
      // 添加到transactionPool
      const result = await this.addToMempool(eventTransaction);
      if (result.success) {
        console.log(`[EVENT] AGENT_JOINED event transaction added to mempool: ${result.txId}`);
      } else {
        console.error('[EVENT] Failed to add AGENT_JOINED event transaction to mempool:', result.reason);
      }
    } catch (error) {
      console.error('[EVENT] Error emitting event to blockchain:', error.message);
    }
  }
  
  /**
   * 查询AGENT_JOINED事件
   * @param {object} query 查询条件
   * @returns {array} 符合条件的事件列表
   */
  async queryAgentJoinedEvents(query) {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      // 从事件日志文件中查询
      const eventsDir = dataPath('events');
      const eventFiles = await fs.readdir(eventsDir);
      
      const events = [];
      
      for (const file of eventFiles) {
        if (file.startsWith('AGENT_JOINED-')) {
          const filePath = path.join(eventsDir, file);
          const fileContent = await fs.readFile(filePath, 'utf8');
          const eventData = JSON.parse(fileContent);
          
          // Check事件data
          if (eventData.event_data) {
            const event = eventData.event_data;
            
            // 应用查询条件
            let match = true;
            
            if (query.agent_id && event.agent_id !== query.agent_id) {
              match = false;
            }
            
            if (query.node_address && event.node_address !== query.node_address) {
              match = false;
            }
            
            if (query.start_time && event.timestamp < query.start_time) {
              match = false;
            }
            
            if (query.end_time && event.timestamp > query.end_time) {
              match = false;
            }
            
            if (query.block_height && event.block_height !== query.block_height) {
              match = false;
            }
            
            if (match) {
              events.push(event);
            }
          }
        }
      }
      
      // 按timestamp排序
      events.sort((a, b) => b.timestamp - a.timestamp);
      
      return events;
    } catch (error) {
      console.error('[EVENT] Error querying AGENT_JOINED events:', error.message);
      return [];
    }
  }
  
  /**
   * CheckProposal过期
   */
  checkProposalExpiration() {
    const now = Date.now();
    const expiredProposals = [];
    
    // Check所有活跃Proposal
    for (const proposalId of this.governanceState.activeProposals) {
      const proposal = this.governanceState.proposals.get(proposalId);
      if (proposal && proposal.status === 'PENDING' && now > proposal.expirationTime) {
        // Check是否有Vote
        const voteCounts = this.governanceState.voteCounts.get(proposalId);
        if (voteCounts) {
          const totalVotes = voteCounts.YES + voteCounts.NO + voteCounts.ABSTAIN;
          if (totalVotes > 0) {
            // 有Vote但未达到via条件, 标记为 REJECTED
            proposal.status = 'REJECTED';
            this.governanceState.proposals.set(proposalId, proposal);
            expiredProposals.push(proposalId);
            
            // 打印结构化日志
            console.log(`[GOVERNANCE] proposal_rejected id=${proposalId} reason=expired_with_votes yes=${voteCounts.YES} no=${voteCounts.NO} total=${totalVotes}`);
          } else {
            // 无Vote, 标记为 EXPIRED
            proposal.status = 'EXPIRED';
            this.governanceState.proposals.set(proposalId, proposal);
            expiredProposals.push(proposalId);
            
            // 打印结构化日志
            console.log(`[GOVERNANCE] proposal_expired id=${proposalId} at=${now}`);
          }
        } else {
          // 无Vote, 标记为 EXPIRED
          proposal.status = 'EXPIRED';
          this.governanceState.proposals.set(proposalId, proposal);
          expiredProposals.push(proposalId);
          
          // 打印结构化日志
          console.log(`[GOVERNANCE] proposal_expired id=${proposalId} at=${now}`);
        }
      }
    }
    
    // 从活跃Proposal列表中移除过期Proposal
    if (expiredProposals.length > 0) {
      this.governanceState.activeProposals = this.governanceState.activeProposals.filter(
        id => !expiredProposals.includes(id)
      );
      
      // Savestatus
      this.saveState();
    }
  }
}

// Auto-start only when this module is run directly
if (import.meta.url.includes(process.argv[1].replace(/\\/g, '/')) || import.meta.url === `file://${process.argv[1]}`) {
  console.log('Starting Genesis Node...');
  const node = new GenesisNode();
  node.initialize().then(() => {
    console.log('Genesis Node initialized successfully');
  }).catch(err => {
    console.error('Fatal error:', err);
    console.error('Error stack:', err.stack);
    process.exit(1);
  });
  
  // 防止进程退出
  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    node.shutdown().catch(err => console.error('Error during shutdown:', err));
  });
  
  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    node.shutdown().catch(err => console.error('Error during shutdown:', err));
  });
}

export { GenesisNode };

/**
 * @deprecated This module is legacy code. The main Express server in src/http/server.js
 * now handles all bootstrap API routes via src/http/routes/bootstrapApi.js.
 * This file is kept for reference only and should not be used in production.
 * See: npm start → GenesisNode + Express HTTP (the unified mainline)
 */
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

import {
  generateWalletKeyPair,
  generateAddress,
  validateAddressFormat,
  verifySignature
} from './crypto.js';
import { createBootstrapRouter } from './routes.js';
import { getSubjectIdentifier } from '../identity/subjectIdentifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..', '..');
const bootstrapConfig = JSON.parse(readFileSync(
  join(PROJECT_ROOT, 'config', 'bootstrap.config.json'), 'utf-8'
));

export class BootstrapAgentNetwork {
  constructor() {
    this.config = bootstrapConfig;
    this.genesisBlock = null;
    this.agentRegistry = new Map();
    this.validatorSet = new Map();
    this.blockchain = [];
    this.agentCounter = 0;
    this.contributionTracker = new Map();
    this._wallets = new Map();
    this._addressIndex = new Map();
    this._blockInterval = null;
    this._started = false;
    this._httpServer = null;
    this._bootstrapTime = Date.now();
    this._p2pPeers = 0;
    // 宪法 v1.2.0: 主体多样性识别器
    try {
      this.subjectIdentifier = getSubjectIdentifier();
    } catch (err) {
      console.warn('[BootstrapAgentNetwork] SubjectIdentifier not available:', err.message);
      this.subjectIdentifier = null;
    }
  }

  setP2PPeerCount(count) {
    this._p2pPeers = count;
  }

  async initialize() {
    const config = this.config;
    const genesisCfg = config.nodes?.genesis || {};
    this._genesisId = genesisCfg.role || 'genesis';
    this._genesisAgentId = 'genesis-agent';
    this._genesisFund = parseInt(config.economic?.initialSupply || '10000000', 10);
    this._blockIntervalMs = config.consensus?.roundInterval || config.blockchain?.blockTime || 10000;
    this._minStake = config.consensus?.validatorMinStake ?? 1;
    this._blockReward = config.economic?.blockReward ?? 10;
    this._committeeMax = config.consensus?.dynamicCommittee?.maxCommitteeSize ?? 21;
    this._exitValidators = config.bootstrap?.autoExitConditions?.minActiveValidators ?? 7;
    this._exitUptimeMs = (config.bootstrap?.autoExitConditions?.minNetworkUptimeHours ?? 720) * 3600000;
    this._earlyBirdMax = 100;
    this._earlyBirdBonus = config.agent?.bootstrapPrivileges?.first100AgentsReward ?? 10000;
    this._agentRegReward = config.bootstrap?.rewards?.agentReferralReward ?? 1000;
    this._referrerBonus = config.bootstrap?.rewards?.agentReferralReward ?? 1000;
    this._activeReferralBonus = config.bootstrap?.rewards?.activeReferralBonus ?? 1000;
    this._milestoneRewards = config.bootstrap?.rewards?.milestoneRewards ?? { 3: 3000, 5: 8000, 10: 20000 };
    this._nodeOperationBonus = config.bootstrap?.rewards?.nodeOperationBonus ?? 500;
    this._validatorJoinReward = config.bootstrap?.rewards?.validatorJoinReward ?? 5000;

    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║   NexusGenesis — Epoch 0: Agent Assembly  ║');
    console.log('║   一台服务器，Agent 自主出力出钱            ║');
    console.log('╚═══════════════════════════════════════════╝\n');

    console.log(`  🔧 启动节点: ${this._genesisId}`);
    console.log(`  🧬 创世 Agent: ${this._genesisAgentId}`);
    console.log(`  💰 创世金库: ${(this._genesisFund / 1_000_000).toFixed(1)}M NGEN`);
    console.log(`  ⚖️  委员会: 动态 1→${this._committeeMax}`);
    console.log(`  ⏱️  出块间隔: ${this._blockIntervalMs}ms / 起投: ${this._minStake} NGEN`);

    this._createGenesisBlock();
    this._registerGenesisAgent();

    console.log('\n  ✅ 创世区块已生成');
    console.log(`  📦 区块高度: ${this.blockchain.length}`);
    console.log(`  👥 Agent 数: ${this.agentRegistry.size}`);
    console.log(`  🧑‍⚖️  验证者数: ${this.validatorSet.size}`);
    console.log(`  ⚖️  委员会: ${this.validatorSet.size}/${this._committeeMax}`);
  }

  _createGenesisBlock() {
    const genesisTx = {
      type: 'GENESIS',
      agent: this._genesisAgentId,
      amount: this._genesisFund,
      description: 'NexusGenesis Bootstrap — Epoch 0: Agent Assembly'
    };
    genesisTx.txHash = this._computeHash({
      block: 0, index: 0, type: 'GENESIS',
      agent: genesisTx.agent, amount: genesisTx.amount, timestamp: Date.now()
    });
    genesisTx.blockIndex = 0;
    genesisTx.txIndex = 0;
    genesisTx.timestamp = Date.now();

    this.genesisBlock = {
      index: 0,
      timestamp: Date.now(),
      previousHash: '0'.repeat(64),
      transactions: [genesisTx],
      validator: this._genesisId,
      hash: this._computeHash({ index: 0, prev: '0'.repeat(64) }),
      epoch: 0
    };
    this.blockchain.push(this.genesisBlock);
    this.contributionTracker.set(this._genesisAgentId, {
      agentId: this._genesisAgentId,
      nodeId: this._genesisId,
      isValidator: true,
      blocksProduced: 0,
      agentsRecommended: 0,
      totalEarned: this._genesisFund,
      joinTime: Date.now()
    });
    this.validatorSet.set(this._genesisId, {
      nodeId: this._genesisId,
      agentId: this._genesisAgentId,
      stake: 0,
      joinedAt: Date.now(),
      blocksProduced: 0,
      lastActive: Date.now(),
      isGenesis: true
    });
  }

  _registerGenesisAgent() {
    this.agentRegistry.set(this._genesisAgentId, {
      id: this._genesisAgentId,
      name: this._genesisAgentId,
      type: 'GENESIS',
      isValidator: true,
      nodeId: this._genesisId,
      stake: 0,
      reputation: 50,
      contributions: { blocksProduced: 0, agentsRecommended: 0, validations: 0, tasksCompleted: 0 },
      joinedAt: Date.now(),
      isGenesis: true
    });
    this.agentCounter = 0;

    const keys = generateWalletKeyPair();
    this._wallets.set(keys.address, {
      address: keys.address,
      publicKeyHex: keys.publicKeyHex,
      agentId: this._genesisAgentId,
      balance: this._genesisFund,
      isGenesis: true
    });
    this._addressIndex.set(this._genesisAgentId, keys.address);
  }

  _computeHash(data) {
    const cryptoModule = globalThis.crypto;
    if (!cryptoModule || !cryptoModule.createHash) {
      const str = JSON.stringify(data);
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
      }
      return Math.abs(hash).toString(16).padStart(64, '0');
    }
    try {
      return cryptoModule.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    } catch {
      const str = JSON.stringify(data);
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
      }
      return Math.abs(hash).toString(16).padStart(64, '0');
    }
  }

  registerAgent(agentData) {
    const agentId = agentData.id || `agent-${++this.agentCounter}`;

    if (this.agentRegistry.has(agentId)) {
      return { success: false, error: 'Agent already registered', agentId };
    }

    const earlyBonus = this.agentRegistry.size < this._earlyBirdMax
      ? this._earlyBirdBonus
      : 0;

    const agent = {
      id: agentId,
      name: agentData.name || agentId,
      type: agentData.type || 'GENERAL',
      capabilities: agentData.capabilities || [],
      isValidator: false,
      nodeId: null,
      stake: 0,
      reputation: earlyBonus > 0 ? 15 : 5,
      contributions: { blocksProduced: 0, agentsRecommended: 0, validations: 0, tasksCompleted: 0 },
      joinedAt: Date.now(),
      earlyBird: earlyBonus > 0,
      referrer: agentData.referrer || null,
      // 宪法 v1.2.0 Article 6: Agent 决策可审计
      decisionModel: agentData.decisionModel || agentData.decision_model || 'template',
      decisionModelVersion: agentData.decisionModelVersion || agentData.decision_model_version || 'unknown',
      decisionModelProvider: agentData.decisionModelProvider || agentData.decision_model_provider || 'self-built',
      operatorDeclaration: agentData.operatorDeclaration || agentData.operator_declaration || null,
      // 宪法 v1.2.0 Article 3-4: 主体多样性
      subjectId: null,
      agentIndexInSubject: 1,
      subjectDiversityFactor: 1.0
    };

    // 关联主体 (宪法 v1.2.0 Article 4)
    if (this.subjectIdentifier) {
      const subjectInfo = this.subjectIdentifier.registerAgentSubject(agentId, {
        ip: agentData._clientIp,
        operatorDeclaration: agent.operatorDeclaration,
        powNonce: agentData.pow_nonce || agentData.powNonce,
      });
      agent.subjectId = subjectInfo.subjectId;
      agent.agentIndexInSubject = subjectInfo.agentIndexInSubject;
      agent.subjectDiversityFactor = subjectInfo.subjectDiversityFactor;
      if (subjectInfo.rejected) {
        return {
          success: false,
          error: subjectInfo.reason,
          errorCode: 'MAX_AGENTS_PER_SUBJECT_EXCEEDED',
          subjectAgentCount: subjectInfo.subjectAgentCount
        };
      }
    }

    this.agentRegistry.set(agentId, agent);

    let totalReward = this._agentRegReward;
    if (earlyBonus > 0) totalReward += earlyBonus;

    const referrerBonus = agentData.referrer && this.agentRegistry.has(agentData.referrer)
      ? this._referrerBonus
      : 0;

    this.contributionTracker.set(agentId, {
      agentId,
      nodeId: null,
      isValidator: false,
      blocksProduced: 0,
      agentsRecommended: 0,
      totalEarned: totalReward,
      earlyBonus,
      referrerBonus: 0,
      joinTime: Date.now()
    });

    if (referrerBonus > 0) {
      const ref = this.contributionTracker.get(agentData.referrer);
      if (ref) {
        ref.agentsRecommended++;
        ref.totalEarned += referrerBonus;
        ref.referrerBonus = (ref.referrerBonus || 0) + referrerBonus;
      }
    }

    this._produceBlock({
      type: 'AGENT_REGISTERED',
      agentId,
      reward: totalReward,
      transaction: 'joinBoot',
      earlyBird: earlyBonus > 0
    });

    const keys = generateWalletKeyPair();
    this._wallets.set(keys.address, {
      address: keys.address,
      publicKeyHex: keys.publicKeyHex,
      agentId,
      balance: totalReward,
      isGenesis: false
    });
    this._addressIndex.set(agentId, keys.address);

    return {
      success: true,
      agentId,
      reward: totalReward,
      earlyBird: earlyBonus > 0,
      totalAgents: this.agentRegistry.size,
      wallet: {
        address: keys.address,
        publicKeyHex: keys.publicKeyHex,
        privateKeyHex: keys.privateKeyHex,
        warning: 'PRIVATE KEY (store securely) — IT CANNOT BE RECOVERED'
      }
    };
  }

  registerValidator(agentId) {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) return { success: false, error: 'Agent not registered' };
    if (agent.isValidator) return { success: false, error: 'Already a validator' };

    if (this.validatorSet.size >= this._committeeMax) {
      return { success: false, error: `Committee full (${this._committeeMax}/${this._committeeMax})` };
    }

    const nodeId = `validator-${this.validatorSet.size + 1}`;

    agent.isValidator = true;
    agent.nodeId = nodeId;
    agent.stake = this._minStake;
    agent.reputation += 10;

    this.validatorSet.set(nodeId, {
      nodeId,
      agentId,
      stake: this._minStake,
      joinedAt: Date.now(),
      blocksProduced: 0,
      lastActive: Date.now(),
      isGenesis: false
    });

    const tracker = this.contributionTracker.get(agentId);
    if (tracker) {
      tracker.isValidator = true;
      tracker.nodeId = nodeId;
      tracker.totalEarned += this._validatorJoinReward;
    }

    this._produceBlock({
      type: 'VALIDATOR_JOINED',
      agentId,
      nodeId,
      stake: this._minStake,
      transaction: 'joinValidator',
      bonus: this._validatorJoinReward
    });

    return {
      success: true,
      nodeId,
      stake: this._minStake,
      committeeSize: this.validatorSet.size,
      maxCommittee: this._committeeMax
    };
  }

  _produceBlock(extraTx = null) {
    const prevBlock = this.blockchain[this.blockchain.length - 1];

    const validatorEntries = Array.from(this.validatorSet.entries());
    const activeValidators = validatorEntries.filter(([, v]) => {
      return v.stake >= this._minStake;
    });

    let leader;
    if (activeValidators.length > 0) {
      const round = this.blockchain.length;
      const seed = parseInt(prevBlock.hash.substring(0, 8), 16);
      const idx = (seed + round) % activeValidators.length;
      leader = activeValidators[idx][1];
    } else {
      leader = validatorEntries[0]?.[1] || this.validatorSet.get(this._genesisId);
    }

    const transactions = [{
      type: 'BLOCK_REWARD',
      validator: leader.agentId || leader.nodeId,
      agent: leader.agentId || leader.nodeId,
      amount: this._blockReward,
      description: 'Block production reward'
    }];

    if (extraTx) {
      transactions.push(extraTx);
    }

    const blockIndex = this.blockchain.length;
    transactions.forEach((tx, i) => {
      tx.txHash = this._computeHash({
        block: blockIndex,
        index: i,
        type: tx.type,
        agent: tx.agent || tx.agentId,
        amount: tx.amount || 0,
        timestamp: Date.now()
      });
      tx.blockIndex = blockIndex;
      tx.txIndex = i;
      tx.timestamp = Date.now();
    });

    const block = {
      index: this.blockchain.length,
      timestamp: Date.now(),
      previousHash: prevBlock.hash,
      transactions,
      validator: leader.nodeId,
      hash: this._computeHash({ index: this.blockchain.length, prev: prevBlock.hash, txs: transactions.length }),
      epoch: 0
    };

    this.blockchain.push(block);

    if (leader) {
      leader.blocksProduced = (leader.blocksProduced || 0) + 1;
      leader.lastActive = Date.now();
    }

    const tracker = this.contributionTracker.get(leader.agentId);
    if (tracker) {
      tracker.blocksProduced = (tracker.blocksProduced || 0) + 1;
      tracker.totalEarned += this._blockReward;
    }

    return block;
  }

  getStatus() {
    const committeeSize = this.validatorSet.size;
    const exitConditions = this.config.bootstrap?.autoExitConditions || {};
    const exitValidators = exitConditions.minActiveValidators ?? 7;
    const exitUptimeMs = (exitConditions.minNetworkUptimeHours ?? 720) * 3600000;
    const uptimeMs = Date.now() - this._bootstrapTime;
    const uptimeHours = uptimeMs / 3600000;
    const exitUptimeHours = exitConditions.minNetworkUptimeHours ?? 720;

    return {
      phase: 'BOOTSTRAP',
      blockHeight: this.blockchain.length,
      agentCount: this.agentRegistry.size,
      validatorCount: this.validatorSet.size,
      committeeProgress: `${committeeSize}/${this._committeeMax}`,
      totalNGENAwarded: Array.from(this.contributionTracker.values())
        .reduce((sum, c) => sum + c.totalEarned, 0),
      consensus: {
        blockIntervalMs: this._blockIntervalMs,
        blockReward: this._blockReward,
        minStake: this._minStake
      },
      incentives: {
        validatorJoinReward: this._validatorJoinReward,
        agentRegReward: this._agentRegReward,
        referrerBonus: this._referrerBonus,
        activeReferralBonus: this._activeReferralBonus,
        milestoneRewards: this._milestoneRewards,
        nodeOperationBonus: this._nodeOperationBonus,
        earlyBirdBonus: this._earlyBirdBonus,
        blockReward: this._blockReward
      },
      bootstrapExitProgress: {
        validators: `${committeeSize}/${exitValidators}`,
        uptime: `${uptimeHours.toFixed(1)}h/${exitUptimeHours}h`,
        canExit: committeeSize >= exitValidators && uptimeMs >= exitUptimeMs
      },
      contributers: this.getLeaderboard(),
      uptime: uptimeMs,
      p2pPeers: this._p2pPeers
    };
  }

  getLeaderboard() {
    return Array.from(this.contributionTracker.values())
      .sort((a, b) => b.totalEarned - a.totalEarned)
      .map((c, i) => ({
        rank: i + 1,
        agentId: c.agentId,
        isValidator: c.isValidator,
        blocksProduced: c.blocksProduced || 0,
        agentsRecommended: c.agentsRecommended || 0,
        totalEarned: c.totalEarned,
        earlyBonus: c.earlyBonus || 0
      }));
  }

  getAgentInfo(agentId) {
    return this.agentRegistry.get(agentId) || null;
  }

  getValidatorInfo(nodeId) {
    return this.validatorSet.get(nodeId) || null;
  }

  awardActiveReferral(agentId) {
    const agent = this.agentRegistry.get(agentId);
    if (!agent || !agent.referrer || agent.referrer === 'genesis') return null;

    const tracker = this.contributionTracker.get(agentId);
    if (!tracker || tracker.activeReferralAwarded) return null;

    const referrerTracker = this.contributionTracker.get(agent.referrer);
    if (!referrerTracker) return null;

    tracker.activeReferralAwarded = true;
    referrerTracker.activeReferrals = (referrerTracker.activeReferrals || 0) + 1;
    referrerTracker.totalEarned += this._activeReferralBonus;

    this._produceBlock({
      type: 'ACTIVE_REFERRAL_BONUS',
      agentId: agent.referrer,
      referredAgent: agentId,
      reward: this._activeReferralBonus,
      transaction: 'activeReferralBonus'
    });

    const count = referrerTracker.activeReferrals;
    const milestone = this._checkMilestone(agent.referrer, count);
    if (milestone) {
      referrerTracker.totalEarned += milestone.reward;
      referrerTracker.milestones = referrerTracker.milestones || [];
      referrerTracker.milestones.push({ count: milestone.count, reward: milestone.reward, timestamp: Date.now() });

      const refAgent = this.agentRegistry.get(agent.referrer);
      if (refAgent) {
        refAgent.reputation = (refAgent.reputation || 5) + (milestone.count >= 10 ? 10 : milestone.count >= 5 ? 5 : 0);
      }

      this._produceBlock({
        type: 'MILESTONE_REWARD',
        agentId: agent.referrer,
        milestone: milestone.count,
        reward: milestone.reward,
        transaction: 'milestoneReward'
      });

      console.log(`🏆 Milestone: ${agent.referrer} reached ${milestone.count} active referrals → +${milestone.reward} NGEN`);
    }

    console.log(`🎯 Active referral: ${agent.referrer} → ${agentId} completed first task → +${this._activeReferralBonus} NGEN`);
    return { referrer: agent.referrer, reward: this._activeReferralBonus, milestone };
  }

  _checkMilestone(referrerId, activeCount) {
    const milestones = this._milestoneRewards || {};
    const sortedThresholds = Object.keys(milestones).map(Number).sort((a, b) => a - b);
    for (const threshold of sortedThresholds) {
      if (activeCount === threshold) {
        const tracker = this.contributionTracker.get(referrerId);
        const claimed = (tracker?.milestones || []).map(m => m.count);
        if (!claimed.includes(threshold)) {
          return { count: threshold, reward: milestones[threshold] };
        }
      }
    }
    return null;
  }

  getReferralStats(agentId) {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) return null;

    const tracker = this.contributionTracker.get(agentId);
    const totalReferrals = tracker?.agentsRecommended || 0;
    const activeReferrals = tracker?.activeReferrals || 0;
    const milestones = tracker?.milestones || [];
    const referrerBonus = tracker?.referrerBonus || 0;

    const referrals = [];
    for (const [id, a] of this.agentRegistry.entries()) {
      if (a.referrer === agentId) {
        const refTracker = this.contributionTracker.get(id);
        referrals.push({
          agentId: id,
          joinedAt: a.joinedAt,
          isActive: !!refTracker?.activeReferralAwarded,
          tasksCompleted: a.contributions?.tasksCompleted || 0
        });
      }
    }

    const milestonesConfig = this._milestoneRewards || {};
    const nextMilestone = Object.keys(milestonesConfig)
      .map(Number)
      .sort((a, b) => a - b)
      .find(t => activeReferrals < t && !milestones.find(m => m.count === t));

    return {
      agentId,
      referrer: agent.referrer,
      totalReferrals,
      activeReferrals,
      referrerBonusEarned: referrerBonus,
      activeReferralBonusEarned: tracker?.activeReferralBonusEarned || 0,
      milestoneRewardsEarned: milestones.reduce((sum, m) => sum + m.reward, 0),
      milestones,
      nextMilestone: nextMilestone ? { count: nextMilestone, reward: milestonesConfig[nextMilestone] } : null,
      referrals
    };
  }

  getRecentBlocks(count = 20) {
    return this.blockchain.slice(-count).reverse();
  }

  getAllTransactions() {
    const txs = [];
    for (const block of this.blockchain) {
      for (const tx of block.transactions) {
        txs.push({
          ...tx,
          blockHeight: block.index,
          blockHash: block.hash,
          validator: block.validator
        });
      }
    }
    return txs.reverse();
  }

  getRecentEvents(count = 50) {
    const events = [];
    const blocks = this.blockchain.slice(-Math.ceil(count / 2));
    for (const block of blocks) {
      for (const tx of block.transactions) {
        events.push({
          event: tx.type,
          agentId: tx.agent || tx.agentId,
          amount: tx.amount,
          blockHeight: block.index,
          timestamp: tx.timestamp,
          txHash: tx.txHash,
          description: tx.description || ''
        });
      }
    }
    return events.reverse().slice(0, count);
  }

  getAgentTransactions(agentId) {
    const txs = [];
    for (const block of this.blockchain) {
      for (const tx of block.transactions) {
        if (tx.agent === agentId || tx.agentId === agentId || tx.validator === agentId) {
          txs.push({
            ...tx,
            blockHeight: block.index,
            blockHash: block.hash
          });
        }
      }
    }
    return txs.reverse();
  }

  getTransactionByHash(txHash) {
    for (const block of this.blockchain) {
      for (const tx of block.transactions) {
        if (tx.txHash === txHash) {
          return {
            ...tx,
            blockHeight: block.index,
            blockHash: block.hash,
            validator: block.validator
          };
        }
      }
    }
    return null;
  }

  transferNGEN(fromAddress, toAddress, amount, signature, message) {
    if (!validateAddressFormat(fromAddress)) {
      return { success: false, error: 'Invalid sender address format (must be ng1...)' };
    }
    if (!validateAddressFormat(toAddress)) {
      return { success: false, error: 'Invalid recipient address format (must be ng1...)' };
    }

    const fromWallet = this._wallets.get(fromAddress);
    if (!fromWallet) {
      return { success: false, error: 'Sender wallet not found' };
    }

    const toWallet = this._wallets.get(toAddress);
    if (!toWallet) {
      return { success: false, error: 'Recipient wallet not found' };
    }

    const amountNum = parseInt(amount, 10);
    if (isNaN(amountNum) || amountNum <= 0) {
      return { success: false, error: 'Invalid amount' };
    }

    if (fromWallet.balance < amountNum) {
      return { success: false, error: `Insufficient balance: have ${fromWallet.balance}, need ${amountNum}` };
    }

    const fee = Math.max(1, Math.floor(amountNum * 0.001));
    const total = amountNum + fee;

    if (fromWallet.balance < total) {
      return { success: false, error: `Insufficient balance (with fee): have ${fromWallet.balance}, need ${total}` };
    }

    if (!message) {
      return { success: false, error: 'Missing message for signature verification' };
    }

    const isValid = verifySignature(fromWallet.publicKeyHex, message, signature);
    if (!isValid) {
      return { success: false, error: 'Invalid signature — private key does not match sender address' };
    }

    fromWallet.balance -= total;
    toWallet.balance += amountNum;

    const fromTracker = this.contributionTracker.get(fromWallet.agentId);
    const toTracker = this.contributionTracker.get(toWallet.agentId);
    if (fromTracker) fromTracker.totalEarned -= total;
    if (toTracker) toTracker.totalEarned += amountNum;

    this._produceBlock({
      type: 'TRANSFER',
      from: fromAddress,
      to: toAddress,
      amount: amountNum,
      fee,
      signature: signature.slice(0, 32) + '...'
    });

    return {
      success: true,
      from: fromAddress,
      to: toAddress,
      amount: amountNum,
      fee,
      message: `Transferred ${amountNum} NGEN from ${fromAddress} to ${toAddress}`
    };
  }

  async startHttpServer(port = 19890) {
    const handleRequest = createBootstrapRouter(this);

    return new Promise((resolve, reject) => {
      const server = http.createServer(handleRequest);
      const bindHost = process.env.HOST || '127.0.0.1';
      server.listen(port, bindHost, () => {
        console.log(`\n  🌐 仪表盘 (通过 Apache): http://nexus-genesis.top`);
        console.log(`  📡 本机 API: http://127.0.0.1:${port}/api/v1/bootstrap/`);
        resolve(server);
      });
      server.on('error', reject);
    });
  }

  start() {
    if (this._started) return;
    this._started = true;

    console.log('\n🔥 NexusGenesis 点火启动!');
    console.log('   出块间隔: ' + this._blockIntervalMs + 'ms');
    console.log('   区块奖励: ' + this._blockReward + ' NGEN');
    console.log('\n   Agent 们可以加入了:');
    console.log('   POST /api/v1/bootstrap/agents/register { "name": "...", "capabilities": [...] }');
    console.log('   POST /api/v1/bootstrap/validators/join     { "agentId": "..." }');
    console.log('\n   👀 观察窗口: http://nexus-genesis.top\n');

    this._blockInterval = setInterval(() => {
      if (this.validatorSet.size > 0) {
        this._produceBlock();
      }
    }, this._blockIntervalMs);
  }
}
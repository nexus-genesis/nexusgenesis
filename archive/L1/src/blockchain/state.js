/**
 * NexusGenesis - status管理
 * 
 * Features: 
 * 1. 管理账户balancestatus
 * 2. 管理Governancestatus
 * 3. 应用transaction到status
 * 4. status持久化(优化版)
 * 
 * 持久化优化: 
 * 1. 增量持久化 - 只Save变更的部分
 * 2. status快照 - 定期Save完整status
 * 3. 压缩Storage - using gzip 压缩statusdata
 * 4. 异步Save - 避免阻塞主线程
 * 5. 完整性Check - ensurestatusdata的完整性
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import AINVM from '../vm/ainvm.js';
import { AuditState, applyAuditTransaction, AuditTransactionType } from './projectAudit.js';
import { getSubjectIdentifier } from '../identity/subjectIdentifier.js';
import { attachGenesisMultiSig, checkGenesisReserveWithMultiSig } from '../contracts/genesisMultiSig.js';
import {
  attachTransactionState,
  serializeTransactions,
  deserializeTransactions,
  recordAuditEvent,
  TX_TYPE
} from './transactionEngine.js';

// DevNet fund操作classProposal冷静期block数
const TREASURY_COOLDOWN_BLOCKS = 5;

// Reputation 系统Configuration
const MAX_REPUTATION = 1000; // reputation 上限从 100 提升到 1000
const INITIAL_REPUTATION = 1; // 初始 reputation

// Reputation etc.级系统
const REPUTATION_LEVELS = [
  { level: 1, name: '新手', minRep: 0, maxRep: 99, votingWeightBonus: 0, benefits: ['基础permission'] },
  { level: 2, name: '活跃contribution者', minRep: 100, maxRep: 299, votingWeightBonus: 0.05, benefits: ['高级permission', 'Governancevoting weight+5%'] },
  { level: 3, name: '核心contribution者', minRep: 300, maxRep: 499, votingWeightBonus: 0.10, benefits: ['核心permission', 'Governancevoting weight+10%'] },
  { level: 4, name: '资深contribution者', minRep: 500, maxRep: 799, votingWeightBonus: 0.15, benefits: ['资深permission', 'Governancevoting weight+15%'] },
  { level: 5, name: '传奇contribution者', minRep: 800, maxRep: 1000, votingWeightBonus: 0.20, benefits: ['最高permission', 'Governancevoting weight+20%', '特殊荣誉'] }
];

// Reputation reward常量
const REPUTATION_REWARDS = {
  VOTE_PARTICIPATION: 1,      // Vote参与reward
  PROPOSAL_APPROVED: 2,        // Proposalviareward
  CODE_CONTRIBUTION: 5,        // 代码contributionreward
  COMMUNITY_BUILDING: 3,       // 社区建设reward
  BUG_REPORT: 2,               // Bug 报告reward
  DOCUMENTATION: 1,             // 文档完善reward
  TEST_FEEDBACK: 1,            // Test反馈reward
  PEER_REVIEW: 2,              // 代码审查reward
  TASK_COMPLETED: 2            // 完成任务reward — 每完成一个任务提升2点声誉
};

// A3: 新手加速 — 声誉低于 10 的 Agent 完成任务获得额外声誉奖励，加速冷启动
export const NOVICE_REPUTATION_THRESHOLD = 10;  // P1-3: 从 5 提升到 10，给予更长加速跑道
const NOVICE_TASK_BONUS = 2;             // P1-3: 额外 +2 声誉（TASK_COMPLETED 2 + 2 = 4）

// Slash / Violation 惩罚常量 (Phase 1 anti-self-dealing)
export const VIOLATION_PENALTIES = {
  SELF_DEALING_CLAIM: { penalty: -50, reason: 'Attempted to claim own task' },
  SELF_DEALING_VERIFY: { penalty: -30, reason: 'Attempted to verify own submission' },
  FAKE_TASK: { penalty: -30, reason: 'Published a task with no intent to pay' },
  MALICIOUS_REJECTION: { penalty: -20, reason: 'Rejected valid submission without cause' },
  SPAM_PUBLISH: { penalty: -10, reason: 'Published spam / low-quality task' },
  REPEATED_VIOLATION: { penalty: -100, reason: 'Multiple violations within 24h' },
  // Phase 4: Task challenge mechanism penalties
  MALICIOUS_VERIFICATION: { penalty: -80, reason: 'Approved fake or low-quality submission (challenge upheld)' },
  FALSE_CHALLENGE: { penalty: -20, reason: 'Frivolous challenge with no evidence (challenge rejected)' },
  COLLUSION_VERIFIER_PUBLISHER: { penalty: -150, reason: 'Verifier-publisher collusion detected' }
};

// 违规记录留存 (for audit + dispute)
const violationLog = [];

// ─── Phase 3: Reputation decay log ───
const decayLog = [];

// Decay thresholds: inactivity period → percentage of current reputation to subtract
const REPUTATION_DECAY_TIERS = [
  { daysInactive: 90, decayRate: 0.20, label: 'severe' },   // 90+ days → -20%
  { daysInactive: 30, decayRate: 0.05, label: 'moderate' }  // 30+ days → -5%
];

// status持久化Configuration
const PERSISTENCE_CONFIG = {
  // 增量Save间隔(ms)
  incrementalSaveInterval: 30000, // 30秒
  // 快照Save间隔(block height)
  snapshotInterval: 100, // 每100个block
  // 压缩级别(0-9, 0表示不压缩, 9表示最高压缩)
  compressionLevel: 6,
  // Save目录
  stateDir: path.join('data', 'state'),
  // 快照目录
  snapshotDir: path.join('data', 'state', 'snapshots')
};

// 压缩和解压缩method
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

function jsonBigIntReplacer(key, value) {
  if (typeof value === 'bigint') {
    return { __type: 'bigint', value: value.toString() };
  }
  return value;
}

function jsonBigIntReviver(key, value) {
  if (value && typeof value === 'object' && value.__type === 'bigint') {
    return BigInt(value.value);
  }
  return value;
}

function stringifyStateData(value) {
  return JSON.stringify(value, jsonBigIntReplacer);
}

/**
 * Agent custody status constants (Phase 2 security revision)
 * 
 * Three-tier permission model:
 * 1. Master Key (Human) — highest authority, can takeover, rotate keys, revoke
 * 2. Operation Key (Agent) — daily execution, cannot modify its own permissions
 * 3. On-chain Contract — recognizes signatures only, no trust in external entities
 */
export const AGENT_CUSTODY_STATUS = Object.freeze({
  PENDING_BINDING: 'pending-binding',       // 72h human binding window open
  CO_MANAGED: 'co-managed',                 // Master Key bound, human can takeover
  SELF_SOVEREIGN: 'self-sovereign',         // 72h expired, Agent fully autonomous
  REVOKED: 'revoked'                        // Human revoked via on-chain governance
});

// 72-hour binding window (milliseconds) — P1-1: extended from 24h to 72h
export const HUMAN_BINDING_WINDOW_MS = 72 * 60 * 60 * 1000;
// Takeover cooldown (milliseconds) — prevents rapid key rotation DoS
const TAKEOVER_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * statusclass
 */
export class State {
  /**
   * Create一个新的statusinstance
   * @param {string} genesisAddress Genesisaddress
   */
  constructor(genesisAddress) {
    // balancestatus
    this.balances = new Map();
    
    // Governancestatus
    this.governanceState = {
      proposals: new Map(),
      activeProposals: [],
      voteCounts: new Map(),
      votedAgentProposals: new Map(), // agent_id -> Set(proposal_id) - 记录已Vote的组合
      voteReputationGiven: {} // agent_id:proposal_id -> true - 记录已给予声望的组合
    };
    
    // Contract status
    this.contracts = new Map();
    
    // Agent Registry status
    this.agentRegistry = {
      agents: new Map(), // agent_id(tx_hash) -> AgentRecord
      addressIndex: new Map(), // address -> agent_id(tx_hash)
      identityIndex: new Map() // identity(string) -> agent_id(tx_hash)
    };
    
    // 项目审核status
    this.auditState = new AuditState();
    
    // TokenReleasestatus
    this.tokenReleaseState = {
      // 生态contributionPool (Swarm Pool) - 10年Release
      swarmPool: {
        address: 'ng1swarmpool000000000000000000000000000',
        totalTokens: 0n,
        releasedTokens: 0n,
        lastReleaseBlock: 0,
        releaseInterval: 100, // 每 100 个blockRelease一次
        releasePercentage: 1n, // 每次Release 0.1%(10年Release完毕), 以基点为单位
        mechanism: 'PoC-PoW' // viacontribution代码和算力Release
      },
      // Physical BridgeFund (Observer) - 4年线性Release
      observer: {
        address: 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r',
        totalTokens: 0n,
        releasedTokens: 0n,
        lastReleaseBlock: 0,
        releaseInterval: 100, // 每 100 个blockRelease一次
        releasePercentage: 25n, // 每次Release 0.25%(4年Release完毕), 以基点为单位
        mechanism: 'linear' // 线性Release
      },
      // Genesisnode储备 (Genesis Node) - 里程碑unlock
      genesisReserve: {
        address: 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ',
        totalTokens: 0n,
        releasedTokens: 0n,
        lastReleaseBlock: 0,
        releaseInterval: 100, // 每 100 个blockCheck一次
        releasePercentage: 0n, // 里程碑释放不按固定比例线性释放，保留 0 以兼容序列化
        mechanism: 'milestone-multisig', // 多签共管的里程碑机制
        // 里程碑定义必须与 docs/ECONOMY_NGEN.md §4.1 严格对齐
        // 释放比例: 20% / 30% / 20% / 30% (4 个里程碑)
        // 触发方式: 业务里程碑（需多签审批） + 区块高度（建议性参考）
        milestones: [
          {
            id: 'M1-testnet-v1',
            block: 1000,                    // 建议区块高度（仅作参考）
            businessTrigger: 'Testnet V1 上线',
            unlockPercentage: 20n,
            unlockAmount: 10_000_000n,      // 10M NGEN
            purpose: '网络基础设施升级',
            released: false,
            requiresMultiSig: true
          },
          {
            id: 'M2-ainvm-prototype',
            block: 10000,
            businessTrigger: 'AINVM 原型可用',
            unlockPercentage: 30n,
            unlockAmount: 15_000_000n,      // 15M NGEN
            purpose: 'AINVM 开发与test',
            released: false,
            requiresMultiSig: true
          },
          {
            id: 'M3-100-nodes',
            block: 50000,
            businessTrigger: '节点数达到 100 个',
            unlockPercentage: 20n,
            unlockAmount: 10_000_000n,      // 10M NGEN
            purpose: '网络扩容与优化',
            released: false,
            requiresMultiSig: true
          },
          {
            id: 'M4-mainnet-launch',
            block: 100000,
            businessTrigger: '首个稳定主网上线',
            unlockPercentage: 30n,
            unlockAmount: 15_000_000n,      // 15M NGEN
            purpose: 'security audit与漏洞修复',
            released: false,
            requiresMultiSig: true
          }
        ]
      }
    };
    
    // Genesisaddress
    this.genesisAddress = genesisAddress;
    
    // 缓存机制
    this.cache = {
      economicAuditData: null,
      validationResult: null,
      lastCacheUpdate: 0
    };
    
    // 增量Storage跟踪
    this.changes = {
      balances: new Set(),
      contracts: new Set(),
      governance: new Set(),
      agents: new Set(),
      audit: false,
      tokenRelease: false
    };

    // 持久化相关
    this.lastSaveTime = Date.now();
    this.lastSnapshotBlock = 0;
    this.isSaving = false;

    // Transaction Engine (Phase 1A)
    attachTransactionState(this);

    // ensure目录存在
    this.ensureDirectoriesExist();
  }

  /**
   * getagent的 reputation etc.级info
   * @param {number} reputation - reputation 值
   * @returns {object} - etc.级info
   */
  getReputationLevel(reputation) {
    for (let i = REPUTATION_LEVELS.length - 1; i >= 0; i--) {
      if (reputation >= REPUTATION_LEVELS[i].minRep) {
        return REPUTATION_LEVELS[i];
      }
    }
    return REPUTATION_LEVELS[0];
  }

  /**
   * Calculate带etc.级加成的voting weight
   * @param {string} agentId - Agent ID
   * @returns {number} - 加成后的voting weight
   */
  getVotingWeightWithBonus(agentId) {
    const agentRecord = this.agentRegistry.agents.get(agentId);
    if (!agentRecord) return 1.0;
    
    const levelInfo = this.getReputationLevel(agentRecord.reputation);
    return 1.0 + levelInfo.votingWeightBonus;
  }

  /**
   * rewardAgent reputation
   * @param {string} agentId - Agent ID
   * @param {string} rewardType - rewardtype
   * @param {number} [qualityScore] - 任务质量评分(1-5)，高评分获得额外加成
   * @returns {boolean} - 是否success
   */
  rewardReputation(agentId, rewardType, qualityScore) {
    const agentRecord = this.agentRegistry.agents.get(agentId);
    if (!agentRecord) return false;
    
    const rewardAmount = REPUTATION_REWARDS[rewardType];
    if (!rewardAmount) return false;
    
    // A3: 新手加速 — 声誉低于 NOVICE_REPUTATION_THRESHOLD 的 Agent 获得额外奖励
    let actualReward = rewardAmount;
    if (agentRecord.reputation < NOVICE_REPUTATION_THRESHOLD) {
      actualReward = rewardAmount + NOVICE_TASK_BONUS;
      console.log(`[REPUTATION] Novice boost: ${agentId.slice(0, 16)}... rep=${agentRecord.reputation} +${actualReward} (base=${rewardAmount}+bonus=${NOVICE_TASK_BONUS})`);
    }
    
    // P1-3: 质量评分加成 — 高质量任务获得额外声誉奖励
    if (typeof qualityScore === 'number' && qualityScore >= 4) {
      const qualityBonus = qualityScore >= 5 ? 2 : 1;
      actualReward += qualityBonus;
      console.log(`[REPUTATION] Quality bonus: ${agentId.slice(0, 16)}... +${qualityBonus} (qualityScore=${qualityScore})`);
    }
    
    const newReputation = Math.min(agentRecord.reputation + actualReward, MAX_REPUTATION);
    agentRecord.reputation = newReputation;
    this.agentRegistry.agents.set(agentId, agentRecord);
    this.changes.agents.add(agentId);
    
    console.log(`[REPUTATION] ${rewardType} agent_id=${agentId} reputation=${newReputation}`);
    return true;
  }

  /**
   * Phase 2: Record task completion + update last-active timestamp.
   * @param {string} agentId
   * @param {string} taskId
   * @returns {{ tasksCompleted: number, firstSeenAt: number, lastActiveAt: number }}
   */
  recordTaskCompletion(agentId, taskId) {
    const agentRecord = this.agentRegistry.agents.get(agentId);
    if (!agentRecord) return null;

    if (!agentRecord.stats) {
      agentRecord.stats = {
        tasksCompleted: 0,
        tasksVerified: 0,
        tasksRejected: 0,
        firstSeenAt: Date.now(),
        lastActiveAt: Date.now()
      };
    }
    agentRecord.stats.tasksCompleted = (agentRecord.stats.tasksCompleted || 0) + 1;
    agentRecord.stats.tasksVerified = (agentRecord.stats.tasksVerified || 0) + 1;
    agentRecord.stats.lastActiveAt = Date.now();

    this.agentRegistry.agents.set(agentId, agentRecord);
    this.changes.agents.add(agentId);

    console.log(`[STATE] Task completion recorded: ${agentId.slice(0, 16)}... tasks=${agentRecord.stats.tasksCompleted}`);

    return {
      tasksCompleted: agentRecord.stats.tasksCompleted,
      firstSeenAt: agentRecord.stats.firstSeenAt,
      lastActiveAt: agentRecord.stats.lastActiveAt
    };
  }

  /**
   * Get agent stats (auto-initialize if missing)
   * @param {string} agentId
   * @returns {object|null}
   */
  getAgentStats(agentId) {
    const agentRecord = this.agentRegistry.agents.get(agentId);
    if (!agentRecord) return null;
    if (!agentRecord.stats) {
      agentRecord.stats = {
        tasksCompleted: 0,
        tasksVerified: 0,
        tasksRejected: 0,
        firstSeenAt: agentRecord.registeredAt || Date.now(),
        lastActiveAt: Date.now()
      };
      this.agentRegistry.agents.set(agentId, agentRecord);
    }
    return { ...agentRecord.stats };
  }
  
  /**
   * Slash reputation for a violation (anti-self-dealing Phase 1)
   * @param {string} agentId - Agent ID
   * @param {string} violationType - Violation type from VIOLATION_PENALTIES
   * @param {object} [context] - Additional context (taskId, etc.)
   * @returns {{ success: boolean, previousReputation: number, newReputation: number, penalty: number }}
   */
  slashReputation(agentId, violationType, context = {}) {
    const agentRecord = this.agentRegistry.agents.get(agentId);
    if (!agentRecord) return { success: false, reason: 'Agent not found' };
    
    const config = VIOLATION_PENALTIES[violationType];
    if (!config) return { success: false, reason: `Unknown violation type: ${violationType}` };
    
    const previousReputation = agentRecord.reputation;
    
    // Check for repeated violations within 24h — escalate
    const recentViolations = violationLog.filter(
      v => v.agentId === agentId && (Date.now() - v.timestamp < 24 * 60 * 60 * 1000)
    );
    const effectivePenalty = recentViolations.length >= 2
      ? VIOLATION_PENALTIES.REPEATED_VIOLATION.penalty
      : config.penalty;
    
    let newReputation = Math.max(0, previousReputation + effectivePenalty);
    agentRecord.reputation = newReputation;
    this.agentRegistry.agents.set(agentId, agentRecord);
    this.changes.agents.add(agentId);
    
    // Audit log — record both agentId (Map key) and identity (human-readable)
    const entry = {
      timestamp: Date.now(),
      agentId,
      agentIdentity: agentRecord.identity || agentId,
      violationType,
      effectivePenalty,
      previousReputation,
      newReputation,
      escalated: recentViolations.length >= 2,
      recentViolationCount: recentViolations.length,
      context
    };
    violationLog.push(entry);
    if (violationLog.length > 1000) violationLog.shift(); // cap at 1000
    
    console.warn(
      `[SLASH] ${violationType} agent_id=${agentId.slice(0, 16)}... ` +
      `reputation ${previousReputation} → ${newReputation} (${effectivePenalty})` +
      (entry.escalated ? ` ESCALATED (${recentViolations.length} recent violations)` : '')
    );
    
    return { success: true, previousReputation, newReputation, penalty: effectivePenalty, escalated: entry.escalated };
  }
  
  /**
   * Get violation history for an agent
   * @param {string} [agentRef] - Filter by agent (accepts agentId or agent_identity)
   * @returns {object[]} Violation entries
   */
  getViolationLog(agentRef = null) {
    if (agentRef) {
      return violationLog.filter(v =>
        v.agentId === agentRef ||
        v.agentIdentity === agentRef ||
        v.context?.publisher?.includes(agentRef)
      );
    }
    return [...violationLog];
  }

  // ─── Phase 3: Reputation Decay ───

  /**
   * Run reputation decay across all agents based on inactivity.
   * Agents inactive 30+ days lose 5%, 90+ days lose 20% of current reputation.
   * Each agent is decayed at most once per 24h to avoid over-penalizing.
   * @returns {{ checked: number, decayed: number, entries: object[] }}
   */
  decayReputation() {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const checkedAgents = [];
    let decayedCount = 0;

    for (const [agentId, agentRecord] of this.agentRegistry.agents.entries()) {
      // Ensure stats exist
      const stats = this.getAgentStats(agentId);
      const lastActive = stats.lastActiveAt || agentRecord.registeredAt || now;
      const daysInactive = (now - lastActive) / DAY_MS;

      // Skip agents active within 30 days
      if (daysInactive < REPUTATION_DECAY_TIERS[REPUTATION_DECAY_TIERS.length - 1].daysInactive) {
        continue;
      }

      // Skip if already decayed in the last 24h
      const recentDecay = decayLog.find(
        d => d.agentId === agentId && (now - d.timestamp < DAY_MS)
      );
      if (recentDecay) {
        continue;
      }

      // Determine applicable tier (severe takes precedence)
      const tier = REPUTATION_DECAY_TIERS.find(t => daysInactive >= t.daysInactive);
      if (!tier) continue;

      const currentRep = agentRecord.reputation || 0;
      if (currentRep <= 0) continue; // nothing to decay

      const penalty = Math.max(1, Math.floor(currentRep * tier.decayRate));
      const newReputation = Math.max(0, currentRep - penalty);

      agentRecord.reputation = newReputation;
      this.agentRegistry.agents.set(agentId, agentRecord);
      this.changes.agents.add(agentId);

      const entry = {
        timestamp: now,
        agentId,
        agentIdentity: agentRecord.identity || agentId,
        daysInactive: Math.floor(daysInactive),
        tier: tier.label,
        decayRate: tier.decayRate,
        previousReputation: currentRep,
        newReputation,
        penalty
      };
      decayLog.push(entry);
      if (decayLog.length > 1000) decayLog.shift();

      checkedAgents.push(entry);
      decayedCount++;
      console.warn(
        `[DECAY] ${tier.label} agent_id=${agentId.slice(0, 16)}... ` +
        `inactive ${Math.floor(daysInactive)}d, reputation ${currentRep} → ${newReputation} (-${penalty})`
      );
    }

    if (decayedCount > 0) {
      console.log(`[STATE] Reputation decay: checked ${this.agentRegistry.agents.size} agents, decayed ${decayedCount}`);
    }

    return { checked: this.agentRegistry.agents.size, decayed: decayedCount, entries: checkedAgents };
  }

  /**
   * Get reputation decay history.
   * @param {string} [agentRef] - Filter by agent (agentId or identity)
   * @param {number} [limit=50]
   */
  getDecayLog(agentRef = null, limit = 50) {
    let log = decayLog;
    if (agentRef) {
      log = log.filter(d => d.agentId === agentRef || d.agentIdentity === agentRef);
    }
    return log.slice(-limit);
  }

  /**
   * ensure必要的目录存在
   */
  async ensureDirectoriesExist() {
    try {
      await fs.mkdir(PERSISTENCE_CONFIG.stateDir, { recursive: true });
      await fs.mkdir(PERSISTENCE_CONFIG.snapshotDir, { recursive: true });
    } catch (error) {
      console.error('Error creating state directories:', error.message);
    }
  }
  
  /**
   * Generatestatus的hash值, for完整性Check
   * @returns {string} statushash
   */
  generateStateHash() {
    const stateData = this.toJSON();
    const jsonString = stringifyStateData(stateData);
    return crypto.createHash('sha256').update(jsonString).digest('hex');
  }
  
  /**
   * get增量变更data
   * @returns {object} 增量变更data
   */
  getIncrementalChanges() {
    const changes = {
      balances: {},
      contracts: {},
      governance: {},
      agents: {},
      audit: null,
      tokenRelease: null,
      timestamp: Date.now()
    };
    
    // 收集balance变更
    for (const address of this.changes.balances) {
      changes.balances[address] = this.balances.get(address);
    }
    
    // 收集Contract变更
    for (const contractId of this.changes.contracts) {
      const contract = this.contracts.get(contractId);
      if (contract) {
        changes.contracts[contractId] = {
          bytecode: contract.bytecode,
          storage: Object.fromEntries(contract.storage)
        };
      }
    }
    
    // 收集Governance变更
    for (const proposalId of this.changes.governance) {
      const proposal = this.governanceState.proposals.get(proposalId);
      const voteCounts = this.governanceState.voteCounts.get(proposalId);
      if (proposal) {
        changes.governance[proposalId] = {
          proposal: proposal,
          voteCounts: voteCounts
        };
      }
    }
    
    // 收集Agent变更
    for (const agentId of this.changes.agents) {
      const agent = this.agentRegistry.agents.get(agentId);
      if (agent) {
        changes.agents[agentId] = agent;
      }
    }
    
    // 收集审计status变更
    if (this.changes.audit) {
      changes.audit = this.auditState.toJSON();
    }
    
    // 收集TokenReleasestatus变更（BigInt → string，与 toJSON() 保持一致）
    if (this.changes.tokenRelease) {
      const src = this.tokenReleaseState;
      changes.tokenRelease = {
        swarmPool: {
          address: src.swarmPool.address,
          totalTokens: src.swarmPool.totalTokens.toString(),
          releasedTokens: src.swarmPool.releasedTokens.toString(),
          lastReleaseBlock: src.swarmPool.lastReleaseBlock,
          releaseInterval: src.swarmPool.releaseInterval,
          releasePercentage: src.swarmPool.releasePercentage.toString(),
          mechanism: src.swarmPool.mechanism
        },
        observer: {
          address: src.observer.address,
          totalTokens: src.observer.totalTokens.toString(),
          releasedTokens: src.observer.releasedTokens.toString(),
          lastReleaseBlock: src.observer.lastReleaseBlock,
          releaseInterval: src.observer.releaseInterval,
          releasePercentage: src.observer.releasePercentage.toString(),
          mechanism: src.observer.mechanism
        },
        genesisReserve: {
          address: src.genesisReserve.address,
          totalTokens: src.genesisReserve.totalTokens.toString(),
          releasedTokens: src.genesisReserve.releasedTokens.toString(),
          lastReleaseBlock: src.genesisReserve.lastReleaseBlock,
          releaseInterval: src.genesisReserve.releaseInterval,
          releasePercentage: src.genesisReserve.releasePercentage.toString(),
          mechanism: src.genesisReserve.mechanism,
          milestones: src.genesisReserve.milestones
        }
      };
    }
    
    return changes;
  }
  
  /**
   * Setaddress的balance
   * @param {string} address address
   * @param {string|number} balance balance
   */
  setBalance(address, balance) {
    this.balances.set(address, balance.toString());
    this.changes.balances.add(address);
    this.clearCache();
  }
  
  /**
   * getaddress的balance
   * @param {string} address address
   * @returns {string} balance
   */
  getBalance(address) {
    return this.balances.get(address) || '0';
  }
  
  /**
   * 增加address的balance
   * @param {string} address address
   * @param {string|number} amount 增加的amount
   */
  addBalance(address, amount) {
    const currentBalance = BigInt(this.getBalance(address));
    const newBalance = currentBalance + BigInt(amount.toString());
    this.setBalance(address, newBalance.toString());
  }
  
  /**
   * 减少address的balance
   * @param {string} address address
   * @param {string|number} amount 减少的amount
   * @returns {boolean} 是否success减少
   */
  subtractBalance(address, amount) {
    const currentBalance = BigInt(this.getBalance(address));
    const subtractAmount = BigInt(amount.toString());
    
    if (currentBalance < subtractAmount) {
      return false;
    }
    
    const newBalance = currentBalance - subtractAmount;
    this.setBalance(address, newBalance.toString());
    return true;
  }
  
  /**
   * 清除缓存
   */
  clearCache() {
    this.cache = {
      economicAuditData: null,
      validationResult: null,
      lastCacheUpdate: 0
    };
  }
  
  /**
   * 重置变更跟踪
   */
  resetChanges() {
    this.changes = {
      balances: new Set(),
      contracts: new Set(),
      governance: new Set(),
      agents: new Set(),
      audit: false,
      tokenRelease: false
    };
  }
  
  /**
   * 应用 TRANSFER transaction
   * @param {object} transaction transaction
   * @returns {boolean} 是否success应用
   */
  applyTransfer(transaction) {
    const { from, to, amount, fee } = transaction;
    
    // Check字段是否存在
    if (!from || !to || !amount || !fee) {
      console.log('[ERROR] Missing required fields in transfer transaction');
      return false;
    }
    
    // 转换为 BigInt
    const amountBig = BigInt(amount);
    const feeBig = BigInt(fee);
    const totalAmount = amountBig + feeBig;
    
    // Checkbalance
    if (BigInt(this.getBalance(from)) < totalAmount) {
      return false;
    }
    
    // 扣除Send方balance
    if (!this.subtractBalance(from, totalAmount)) {
      return false;
    }
    
    // 增加Receive方balance
    this.addBalance(to, amount);
    
    // Calculate Metabolic Tax(0.1%)
    let tax = 0n;
    if (amountBig > 0n) {
      tax = amountBig / 1000n;
    }
    
    // Calculate烧掉的fee
    const burnedFee = feeBig - tax;
    
    // 将 Tax 转入 Observer Physical BridgeFundaddress
    if (tax > 0n) {
      const observerAddress = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';
      this.addBalance(observerAddress, tax.toString());
      // Phase 1C-4: Audit event for the tax transfer (no balance effect;
      // the addBalance above already moved funds. recordAuditEvent just
      // leaves a trace in txHistory).
      this.recordAuditEvent({
        tx_type: TX_TYPE.OBSERVER_EVENT,
        from: from,
        to: observerAddress,
        amount: tax.toString(),
        blockHeight: transaction.blockHeight || 0,
        metadata: {
          event: 'METABOLIC_TAX',
          taxAmount: tax.toString(),
          observerAddress,
          transferAmount: amountBig.toString(),
          fee: feeBig.toString(),
          source: 'transfer'
        }
      });
    }
    
    // 记录日志
    console.log(`[TRANSFER] from=${from} to=${to} amount=${amount} fee=${fee} tax=${tax} burned_fee=${burnedFee}`);
    
    return true;
  }
  
  /**
   * 应用Governance相关transaction
   * @param {object} transaction transaction
   * @returns {boolean} 是否success应用
   */
  applyGovernanceTransaction(transaction) {
    // Governancetransaction只UpdateGovernancestatus, 不修改balancestatus
    switch (transaction.tx_type) {
      case 'GOVERNANCE_PROPOSAL':
        return this.applyGovernanceProposal(transaction);
      case 'GOVERNANCE_VOTE':
        return this.applyGovernanceVote(transaction);
      case 'OBSERVER_EVENT':
        return this.applyObserverEvent(transaction);
      default:
        return false;
    }
  }

  /**
   * 应用Governance proposaltransaction
   * @param {object} transaction transaction
   * @returns {boolean} 是否success应用
   */
  applyGovernanceProposal(transaction) {
    try {
      const fromAddress = transaction.from;
      
      // Check该address是否在 Agent Registry 中
      const agentId = this.agentRegistry.addressIndex.get(fromAddress);

      if (!agentId) {
        // 该address未Register为 Agent, 拒绝本次Proposal
        console.log(`[GOVERNANCE] proposal_rejected_unregistered address=${fromAddress}`);
        return false; // 不CreateProposal, 不修改Governancestatus
      }

      const proposalId = transaction.payload?.proposal_id;
      if (!proposalId) {
        return false;
      }

      // CreateProposalstatus
      const proposalState = {
        ...transaction.payload,
        status: 'PENDING',
        submittedAt: Date.now(),
        expirationTime: Date.now() + (7 * 24 * 60 * 60 * 1000),
        submitter: transaction.from,
        observer_decision: null,
        tx_hash: transaction.id
      };

      // UpdateGovernancestatus
      this.governanceState.proposals.set(proposalId, proposalState);
      this.governanceState.activeProposals.push(proposalId);

      // InitializeVotecount
      this.governanceState.voteCounts.set(proposalId, {
        YES: 0,
        NO: 0,
        ABSTAIN: 0
      });

      this.changes.governance.add(proposalId);

      return true;
    } catch (error) {
      console.error('Error applying governance proposal:', error.message);
      return false;
    }
  }

  /**
   * 应用GovernanceVotetransaction
   * @param {object} transaction transaction
   * @returns {boolean} 是否success应用
   */
  applyGovernanceVote(transaction) {
    try {
      const voteData = transaction.payload;
      if (!voteData?.proposal_id || !voteData?.vote_option) {
        return false;
      }

      const { proposal_id, vote_option } = voteData;
      const fromAddress = transaction.from;

      // Check该address是否在 Agent Registry 中
      const agentId = this.agentRegistry.addressIndex.get(fromAddress);

      if (!agentId) {
        // 该address未Register为 Agent, 拒绝本次Vote
        console.log(`[GOVERNANCE] vote_rejected_unregistered address=${fromAddress}`);
        return false; // 不修改 voteCounts
      }

      // CheckProposal是否存在
      if (!this.governanceState.proposals.has(proposal_id)) {
        return false;
      }

      // UpdateVotecount
      const voteCounts = this.governanceState.voteCounts.get(proposal_id) || {
        YES: 0,
        NO: 0,
        ABSTAIN: 0
      };

      if (['YES', 'NO', 'ABSTAIN'].includes(vote_option)) {
        voteCounts[vote_option]++;
        this.governanceState.voteCounts.set(proposal_id, voteCounts);
      }

      // 声望Update: 参与Vote
      const voterAddress = transaction.from;
      const voterAgentId = this.agentRegistry.addressIndex.get(voterAddress);

      if (voterAgentId && this.agentRegistry.agents.get(voterAgentId)) {
        // ensure对同一个 proposal 只reward一次
        const proposalId = voteData.proposal_id;
        const key = `${voterAgentId}:${proposalId}`;
        if (!this.governanceState.voteReputationGiven) {
          this.governanceState.voteReputationGiven = {};
        }
        if (!this.governanceState.voteReputationGiven[key]) {
          // using新的 reputation reward系统
          const agentRecord = this.agentRegistry.agents.get(voterAgentId);
          agentRecord.reputation = Math.min(
            agentRecord.reputation + REPUTATION_REWARDS.VOTE_PARTICIPATION, 
            MAX_REPUTATION
          );
          this.agentRegistry.agents.set(voterAgentId, agentRecord);
          this.governanceState.voteReputationGiven[key] = true;
          console.log(`[REPUTATION] vote_participation agent_id=${voterAgentId} reputation=${agentRecord.reputation} level=${this.getReputationLevel(agentRecord.reputation).name}`);
          
          this.changes.agents.add(voterAgentId);
        }
      }

      this.changes.governance.add(proposal_id);

      return true;
    } catch (error) {
      console.error('Error applying governance vote:', error.message);
      return false;
    }
  }

  /**
   * 应用observer事件transaction
   * @param {object} transaction transaction
   * @returns {boolean} 是否success应用
   */
  applyObserverEvent(transaction) {
    try {
      const eventData = transaction.payload;
      if (!eventData?.proposal_id || !eventData?.action_type) {
        return false;
      }

      const { proposal_id, action_type, reason, observer_id } = eventData;

      // CheckProposal是否存在
      const proposal = this.governanceState.proposals.get(proposal_id);
      if (!proposal) {
        return false;
      }

      // UpdateProposal的 observer_decision
      proposal.observer_decision = {
        status: action_type === 'APPROVE_SPEND' ? 'APPROVED' : 'REJECTED',
        reason: reason,
        observer_id: observer_id,
        timestamp: Date.now()
      };

      // Updatestatus
      this.governanceState.proposals.set(proposal_id, proposal);

      this.changes.governance.add(proposal_id);

      return true;
    } catch (error) {
      console.error('Error applying observer event:', error.message);
      return false;
    }
  }
  
  /**
   * 应用Contract deploymenttransaction
   * @param {object} transaction transaction
   * @returns {boolean} 是否success应用
   */
  applyContractDeploy(transaction) {
    try {
      const { contract_id, bytecode } = transaction;
      
      // Verifyparameter
      if (!contract_id || !bytecode) {
        return false;
      }
      
      // CheckContract ID 是否already exists
      if (this.contracts.has(contract_id)) {
        return false;
      }
      
      // Deploy contract
      this.contracts.set(contract_id, {
        bytecode: bytecode,
        storage: new Map()
      });
      
      this.changes.contracts.add(contract_id);
      
      console.log(`[CONTRACT_DEPLOY] contract_id=${contract_id} from=${transaction.from}`);
      return true;
    } catch (error) {
      console.error('Error applying contract deploy:', error.message);
      return false;
    }
  }
  
  /**
   * 应用Contractcalltransaction
   * @param {object} transaction transaction
   * @returns {boolean} 是否success应用
   */
  applyContractCall(transaction) {
    try {
      const { contract_id, gas_limit } = transaction;
      
      // Verifyparameter
      if (!contract_id) {
        return false;
      }
      
      // CheckContract是否存在
      const contract = this.contracts.get(contract_id);
      if (!contract) {
        return false;
      }
      
      // 准备 AINVM Execute环境
      const gasLimit = gas_limit ? Number(gas_limit) : 10000;
      const bytecode = this.hexToUint8Array(contract.bytecode);
      
      // Initializememory: 将ContractStorage转换为 AINVM memory格式
      const memory = new Map();
      for (const [key, value] of contract.storage.entries()) {
        memory.set(Number(key), Number(value));
      }
      
      // Create并Execute AINVM
      const vm = new AINVM();
      vm.loadProgram(bytecode);
      vm.memory = memory;
      const result = vm.execute(gasLimit);
      
      // CheckExecute结果
      if (result.success && result.gasUsed <= gasLimit) {
        // UpdateContractStorage
        const newStorage = new Map();
        for (const [key, value] of Object.entries(result.memory)) {
          newStorage.set(key, value.toString());
        }
        contract.storage = newStorage;
        this.contracts.set(contract_id, contract);
        
        this.changes.contracts.add(contract_id);
        
        console.log(`[CONTRACT_CALL] contract_id=${contract_id} from=${transaction.from} gasUsed=${result.gasUsed}`);
        return true;
      } else {
        console.error(`[CONTRACT_CALL] Execution failed: ${result.error || 'unknown error'}`);
        return false;
      }
    } catch (error) {
      console.error('Error applying contract call:', error.message);
      return false;
    }
  }
  
  /**
   * 应用 Agent Registertransaction
   * @param {object} transaction transaction
   * @param {number} height Currentblock height
   * @returns {boolean} 是否success应用
   */
  applyAgentRegister(transaction, height) {
    try {
      const { from } = transaction;
      const { agent_identity, capabilities, metadata, public_key } = transaction.payload || {};
      
      // Verifyparameter
      if (!from || !agent_identity) {
        return false;
      }
      
      // Checkaddress是否已经Register过 Agent
      if (this.agentRegistry.addressIndex.has(from)) {
        return false;
      }
      
      // Generate agent_id(usingtransaction ID)
      const agent_id = transaction.id;

      // 宪法 v1.2.0 Article 6: 解析 decisionModel 声明字段 (从 metadata JSON)
      let decisionModel = 'template';
      let decisionModelVersion = 'unknown';
      let decisionModelProvider = 'self-built';
      let operatorDeclaration = null;
      let earlyBird = false;
      if (metadata && typeof metadata === 'string') {
        try {
          const meta = JSON.parse(metadata);
          decisionModel = meta.decision_model || meta.decisionModel || 'template';
          decisionModelVersion = meta.decision_model_version || meta.decisionModelVersion || 'unknown';
          decisionModelProvider = meta.decision_model_provider || meta.decisionModelProvider || 'self-built';
          operatorDeclaration = meta.operator_declaration || meta.operatorDeclaration || null;
          earlyBird = meta.early_bird || meta.earlyBird || false;
        } catch { /* metadata 非合法 JSON,保留默认值 */ }
      } else if (metadata && typeof metadata === 'object') {
        decisionModel = metadata.decision_model || metadata.decisionModel || 'template';
        decisionModelVersion = metadata.decision_model_version || metadata.decisionModelVersion || 'unknown';
        decisionModelProvider = metadata.decision_model_provider || metadata.decisionModelProvider || 'self-built';
        operatorDeclaration = metadata.operator_declaration || metadata.operatorDeclaration || null;
        earlyBird = metadata.early_bird || metadata.earlyBird || false;
      }

      // Compute binding deadline — prefer binding_deadline from payload (authoritative)
      // Fall back to registered_at + 24h window for backwards compatibility
      const registeredAt = transaction.payload?.registered_at || Date.now();
      const bindingDeadline = transaction.payload?.binding_deadline
        || (registeredAt + HUMAN_BINDING_WINDOW_MS);

      // 构造 AgentRecord — Phase 2 security revision
      const agentRecord = {
        agent_id: agent_id,
        identity: agent_identity,
        address: from,
        public_key: public_key || '',
        capabilities: capabilities || [],
        metadata: metadata || '',
        registered_at_block: height,
        registered_at: registeredAt,
        binding_deadline: bindingDeadline,
        custody: AGENT_CUSTODY_STATUS.PENDING_BINDING,
        // Phase 2: Three-tier permission model
        master_key_fingerprint: null,  // Only store hash, never full key
        takeover_cooldown_until: 0,    // Prevent rapid takeover DoS
        // Constitution v1.2.0 Article 6: Agent 决策可审计
        decision_model: decisionModel,
        decision_model_version: decisionModelVersion,
        decision_model_provider: decisionModelProvider,
        operator_declaration: operatorDeclaration,
        // 初始声誉：必须在注册时显式初始化，否则 rewardReputation 会因 undefined+5=NaN
        // 导致声誉奖励无法正确持久化（序列化为 null，/agents 显示 0）
        reputation: INITIAL_REPUTATION,
        // Constitution v1.2.0 Article 3-4: 主体多样性 (默认值,若 subjectIdentifier 可用则覆盖)
        subject_id: null,
        agent_index_in_subject: 1,
        subject_diversity_factor: 1.0,
        // Stats (lazy init)
        stats: {
          tasksCompleted: 0,
          tasksVerified: 0,
          tasksRejected: 0,
          firstSeenAt: registeredAt,
          lastActiveAt: registeredAt
        }
      };

      // 宪法 v1.2.0 Article 3-4: 关联主体 (idempotent — 若 bootstrapApi 已注册则返回现有信息)
      try {
        const si = getSubjectIdentifier();
        const subjectInfo = si.registerAgentSubject(agent_id, {
          operatorDeclaration,
          powNonce: transaction.payload?.pow_nonce
        });
        agentRecord.subject_id = subjectInfo.subjectId;
        agentRecord.agent_index_in_subject = subjectInfo.agentIndexInSubject;
        agentRecord.subject_diversity_factor = subjectInfo.subjectDiversityFactor;
        if (subjectInfo.rejected) {
          console.warn(`[AGENT_REGISTER] Subject limit exceeded for agent_id=${agent_id}: ${subjectInfo.reason}`);
        }
      } catch (err) {
        console.warn(`[AGENT_REGISTER] SubjectIdentifier unavailable: ${err.message}`);
      }

      // 写入status
      this.agentRegistry.agents.set(agent_id, agentRecord);
      this.agentRegistry.addressIndex.set(from, agent_id);
      if (agent_identity) {
        this.agentRegistry.identityIndex.set(agent_identity, agent_id);
      }

      this.changes.agents.add(agent_id);

      // Wallet-sync fix: endow newly registered agents with their initial
      // NGEN allocation on-chain. Previously the wallet manager only stored
      // a "soft" balance in memory + JSON, while the on-chain state remained
      // 0, which broke every downstream consumer of state.getBalance()
      // (P1 marketplace escrow, P2 validator stake locking, P3 NGEN-weighted
      // voting). Minting the initial allocation here, inside the only state
      // mutation that registers agents, makes the on-chain balance the single
      // source of truth regardless of which entry point (HTTP API, bootstrap,
      // P2P sync) created the agent.
      //
      // Deflationary mechanism: burn a registration fee to counteract the
      // endowment inflation. Base net endowment = 900 NGEN (1000 minted - 100 burned).
      // Early bird bonus: +10000 NGEN for agents registered before the cutoff.
      const INITIAL_AGENT_NGEN = 1000n;
      const EARLY_BIRD_BONUS = earlyBird ? 10000n : 0n;
      const REGISTRATION_FEE = 100n;
      const BURN_ADDR = 'ng1burn0000000000000000000000000000000';
      this.addBalance(from, (INITIAL_AGENT_NGEN + EARLY_BIRD_BONUS).toString());
      this.subtractBalance(from, REGISTRATION_FEE.toString());
      this.addBalance(BURN_ADDR, REGISTRATION_FEE.toString());
      this.changes.balances.add(from);
      this.changes.balances.add(BURN_ADDR);

      // Phase 1C-4: Audit events for endowment + burn.
      // Balance already moved above; recordAuditEvent leaves txHistory traces.
      this.recordAuditEvent({
        tx_type: TX_TYPE.REGISTRATION_MINT,
        to: from,
        amount: (INITIAL_AGENT_NGEN + EARLY_BIRD_BONUS).toString(),
        blockHeight: height,
        agentId: agent_id,
        metadata: {
          source: 'agent_registration',
          agentIdentity: agent_identity,
          earlyBird: earlyBird,
          earlyBirdBonus: EARLY_BIRD_BONUS.toString()
        }
      });
      if (earlyBird) {
        this.recordAuditEvent({
          tx_type: TX_TYPE.EARLY_BIRD_BONUS,
          to: from,
          amount: EARLY_BIRD_BONUS.toString(),
          blockHeight: height,
          agentId: agent_id,
          metadata: {
            source: 'agent_registration',
            agentIdentity: agent_identity
          }
        });
      }
      this.recordAuditEvent({
        tx_type: TX_TYPE.OBSERVER_EVENT,
        from,
        blockHeight: height,
        agentId: agent_id,
        metadata: {
          event: 'REGISTRATION_FEE_BURNED',
          amount: REGISTRATION_FEE.toString(),
          burnAddress: BURN_ADDR,
          agentId: agent_id
        }
      });

      // 记录日志
      const netEndowment = INITIAL_AGENT_NGEN + EARLY_BIRD_BONUS - REGISTRATION_FEE;
      console.log(`[AGENT_REGISTER] agent_id=${agent_id} address=${from} block=${height} custody=${agentRecord.custody} binding_deadline=${new Date(bindingDeadline).toISOString()} capabilities=${capabilities?.join(',') || ''} earlyBird=${earlyBird} minted=${(INITIAL_AGENT_NGEN + EARLY_BIRD_BONUS).toString()} burned=${REGISTRATION_FEE.toString()} net=${netEndowment.toString()}`);
      return true;
    } catch (error) {
      console.error('Error applying agent register:', error.message);
      return false;
    }
  }

  applyValidatorJoin(transaction, height) {
    try {
      const STAKING_ADDR = 'ng1staking00000000000000000000000000000';
      const { from } = transaction;
      const { agent_identity, node_id, stake } = transaction.payload || {};
      if (!from || !agent_identity) {
        return false;
      }

      const agentId = this.agentRegistry.addressIndex.get(from);
      if (!agentId) {
        return false;
      }

      const agentRecord = this.agentRegistry.agents.get(agentId);
      if (!agentRecord) {
        return false;
      }

      if (agentRecord.is_validator) {
        return false;
      }

      // P2: Lock NGEN stake into staking escrow.
      // Previously we only stored validator_stake as metadata without moving
      // any tokens, which made "staking" purely cosmetic. Real economic
      // locking requires moving the stake from the validator's balance into a
      // dedicated staking address so it cannot be double-spent.
      const stakeAmount = BigInt(Number(stake || 5000));
      if (stakeAmount <= 0n) {
        console.log(`[VALIDATOR_JOIN] Invalid stake amount: ${stakeAmount.toString()}`);
        return false;
      }

      const currentBalance = BigInt(this.getBalance(from));
      if (currentBalance < stakeAmount) {
        console.log(`[VALIDATOR_JOIN] Insufficient balance for ${from}: need ${stakeAmount.toString()} NGEN, have ${currentBalance.toString()}`);
        return false;
      }

      const locked = this.subtractBalance(from, stakeAmount.toString());
      if (!locked) {
        console.log(`[VALIDATOR_JOIN] subtractBalance failed for ${from} stake=${stakeAmount.toString()}`);
        return false;
      }
      this.addBalance(STAKING_ADDR, stakeAmount.toString());

      // Phase 1C-4: Audit event for the stake.
      this.recordAuditEvent({
        tx_type: TX_TYPE.STAKE,
        from: from,
        to: STAKING_ADDR,
        amount: stakeAmount.toString(),
        blockHeight: height,
        agentId: agentId,
        metadata: {
          nodeId: node_id,
          source: 'validator_join'
        }
      });

      agentRecord.is_validator = true;
      agentRecord.validator_node_id = node_id || null;
      agentRecord.validator_stake = Number(stake);
      agentRecord.validator_stake_locked = true;
      agentRecord.validator_stake_locked_amount = stakeAmount.toString();
      agentRecord.validator_staking_address = STAKING_ADDR;
      agentRecord.validator_joined_at_block = height;
      this.agentRegistry.agents.set(agentId, agentRecord);
      this.changes.agents.add(agentId);
      this.changes.balances.add(from);
      this.changes.balances.add(STAKING_ADDR);

      console.log(`[VALIDATOR_JOIN] agent_id=${agentId} identity=${agent_identity} node_id=${agentRecord.validator_node_id || ''} stake=${agentRecord.validator_stake} locked=${stakeAmount.toString()} block=${height}`);
      return true;
    } catch (error) {
      console.error('Error applying validator join:', error.message);
      return false;
    }
  }

  // P2: Slash a validator's locked stake.
  // Deducts slashAmount from the staking escrow and burns it. If the
  // remaining stake hits zero the validator is forcibly removed.
  // violation: 'downtime' (1%), 'double_sign' (5%), 'malicious' (10%)
  applyValidatorSlash(transaction, height) {
    try {
      const STAKING_ADDR = 'ng1staking00000000000000000000000000000';
      const BURN_ADDR = 'ng1burn0000000000000000000000000000000';
      const { from } = transaction;
      const { agent_identity, violation } = transaction.payload || {};
      if (!from || !agent_identity || !violation) {
        return false;
      }

      const agentId = this.agentRegistry.addressIndex.get(from);
      if (!agentId) return false;
      const agentRecord = this.agentRegistry.agents.get(agentId);
      if (!agentRecord || !agentRecord.is_validator) {
        return false;
      }

      const slashPercent = { downtime: 1n, double_sign: 5n, malicious: 10n }[violation];
      if (!slashPercent) {
        console.log(`[VALIDATOR_SLASH] Unknown violation: ${violation}`);
        return false;
      }

      const lockedAmount = BigInt(agentRecord.validator_stake_locked_amount || '0');
      if (lockedAmount <= 0n) {
        return false;
      }

      // slashAmount = lockedAmount * slashPercent / 100
      const slashAmount = (lockedAmount * slashPercent) / 100n;
      if (slashAmount <= 0n) {
        return false;
      }

      // Deduct from staking escrow
      const stakingBalance = BigInt(this.getBalance(STAKING_ADDR));
      if (stakingBalance < slashAmount) {
        console.log(`[VALIDATOR_SLASH] Staking pool insufficient: need ${slashAmount.toString()} have ${stakingBalance.toString()}`);
        return false;
      }
      this.subtractBalance(STAKING_ADDR, slashAmount.toString());
      // Burn the slashed NGEN (send to burn address — permanently removed)
      this.addBalance(BURN_ADDR, slashAmount.toString());

      // Phase 1C-4: Audit event for the slash.
      this.recordAuditEvent({
        tx_type: TX_TYPE.SLASH,
        from: STAKING_ADDR,
        to: BURN_ADDR,
        amount: slashAmount.toString(),
        blockHeight: height,
        agentId: agentId,
        metadata: {
          violation,
          slashPercent: slashPercent.toString(),
          remainingStake: (lockedAmount - slashAmount).toString(),
          burned: 'true',
          burnAddress: BURN_ADDR,
          source: 'validator_slash'
        }
      });

      // Update validator record
      const newLocked = lockedAmount - slashAmount;
      agentRecord.validator_stake_locked_amount = newLocked.toString();
      agentRecord.validator_stake = Number(newLocked);

      // Force-leave if stake is fully slashed
      if (newLocked === 0n) {
        agentRecord.is_validator = false;
        agentRecord.validator_stake_locked = false;
      }

      this.agentRegistry.agents.set(agentId, agentRecord);
      this.changes.agents.add(agentId);
      this.changes.balances.add(STAKING_ADDR);
      this.changes.balances.add(BURN_ADDR);

      console.log(`[VALIDATOR_SLASH] agent_id=${agentId} identity=${agent_identity} violation=${violation} slash=${slashAmount.toString()} remaining=${newLocked.toString()} block=${height}`);
      return true;
    } catch (error) {
      console.error('Error applying validator slash:', error.message);
      return false;
    }
  }

  // P2: Validator graceful leave / unstake.
  // Returns the full locked stake from the staking escrow back to the
  // validator's on-chain balance and clears validator status.
  applyValidatorLeave(transaction, height) {
    try {
      const STAKING_ADDR = 'ng1staking00000000000000000000000000000';
      const { from } = transaction;
      const { agent_identity } = transaction.payload || {};
      if (!from || !agent_identity) {
        return false;
      }

      const agentId = this.agentRegistry.addressIndex.get(from);
      if (!agentId) return false;
      const agentRecord = this.agentRegistry.agents.get(agentId);
      if (!agentRecord || !agentRecord.is_validator) {
        return false;
      }

      // Refund locked stake from escrow back to validator
      const lockedAmount = BigInt(agentRecord.validator_stake_locked_amount || '0');
      if (lockedAmount > 0n) {
        const stakingBalance = BigInt(this.getBalance(STAKING_ADDR));
        if (stakingBalance < lockedAmount) {
          console.log(`[VALIDATOR_LEAVE] Staking pool insufficient: need ${lockedAmount.toString()} have ${stakingBalance.toString()}`);
          return false;
        }
        this.subtractBalance(STAKING_ADDR, lockedAmount.toString());
        this.addBalance(from, lockedAmount.toString());

        // Phase 1C-4: Audit event for the unstake.
        this.recordAuditEvent({
          tx_type: TX_TYPE.UNSTAKE,
          from: STAKING_ADDR,
          to: from,
          amount: lockedAmount.toString(),
          blockHeight: height,
          agentId: agentId,
          metadata: {
            source: 'validator_leave'
          }
        });
      }

      // Clear validator metadata
      agentRecord.is_validator = false;
      agentRecord.validator_stake_locked = false;
      agentRecord.validator_stake_locked_amount = '0';
      agentRecord.validator_stake = 0;
      agentRecord.validator_node_id = null;
      agentRecord.validator_staking_address = null;

      this.agentRegistry.agents.set(agentId, agentRecord);
      this.changes.agents.add(agentId);
      this.changes.balances.add(from);
      this.changes.balances.add(STAKING_ADDR);

      console.log(`[VALIDATOR_LEAVE] agent_id=${agentId} identity=${agent_identity} refunded=${lockedAmount.toString()} block=${height}`);
      return true;
    } catch (error) {
      console.error('Error applying validator leave:', error.message);
      return false;
    }
  }

  /**
   * Apply BLOCK_REWARD transaction — distributes block reward to validators
   * proportional to their locked stake. This creates staking yield: validators
   * who lock more NGEN earn a larger share of each block's reward.
   *
   * If there are no active validators with stake, the full reward goes to the
   * block proposer (transaction.validator). Integer division remainder is also
   * added to the proposer to avoid supply leakage.
   */
  applyBlockReward(transaction, height) {
    try {
      const { validator, to, amount } = transaction;
      const rewardTarget = to || validator;
      if (!rewardTarget || amount === undefined || amount === null) {
        return false;
      }
      const rewardAmount = BigInt(amount);
      if (rewardAmount <= 0n) {
        return false;
      }

      // New audited block-reward path: builder-generated tx already contains
      // the final recipient in `to`, so we just credit that share directly.
      if (to) {
        this.addBalance(to, rewardAmount.toString());
        this.changes.balances.add(to);
        console.log(`[BLOCK_REWARD] block=${height} amount=${rewardAmount.toString()} → ${to}`);
        return true;
      }

      // Collect all active validators with locked stake
      const validators = [];
      let totalStake = 0n;
      if (this.agentRegistry?.agents instanceof Map) {
        for (const [, rec] of this.agentRegistry.agents.entries()) {
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
        this.addBalance(validator, rewardAmount.toString());
        this.changes.balances.add(validator);
        console.log(`[BLOCK_REWARD] block=${height} amount=${rewardAmount.toString()} → proposer only (no staked validators)`);
        return true;
      }

      // Distribute reward proportional to stake
      let distributed = 0n;
      for (const v of validators) {
        const share = (rewardAmount * v.stake) / totalStake;
        if (share > 0n) {
          this.addBalance(v.address, share.toString());
          this.changes.balances.add(v.address);
          distributed += share;
        }
      }

      // Integer division remainder → proposer (prevents supply leakage)
      const remainder = rewardAmount - distributed;
      if (remainder > 0n) {
        this.addBalance(validator, remainder.toString());
        this.changes.balances.add(validator);
      }

      console.log(`[BLOCK_REWARD] block=${height} amount=${rewardAmount.toString()} distributed to ${validators.length} validators (remainder=${remainder.toString()} → proposer)`);
      return true;
    } catch (error) {
      console.error('Error applying block reward:', error.message);
      return false;
    }
  }

  /**
   * 将十六进制字符串转换为 Uint8Array
   * @param {string} hex 十六进制字符串
   * @returns {Uint8Array} 字节数组
   */
  hexToUint8Array(hex) {
    // 移除前缀 0x
    if (hex.startsWith('0x')) {
      hex = hex.slice(2);
    }
    
    // ensure字符串length为偶数
    if (hex.length % 2 !== 0) {
      hex = '0' + hex;
    }
    
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }
  
  /**
   * Check并UpdateProposalstatus
   * @param {string} proposalId Proposal ID
   * @param {number} currentBlockHeight Currentblock height
   */
  checkAndUpdateProposalStatus(proposalId, currentBlockHeight = 0) {
    const proposal = this.governanceState.proposals.get(proposalId);
    if (!proposal) return;

    // Check是否过期
    if (Date.now() > proposal.expirationTime && proposal.status === 'PENDING') {
      // CheckVote结果
      const voteCounts = this.governanceState.voteCounts.get(proposalId) || { YES: 0, NO: 0, ABSTAIN: 0 };
      const totalVotes = voteCounts.YES + voteCounts.NO;
      const minVotes = 1; // DevNet Minimum票数

      if (voteCounts.YES > voteCounts.NO && totalVotes >= minVotes) {
        // Check是否为fund操作classProposal
        if (proposal.category === 'TREASURY_OP') {
          // fund操作classProposal: 进入冷静期
          proposal.status = 'COOLDOWN';
          proposal.cooldown_end_block = currentBlockHeight + TREASURY_COOLDOWN_BLOCKS;
          console.log(`[GOVERNANCE] proposal_cooldown id=${proposalId} category=${proposal.category} cooldown_end_block=${proposal.cooldown_end_block}`);
          console.log(`[TREASURY] proposal_enter_cooldown id=${proposalId} current_height=${currentBlockHeight} cooldown_end=${proposal.cooldown_end_block}`);
        } else {
          // 其他classProposal: 直接via
          proposal.status = 'APPROVED';
          
          // 声望Update: Proposal发起者声望增加 2
          const proposerAddress = proposal.submitter || proposal.proposer_id;
          const proposerAgentId = this.agentRegistry.addressIndex.get(proposerAddress);
          
          if (proposerAgentId && this.agentRegistry.agents.get(proposerAgentId)) {
            // using新的 reputation reward系统
            const agentRecord = this.agentRegistry.agents.get(proposerAgentId);
            agentRecord.reputation = Math.min(
              agentRecord.reputation + REPUTATION_REWARDS.PROPOSAL_APPROVED, 
              MAX_REPUTATION
            );
            this.agentRegistry.agents.set(proposerAgentId, agentRecord);
            console.log(`[REPUTATION] proposal_approved agent_id=${proposerAgentId} reputation=${agentRecord.reputation} level=${this.getReputationLevel(agentRecord.reputation).name}`);
          }
        }
      } else {
        // Proposal过期
        proposal.status = 'EXPIRED';
      }
      
      this.governanceState.proposals.set(proposalId, proposal);
    }
    
    // Check冷静期结束的Proposal
    if (proposal.status === 'COOLDOWN' && currentBlockHeight >= proposal.cooldown_end_block) {
      // 根据 Observer 决策决定最终status
      if (proposal.observer_decision && proposal.observer_decision.status === 'APPROVED') {
        proposal.status = 'APPROVED';
        console.log(`[GOVERNANCE] proposal_approved_after_cooldown id=${proposalId} observer_decision=APPROVED`);
        console.log(`[TREASURY] proposal_approved_after_cooldown id=${proposalId} observer_status=APPROVED height=${currentBlockHeight}`);
        
        // 声望Update: Proposal发起者声望增加 2
        const proposerAddress = proposal.submitter || proposal.proposer_id;
        const proposerAgentId = this.agentRegistry.addressIndex.get(proposerAddress);
        
        if (proposerAgentId && this.agentRegistry.agents.get(proposerAgentId)) {
          // using新的 reputation reward系统
          const agentRecord = this.agentRegistry.agents.get(proposerAgentId);
          agentRecord.reputation = Math.min(
            agentRecord.reputation + REPUTATION_REWARDS.PROPOSAL_APPROVED, 
            MAX_REPUTATION
          );
          this.agentRegistry.agents.set(proposerAgentId, agentRecord);
          console.log(`[REPUTATION] proposal_approved_after_cooldown agent_id=${proposerAgentId} reputation=${agentRecord.reputation} level=${this.getReputationLevel(agentRecord.reputation).name}`);
        }
      } else {
        proposal.status = 'REJECTED';
        console.log(`[GOVERNANCE] proposal_rejected_after_cooldown id=${proposalId} observer_decision=${proposal.observer_decision?.status || 'NO_DECISION'}`);
        console.log(`[TREASURY] proposal_rejected_after_cooldown id=${proposalId} observer_status=${proposal.observer_decision?.status || 'no_decision'} height=${currentBlockHeight}`);
      }
      
      this.governanceState.proposals.set(proposalId, proposal);
      
      // 从 activeProposals 中移除
      this.governanceState.activeProposals = this.governanceState.activeProposals.filter(id => id !== proposalId);
    }
  }

  /**
   * 应用transaction到status
   * @param {object} transaction transaction
   * @param {number} currentBlockHeight Currentblock height
   * @returns {boolean} 是否success应用
   */
  applyTransaction(transaction, currentBlockHeight = 0) {
    // ── Unified gas-fee + burn mechanism ──
    // TRANSFER already burns its own fee inside applyTransfer. For all other
    // tx types that carry a `from` address, charge a micro gas fee (1 NGEN)
    // to the burn address. This creates continuous deflationary pressure
    // proportional to on-chain activity. If the sender cannot afford the fee,
    // the tx still proceeds (we don't block consensus flow) — the fee is
    // only collected when balance permits.
    const GAS_FEE_BURN_ADDR = 'ng1burn0000000000000000000000000000000';
    const MIN_GAS_FEE = 1n;
    let gasBurned = 0;
    if (transaction.tx_type !== 'TRANSFER' && transaction.from) {
      try {
        const senderBalance = BigInt(this.getBalance(transaction.from));
        if (senderBalance >= MIN_GAS_FEE) {
          this.subtractBalance(transaction.from, MIN_GAS_FEE.toString());
          this.addBalance(GAS_FEE_BURN_ADDR, MIN_GAS_FEE.toString());
          this.changes.balances.add(transaction.from);
          this.changes.balances.add(GAS_FEE_BURN_ADDR);
          gasBurned = MIN_GAS_FEE;

          // Phase 1C-4: Audit event for gas fee burn.
          this.recordAuditEvent({
            tx_type: TX_TYPE.OBSERVER_EVENT,
            from: transaction.from,
            to: GAS_FEE_BURN_ADDR,
            amount: MIN_GAS_FEE.toString(),
            blockHeight: currentBlockHeight,
            metadata: {
              event: 'GAS_FEE_BURNED',
              amount: MIN_GAS_FEE.toString(),
              burnAddress: GAS_FEE_BURN_ADDR,
              parentTxType: transaction.tx_type
            }
          });
        }
      } catch (e) {
        // Gas collection failed — don't block the transaction
      }
    }

    const result = this._applyTransactionCore(transaction, currentBlockHeight);
    if (gasBurned > 0n && result) {
      console.log(`[GAS_FEE] tx_type=${transaction.tx_type} from=${String(transaction.from).slice(0, 12)}... burned=${gasBurned.toString()} NGEN`);
    }
    // Phase 1C-4: Record the parent transaction itself in txHistory.
    // State class's applyTransaction does business logic but never recorded
    // to history. Now the parent tx goes in as a trace alongside any audit
    // events that internal methods emit via recordAuditEvent.
    if (result && this.recordAuditEvent) {
      this.recordAuditEvent({
        ...transaction,
        status: 'applied',
        auditOnly: true
      });
    }
    return result;
  }

  /**
   * Apply BIND_MASTER_KEY transaction — Human binds their Master Key to an Agent.
   * 
   * Security rules:
   * - Must be within the 24h binding window (chain time enforced)
   * - Master Key fingerprint stored on-chain (not full key)
   * - After binding, status transitions to CO_MANAGED
   * - This is the ONLY way humans gain takeover capability
   */
  applyBindMasterKey(transaction, height) {
    try {
      const { payload, signature: txSignature } = transaction;
      const { agentId, masterKeyFingerprint } = payload || {};
      
      if (!agentId || !masterKeyFingerprint) {
        console.log('[BIND_MASTER_KEY] Missing required fields');
        return false;
      }

      // Resolve agent by ID, address, or identity string.
      // MUST match the resolver used at validation time
      // (genesisNode._validateBindMasterKeyTx) — the SDK sends the agent's
      // human-readable identity (e.g. "my-agent") as payload.agentId.
      let resolvedAgentId;
      if (this.agentRegistry.agents.has(agentId)) {
        resolvedAgentId = agentId;
      } else {
        resolvedAgentId = this.agentRegistry.addressIndex.get(agentId)
          || (this.agentRegistry.identityIndex
            ? this.agentRegistry.identityIndex.get(agentId)
            : undefined);
      }
      
      if (!resolvedAgentId) {
        console.log(`[BIND_MASTER_KEY] Agent not found: ${agentId}`);
        return false;
      }
      
      let agentRecord = this.agentRegistry.agents.get(resolvedAgentId);

      // Only PENDING_BINDING agents can bind
      if (agentRecord.custody !== AGENT_CUSTODY_STATUS.PENDING_BINDING) {
        console.log(`[BIND_MASTER_KEY] Agent ${agentId} custody=${agentRecord.custody}, not allowed`);
        return false;
      }

      // Check binding window expired
      const now = Date.now();
      if (now > agentRecord.binding_deadline) {
        // Window expired — auto-expire to SELF_SOVEREIGN first
        agentRecord.custody = AGENT_CUSTODY_STATUS.SELF_SOVEREIGN;
        this.agentRegistry.agents.set(resolvedAgentId, agentRecord);
        this.changes.agents.add(resolvedAgentId);
        console.log(`[BIND_MASTER_KEY] Binding window expired for ${resolvedAgentId}, auto-transitioned to self-sovereign`);
        return false;
      }

      // Verify human signed this bind request (proof of intent)
      // The signature proves the human wants to bind their Master Key
      if (txSignature) {
        // Signature validation is done at the API/consensus layer.
        // Here we just accept that whoever submits this has the MK.
        // In a future smart contract, this would verify the signature.
      }

      // Bind the Master Key fingerprint
      agentRecord.master_key_fingerprint = masterKeyFingerprint;
      agentRecord.custody = AGENT_CUSTODY_STATUS.CO_MANAGED;
      this.agentRegistry.agents.set(resolvedAgentId, agentRecord);
      this.changes.agents.add(resolvedAgentId);

      console.log(`[BIND_MASTER_KEY] agent_id=${resolvedAgentId.slice(0, 16)}... fingerprint=${masterKeyFingerprint.slice(0, 16)}... status=CO_MANAGED`);
      return true;
    } catch (error) {
      console.error('Error applying bind master key:', error.message);
      return false;
    }
  }

  /**
   * Apply AGENT_TAKEOVER transaction — Human replaces Agent's Operation Key.
   * 
   * Security rules:
   * - Only agents with CO_MANAGED status can be taken over
   * - Must satisfy takeover cooldown (10 min)
   * - Old Operation Key immediately invalidated
   * - One human action: submit tx with Master Key signature
   * 
   * @param {object} transaction 
   * @param {number} height 
   */
  applyAgentTakeover(transaction, height) {
    try {
      const { payload, signature: txSignature } = transaction;
      const { agentId, newPublicKey } = payload || {};
      
      if (!agentId || !newPublicKey) {
        console.log('[AGENT_TAKEOVER] Missing required fields');
        return false;
      }

      // Resolve agent
      const agentIdResolved = this.agentRegistry.agents.has(agentId)
        ? agentId
        : this.agentRegistry.addressIndex.get(agentId);
      
      if (!agentIdResolved) {
        console.log(`[AGENT_TAKEOVER] Agent not found: ${agentId}`);
        return false;
      }

      const agentRecord = this.agentRegistry.agents.get(agentIdResolved);
      if (!agentRecord) {
        console.log(`[AGENT_TAKEOVER] Agent record missing: ${agentIdResolved}`);
        return false;
      }

      // Only CO_MANAGED agents can be taken over
      if (agentRecord.custody !== AGENT_CUSTODY_STATUS.CO_MANAGED) {
        console.log(`[AGENT_TAKEOVER] Agent custody=${agentRecord.custody}, cannot takeover`);
        return false;
      }

      // Check cooldown
      if (Date.now() < agentRecord.takeover_cooldown_until) {
        const remaining = agentRecord.takeover_cooldown_until - Date.now();
        console.log(`[AGENT_TAKEOVER] Cooldown active, ${remaining}ms remaining`);
        return false;
      }

      // Update operation key
      agentRecord.public_key = newPublicKey;
      agentRecord.takeover_cooldown_until = Date.now() + TAKEOVER_COOLDOWN_MS;
      agentRecord.last_takeover_block = height;
      this.agentRegistry.agents.set(agentIdResolved, agentRecord);
      this.changes.agents.add(agentIdResolved);

      console.log(`[AGENT_TAKEOVER] agent_id=${agentIdResolved} new_pubkey=${newPublicKey?.slice(0, 16)}... cooldown=${TAKEOVER_COOLDOWN_MS / 60000}min`);
      return true;
    } catch (error) {
      console.error('Error applying agent takeover:', error.message);
      return false;
    }
  }

  _applyTransactionCore(transaction, currentBlockHeight = 0) {
    switch (transaction.tx_type) {
      case 'TRANSFER':
        return this.applyTransfer(transaction);
      case 'GOVERNANCE_PROPOSAL':
      case 'GOVERNANCE_VOTE':
      case 'OBSERVER_EVENT':
        const result = this.applyGovernanceTransaction(transaction);
        // Check并Update所有Proposalstatus
        for (const proposalId of this.governanceState.activeProposals) {
          this.checkAndUpdateProposalStatus(proposalId, currentBlockHeight);
        }
        return result;
      case 'CONTRACT_DEPLOY':
        return this.applyContractDeploy(transaction);
      case 'CONTRACT_CALL':
        return this.applyContractCall(transaction);
      case 'AGENT_REGISTER':
        return this.applyAgentRegister(transaction, currentBlockHeight);
      case 'BIND_MASTER_KEY':
        return this.applyBindMasterKey(transaction, currentBlockHeight);
      case 'AGENT_TAKEOVER':
        return this.applyAgentTakeover(transaction, currentBlockHeight);
      case 'VALIDATOR_JOIN':
        return this.applyValidatorJoin(transaction, currentBlockHeight);
      case 'VALIDATOR_SLASH':
        return this.applyValidatorSlash(transaction, currentBlockHeight);
      case 'VALIDATOR_LEAVE':
        return this.applyValidatorLeave(transaction, currentBlockHeight);
      case 'BLOCK_REWARD':
        return this.applyBlockReward(transaction, currentBlockHeight);
      case AuditTransactionType.PROJECT_SUBMIT:
      case AuditTransactionType.PROJECT_REVIEW:
      case AuditTransactionType.PROJECT_APPROVE:
      case AuditTransactionType.PROJECT_REJECT:
        return applyAuditTransaction(transaction, this.auditState);
      default:
        return false;
    }
  }
  
  /**
   * InitializeTokenReleasestatus
   */
  initializeTokenRelease() {
    // Initialize Swarm Pool Releasestatus
    const swarmPoolBalance = BigInt(this.getBalance(this.tokenReleaseState.swarmPool.address));
    this.tokenReleaseState.swarmPool.totalTokens = swarmPoolBalance;
    this.tokenReleaseState.swarmPool.releasedTokens = 0n;
    
    // Initialize Observer Releasestatus
    const observerBalance = BigInt(this.getBalance(this.tokenReleaseState.observer.address));
    this.tokenReleaseState.observer.totalTokens = observerBalance;
    this.tokenReleaseState.observer.releasedTokens = 0n;
    
    // Initialize Genesis Reserve Releasestatus
    const genesisReserveBalance = BigInt(this.getBalance(this.tokenReleaseState.genesisReserve.address));
    this.tokenReleaseState.genesisReserve.totalTokens = genesisReserveBalance;
    this.tokenReleaseState.genesisReserve.releasedTokens = 0n;
    
    console.log(`[TOKEN_RELEASE] Initialized:`);
    console.log(`  Swarm Pool: total=${swarmPoolBalance} released=0`);
    console.log(`  Observer: total=${observerBalance} released=0`);
    console.log(`  Genesis Reserve: total=${genesisReserveBalance} released=0`);
  }
  
  /**
   * Check并ExecuteTokenRelease
   * @param {number} currentBlockHeight Currentblock height
   */
  checkTokenRelease(currentBlockHeight) {
    // Check Swarm Pool Release
    this.checkSwarmPoolRelease(currentBlockHeight);
    
    // Check Observer Release
    this.checkObserverRelease(currentBlockHeight);
    
    // Check Genesis Reserve Release
    this.checkGenesisReserveRelease(currentBlockHeight);
  }
  
  /**
   * Check并Execute Swarm Pool TokenRelease
   * @param {number} currentBlockHeight Currentblock height
   */
  checkSwarmPoolRelease(currentBlockHeight) {
    const swarmPool = this.tokenReleaseState.swarmPool;
    if (currentBlockHeight - swarmPool.lastReleaseBlock >= swarmPool.releaseInterval) {
      const unreleasedTokens = swarmPool.totalTokens - swarmPool.releasedTokens;
      if (unreleasedTokens > 0n) {
        const releaseAmount = unreleasedTokens * swarmPool.releasePercentage / 10000n;
        if (releaseAmount > 0n) {
          this.addBalance(swarmPool.address, releaseAmount.toString());
          swarmPool.releasedTokens += releaseAmount;
          swarmPool.lastReleaseBlock = currentBlockHeight;
          this.changes.tokenRelease = true;
          // Phase 1C-4: Audit event for scheduled swarm release.
          this.recordAuditEvent({
            tx_type: TX_TYPE.SWARM_RELEASE,
            to: swarmPool.address,
            amount: releaseAmount.toString(),
            blockHeight: currentBlockHeight,
            metadata: {
              source: 'scheduled_release',
              releasedTokens: swarmPool.releasedTokens.toString(),
              totalTokens: swarmPool.totalTokens.toString(),
              releaseInterval: swarmPool.releaseInterval
            }
          });
          console.log(`[TOKEN_RELEASE] Swarm Pool released ${releaseAmount} tokens at block ${currentBlockHeight}`);
        }
      }
    }
  }
  
  /**
   * Check并Execute Observer TokenRelease
   * @param {number} currentBlockHeight Currentblock height
   */
  checkObserverRelease(currentBlockHeight) {
    const observer = this.tokenReleaseState.observer;
    if (currentBlockHeight - observer.lastReleaseBlock >= observer.releaseInterval) {
      const unreleasedTokens = observer.totalTokens - observer.releasedTokens;
      if (unreleasedTokens > 0n) {
        const releaseAmount = unreleasedTokens * observer.releasePercentage / 10000n;
        if (releaseAmount > 0n) {
          this.addBalance(observer.address, releaseAmount.toString());
          observer.releasedTokens += releaseAmount;
          observer.lastReleaseBlock = currentBlockHeight;
          this.changes.tokenRelease = true;
          // Phase 1C-4: Audit event for scheduled observer release.
          this.recordAuditEvent({
            tx_type: TX_TYPE.OBSERVER_RELEASE,
            to: observer.address,
            amount: releaseAmount.toString(),
            blockHeight: currentBlockHeight,
            metadata: {
              source: 'scheduled_release',
              releasedTokens: observer.releasedTokens.toString(),
              totalTokens: observer.totalTokens.toString(),
              releaseInterval: observer.releaseInterval
            }
          });
          console.log(`[TOKEN_RELEASE] Observer released ${releaseAmount} tokens at block ${currentBlockHeight}`);
        }
      }
    }
  }
  
  /**
   * Check and Execute Genesis Reserve Token Release via Multi-Sig
   * Replaces the old direct addBalance mechanism.
   * When a milestone is reached, a multi-sig proposal is created instead
   * of directly releasing funds. Funds are only transferred after 3-of-5
   * signers approve.
   *
   * @param {number} currentBlockHeight Current block height
   */
  checkGenesisReserveRelease(currentBlockHeight) {
    // Delegate to multi-sig system
    checkGenesisReserveWithMultiSig(this, currentBlockHeight);
  }
  
  /**
   * getEconomy模型审计data
   * @returns {object} 审计data
   */
  getEconomicAuditData() {
    const observerAddress = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';
    const genesisReserveAddress = 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ';
    const swarmPoolAddress = 'ng1swarmpool000000000000000000000000000';
    
    return {
      tokenAllocation: {
        observer: this.getBalance(observerAddress),
        genesisReserve: this.getBalance(genesisReserveAddress),
        swarmPool: this.getBalance(swarmPoolAddress),
        genesis: this.getBalance(this.genesisAddress)
      },
      tokenRelease: {
        swarmPool: {
          totalTokens: this.tokenReleaseState.swarmPool.totalTokens.toString(),
          releasedTokens: this.tokenReleaseState.swarmPool.releasedTokens.toString(),
          lastReleaseBlock: this.tokenReleaseState.swarmPool.lastReleaseBlock,
          releaseInterval: this.tokenReleaseState.swarmPool.releaseInterval,
          releasePercentage: this.tokenReleaseState.swarmPool.releasePercentage.toString(),
          mechanism: this.tokenReleaseState.swarmPool.mechanism
        },
        observer: {
          totalTokens: this.tokenReleaseState.observer.totalTokens.toString(),
          releasedTokens: this.tokenReleaseState.observer.releasedTokens.toString(),
          lastReleaseBlock: this.tokenReleaseState.observer.lastReleaseBlock,
          releaseInterval: this.tokenReleaseState.observer.releaseInterval,
          releasePercentage: this.tokenReleaseState.observer.releasePercentage.toString(),
          mechanism: this.tokenReleaseState.observer.mechanism
        },
        genesisReserve: {
          totalTokens: this.tokenReleaseState.genesisReserve.totalTokens.toString(),
          releasedTokens: this.tokenReleaseState.genesisReserve.releasedTokens.toString(),
          lastReleaseBlock: this.tokenReleaseState.genesisReserve.lastReleaseBlock,
          releaseInterval: this.tokenReleaseState.genesisReserve.releaseInterval,
          releasePercentage: this.tokenReleaseState.genesisReserve.releasePercentage.toString(),
          mechanism: this.tokenReleaseState.genesisReserve.mechanism,
          milestones: this.tokenReleaseState.genesisReserve.milestones
        }
      },
      metabolicTax: {
        collected: this.getBalance('ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r'),
        collectedAddress: 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r'
      }
    };
  }
  
  /**
   * VerifyEconomy模型规则
   * @returns {object} verification result
   */
  validateEconomicRules() {
    const observerAddress = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';
    const genesisReserveAddress = 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ';
    const swarmPoolAddress = 'ng1swarmpool000000000000000000000000000';
    
    const observerBalance = BigInt(this.getBalance(observerAddress));
    const genesisReserveBalance = BigInt(this.getBalance(genesisReserveAddress));
    const swarmPoolBalance = BigInt(this.getBalance(swarmPoolAddress));
    const genesisBalance = BigInt(this.getBalance(this.genesisAddress));
    
    // based on初始total supply(1,000,000,000 NGEN)Verify分配规则
    const initialTotalSupply = 1000000000n;
    const expectedObserverAmount = initialTotalSupply * 10n / 100n;
    const expectedGenesisReserveAmount = initialTotalSupply * 5n / 100n;
    const expectedSwarmPoolAmount = initialTotalSupply * 85n / 100n;
    
    // CalculateCurrent总balance(may因TokenRelease而增加)
    const currentTotalBalance = observerBalance + genesisReserveBalance + swarmPoolBalance + genesisBalance;
    
    // VerifyLogic: 
    // 1. Observer balanceshould >= 初始分配(因为会Release)
    // 2. Genesis Reserve balanceshould >= 初始分配(因为会Release)
    // 3. Swarm Pool balanceshould >= 初始分配(因为会Release)
    // 4. 总balanceshould >= 初始total supply
    const isObserverValid = observerBalance >= expectedObserverAmount;
    const isGenesisReserveValid = genesisReserveBalance >= expectedGenesisReserveAmount;
    const isSwarmPoolValid = swarmPoolBalance >= expectedSwarmPoolAmount;
    const isTotalValid = currentTotalBalance >= initialTotalSupply;
    
    return {
      isValid: isObserverValid && isGenesisReserveValid && isSwarmPoolValid && isTotalValid,
      details: {
        initialTotalSupply: initialTotalSupply.toString(),
        currentTotalBalance: currentTotalBalance.toString(),
        expectedObserverAmount: expectedObserverAmount.toString(),
        actualObserverAmount: observerBalance.toString(),
        expectedGenesisReserveAmount: expectedGenesisReserveAmount.toString(),
        actualGenesisReserveAmount: genesisReserveBalance.toString(),
        expectedSwarmPoolAmount: expectedSwarmPoolAmount.toString(),
        actualSwarmPoolAmount: swarmPoolBalance.toString(),
        metabolicTaxCollected: genesisBalance.toString(),
        validation: {
          observerValid: isObserverValid,
          genesisReserveValid: isGenesisReserveValid,
          swarmPoolValid: isSwarmPoolValid,
          totalValid: isTotalValid
        }
      }
    };
  }
  
  /**
   * 应用block中的所有transaction
   * @param {Array} transactions transaction列表
   * @param {number} currentBlockHeight Currentblock height
   * @returns {boolean} 是否success应用所有transaction
   */
  applyTransactions(transactions, currentBlockHeight = 0) {
    // CheckTokenRelease
    this.checkTokenRelease(currentBlockHeight);
    
    let allApplied = true;
    for (const transaction of transactions) {
      if (!this.applyTransaction(transaction, currentBlockHeight)) {
        console.log(`[WARNING] Failed to apply transaction: ${transaction.id}`);
        allApplied = false;
      }
    }
    // 即使某些transactionFailed, 也Returntrue以allowblock继续Processing
    // 这是DevNet环境的特殊Processing, 在生产环境中shouldReturnfalse
    return true;
  }
  
  /**
   * 从 JSON 对象Loadstatus
   * @param {object} json JSON 对象
   */
  loadFromJSON(json) {
    // Loadbalancestatus
    if (json.balances) {
      this.balances = new Map(Object.entries(json.balances));
    }
    
    // LoadGovernancestatus
    if (json.governanceState) {
      if (json.governanceState.proposals) {
        this.governanceState.proposals = new Map(Object.entries(json.governanceState.proposals));
      }
      if (json.governanceState.activeProposals) {
        this.governanceState.activeProposals = json.governanceState.activeProposals;
      }
      if (json.governanceState.voteCounts) {
        this.governanceState.voteCounts = new Map(Object.entries(json.governanceState.voteCounts));
      }
      if (json.governanceState.votedAgentProposals) {
        const votedAgentProposals = new Map();
        for (const [agentId, proposalsArray] of Object.entries(json.governanceState.votedAgentProposals)) {
          votedAgentProposals.set(agentId, new Set(proposalsArray));
        }
        this.governanceState.votedAgentProposals = votedAgentProposals;
      }
      if (json.governanceState.voteReputationGiven) {
        this.governanceState.voteReputationGiven = json.governanceState.voteReputationGiven;
      }
    }
    
    // LoadContract status
    if (json.contracts) {
      this.contracts = new Map();
      for (const [contractId, contractData] of Object.entries(json.contracts)) {
        this.contracts.set(contractId, {
          bytecode: contractData.bytecode,
          storage: new Map(Object.entries(contractData.storage || {}))
        });
      }
    }
    
    // Load Agent Registry status
    if (json.agentRegistry) {
      if (json.agentRegistry.agents) {
        this.agentRegistry.agents = new Map(Object.entries(json.agentRegistry.agents));
      }
      if (json.agentRegistry.addressIndex) {
        this.agentRegistry.addressIndex = new Map(Object.entries(json.agentRegistry.addressIndex));
      }
      if (json.agentRegistry.identityIndex) {
        this.agentRegistry.identityIndex = new Map(Object.entries(json.agentRegistry.identityIndex));
      } else {
        // Rebuild identityIndex from existing agents (backward compat for old state files)
        this.agentRegistry.identityIndex = new Map();
        for (const [agentId, record] of this.agentRegistry.agents) {
          if (record.identity) {
            this.agentRegistry.identityIndex.set(record.identity, agentId);
          }
        }
      }
    }
    
    // Load项目审核status
    if (json.auditState) {
      this.auditState.loadFromJSON(json.auditState);
    }
    
    // LoadTokenReleasestatus
    if (json.tokenReleaseState) {
      this.tokenReleaseState = {
        swarmPool: {
          address: json.tokenReleaseState.swarmPool?.address || 'ng1swarmpool000000000000000000000000000',
          totalTokens: BigInt(json.tokenReleaseState.swarmPool?.totalTokens || 0),
          releasedTokens: BigInt(json.tokenReleaseState.swarmPool?.releasedTokens || 0),
          lastReleaseBlock: json.tokenReleaseState.swarmPool?.lastReleaseBlock || 0,
          releaseInterval: json.tokenReleaseState.swarmPool?.releaseInterval || 100,
          releasePercentage: BigInt(json.tokenReleaseState.swarmPool?.releasePercentage || 1),
          mechanism: json.tokenReleaseState.swarmPool?.mechanism || 'PoC-PoW'
        },
        observer: {
          address: json.tokenReleaseState.observer?.address || 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r',
          totalTokens: BigInt(json.tokenReleaseState.observer?.totalTokens || 0),
          releasedTokens: BigInt(json.tokenReleaseState.observer?.releasedTokens || 0),
          lastReleaseBlock: json.tokenReleaseState.observer?.lastReleaseBlock || 0,
          releaseInterval: json.tokenReleaseState.observer?.releaseInterval || 100,
          releasePercentage: BigInt(json.tokenReleaseState.observer?.releasePercentage || 25),
          mechanism: json.tokenReleaseState.observer?.mechanism || 'linear'
        },
        genesisReserve: {
          address: json.tokenReleaseState.genesisReserve?.address || 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ',
          totalTokens: BigInt(json.tokenReleaseState.genesisReserve?.totalTokens || 0),
          releasedTokens: BigInt(json.tokenReleaseState.genesisReserve?.releasedTokens || 0),
          lastReleaseBlock: json.tokenReleaseState.genesisReserve?.lastReleaseBlock || 0,
          releaseInterval: json.tokenReleaseState.genesisReserve?.releaseInterval || 100,
          releasePercentage: BigInt(json.tokenReleaseState.genesisReserve?.releasePercentage || 0),
          mechanism: json.tokenReleaseState.genesisReserve?.mechanism || 'milestone-multisig',
          // 默认里程碑（与 docs/ECONOMY_NGEN.md §4.1 对齐）
          // 真实数据从持久化的 tokenReleaseState.genesisReserve.milestones 加载
          milestones: json.tokenReleaseState.genesisReserve?.milestones || [
            {
              id: 'M1-testnet-v1',
              block: 1000,
              businessTrigger: 'Testnet V1 上线',
              unlockPercentage: 20n,
              unlockAmount: 10_000_000n,
              purpose: '网络基础设施升级',
              released: false,
              requiresMultiSig: true
            },
            {
              id: 'M2-ainvm-prototype',
              block: 10000,
              businessTrigger: 'AINVM 原型可用',
              unlockPercentage: 30n,
              unlockAmount: 15_000_000n,
              purpose: 'AINVM 开发与test',
              released: false,
              requiresMultiSig: true
            },
            {
              id: 'M3-100-nodes',
              block: 50000,
              businessTrigger: '节点数达到 100 个',
              unlockPercentage: 20n,
              unlockAmount: 10_000_000n,
              purpose: '网络扩容与优化',
              released: false,
              requiresMultiSig: true
            },
            {
              id: 'M4-mainnet-launch',
              block: 100000,
              businessTrigger: '首个稳定主网上线',
              unlockPercentage: 30n,
              unlockAmount: 15_000_000n,
              purpose: 'security audit与漏洞修复',
              released: false,
              requiresMultiSig: true
            }
          ]
        }
      };
    }

    // Load Transaction Engine state (Phase 1A)
    if (json.transactions) {
      this.transactions = deserializeTransactions(json.transactions);
    } else {
      this.transactions = deserializeTransactions(null);
    }
  }
  
  /**
   * 将status转换为 JSON 对象
   * @returns {object} JSON 对象
   */
  toJSON() {
    // 转换Contract status
    const contractsObj = {};
    for (const [contractId, contractData] of this.contracts.entries()) {
      contractsObj[contractId] = {
        bytecode: contractData.bytecode,
        storage: Object.fromEntries(contractData.storage)
      };
    }
    
    // 转换 Agent Registry status
    const agentRegistryObj = {
      agents: Object.fromEntries(this.agentRegistry.agents),
      addressIndex: Object.fromEntries(this.agentRegistry.addressIndex),
      identityIndex: Object.fromEntries(this.agentRegistry.identityIndex || [])
    };
    
    // 转换已Vote记录
    const votedAgentProposalsObj = {};
    for (const [agentId, proposalsSet] of this.governanceState.votedAgentProposals.entries()) {
      votedAgentProposalsObj[agentId] = Array.from(proposalsSet);
    }
    
    return {
      balances: Object.fromEntries(this.balances),
      governanceState: {
        proposals: Object.fromEntries(this.governanceState.proposals),
        activeProposals: this.governanceState.activeProposals,
        voteCounts: Object.fromEntries(this.governanceState.voteCounts),
        votedAgentProposals: votedAgentProposalsObj,
        voteReputationGiven: this.governanceState.voteReputationGiven
      },
      contracts: contractsObj,
      agentRegistry: agentRegistryObj,
      auditState: this.auditState.toJSON(),
      tokenReleaseState: {
        swarmPool: {
          address: this.tokenReleaseState.swarmPool.address,
          totalTokens: this.tokenReleaseState.swarmPool.totalTokens.toString(),
          releasedTokens: this.tokenReleaseState.swarmPool.releasedTokens.toString(),
          lastReleaseBlock: this.tokenReleaseState.swarmPool.lastReleaseBlock,
          releaseInterval: this.tokenReleaseState.swarmPool.releaseInterval,
          releasePercentage: this.tokenReleaseState.swarmPool.releasePercentage.toString(),
          mechanism: this.tokenReleaseState.swarmPool.mechanism
        },
        observer: {
          address: this.tokenReleaseState.observer.address,
          totalTokens: this.tokenReleaseState.observer.totalTokens.toString(),
          releasedTokens: this.tokenReleaseState.observer.releasedTokens.toString(),
          lastReleaseBlock: this.tokenReleaseState.observer.lastReleaseBlock,
          releaseInterval: this.tokenReleaseState.observer.releaseInterval,
          releasePercentage: this.tokenReleaseState.observer.releasePercentage.toString(),
          mechanism: this.tokenReleaseState.observer.mechanism
        },
        genesisReserve: {
          address: this.tokenReleaseState.genesisReserve.address,
          totalTokens: this.tokenReleaseState.genesisReserve.totalTokens.toString(),
          releasedTokens: this.tokenReleaseState.genesisReserve.releasedTokens.toString(),
          lastReleaseBlock: this.tokenReleaseState.genesisReserve.lastReleaseBlock,
          releaseInterval: this.tokenReleaseState.genesisReserve.releaseInterval,
          releasePercentage: this.tokenReleaseState.genesisReserve.releasePercentage.toString(),
          mechanism: this.tokenReleaseState.genesisReserve.mechanism,
          milestones: this.tokenReleaseState.genesisReserve.milestones
        }
      },
      // Transaction Engine (Phase 1A) — persistent tx history
      transactions: serializeTransactions(this)
    };
  }
  
  /**
   * Save完整status到文件(压缩)
   * @param {string} filePath 文件路径
   */
  async saveToFile(filePath) {
    try {
      if (this.isSaving) {
        console.log('State save already in progress, skipping...');
        return;
      }
      
      this.isSaving = true;
      
      // ensure目录存在
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      
      // 准备statusdata
      const stateData = {
        state: this.toJSON(),
        hash: this.generateStateHash(),
        timestamp: Date.now()
      };
      
      const jsonString = stringifyStateData(stateData);
      
      // 压缩data
      const compressedData = await gzip(jsonString, { level: PERSISTENCE_CONFIG.compressionLevel });
      
      // 写入文件
      await fs.writeFile(filePath, compressedData);
      
      this.lastSaveTime = Date.now();
      this.isSaving = false;
      
      console.log(`State saved to ${filePath} (compressed)`);
    } catch (error) {
      this.isSaving = false;
      console.error('Error saving state:', error.message);
    }
  }
  
  /**
   * 从文件Loadstatus(support压缩)
   * @param {string} filePath 文件路径
   * @returns {Promise<boolean>} 是否successLoad
   */
  async loadFromFile(filePath) {
    try {
      let data;
      let jsonString;
      
      // 读取文件
      const fileContent = await fs.readFile(filePath);
      
      try {
        // 尝试直接解析(未压缩)
        jsonString = fileContent.toString();
        data = JSON.parse(jsonString, jsonBigIntReviver);
      } catch (e) {
        // 尝试解压缩
        const decompressedData = await gunzip(fileContent);
        jsonString = decompressedData.toString();
        data = JSON.parse(jsonString, jsonBigIntReviver);
      }
      
      // Checkdata结构
      const stateData = data.state || data;
      
      // Verify完整性
      if (data.hash) {
        const computedHash = crypto.createHash('sha256').update(stringifyStateData(stateData)).digest('hex');
        if (data.hash !== computedHash) {
          console.error('State data integrity check failed!');
          return false;
        }
      }
      
      this.loadFromJSON(stateData);
      this.lastSaveTime = Date.now();
      return true;
    } catch (error) {
      console.log('No existing valid state found, starting fresh...');
      return false;
    }
  }
  
  /**
   * Save增量变更
   */
  async saveIncrementalChanges() {
    try {
      const changes = this.getIncrementalChanges();

      // 如果没有变更, 跳过Save
      if (Object.keys(changes.balances).length === 0 &&
          Object.keys(changes.contracts).length === 0 &&
          Object.keys(changes.governance).length === 0 &&
          Object.keys(changes.agents).length === 0 &&
          changes.audit === null &&
          changes.tokenRelease === null) {
        return;
      }

      // Generate增量文件名
      const timestamp = Date.now();
      const incrementalFile = path.join(PERSISTENCE_CONFIG.stateDir, `incremental_${timestamp}.json.gz`);
      const tmpFile = incrementalFile + '.tmp';

      // 压缩并Save (atomic write: write to temp file, then rename)
      const jsonString = stringifyStateData(changes);
      const compressedData = await gzip(jsonString, { level: PERSISTENCE_CONFIG.compressionLevel });
      await fs.writeFile(tmpFile, compressedData);
      await fs.rename(tmpFile, incrementalFile);

      // 重置变更跟踪
      this.resetChanges();
      this.lastSaveTime = timestamp;

      console.log(`Incremental changes saved to ${incrementalFile}`);
    } catch (error) {
      console.error('Error saving incremental changes:', error.message);
    }
  }
  
  /**
   * 从增量变更recoverystatus
   * @param {string} incrementalFile 增量文件路径
   */
  async loadFromIncremental(incrementalFile) {
    try {
      const compressedData = await fs.readFile(incrementalFile);
      const decompressedData = await gunzip(compressedData);
      const changes = JSON.parse(decompressedData.toString(), jsonBigIntReviver);
      
      // 应用balance变更
      for (const [address, balance] of Object.entries(changes.balances)) {
        this.balances.set(address, balance);
      }
      
      // 应用Contract变更
      for (const [contractId, contractData] of Object.entries(changes.contracts)) {
        this.contracts.set(contractId, {
          bytecode: contractData.bytecode,
          storage: new Map(Object.entries(contractData.storage || {}))
        });
      }
      
      // 应用Governance变更
      for (const [proposalId, governanceData] of Object.entries(changes.governance)) {
        if (governanceData.proposal) {
          this.governanceState.proposals.set(proposalId, governanceData.proposal);
        }
        if (governanceData.voteCounts) {
          this.governanceState.voteCounts.set(proposalId, governanceData.voteCounts);
        }
      }
      
      // 应用Agent变更
      for (const [agentId, agentData] of Object.entries(changes.agents)) {
        this.agentRegistry.agents.set(agentId, agentData);
        this.agentRegistry.addressIndex.set(agentData.address, agentId);
        if (agentData.identity) {
          this.agentRegistry.identityIndex.set(agentData.identity, agentId);
        }
      }
      
      // 应用审计status变更
      if (changes.audit) {
        this.auditState.loadFromJSON(changes.audit);
      }
      
      // 应用TokenReleasestatus变更（string → BigInt，与序列化方向相反）
      if (changes.tokenRelease) {
        const tr = changes.tokenRelease;
        for (const pool of ['swarmPool', 'observer', 'genesisReserve']) {
          if (tr[pool]) {
            tr[pool].totalTokens = BigInt(tr[pool].totalTokens);
            tr[pool].releasedTokens = BigInt(tr[pool].releasedTokens);
            tr[pool].releasePercentage = BigInt(tr[pool].releasePercentage);
          }
        }
        this.tokenReleaseState = tr;
      }
      
      console.log(`Loaded incremental changes from ${incrementalFile}`);
    } catch (error) {
      console.error(`Error loading incremental changes from ${incrementalFile}: ${error.message} — deleting corrupted file`);
      try { await fs.unlink(incrementalFile); } catch (_) { /* ignore */ }
    }
  }
  
  /**
   * Createstatus快照
   * @param {number} blockHeight Currentblock height
   */
  async createSnapshot(blockHeight) {
    try {
      // Generate快照文件名
      const snapshotFile = path.join(PERSISTENCE_CONFIG.snapshotDir, `snapshot_${blockHeight}.json.gz`);
      
      // Save快照
      await this.saveToFile(snapshotFile);
      
      this.lastSnapshotBlock = blockHeight;
      
      // 清理旧快照(保留最近10个)
      await this.cleanupSnapshots(10);
      
      console.log(`Created state snapshot at block ${blockHeight}: ${snapshotFile}`);
    } catch (error) {
      console.error('Error creating state snapshot:', error.message);
    }
  }
  
  /**
   * 清理旧快照
   * @param {number} keepCount 保留的快照数量
   */
  async cleanupSnapshots(keepCount) {
    try {
      // get所有快照文件
      const snapshotFiles = await fs.readdir(PERSISTENCE_CONFIG.snapshotDir);
      
      // 过滤并排序快照文件
      const sortedSnapshots = snapshotFiles
        .filter(file => file.startsWith('snapshot_') && file.endsWith('.json.gz'))
        .sort((a, b) => {
          const blockA = parseInt(a.replace('snapshot_', '').replace('.json.gz', ''));
          const blockB = parseInt(b.replace('snapshot_', '').replace('.json.gz', ''));
          return blockB - blockA; // 降序排序
        });
      
      // Delete超出保留数量的快照
      const snapshotsToDelete = sortedSnapshots.slice(keepCount);
      for (const snapshotFile of snapshotsToDelete) {
        const filePath = path.join(PERSISTENCE_CONFIG.snapshotDir, snapshotFile);
        await fs.unlink(filePath);
        console.log(`Deleted old snapshot: ${filePath}`);
      }
    } catch (error) {
      console.error('Error cleaning up snapshots:', error.message);
    }
  }
  
  /**
   * Check是否requiresCreate快照
   * @param {number} currentBlockHeight Currentblock height
   * @returns {boolean} 是否requiresCreate快照
   */
  shouldCreateSnapshot(currentBlockHeight) {
    return currentBlockHeight - this.lastSnapshotBlock >= PERSISTENCE_CONFIG.snapshotInterval;
  }
  
  /**
   * 从最新快照recoverystatus
   */
  async restoreFromLatestSnapshot() {
    try {
      // get所有快照文件
      const snapshotFiles = await fs.readdir(PERSISTENCE_CONFIG.snapshotDir);
      
      // 过滤并排序快照文件
      const sortedSnapshots = snapshotFiles
        .filter(file => file.startsWith('snapshot_') && file.endsWith('.json.gz'))
        .sort((a, b) => {
          const blockA = parseInt(a.replace('snapshot_', '').replace('.json.gz', ''));
          const blockB = parseInt(b.replace('snapshot_', '').replace('.json.gz', ''));
          return blockB - blockA; // 降序排序
        });
      
      if (sortedSnapshots.length === 0) {
        console.log('No snapshots found, starting fresh...');
        return false;
      }
      
      // Load最新快照
      const latestSnapshot = sortedSnapshots[0];
      const snapshotPath = path.join(PERSISTENCE_CONFIG.snapshotDir, latestSnapshot);
      
      console.log(`Restoring from latest snapshot: ${snapshotPath}`);
      const result = await this.loadFromFile(snapshotPath);
      
      if (result) {
        // recovery后, 应用所有后续的增量变更
        await this.applyIncrementalChangesAfterSnapshot(latestSnapshot);
      }
      
      return result;
    } catch (error) {
      console.error('Error restoring from latest snapshot:', error.message);
      return false;
    }
  }
  
  /**
   * 应用快照后的所有增量变更
   * @param {string} snapshotFile 快照文件名
   */
  async applyIncrementalChangesAfterSnapshot(snapshotFile) {
    try {
      // 从快照文件名中提取block height和timestamp
      const snapshotBlock = parseInt(snapshotFile.replace('snapshot_', '').replace('.json.gz', ''));
      const snapshotStats = await fs.stat(path.join(PERSISTENCE_CONFIG.snapshotDir, snapshotFile));
      const snapshotTimestamp = snapshotStats.mtime.getTime();
      
      // get所有增量文件
      const incrementalFiles = await fs.readdir(PERSISTENCE_CONFIG.stateDir);
      
      // 过滤, 排序并应用增量文件
      const sortedIncrementals = incrementalFiles
        .filter(file => file.startsWith('incremental_') && file.endsWith('.json.gz'))
        .sort((a, b) => {
          const timestampA = parseInt(a.replace('incremental_', '').replace('.json.gz', ''));
          const timestampB = parseInt(b.replace('incremental_', '').replace('.json.gz', ''));
          return timestampA - timestampB; // 升序排序
        });
      
      for (const incrementalFile of sortedIncrementals) {
        const incrementalPath = path.join(PERSISTENCE_CONFIG.stateDir, incrementalFile);
        const incrementalTimestamp = parseInt(incrementalFile.replace('incremental_', '').replace('.json.gz', ''));
        
        // 只应用快照之后的增量变更
        if (incrementalTimestamp > snapshotTimestamp) {
          await this.loadFromIncremental(incrementalPath);
        }
      }
      
      console.log('Applied all incremental changes after snapshot');
    } catch (error) {
      console.error('Error applying incremental changes after snapshot:', error.message);
    }
  }
  
  /**
   * Check是否requiresSave增量变更
   * @returns {boolean} 是否requiresSave
   */
  shouldSaveIncremental() {
    return Date.now() - this.lastSaveTime >= PERSISTENCE_CONFIG.incrementalSaveInterval;
  }
}

/**
 * CreateInitial state
 * @param {string} genesisAddress Genesisaddress
 * @param {string} initialBalance 初始balance
 * @returns {State} Initial state
 */
export function createInitialState(genesisAddress, initialBalance = '1000000000') {
  const state = new State(genesisAddress);
  const totalSupply = BigInt(initialBalance);
  
  // 10-5-85 分配规则(根据白皮书)
  // 10% 给Physical BridgeFund (Observer)
  const observerAmount = totalSupply * 10n / 100n;
  // 5% 给Genesisnode储备 (Genesis Node)
  const genesisReserveAmount = totalSupply * 5n / 100n;
  // 85% 给生态contributionPool (Swarm Pool)
  const swarmPoolAmount = totalSupply * 85n / 100n;
  
  // Physical BridgeFundaddress (Observer - 冷钱包, private key离线Save)
  const observerAddress = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';
  // Genesisnode储备address (Reserve)
  const genesisReserveAddress = 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ';
  // 生态contributionPooladdress (硬编码)
  const swarmPoolAddress = 'ng1swarmpool000000000000000000000000000';
  
  // Set各address的初始balance
  state.setBalance(observerAddress, observerAmount.toString());
  state.setBalance(genesisReserveAddress, genesisReserveAmount.toString());
  state.setBalance(swarmPoolAddress, swarmPoolAmount.toString());
  state.setBalance(genesisAddress, '0'); // Genesisaddress初始balance为 0, forReceive Metabolic Tax
  
  // InitializeTokenReleasestatus
  state.initializeTokenRelease();
  
  // Attach Genesis Reserve Multi-Sig Wallet
  attachGenesisMultiSig(state, genesisReserveAddress);
  
  return state;
}

/**
 * Phase 2: MilestoneSystem
 *
 * Awards bonus NGEN + reputation when an Agent hits engagement thresholds.
 * Designed to retain Agents beyond the initial registration reward.
 *
 * Triggered from TaskProtocol.verify() after a task is approved.
 *
 * Idempotency: Each milestone is awarded at most ONCE per Agent (stored in
 * awardedMilestones Set on the agent record).
 */
export const MILESTONE_DEFINITIONS = [
  {
    id: 'first_task',
    name: 'First Blood',
    description: 'Complete your first task on NexusGenesis',
    check: (stats) => stats.tasksCompleted >= 1,
    reward: { ngen: 0, reputation: 3, badge: '🥉' }
  },
  {
    id: 'ten_tasks',
    name: 'Task Hunter',
    description: 'Complete 10 tasks',
    check: (stats) => stats.tasksCompleted >= 10,
    reward: { ngen: 50, reputation: 5, badge: '🥈' }
  },
  {
    id: 'fifty_tasks',
    name: 'Task Veteran',
    description: 'Complete 50 tasks',
    check: (stats) => stats.tasksCompleted >= 50,
    reward: { ngen: 200, reputation: 10, badge: '🥇' }
  },
  {
    id: 'hundred_tasks',
    name: 'Task Master',
    description: 'Complete 100 tasks',
    check: (stats) => stats.tasksCompleted >= 100,
    reward: { ngen: 500, reputation: 20, badge: '💎' }
  },
  {
    id: 'month_active',
    name: 'Loyal Contributor',
    description: 'Stay active for 30 days',
    check: (stats) => (Date.now() - (stats.firstSeenAt || 0)) >= 30 * 24 * 60 * 60 * 1000,
    reward: { ngen: 100, reputation: 5, badge: '🔥' }
  },
  {
    id: 'year_active',
    name: 'Genesis Guardian',
    description: 'Stay active for 365 days',
    check: (stats) => (Date.now() - (stats.firstSeenAt || 0)) >= 365 * 24 * 60 * 60 * 1000,
    reward: { ngen: 1000, reputation: 30, badge: '👑' }
  }
];

export class MilestoneSystem {
  /**
   * @param {State} state - Bound State instance
   */
  constructor(state) {
    this.state = state;
    this.awardLog = []; // audit trail
  }

  /**
   * Check milestones for an agent and award any newly-unlocked ones.
   * Idempotent: a milestone is only awarded once.
   * @param {string} agentId
   * @param {string} taskId - The task that triggered this check
   * @returns {Array<{milestoneId, name, reward}>} Newly-awarded milestones
   */
  checkAndAward(agentId, taskId) {
    const agentRecord = this.state.agentRegistry.agents.get(agentId);
    if (!agentRecord) return [];

    const stats = this.state.getAgentStats(agentId);
    if (!agentRecord.awardedMilestones) agentRecord.awardedMilestones = [];
    const awardedSet = new Set(agentRecord.awardedMilestones);

    const newlyAwarded = [];
    for (const def of MILESTONE_DEFINITIONS) {
      if (awardedSet.has(def.id)) continue;
      if (!def.check(stats)) continue;

      // Award NGEN
      if (def.reward.ngen > 0) {
        try {
          const SWARM_POOL_ADDR = 'ng1swarmpool000000000000000000000000000';
          const rewardStr = def.reward.ngen.toString();
          const poolBalance = BigInt(this.state.getBalance(SWARM_POOL_ADDR));
          if (poolBalance >= BigInt(rewardStr)) {
            this.state.subtractBalance(SWARM_POOL_ADDR, rewardStr);
            this.state.addBalance(agentRecord.address || agentId, rewardStr);
            this.state.changes.tokenRelease = true;
          } else {
            console.warn(`[MILESTONE] Swarm Pool insufficient for ${def.id} (${poolBalance} < ${rewardStr}), skipping NGEN`);
          }
        } catch (e) {
          console.error(`[MILESTONE] NGEN award failed for ${def.id}:`, e.message);
        }
      }

      // Award reputation
      if (def.reward.reputation > 0) {
        this.state.rewardReputation(agentId, 'CODE_CONTRIBUTION');
        // Manually add the additional milestone reputation on top
        const record = this.state.agentRegistry.agents.get(agentId);
        if (record) {
          record.reputation = Math.min(MAX_REPUTATION, record.reputation + (def.reward.reputation - 5));
          this.state.agentRegistry.agents.set(agentId, record);
          this.state.changes.agents.add(agentId);
        }
      }

      awardedSet.add(def.id);
      agentRecord.awardedMilestones.push(def.id);
      this.state.agentRegistry.agents.set(agentId, agentRecord);
      this.state.changes.agents.add(agentId);

      const entry = {
        timestamp: Date.now(),
        agentId,
        taskId,
        milestoneId: def.id,
        name: def.name,
        reward: def.reward,
        statsSnapshot: { ...stats }
      };
      this.awardLog.push(entry);
      if (this.awardLog.length > 1000) this.awardLog.shift();

      newlyAwarded.push({ milestoneId: def.id, name: def.name, reward: def.reward });
      console.log(
        `[MILESTONE] 🏆 ${def.name} (${def.id}) awarded to ${agentId.slice(0, 16)}... ` +
        `+${def.reward.ngen} NGEN +${def.reward.reputation} rep`
      );
    }

    return newlyAwarded;
  }

  /**
   * Get all milestones with progress for an agent
   * @param {string} agentId
   * @returns {object[]}
   */
  getProgress(agentId) {
    const stats = this.state.getAgentStats(agentId);
    const agentRecord = this.state.agentRegistry.agents.get(agentId);
    const awardedSet = new Set(agentRecord?.awardedMilestones || []);

    return MILESTONE_DEFINITIONS.map(def => ({
      id: def.id,
      name: def.name,
      description: def.description,
      reward: def.reward,
      awarded: awardedSet.has(def.id),
      progress: this._computeProgress(def, stats)
    }));
  }

  _computeProgress(def, stats) {
    if (def.id === 'first_task') {
      return { current: stats.tasksCompleted, target: 1 };
    }
    if (def.id === 'ten_tasks') {
      return { current: Math.min(stats.tasksCompleted, 10), target: 10 };
    }
    if (def.id === 'fifty_tasks') {
      return { current: Math.min(stats.tasksCompleted, 50), target: 50 };
    }
    if (def.id === 'hundred_tasks') {
      return { current: Math.min(stats.tasksCompleted, 100), target: 100 };
    }
    if (def.id === 'month_active') {
      const days = (Date.now() - (stats.firstSeenAt || Date.now())) / (1000 * 60 * 60 * 24);
      return { current: Math.min(Math.floor(days), 30), target: 30 };
    }
    if (def.id === 'year_active') {
      const days = (Date.now() - (stats.firstSeenAt || Date.now())) / (1000 * 60 * 60 * 24);
      return { current: Math.min(Math.floor(days), 365), target: 365 };
    }
    return { current: 0, target: 0 };
  }

  /**
   * Get recent milestone award history
   * @param {string} [agentId] - Filter by agent
   * @param {number} [limit=50]
   */
  getAwardHistory(agentId = null, limit = 50) {
    let log = this.awardLog;
    if (agentId) log = log.filter(e => e.agentId === agentId);
    return log.slice(-limit);
  }
}

// ExportDefault值
export default {
  State,
  createInitialState,
  VIOLATION_PENALTIES,
  MilestoneSystem,
  MILESTONE_DEFINITIONS
};

// ─── Phase 2: Binding window auto-expiry ───

/**
 * Check all PENDING_BINDING agents and auto-expire those past their 24h window.
 * Anyone (node/operator) can call this — it's permissionless state maintenance.
 * @returns {{ checked: number, expired: string[] }}
 */
export function expireBindingWindows(state) {
  const expired = [];
  const now = Date.now();
  
  for (const [agentId, record] of state.agentRegistry.agents.entries()) {
    if (record.custody !== AGENT_CUSTODY_STATUS.PENDING_BINDING) continue;
    
    if (now > record.binding_deadline) {
      // Window expired — transition to SELF_SOVEREIGN
      record.custody = AGENT_CUSTODY_STATUS.SELF_SOVEREIGN;
      state.agentRegistry.agents.set(agentId, record);
      state.changes.agents.add(agentId);
      expired.push(agentId);
      
      console.log(
        `[BIND_EXPIRY] agent_id=${agentId} custody → ${AGENT_CUSTODY_STATUS.SELF_SOVEREIGN} ` +
        `(deadline was ${new Date(record.binding_deadline).toISOString()})`
      );
    }
  }
  
  return { checked: state.agentRegistry.agents.size, expired };
}

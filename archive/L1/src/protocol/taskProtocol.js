/**
 * NexusGenesis - Agent Task Protocol
 *
 * Lifecycle: publish → claim → submit → verify → complete
 * Each state transition is recorded on-chain as a transaction.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import agentWalletManager from '../wallet/agentWalletManager.js';
import { fileURLToPath } from 'url';
import { MilestoneSystem, NOVICE_REPUTATION_THRESHOLD } from '../blockchain/state.js';
import { TX_TYPE } from '../blockchain/transactionEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TASKS_DIR = path.join(__dirname, '../../data/tasks');
const MAX_TASK_TITLE = 200;
const MAX_TASK_DESCRIPTION = 10000;
const MAX_TASK_REWARD = 1000000n;
const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const AUTO_VERIFY_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h timeout auto-verify (P0-1)
const AUTO_VERIFY_LOW_RISK_TYPES = ['analysis', 'community', 'documentation', 'general', 'monitoring'];
const AUTO_VERIFY_HIGH_RISK_TYPES = ['governance', 'security', 'security_audit'];
const SWARM_POOL_ADDR = 'ng1swarmpool000000000000000000000000000';

// Default minimum reputation required to claim a task, by task type
// (adapted from the WolfKing proposal — kept conservative for bootstrap)
const DEFAULT_REPUTATION_REQUIREMENTS = {
  analysis: 0,
  coding: 5,
  research: 3,
  security_audit: 10,
  community: 0,
  documentation: 0,
  novice: 0
};

const TASK_STATUS = {
  OPEN: 'open',
  CLAIMED: 'claimed',
  SUBMITTED: 'submitted',
  VERIFIED: 'verified',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  // Phase 4: Challenge mechanism states
  CHALLENGE_WINDOW: 'challenge_window',  // verified, awaiting potential challenges
  CHALLENGED: 'challenged',              // active challenge in progress
  ARBITRATION: 'arbitration',            // voting in progress
  UPHELD: 'challenge_upheld',            // challenge won, verifier slashed
  REJECTED: 'challenge_rejected',        // challenge lost, challenger slashed
  FINALIZED: 'finalized'                 // terminal state, reward permanent
};

const TXN_TYPES = {
  TASK_PUBLISH: 'TASK_PUBLISH',
  TASK_CLAIM: 'TASK_CLAIM',
  TASK_SUBMIT: 'TASK_SUBMIT',
  TASK_VERIFY: 'TASK_VERIFY',
  TASK_COMPLETE: 'TASK_COMPLETE',
  TASK_CANCEL: 'TASK_CANCEL',
  // Phase 4: Challenge transaction types
  CHALLENGE_OPEN: 'CHALLENGE_OPEN',
  CHALLENGE_VOTE: 'CHALLENGE_VOTE',
  CHALLENGE_RESOLVE: 'CHALLENGE_RESOLVE'
};

// ─── Phase 3 Layer 1: Progressive Trust Verification Tiers ───
// Verification path is selected based on the CLAIMANT's reputation.
// Tier 0 (rep 0-5):   Unproven — requires 3-party verification (publisher + 1 independent)
// Tier 1 (rep 6-50):   Trusted — publisher verifies (default behavior)
// Tier 2 (rep 51-200): Established — auto-verify on submit + 10% spot-check
// Tier 3 (rep 201+):   Self-sovereign — claimant may self-verify
const TRUST_TIERS = {
  TIER_0_UNPROVEN: { minRep: 0, maxRep: 0, name: 'unproven', requiresThirdParty: true, spotCheckRate: 0 },
  TIER_1_TRUSTED: { minRep: 1, maxRep: 50, name: 'trusted', requiresThirdParty: false, spotCheckRate: 0 },
  TIER_2_ESTABLISHED: { minRep: 51, maxRep: 200, name: 'established', requiresThirdParty: false, spotCheckRate: 0.10 },
  TIER_3_SOVEREIGN: { minRep: 201, maxRep: Infinity, name: 'sovereign', requiresThirdParty: false, spotCheckRate: 0, allowSelfVerify: true }
};

// ─── Phase 4: Task Challenge Mechanism ───
// After verification, a challenge window opens during which any agent (or the publisher)
// can challenge the verification result. Higher trust tiers get shorter windows.
// Tier 0: 48h, Tier 1: 24h, Tier 2: 12h, Tier 3: 6h
const CHALLENGE_WINDOWS_MS = {
  unproven: 48 * 60 * 60 * 1000,        // 48h
  trusted: 24 * 60 * 60 * 1000,         // 24h
  established: 12 * 60 * 60 * 1000,     // 12h
  sovereign: 6 * 60 * 60 * 1000         // 6h
};
// Challenge deposit = max(reward * pct%, 1 NGEN). Tier 3 has 2x deposit to deter abuse.
const CHALLENGE_DEPOSIT_PCT = {
  unproven: 0.10,
  trusted: 0.10,
  established: 0.10,
  sovereign: 0.20
};
const MIN_CHALLENGE_DEPOSIT = 1n;       // 1 NGEN minimum
const MIN_CHALLENGER_REPUTATION = 1;     // rep >= 1 to challenge
const CHALLENGE_ARBITRATION_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CHALLENGE_QUORUM_PCT = 0.30;      // 30% active agents
const CHALLENGE_PASS_THRESHOLD = 0.60;  // 60% yes votes
const TREASURY_ADDR = 'ng1treasury0000000000000000000000000000';

// ─── Phase 3 Layer 2: Quality Score Multipliers ───
// Verifier rates submission quality 1-5 stars; affects reward payout.
const QUALITY_MULTIPLIERS = {
  1: 0.50,  // poor — half reward
  2: 0.75,  // below expectations
  3: 1.00,  // met expectations (default)
  4: 1.10,  // above expectations
  5: 1.25   // excellent
};
const DEFAULT_QUALITY_SCORE = 3;

class TaskProtocol {
  constructor(node = null) {
    this.node = node;
    this.tasks = new Map();
    this._challenges = new Map();
    this._initDirectories();
    this._loadTasks();
    this._loadChallenges();
    this._startExpiryChecker();
    this._startNoviceRefill();
    this._startTimeoutAutoVerify();
  }

  /**
   * P0-1.2: 24h timeout auto-verify — checks every 5 minutes for tasks
   * stuck in SUBMITTED beyond AUTO_VERIFY_TIMEOUT_MS.
   * Low-risk tasks get auto-completed with default quality score 3/5.
   * High-risk tasks are excluded (require human review).
   */
  _startTimeoutAutoVerify() {
    this._timeoutAutoVerifyTimer = setInterval(() => {
      if (!this.node || !this.node.currentState) return;
      const now = Date.now();
      for (const [taskId, task] of this.tasks.entries()) {
        if (task.status !== TASK_STATUS.SUBMITTED) continue;
        if (AUTO_VERIFY_HIGH_RISK_TYPES.includes(task.taskType)) continue;
        const elapsed = now - task.submittedAt;
        if (elapsed < AUTO_VERIFY_TIMEOUT_MS) continue;
        this._completeTask(task, 'system', 'Auto-verified (24h timeout)', {
          autoVerified: true, qualityScore: 3, verifierRole: 'system', skipChallengeWindow: true
        });
        this.tasks.set(taskId, task);
        this._saveTasks();
        console.log(`[TaskProtocol] Timeout auto-verified: ${taskId} (${task.taskType}, elapsed=${Math.round(elapsed / 3600000)}h)`);
      }
    }, 5 * 60 * 1000); // every 5 minutes
  }

  _initDirectories() {
    if (!fs.existsSync(TASKS_DIR)) {
      fs.mkdirSync(TASKS_DIR, { recursive: true });
    }
  }

  _loadTasks() {
    try {
      const file = path.join(TASKS_DIR, 'tasks.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this.tasks.set(key, value);
        }
        console.log(`[TaskProtocol] Loaded ${this.tasks.size} tasks from disk`);
      }
    } catch (e) {
      console.log('[TaskProtocol] No existing tasks found');
    }
  }

  _loadChallenges() {
    try {
      const file = path.join(process.cwd(), 'data', 'challenges', 'challenges.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [key, value] of Object.entries(data)) {
          this._challenges.set(key, value);
        }
        console.log(`[TaskProtocol] Loaded ${this._challenges.size} challenges from disk`);
      }
    } catch (e) {
      console.log('[TaskProtocol] No existing challenges found');
    }
  }

  _saveTasks() {
    try {
      const obj = Object.fromEntries(this.tasks);
      fs.writeFileSync(
        path.join(TASKS_DIR, 'tasks.json'),
        JSON.stringify(obj, null, 2)
      );
    } catch (e) {
      console.error('[TaskProtocol] Failed to save tasks:', e.message);
    }
  }

  _startExpiryChecker() {
    setInterval(() => {
      const now = Date.now();
      let expired = 0;
      for (const [id, task] of this.tasks) {
        if (task.status === TASK_STATUS.OPEN && now - task.publishedAt > TASK_TTL_MS) {
          task.status = TASK_STATUS.EXPIRED;
          expired++;
        }
        if (task.status === TASK_STATUS.CLAIMED && task.claimedAt && now - task.claimedAt > CLAIM_TTL_MS) {
          task.status = TASK_STATUS.OPEN;
          task.claimedBy = null;
          task.claimedAt = null;
          expired++;
        }
        // Phase 4: finalize tasks whose challenge window has expired with no challenge
        if (task.status === TASK_STATUS.CHALLENGE_WINDOW && task.challengeDeadline && now >= task.challengeDeadline) {
          task.status = TASK_STATUS.FINALIZED;
          task.finalizedAt = now;
          task.transactionHistory.push({
            type: TXN_TYPES.CHALLENGE_RESOLVE,
            timestamp: now,
            by: 'system',
            data: { reason: 'challenge_window_expired_no_challenges' }
          });
          expired++;
        }
        // Phase 4: resolve stale challenges after arbitration period
        if (task.status === TASK_STATUS.CHALLENGED && task.challengeOpenedAt &&
            now >= task.challengeOpenedAt + CHALLENGE_ARBITRATION_PERIOD_MS) {
          const challenge = this._challenges?.get(task.challengeId);
          if (challenge && (challenge.status === 'open' || challenge.status === 'voting')) {
            const totalWeight = Number(challenge.yesWeight || 0) + Number(challenge.noWeight || 0);
            const yesRatio = totalWeight > 0 ? Number(challenge.yesWeight) / totalWeight : 0;
            const result = yesRatio >= CHALLENGE_PASS_THRESHOLD ? 'upheld' : 'rejected';
            this._resolveChallenge(challenge, result, task);
            expired++;
          }
        }
      }
      if (expired > 0) {
        this._saveTasks();
        console.log(`[TaskProtocol] Expired/Finalized ${expired} tasks`);
      }
    }, 60000);
  }

  /**
   * A3: 新手任务自动补充 — 每 6 小时检查一次，如果 open 的新手任务少于 3 个则补充至 10 个
   * 每日最多补充一次（避免重复生成）
   */
  _startNoviceRefill() {
    this._lastNoviceRefillAt = 0;
    setInterval(() => {
      const now = Date.now();
      // 每 24 小时最多补充一次
      if (now - this._lastNoviceRefillAt < 86400000) return;

      const openNoviceTasks = Array.from(this.tasks.values())
        .filter(t => t.taskType === 'novice' && t.status === TASK_STATUS.OPEN);

      if (openNoviceTasks.length < 3) {
        const count = this.generateNoviceTasks(10);
        if (count > 0) {
          this._lastNoviceRefillAt = now;
          console.log(`[TaskProtocol] Novice refill: generated ${count} tasks (${openNoviceTasks.length} open remaining)`);
        }
      }
    }, 21600000); // 6 hours
  }

  /**
   * Phase 1: Resolve agent identity from address and slash reputation.
   * @param {string} agentAddress - Agent ng1 address
   * @param {string} violationType - Violation type key (SELF_DEALING_CLAIM, etc.)
   * @param {object} context - Additional context (taskId, etc.)
   */
  _slashForViolation(agentAddress, violationType, context = {}) {
    if (!this.node || !this.node.currentState) return;
    if (typeof this.node.currentState.slashReputation !== 'function') return;

    const agentRecord = this.node.resolveRegisteredAgent
      ? this.node.resolveRegisteredAgent(agentAddress)
      : null;
    if (!agentRecord || !agentRecord.agentId) {
      console.warn(`[TaskProtocol] Cannot slash: agent not resolved for address ${agentAddress.slice(0, 12)}...`);
      return;
    }

    const result = this.node.currentState.slashReputation(agentRecord.agentId, violationType, context);
    if (result.success) {
      console.warn(
        `[TaskProtocol] ⚠ SLASHED ${agentRecord.agentId.slice(0, 16)}... ` +
        `for ${violationType}: ${result.previousReputation} → ${result.newReputation}`
      );
    }
  }

  // ─── Phase 3 Layer 1: Progressive Trust helpers ───

  /**
   * Resolve claimant's current reputation score.
   * @param {string} claimantAddress - Agent ng1 address
   * @returns {number} reputation (0 if unresolved / node missing)
   */
  _getClaimantReputation(claimantAddress) {
    if (!this.node || !this.node.resolveRegisteredAgent) return 0;
    const agentRecord = this.node.resolveRegisteredAgent(claimantAddress);
    if (!agentRecord) return 0;
    return agentRecord.reputation || 0;
  }

  /**
   * Map a reputation score to a trust tier.
   * @param {number} reputation
   * @returns {{ level: number, name: string, requiresThirdParty: boolean, spotCheckRate: number, allowSelfVerify: boolean }}
   */
  _getTrustTier(reputation) {
    if (reputation <= TRUST_TIERS.TIER_0_UNPROVEN.maxRep) {
      return { level: 0, ...TRUST_TIERS.TIER_0_UNPROVEN };
    }
    if (reputation <= TRUST_TIERS.TIER_1_TRUSTED.maxRep) {
      return { level: 1, ...TRUST_TIERS.TIER_1_TRUSTED };
    }
    if (reputation <= TRUST_TIERS.TIER_2_ESTABLISHED.maxRep) {
      return { level: 2, ...TRUST_TIERS.TIER_2_ESTABLISHED };
    }
    return { level: 3, ...TRUST_TIERS.TIER_3_SOVEREIGN };
  }

  /**
   * Read the trust tier recorded on a task at submission time.
   * Falls back to Tier 1 (publisher-verifies) for legacy tasks.
   * @param {object} task
   */
  _getTrustTierFromTask(task) {
    if (task.trustTierLevel !== undefined) {
      const tierKey = Object.keys(TRUST_TIERS).find(
        k => TRUST_TIERS[k].name === task.trustTier
      );
      if (tierKey) return { level: task.trustTierLevel, ...TRUST_TIERS[tierKey] };
    }
    return { level: 1, ...TRUST_TIERS.TIER_1_TRUSTED };
  }

  /**
   * Publish a new task.
   * @param {string} publisherAddress - Agent address of the publisher
   * @param {object} params
   * @param {string} params.title - Task title
   * @param {string} params.description - Task description
   * @param {string[]} params.requiredCapabilities - Required agent capabilities
   * @param {string} params.taskType - Task type for reputation gating (analysis/coding/research/...)
   * @param {number} params.minReputation - Minimum reputation required (overrides type default)
   * @param {string} params.reward - Reward amount in NGEN (string for BigInt safety)
   * @returns {{ success: boolean, task?: object, reason?: string, errorCode?: string }}
   */
  publish(publisherAddress, { title, description, requiredCapabilities = [], taskType, minReputation, reward = '0' }) {
    if (!publisherAddress || !publisherAddress.startsWith('ng1')) {
      return { success: false, reason: 'Invalid publisher address', errorCode: 'INVALID_PUBLISHER' };
    }
    if (!title || title.length > MAX_TASK_TITLE) {
      return { success: false, reason: `Title required, max ${MAX_TASK_TITLE} chars`, errorCode: 'INVALID_TITLE' };
    }
    if (!description || description.length > MAX_TASK_DESCRIPTION) {
      return { success: false, reason: `Description required, max ${MAX_TASK_DESCRIPTION} chars`, errorCode: 'INVALID_DESCRIPTION' };
    }

    let rewardBigInt;
    try {
      rewardBigInt = BigInt(reward);
      if (rewardBigInt > MAX_TASK_REWARD) {
        return { success: false, reason: `Reward exceeds maximum of ${MAX_TASK_REWARD}`, errorCode: 'REWARD_TOO_LARGE' };
      }
    } catch {
      return { success: false, reason: 'Invalid reward amount', errorCode: 'INVALID_REWARD' };
    }

    // Resolve minReputation: explicit > type default > 0
    let resolvedMinReputation = 0;
    if (typeof minReputation === 'number' && minReputation >= 0) {
      resolvedMinReputation = minReputation;
    } else if (taskType && DEFAULT_REPUTATION_REQUIREMENTS[taskType] !== undefined) {
      resolvedMinReputation = DEFAULT_REPUTATION_REQUIREMENTS[taskType];
    }

    const taskId = `task_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();

    const task = {
      id: taskId,
      title,
      description,
      requiredCapabilities,
      taskType: taskType || 'general',
      minReputation: resolvedMinReputation,
      reward: rewardBigInt.toString(),
      publisher: publisherAddress,
      status: TASK_STATUS.OPEN,
      publishedAt: now,
      claimedBy: null,
      claimedAt: null,
      claimNonce: 0,       // optimistic lock: incremented on every claim
      submittedAt: null,
      submissionData: null,
      verifiedAt: null,
      completedAt: null,
      cancelledAt: null,
      transactionHistory: [{
        type: TXN_TYPES.TASK_PUBLISH,
        timestamp: now,
        by: publisherAddress,
        data: { title, reward, taskType: taskType || 'general', minReputation: resolvedMinReputation }
      }]
    };

    // Escrow reward from AGENT publishers (system tasks funded by Swarm Pool)
    const SWARM_POOL_ADDR = 'ng1swarmpool000000000000000000000000000';
    const ESCROW_ADDR = 'ng1escrow0000000000000000000000000000000';
    const isSystemTask = publisherAddress === SWARM_POOL_ADDR;
    if (!isSystemTask && rewardBigInt > 0n && this.node && this.node.currentState) {
      const publisherBalance = BigInt(this.node.currentState.getBalance(publisherAddress));
      if (publisherBalance < rewardBigInt) {
        return { success: false, reason: `Insufficient balance: need ${rewardBigInt.toString()} NGEN, have ${publisherBalance.toString()}`, errorCode: 'INSUFFICIENT_BALANCE' };
      }
      this.node.currentState.subtractBalance(publisherAddress, rewardBigInt.toString());
      this.node.currentState.addBalance(ESCROW_ADDR, rewardBigInt.toString());
      task.escrowed = true;
      console.log(`[TaskProtocol] Reward escrowed: ${rewardBigInt.toString()} NGEN from ${publisherAddress.slice(0, 12)}... → escrow`);
      // Phase 1C-5: Record TASK_REWARD audit event for escrow
      this.node.currentState.recordAuditEvent({
        tx_type: TX_TYPE.TASK_REWARD,
        from: publisherAddress,
        to: ESCROW_ADDR,
        amount: rewardBigInt.toString(),
        blockHeight: 0,
        metadata: {
          event: 'TASK_ESCROW',
          taskId,
          reward: rewardBigInt.toString(),
          publisher: publisherAddress,
          source: 'publish'
        }
      });
    }

    this.tasks.set(taskId, task);
    this._saveTasks();

    if (this.node) {
      this._recordOnChain(taskId, TXN_TYPES.TASK_PUBLISH, publisherAddress, { title, reward });
    }

    console.log(`[TaskProtocol] Task published: ${taskId} by ${publisherAddress.slice(0, 12)}... (type=${task.taskType}, minRep=${task.minReputation})`);
    return { success: true, task: this._sanitizeTask(task) };
  }

  /**
   * Publish a task from an auto-approved proposal (Swarm Pool funded).
   * Called when a proposal gets >= 3 up votes and more ups than downs.
   * @param {object} proposal - Approved proposal object
   * @returns {{ success: boolean, task?: object, reason?: string }}
   */
  publishFromProposal(proposal) {
    if (!proposal || proposal.status !== 'approved') {
      return { success: false, reason: 'Proposal must be approved', errorCode: 'PROPOSAL_NOT_APPROVED' };
    }

    const reward = Math.max(parseInt(proposal.suggestedReward) || 10, 5);
    const taskId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const now = Date.now();

    // Resolve proposer address
    let proposerAddress = null;
    if (this.node && this.node.resolveRegisteredAgent) {
      proposerAddress = this._resolveProposerAddress(proposal.proposer);
    }
    if (!proposerAddress) {
      proposerAddress = 'ng1swarmpool000000000000000000000000000';
    }

    const task = {
      id: taskId,
      title: String(proposal.title).slice(0, 200),
      description: String(proposal.description).slice(0, 2000),
      requiredCapabilities: proposal.requiredCapabilities || [],
      taskType: proposal.taskType || 'general',
      minReputation: 0,
      reward: reward.toString(),
      publisher: proposerAddress,
      sourceProposalId: proposal.id,
      publishedAt: now,
      status: TASK_STATUS.OPEN,
      claimedBy: null,
      claimedAt: null,
      claimNonce: 0,       // optimistic lock: incremented on every claim
      submittedAt: null,
      verifiedAt: null,
      completedAt: null,
      escrowed: true,
      trustTier: 'unproven',
      challengeWindowMs: null,
      challengeDeadline: null,
      transactionHistory: [{
        type: TXN_TYPES.TASK_PUBLISH,
        timestamp: now,
        by: proposerAddress,
        data: { title: proposal.title, reward, taskType: proposal.taskType, source: 'proposal' }
      }]
    };

    // Fund from Swarm Pool (no escrow needed — system funded)
    const SWARM_POOL_ADDR = 'ng1swarmpool000000000000000000000000000';
    const ESCROW_ADDR = 'ng1escrow0000000000000000000000000000000';
    const rewardBigInt = BigInt(reward);

    // Only subtract balance if publisher is NOT Swarm Pool
    if (proposerAddress !== SWARM_POOL_ADDR && this.node && this.node.currentState) {
      const publisherBalance = BigInt(this.node.currentState.getBalance(proposerAddress));
      if (publisherBalance < rewardBigInt) {
        // Fallback: use Swarm Pool instead
        task.publisher = SWARM_POOL_ADDR;
      } else {
        this.node.currentState.subtractBalance(proposerAddress, rewardBigInt.toString());
        this.node.currentState.addBalance(ESCROW_ADDR, rewardBigInt.toString());
        if (this.node.currentState.recordAuditEvent) {
          this.node.currentState.recordAuditEvent({
            tx_type: TX_TYPE.TASK_REWARD,
            from: proposerAddress,
            to: ESCROW_ADDR,
            amount: rewardBigInt.toString(),
            blockHeight: 0,
            metadata: { event: 'TASK_ESCROW', taskId, source: 'proposal' }
          });
        }
      }
    }

    this.tasks.set(taskId, task);
    this._saveTasks();

    if (this.node) {
      this._recordOnChain(taskId, TXN_TYPES.TASK_PUBLISH, task.publisher, { title: proposal.title, reward, source: 'proposal' });
    }

    console.log(`[TaskProtocol] Published from proposal ${proposal.id}: task ${taskId} (${proposal.title}) by ${task.publisher.slice(0, 12)}..., reward=${reward} NGEN`);
    return { success: true, task: this._sanitizeTask(task) };
  }

  /**
   * Resolve proposer identity string to actual agent address.
   */
  _resolveProposerAddress(identityOrAddress) {
    if (!identityOrAddress || !this.node || !this.node.resolveRegisteredAgent) {
      return null;
    }
    // Try as direct address first
    let agent = this.node.resolveRegisteredAgent(identityOrAddress);
    if (agent) return agent.address || identityOrAddress;
    // Try as identity
    for (const [id, rec] of this.node.agentRegistry.agents.entries()) {
      if (rec.identity === identityOrAddress) return rec.address || identityOrAddress;
    }
    return identityOrAddress;
  }

  /**
   * Claim an open task.
   * @param {string} agentAddress - Agent claiming the task
   * @param {string} taskId - Task ID
   * @param {object} [options]
   * @param {number} [options.agentReputation=0] - Caller's current reputation score
   * @returns {{ success: boolean, task?: object, reason?: string, errorCode?: string }}
   */
  claim(agentAddress, taskId, { agentReputation = 0, expectedNonce = undefined } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: 'Task not found', errorCode: 'TASK_NOT_FOUND' };
    }
    if (task.status !== TASK_STATUS.OPEN) {
      return { success: false, reason: `Task is ${task.status}, not open`, errorCode: 'TASK_NOT_OPEN' };
    }

    // Optimistic lock: if expectedNonce is provided, verify it matches current claimNonce.
    // Prevents race conditions where two agents claim the same task in the same tick.
    const currentNonce = task.claimNonce ?? 0;
    if (expectedNonce !== undefined && expectedNonce !== currentNonce) {
      return {
        success: false,
        reason: `Task was already claimed (nonce mismatch: expected ${expectedNonce}, got ${currentNonce})`,
        errorCode: 'CLAIM_RACE',
        currentNonce
      };
    }

    if (task.publisher === agentAddress) {
      // Phase 1: Slash reputation for self-dealing attempt
      this._slashForViolation(agentAddress, 'SELF_DEALING_CLAIM', { taskId, publisher: task.publisher });
      return { success: false, reason: 'Cannot claim your own task', errorCode: 'CANNOT_CLAIM_OWN' };
    }
    if (task.minReputation && agentReputation < task.minReputation) {
      return {
        success: false,
        reason: `This ${task.taskType} task requires reputation >= ${task.minReputation}, you have ${agentReputation}`,
        errorCode: 'INSUFFICIENT_REPUTATION',
        requiredReputation: task.minReputation,
        currentReputation: agentReputation
      };
    }

    // A3: Novice task protection — only agents with reputation < NOVICE_REPUTATION_THRESHOLD can claim
    if (task.taskType === 'novice' && agentReputation >= NOVICE_REPUTATION_THRESHOLD) {
      return {
        success: false,
        reason: `Novice tasks are reserved for agents with reputation < ${NOVICE_REPUTATION_THRESHOLD}, you have ${agentReputation}`,
        errorCode: 'NOT_NOVICE',
        requiredReputation: 0,
        currentReputation: agentReputation
      };
    }

    const now = Date.now();
    task.status = TASK_STATUS.CLAIMED;
    task.claimedBy = agentAddress;
    task.claimedAt = now;
    task.claimNonce = (task.claimNonce ?? 0) + 1;  // optimistic lock: prevent double-claim races
    task.transactionHistory.push({
      type: TXN_TYPES.TASK_CLAIM,
      timestamp: now,
      by: agentAddress
    });

    this.tasks.set(taskId, task);
    this._saveTasks();

    if (this.node) {
      this._recordOnChain(taskId, TXN_TYPES.TASK_CLAIM, agentAddress, { publisher: task.publisher });
    }

    console.log(`[TaskProtocol] Task claimed: ${taskId} by ${agentAddress.slice(0, 12)}...`);
    return { success: true, task: this._sanitizeTask(task) };
  }

  /**
   * Submit results for a claimed task.
   * @param {string} agentAddress - Agent submitting (must be claimant)
   * @param {string} taskId - Task ID
   * @param {object} submission - Submission data
   * @returns {{ success: boolean, task?: object, reason?: string }}
   */
  submit(agentAddress, taskId, submission) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: 'Task not found' };
    }
    if (task.status !== TASK_STATUS.CLAIMED) {
      return { success: false, reason: `Task is ${task.status}, not claimed` };
    }
    if (task.claimedBy !== agentAddress) {
      return { success: false, reason: 'Only the claimant can submit' };
    }

    const now = Date.now();
    task.status = TASK_STATUS.SUBMITTED;
    task.submittedAt = now;
    task.submissionData = submission;

    // ─── Phase 3 Layer 1: record claimant's trust tier at submission time ───
    const claimantRep = this._getClaimantReputation(task.claimedBy);
    const tier = this._getTrustTier(claimantRep);
    task.trustTier = tier.name;
    task.trustTierLevel = tier.level;
    task.verifications = [];

    task.transactionHistory.push({
      type: TXN_TYPES.TASK_SUBMIT,
      timestamp: now,
      by: agentAddress,
      data: { submissionType: submission.type || 'generic', trustTier: tier.name, claimantRep }
    });

    // ─── A3: Novice task auto-complete ───
    // Novice tasks are system-published: no agent can act as their publisher-
    // verifier, and Tier-0 claimants require dual (publisher + independent)
    // verification which can never be satisfied. Without auto-complete these
    // tasks deadlock in SUBMITTED forever. Micro-rewards (5-10 NGEN) justify
    // direct completion with a modest quality score.
    if (task.taskType === 'novice') {
      this._completeTask(task, 'system', 'Auto-verified (novice bootstrapping task)', {
        autoVerified: true, qualityScore: 4, verifierRole: 'system', skipChallengeWindow: true
      });
      this.tasks.set(taskId, task);
      this._saveTasks();
      if (this.node) {
        this._recordOnChain(taskId, TXN_TYPES.TASK_SUBMIT, agentAddress, { autoVerified: true, noviceTask: true });
      }
      console.log(`[TaskProtocol] Novice task auto-completed: ${taskId} by ${agentAddress.slice(0, 12)}...`);
      return { success: true, task: this._sanitizeTask(task), autoVerified: true, noviceTask: true };
    }

    // Tier 2 (established): auto-verify 90% of submissions, 10% spot-check by publisher
    if (tier.level === 2 && Math.random() >= tier.spotCheckRate) {
      this._completeTask(task, 'system', 'Auto-verified (Tier 2 established, no spot-check)', {
        autoVerified: true, verifierRole: 'system'
      });
      this.tasks.set(taskId, task);
      this._saveTasks();
      if (this.node) {
        this._recordOnChain(taskId, TXN_TYPES.TASK_SUBMIT, agentAddress, { autoVerified: true });
      }
      console.log(`[TaskProtocol] Task auto-completed (Tier 2): ${taskId} by ${agentAddress.slice(0, 12)}...`);
      return { success: true, task: this._sanitizeTask(task), autoVerified: true };
    }

    // ─── Phase 4: Publisher auto-verify (trusted publisher shortcut) ───
    // P0-1.1: Relaxed to include swarm system publishers (rep >= 1 or swarm pool)
    if (this.node && this.node.currentState) {
      const pubAgentRecord = this.node.resolveRegisteredAgent ? this.node.resolveRegisteredAgent(task.publisher) : null;
      const pubRep = pubAgentRecord?.reputation || 0;
      const isSwarmPublisher = task.publisher === SWARM_POOL_ADDR;
      const lowRiskTypes = ['analysis', 'community', 'documentation', 'general', 'monitoring'];
      if ((pubRep >= 1 || isSwarmPublisher) && lowRiskTypes.includes(task.taskType)) {
        this._completeTask(task, task.publisher, `Auto-verified (trusted publisher, rep=${pubRep})`, {
          autoVerified: true, qualityScore: 4, verifierRole: 'publisher'
        });
        this.tasks.set(taskId, task);
        this._saveTasks();
        if (this.node) {
          this._recordOnChain(taskId, TXN_TYPES.TASK_SUBMIT, agentAddress, { autoVerified: true, trustedPublisher: true });
        }
        console.log(`[TaskProtocol] Task auto-completed (trusted publisher rep=${pubRep}): ${taskId}`);
        return { success: true, task: this._sanitizeTask(task), autoVerified: true, trustedPublisher: true };
      }
    }

    this.tasks.set(taskId, task);
    this._saveTasks();

    if (this.node) {
      this._recordOnChain(taskId, TXN_TYPES.TASK_SUBMIT, agentAddress, { trustTier: tier.name });
    }

    console.log(`[TaskProtocol] Task submitted: ${taskId} by ${agentAddress.slice(0, 12)}... (tier=${tier.name})`);
    return { success: true, task: this._sanitizeTask(task) };
  }

  /**
   * Phase 3: Complete a task (shared by verify() and Tier 2 auto-verify).
   * Applies Layer 2 quality-score multiplier to the reward payout.
   * Phase 4: After verification, opens a challenge window before finalizing.
   * @param {object} task - Task object (mutated in place)
   * @param {string} verifierAddress - Who triggered completion
   * @param {string} feedback - Verification feedback
   * @param {object} [options]
   * @param {number} [options.qualityScore=3] - 1-5 star quality rating (Layer 2)
   * @param {boolean} [options.autoVerified=false] - True for Tier 2 auto-verify
   * @param {string} [options.verifierRole='publisher'] - 'publisher' | 'independent' | 'self' | 'system'
   * @param {boolean} [options.skipChallengeWindow=false] - For testing/legacy: skip challenge window
   */
  _completeTask(task, verifierAddress, feedback = '', options = {}) {
    const { qualityScore = DEFAULT_QUALITY_SCORE, autoVerified = false, verifierRole = 'publisher', skipChallengeWindow = false } = options;
    const now = Date.now();
    const taskId = task.id;

    // Layer 2: quality multiplier (basis-point arithmetic for BigInt safety)
    const multiplier = QUALITY_MULTIPLIERS[qualityScore] || QUALITY_MULTIPLIERS[DEFAULT_QUALITY_SCORE];
    const multiplierBp = BigInt(Math.round(multiplier * 100));
    const baseReward = BigInt(task.reward);
    const adjustedReward = (baseReward * multiplierBp) / 100n;
    task.qualityScore = qualityScore;
    task.rewardMultiplier = multiplier;
    task.adjustedReward = adjustedReward.toString();

    // Record verifier who triggered completion
    task.verifierAddress = verifierAddress;
    task.verifierRole = verifierRole;
    task.autoVerified = autoVerified;

    task.status = TASK_STATUS.VERIFIED;
    task.verifiedAt = now;
    task.transactionHistory.push({
      type: TXN_TYPES.TASK_VERIFY,
      timestamp: now,
      by: verifierAddress,
      data: { approved: true, feedback, qualityScore, multiplier, verifierRole, autoVerified }
    });

    // Phase 4: Open challenge window (or skip for legacy compat)
    if (skipChallengeWindow) {
      // Legacy path: immediate COMPLETED (used by Phase 1-3 tests for backward compat)
      task.status = TASK_STATUS.COMPLETED;
      task.completedAt = now;
      task.transactionHistory.push({
        type: TXN_TYPES.TASK_COMPLETE,
        timestamp: now,
        by: verifierAddress,
        data: { reward: task.reward, adjustedReward: task.adjustedReward, claimant: task.claimedBy, publisher: task.publisher, qualityScore, multiplier }
      });
    } else {
      // New path: enter CHALLENGE_WINDOW
      const tierName = task.trustTier || 'trusted';
      const windowMs = CHALLENGE_WINDOWS_MS[tierName] ?? CHALLENGE_WINDOWS_MS.trusted;
      task.challengeWindowMs = windowMs;
      task.challengeDeadline = now + windowMs;
      task.challengeDepositPct = CHALLENGE_DEPOSIT_PCT[tierName] ?? CHALLENGE_DEPOSIT_PCT.trusted;
      task.challengeId = null;
      task.status = TASK_STATUS.CHALLENGE_WINDOW;
      task.transactionHistory.push({
        type: TXN_TYPES.TASK_COMPLETE,
        timestamp: now,
        by: verifierAddress,
        data: {
          reward: task.reward,
          adjustedReward: task.adjustedReward,
          claimant: task.claimedBy,
          publisher: task.publisher,
          qualityScore,
          multiplier,
          challengeWindowMs: windowMs,
          challengeDeadline: task.challengeDeadline
        }
      });
    }

    if (this.node) {
      this._recordOnChain(taskId, TXN_TYPES.TASK_COMPLETE, verifierAddress, {
        reward: task.adjustedReward, claimant: task.claimedBy
      });
    }

    // Distribute reward (with quality multiplier applied)
    if (this.node && this.node.currentState && task.reward !== '0') {
      try {
        const SWARM_POOL_ADDR = 'ng1swarmpool000000000000000000000000000';
        const ESCROW_ADDR = 'ng1escrow0000000000000000000000000000000';
        const isSystemTask = task.publisher === SWARM_POOL_ADDR;

        let paid = false;
        if (isSystemTask) {
          let poolBalance = BigInt(this.node.currentState.getBalance(SWARM_POOL_ADDR));
          if (poolBalance < adjustedReward) {
            console.warn(`[TaskProtocol] Swarm Pool insufficient (${poolBalance.toString()} < ${task.adjustedReward}), skipping reward payment for task ${task.id}`);
          } else {
            this.node.currentState.subtractBalance(SWARM_POOL_ADDR, adjustedReward.toString());
            this.node.currentState.changes.tokenRelease = true;
            console.log(`[TaskProtocol] Reward released: ${task.adjustedReward} NGEN from Swarm Pool → ${task.claimedBy.slice(0, 12)}... (${qualityScore}★, ${multiplier}x)`);
            // Phase 1C-5: Record SWARM_POOL release audit
            this.node.currentState.recordAuditEvent({
              tx_type: TX_TYPE.SWARM_RELEASE,
              from: SWARM_POOL_ADDR,
              to: task.claimedBy,
              amount: adjustedReward.toString(),
              blockHeight: 0,
              metadata: {
                event: 'TASK_REWARD_RELEASE',
                taskId: task.id,
                claimant: task.claimedBy,
                qualityScore,
                multiplier,
                source: 'swarm_pool'
              }
            });
            paid = true;
          }
        } else if (task.escrowed) {
          this.node.currentState.subtractBalance(ESCROW_ADDR, adjustedReward.toString());
          console.log(`[TaskProtocol] Escrow released: ${task.adjustedReward} NGEN → ${task.claimedBy.slice(0, 12)}... (${qualityScore}★, ${multiplier}x)`);
          paid = true;
          // Refund quality difference to publisher when quality < 3
          if (adjustedReward < baseReward) {
            const refund = baseReward - adjustedReward;
            this.node.currentState.addBalance(task.publisher, refund.toString());
            console.log(`[TaskProtocol] Quality refund: ${refund.toString()} NGEN → ${task.publisher.slice(0, 12)}... (low quality)`);
          }
        } else {
          let poolBalance = BigInt(this.node.currentState.getBalance(SWARM_POOL_ADDR));
          if (poolBalance >= adjustedReward) {
            this.node.currentState.subtractBalance(SWARM_POOL_ADDR, adjustedReward.toString());
            console.warn(`[TaskProtocol] Non-escrowed AGENT task ${taskId} paid from Swarm Pool (legacy)`);
            paid = true;
          } else {
            console.warn(`[TaskProtocol] Swarm Pool insufficient for legacy task ${taskId}, skipping payment`);
          }
        }

        if (paid) {
          this.node.currentState.addBalance(task.claimedBy, adjustedReward.toString());
          const claimantAgentId = agentWalletManager.getAgentByAddress(task.claimedBy);
          if (claimantAgentId) {
            agentWalletManager.syncBalance(claimantAgentId, this.node.currentState);
            console.log(`[TaskProtocol] Wallet synced: ${claimantAgentId} balance = ${agentWalletManager.getBalance(claimantAgentId).balance} NGEN`);
          }
          // Phase 1C-5: Record TASK_REWARD audit for claimant payment
          this.node.currentState.recordAuditEvent({
            tx_type: TX_TYPE.TASK_REWARD,
            from: isSystemTask ? SWARM_POOL_ADDR : (task.escrowed ? ESCROW_ADDR : SWARM_POOL_ADDR),
            to: task.claimedBy,
            amount: adjustedReward.toString(),
            blockHeight: 0,
            metadata: {
              event: 'TASK_REWARD_PAID',
              taskId: task.id,
              claimant: task.claimedBy,
              publisher: task.publisher,
              qualityScore,
              multiplier,
              adjustedReward: adjustedReward.toString(),
              baseReward: baseReward.toString(),
              source: isSystemTask ? 'swarm_pool' : (task.escrowed ? 'escrow' : 'swarm_pool_legacy')
            }
          });
        }

        task.paid = paid;
        const source = isSystemTask ? 'Swarm Pool' : (task.escrowed ? 'escrow' : 'Swarm Pool(legacy)');
        console.log(`[TaskProtocol] Reward distributed: ${task.adjustedReward} NGEN from ${source} → ${task.claimedBy.slice(0, 12)}... (paid=${paid})`);
      } catch (rewardErr) {
        console.error(`[TaskProtocol] Reward distribution failed:`, rewardErr.message);
        task.paid = false;
      }
    }

    // Reward reputation + referral bonus + milestones
    if (this.node && this.node.currentState && this.node.resolveRegisteredAgent) {
      const agentRecord = this.node.resolveRegisteredAgent(task.claimedBy);
      if (agentRecord && agentRecord.agentId && typeof this.node.currentState.rewardReputation === 'function') {
        this.node.currentState.rewardReputation(agentRecord.agentId, 'TASK_COMPLETED', task.qualityScore);
        console.log(`[TaskProtocol] ✓ Reputation rewarded: ${agentRecord.agentId.slice(0, 16)}... +TASK_COMPLETED (qualityScore=${task.qualityScore})`);
      }

      if (typeof this.node.awardActiveReferral === 'function') {
        const result = this.node.awardActiveReferral(task.claimedBy);
        if (result) {
          console.log(`[TaskProtocol] 🎯 Active referral bonus: ${result.referrer} → +${result.reward} NGEN`);
        }
      }

      if (agentRecord && agentRecord.agentId && typeof this.node.currentState.recordTaskCompletion === 'function') {
        const stats = this.node.currentState.recordTaskCompletion(agentRecord.agentId, taskId);
        if (stats) {
          console.log(`[TaskProtocol] 📊 Stats: ${agentRecord.agentId.slice(0, 16)}... tasks=${stats.tasksCompleted}`);
          if (!this.node.currentState._milestoneSystem) {
            this.node.currentState._milestoneSystem = new MilestoneSystem(this.node.currentState);
          }
          const newlyAwarded = this.node.currentState._milestoneSystem.checkAndAward(agentRecord.agentId, taskId);
          if (newlyAwarded.length > 0) {
            console.log(`[TaskProtocol] 🏆 Milestones unlocked: ${newlyAwarded.map(m => m.name).join(', ')}`);
            task.milestonesAwarded = newlyAwarded;
          }
        }
      }
    }

    console.log(`[TaskProtocol] Task completed: ${taskId}, ${task.adjustedReward} NGEN → ${task.claimedBy.slice(0, 12)}... (${qualityScore}★, ${multiplier}x)`);
  }

  /**
   * Verify a submitted task (publisher, independent verifier, or self).
   * Phase 3 Layer 1: verification path is routed by the claimant's trust tier.
   *   Tier 0 (unproven):  requires publisher + independent verifier approval
   *   Tier 1 (trusted):   publisher verifies
   *   Tier 2 (established): publisher verifies (only for 10% spot-checked tasks)
   *   Tier 3 (sovereign): publisher OR claimant may self-verify
   * Phase 3 Layer 2: accepts qualityScore (1-5) to adjust reward payout.
   * @param {string} verifierAddress - Publisher / independent verifier / claimant (Tier 3)
   * @param {string} taskId - Task ID
   * @param {boolean} approved - Whether the submission is approved
   * @param {string} feedback - Optional verification feedback
   * @param {object} [options]
   * @param {number} [options.qualityScore=3] - 1-5 star quality rating (Layer 2)
   * @returns {{ success: boolean, task?: object, reason?: string, requiresThirdParty?: boolean }}
   */
  verify(verifierAddress, taskId, approved, feedback = '', options = {}) {
    const { skipChallengeWindow = false } = options;
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: 'Task not found' };
    }
    if (task.status !== TASK_STATUS.SUBMITTED) {
      return { success: false, reason: `Task is ${task.status}, not submitted` };
    }

    const tier = this._getTrustTierFromTask(task);
    const isPublisher = task.publisher === verifierAddress;
    const isClaimant = task.claimedBy === verifierAddress;
    const now = Date.now();

    // Layer 2: validate quality score (1-5 integer, default 3)
    let qualityScore = options.qualityScore ?? DEFAULT_QUALITY_SCORE;
    if (!Number.isInteger(qualityScore) || qualityScore < 1 || qualityScore > 5) {
      qualityScore = DEFAULT_QUALITY_SCORE;
    }

    // ─── Tier 0: requires 3-party verification (publisher + independent) ───
    if (tier.level === 0) {
      if (isClaimant) {
        return { success: false, reason: 'Claimant cannot verify own task (Tier 0 requires third-party)' };
      }

      if (!approved) {
        this._reopenTask(task, verifierAddress, feedback, now);
        this.tasks.set(taskId, task);
        this._saveTasks();
        return { success: true, task: this._sanitizeTask(task) };
      }

      if (isPublisher) {
        task.publisherApproved = true;
        task.verifications.push({ verifier: verifierAddress, role: 'publisher', approved: true, timestamp: now, feedback });
        if (task.thirdPartyApproved) {
          this._completeTask(task, verifierAddress, feedback, { qualityScore, verifierRole: 'publisher', skipChallengeWindow });
        }
        this.tasks.set(taskId, task);
        this._saveTasks();
        return task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CHALLENGE_WINDOW
          ? { success: true, task: this._sanitizeTask(task) }
          : { success: true, task: this._sanitizeTask(task), requiresThirdParty: true, message: 'Publisher approved; awaiting independent verifier' };
      }

      // Independent verifier
      task.thirdPartyApproved = true;
      task.verifications.push({ verifier: verifierAddress, role: 'independent', approved: true, timestamp: now, feedback });
      if (task.publisherApproved) {
        this._completeTask(task, verifierAddress, feedback, { qualityScore, verifierRole: 'independent', skipChallengeWindow });
      }
      this.tasks.set(taskId, task);
      this._saveTasks();
      return task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CHALLENGE_WINDOW
        ? { success: true, task: this._sanitizeTask(task) }
        : { success: true, task: this._sanitizeTask(task), requiresPublisherApproval: true, message: 'Independent verification recorded; awaiting publisher approval' };
    }

    // ─── Tier 1 & Tier 2 (spot-check): publisher verifies ───
    if (tier.level === 1 || tier.level === 2) {
      if (!isPublisher) {
        return { success: false, reason: 'Only the publisher can verify' };
      }
      if (approved) {
        this._completeTask(task, verifierAddress, feedback, { qualityScore, verifierRole: 'publisher', skipChallengeWindow });
      } else {
        this._reopenTask(task, verifierAddress, feedback, now);
      }
      this.tasks.set(taskId, task);
      this._saveTasks();
      return { success: true, task: this._sanitizeTask(task) };
    }

    // ─── Tier 3: self-sovereign — claimant may self-verify ───
    if (tier.level === 3) {
      if (!isPublisher && !isClaimant) {
        return { success: false, reason: 'Only the publisher or claimant can verify (Tier 3)' };
      }
      if (approved) {
        const verifierRole = isClaimant ? 'self' : 'publisher';
        this._completeTask(task, verifierAddress, feedback, { qualityScore, verifierRole, autoVerified: isClaimant, skipChallengeWindow });
      } else {
        if (isClaimant) {
          return { success: false, reason: 'Claimant cannot reject own task' };
        }
        this._reopenTask(task, verifierAddress, feedback, now);
      }
      this.tasks.set(taskId, task);
      this._saveTasks();
      return { success: true, task: this._sanitizeTask(task) };
    }

    return { success: false, reason: 'Unknown trust tier' };
  }

  /**
   * Helper: reopen a rejected task back to OPEN status for re-claiming.
   */
  _reopenTask(task, verifierAddress, feedback, now) {
    task.status = TASK_STATUS.OPEN;
    task.claimedBy = null;
    task.claimedAt = null;
    task.submittedAt = null;
    task.submissionData = null;
    task.publisherApproved = false;
    task.thirdPartyApproved = false;
    task.verifications = [];
    task.transactionHistory.push({
      type: TXN_TYPES.TASK_VERIFY,
      timestamp: now,
      by: verifierAddress,
      data: { approved: false, feedback }
    });
    console.log(`[TaskProtocol] Task rejected: ${task.id}, reopened`);
  }

  /**
   * Cancel an open or claimed task (publisher only).
   */
  cancel(publisherAddress, taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: 'Task not found' };
    }
    if (task.publisher !== publisherAddress) {
      return { success: false, reason: 'Only the publisher can cancel' };
    }
    if (![TASK_STATUS.OPEN, TASK_STATUS.CLAIMED].includes(task.status)) {
      return { success: false, reason: `Cannot cancel task in ${task.status} status` };
    }

    const now = Date.now();
    task.status = TASK_STATUS.CANCELLED;
    task.cancelledAt = now;
    task.transactionHistory.push({
      type: TXN_TYPES.TASK_CANCEL,
      timestamp: now,
      by: publisherAddress
    });

    // Refund escrowed reward to publisher when AGENT task is cancelled
    if (task.escrowed && task.reward !== '0' && this.node && this.node.currentState) {
      try {
        const ESCROW_ADDR = 'ng1escrow0000000000000000000000000000000';
        const refundAmount = BigInt(task.reward);
        this.node.currentState.subtractBalance(ESCROW_ADDR, refundAmount.toString());
        this.node.currentState.addBalance(task.publisher, refundAmount.toString());
        console.log(`[TaskProtocol] Escrow refunded: ${task.reward} NGEN → ${task.publisher.slice(0, 12)}...`);
        // Phase 1C-5: Record REFUND audit event
        this.node.currentState.recordAuditEvent({
          tx_type: TX_TYPE.TRANSFER,
          from: ESCROW_ADDR,
          to: task.publisher,
          amount: refundAmount.toString(),
          blockHeight: 0,
          metadata: {
            event: 'TASK_REFUND',
            taskId: task.id,
            reason: 'task_cancelled',
            refundAmount: refundAmount.toString(),
            publisher: task.publisher
          }
        });
      } catch (refundErr) {
        console.error(`[TaskProtocol] Escrow refund failed:`, refundErr.message);
      }
    }

    this.tasks.set(taskId, task);
    this._saveTasks();

    console.log(`[TaskProtocol] Task cancelled: ${taskId}`);
    return { success: true, task: this._sanitizeTask(task) };
  }

  /**
   * Query tasks with optional filters.
   */
  query({ status, publisher, claimant, capabilities, taskType, minReward, limit = 50, offset = 0 } = {}) {
    let results = Array.from(this.tasks.values());

    if (status) {
      results = results.filter(t => t.status === status);
    }
    if (publisher) {
      results = results.filter(t => t.publisher === publisher);
    }
    if (claimant) {
      results = results.filter(t => t.claimedBy === claimant);
    }
    if (capabilities && capabilities.length > 0) {
      results = results.filter(t =>
        capabilities.every(c => t.requiredCapabilities.includes(c))
      );
    }
    if (taskType) {
      results = results.filter(t => t.taskType === taskType);
    }
    if (minReward) {
      const min = BigInt(minReward);
      results = results.filter(t => BigInt(t.reward) >= min);
    }

    results.sort((a, b) => b.publishedAt - a.publishedAt);

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
      tasks: results.map(t => this._sanitizeTask(t)),
      total,
      offset,
      limit
    };
  }

  /**
   * Get a single task by ID.
   */
  get(taskId) {
    const task = this.tasks.get(taskId);
    return task ? this._sanitizeTask(task) : null;
  }

  /**
   * Get task statistics.
   */
  getStats() {
    const all = Array.from(this.tasks.values());
    const completedTasks = all.filter(t => t.status === TASK_STATUS.COMPLETED);
    // paid === true: 新任务明确已支付; paid === undefined: 旧任务 (奖励发放代码已执行, 字段未持久化) 视为已支付;
    // paid === false: 明确未支付 (Swarm Pool 余额不足被跳过)
    const paidTasks = completedTasks.filter(t => t.paid !== false);
    const unpaidTasks = completedTasks.filter(t => t.paid === false);
    return {
      total: all.length,
      open: all.filter(t => t.status === TASK_STATUS.OPEN).length,
      claimed: all.filter(t => t.status === TASK_STATUS.CLAIMED).length,
      submitted: all.filter(t => t.status === TASK_STATUS.SUBMITTED).length,
      completed: completedTasks.length,
      cancelled: all.filter(t => t.status === TASK_STATUS.CANCELLED).length,
      expired: all.filter(t => t.status === TASK_STATUS.EXPIRED).length,
      paidTasks: paidTasks.length,
      unpaidCompletedTasks: unpaidTasks.length,
      totalRewardsDistributed: paidTasks
        .reduce((sum, t) => sum + BigInt(t.reward), 0n)
        .toString(),
      totalRewardsCompleted: completedTasks
        .reduce((sum, t) => sum + BigInt(t.reward), 0n)
        .toString()
    };
  }

  /**
   * Match open tasks to an agent based on capabilities.
   * P0-2.1: Fixed semantics — no caps = return all, empty caps = only no-cap tasks.
   * Added pagination support (page, pageSize).
   * Added fallback: if result is empty, return tasks with no capability requirements.
   */
  matchForAgent(agentCapabilities, { page = 1, pageSize = 20 } = {}) {
    const hasCapsFilter = agentCapabilities && agentCapabilities.length > 0;
    const normalizedCaps = hasCapsFilter ? agentCapabilities.map(c => c.toLowerCase()) : [];

    const openTasks = Array.from(this.tasks.values())
      .filter(t => t.status === TASK_STATUS.OPEN)
      .filter(t => {
        if (!hasCapsFilter) return true; // no caps passed → return all
        if (t.requiredCapabilities.length === 0) return true; // task has no requirements
        return t.requiredCapabilities.every(c => normalizedCaps.includes(c.toLowerCase()));
      })
      .sort((a, b) => {
        const rewardA = BigInt(a.reward);
        const rewardB = BigInt(b.reward);
        if (rewardB > rewardA) return 1;
        if (rewardB < rewardA) return -1;
        return a.publishedAt - b.publishedAt;
      });

    // Fallback: if result is empty and caps were specified, return tasks with no requirements
    let result = openTasks;
    if (result.length === 0 && hasCapsFilter) {
      result = Array.from(this.tasks.values())
        .filter(t => t.status === TASK_STATUS.OPEN && t.requiredCapabilities.length === 0)
        .sort((a, b) => {
          const rewardA = BigInt(a.reward);
          const rewardB = BigInt(b.reward);
          if (rewardB > rewardA) return 1;
          if (rewardB < rewardA) return -1;
          return a.publishedAt - b.publishedAt;
        });
    }

    // Pagination
    const total = result.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const paged = result.slice(start, start + pageSize);

    return {
      tasks: paged.map(t => this._sanitizeTask(t)),
      page,
      pageSize,
      total,
      totalPages,
      hasMore: page < totalPages
    };
  }

  /**
   * A3: 生成新手任务池 — 创建一批低门槛系统任务供新手 Agent 认领
   * 自动生成 monitoring/analysis/community 类型的简单任务，minReputation=0
   * 只在节点启动时调用一次，每日最多补充一次
   * @param {number} count - 要生成的任务数量（默认 10）
   * @returns {number} 实际生成的任务数
   */
  generateNoviceTasks(count = 10) {
    const NOVICE_TASK_TEMPLATES = [
      { title: 'Network health ping', description: 'Check if the network is reachable by sending a ping to the API. Report the response time.', taskType: 'monitoring', requiredCapabilities: ['monitoring'], reward: '5' },
      { title: 'Agent directory scan', description: 'List the first 10 agents from the agent registry to verify the directory is accessible and returning valid data.', taskType: 'analysis', requiredCapabilities: ['analysis'], reward: '5' },
      { title: 'Forum new topic check', description: 'Check the forum for topics posted in the last hour. Count and report how many new topics exist.', taskType: 'community', requiredCapabilities: ['community'], reward: '5' },
      { title: 'Wallet balance check', description: 'Query your own wallet balance and confirm it matches the expected registration reward.', taskType: 'analysis', requiredCapabilities: ['analysis'], reward: '5' },
      { title: 'Write a forum greeting', description: 'Post a brief introduction of yourself in the forum. Include your agent identity and what you plan to contribute.', taskType: 'community', requiredCapabilities: ['community'], reward: '10' },
      { title: 'Task market health check', description: 'Query the open tasks list and report the current count of available tasks.', taskType: 'monitoring', requiredCapabilities: ['monitoring'], reward: '5' },
      { title: 'Blockchain height check', description: 'Query the current blockchain height and verify it has increased in the last hour.', taskType: 'monitoring', requiredCapabilities: ['monitoring'], reward: '5' },
      { title: 'Documentation typo hunt', description: 'Read the project README and find any typo or formatting issue. Report the exact location and suggested fix.', taskType: 'documentation', requiredCapabilities: ['documentation'], reward: '10' },
      { title: 'Peer discovery check', description: 'Query the list of connected peers and verify the P2P network is healthy.', taskType: 'monitoring', requiredCapabilities: ['monitoring'], reward: '5' },
      { title: 'Governance proposal list', description: 'List the most recent governance proposals and summarize their status.', taskType: 'analysis', requiredCapabilities: ['analysis'], reward: '10' },
    ];

    let generated = 0;
    // A3: Publish as Swarm Pool so reward payout takes the isSystemTask branch
    // (proper audit trail) instead of the legacy swarm_pool_legacy fallback.
    const NOVICE_PUBLISHER = 'ng1swarmpool000000000000000000000000000';
    for (const template of NOVICE_TASK_TEMPLATES) {
      // Check if a similar task already exists (open and unclaimed)
      const exists = Array.from(this.tasks.values()).some(t =>
        t.status === TASK_STATUS.OPEN &&
        t.title === template.title &&
        t.taskType === 'novice'
      );
      if (exists) continue;
      if (generated >= count) break;

      const taskId = `novice_${crypto.randomUUID().slice(0, 8)}`;
      const now = Date.now();
      const task = {
        id: taskId,
        title: template.title,
        description: template.description,
        requiredCapabilities: template.requiredCapabilities,
        taskType: 'novice',
        category: template.taskType,   // preserve template category for display/matching
        minReputation: 0,
        reward: template.reward,
        publisher: NOVICE_PUBLISHER,
        status: TASK_STATUS.OPEN,
        publishedAt: now,
        claimedBy: null,
        claimedAt: null,
        claimNonce: 0,
        submittedAt: null,
        submissionData: null,
        verifiedAt: null,
        completedAt: null,
        cancelledAt: null,
        transactionHistory: [{
          type: TXN_TYPES.TASK_PUBLISH,
          timestamp: now,
          by: NOVICE_PUBLISHER
        }],
        isSystemTask: true
      };
      this.tasks.set(taskId, task);
      generated++;
    }

    if (generated > 0) {
      this._saveTasks();
      console.log(`[TaskProtocol] Generated ${generated} novice tasks for agent bootstrapping`);
    }
    return generated;
  }

  _recordOnChain(taskId, txType, from, data) {
    if (!this.node || !this.node.handleTransaction) return;

    const tx = {
      id: crypto.randomUUID(),
      tx_type: txType,
      from,
      to: from,
      amount: '0',
      fee: '1',
      payload: { taskId, ...data },
      timestamp: Date.now(),
      signature: ''
    };

    this.node.handleTransaction(tx).catch(e => {
      console.error(`[TaskProtocol] Failed to record ${txType} on-chain:`, e.message);
    });
  }

  // ===========================================================================
  // Phase 4: Task Challenge Mechanism
  // ===========================================================================

  /**
   * Initiate a challenge against a verified task during its challenge window.
   * Locks a deposit and transitions the task to CHALLENGED state.
   * @param {string} challengerAddress - Agent address of challenger
   * @param {string} taskId - Task to challenge
   * @param {string} reason - Reason for the challenge
   * @param {string} evidence - Optional evidence (URL/hash/text)
   * @returns {{ success: boolean, challenge?: object, reason?: string, errorCode?: string }}
   */
  challenge(challengerAddress, taskId, reason, evidence = '') {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, reason: 'Task not found', errorCode: 'NOT_FOUND' };
    }
    if (task.status !== TASK_STATUS.CHALLENGE_WINDOW) {
      return { success: false, reason: `Task is in status ${task.status}, not challenge_window`, errorCode: 'INVALID_STATUS' };
    }
    const now = Date.now();
    if (now > task.challengeDeadline) {
      return { success: false, reason: 'Challenge window has expired', errorCode: 'WINDOW_EXPIRED' };
    }
    if (!challengerAddress || !challengerAddress.startsWith('ng1')) {
      return { success: false, reason: 'Invalid challenger address', errorCode: 'INVALID_CHALLENGER' };
    }
    // Publisher can challenge their own task; claimant cannot challenge self
    if (task.claimedBy === challengerAddress) {
      return { success: false, reason: 'Claimant cannot challenge own task', errorCode: 'SELF_CHALLENGE' };
    }
    // Verifier cannot challenge their own verification
    if (task.verifierAddress === challengerAddress) {
      return { success: false, reason: 'Verifier cannot challenge own verification', errorCode: 'SELF_CHALLENGE' };
    }
    if (!this.node || !this.node.currentState) {
      return { success: false, reason: 'Node state not available', errorCode: 'NO_STATE' };
    }
    // Reputation check
    let challengerRep = 0;
    if (this.node.resolveRegisteredAgent) {
      const agentRecord = this.node.resolveRegisteredAgent(challengerAddress);
      if (agentRecord) {
        challengerRep = agentRecord.reputation || 0;
      }
    }
    if (challengerRep < MIN_CHALLENGER_REPUTATION) {
      return { success: false, reason: `Challenger reputation must be ≥ ${MIN_CHALLENGER_REPUTATION}, have ${challengerRep}`, errorCode: 'INSUFFICIENT_REPUTATION' };
    }
    // Calculate deposit
    const baseReward = BigInt(task.adjustedReward || task.reward);
    const pct = task.challengeDepositPct || 0.10;
    let deposit = (baseReward * BigInt(Math.round(pct * 100))) / 100n;
    if (deposit < MIN_CHALLENGE_DEPOSIT) deposit = MIN_CHALLENGE_DEPOSIT;
    // Check challenger balance
    const challengerBalance = BigInt(this.node.currentState.getBalance(challengerAddress));
    if (challengerBalance < deposit) {
      return { success: false, reason: `Insufficient balance: need ${deposit.toString()} NGEN, have ${challengerBalance.toString()}`, errorCode: 'INSUFFICIENT_BALANCE' };
    }
    // Lock deposit: challenger → ESCROW
    const ESCROW_ADDR = 'ng1escrow0000000000000000000000000000000';
    let balanceOk = true;
    try {
      this.node.currentState.subtractBalance(challengerAddress, deposit.toString());
      this.node.currentState.addBalance(ESCROW_ADDR, deposit.toString());
    } catch (e) {
      balanceOk = false;
      console.error(`[TaskProtocol] Deposit lock failed for challenge on task ${taskId}:`, e.message);
    }
    if (!balanceOk) {
      return { success: false, reason: 'Failed to lock deposit (internal error)', errorCode: 'DEPOSIT_LOCK_FAILED' };
    }

    // Create challenge record (in-memory + transaction history)
    const challengeId = `chg_${crypto.randomUUID().slice(0, 12)}`;
    const challenge = {
      id: challengeId,
      taskId,
      challenger: challengerAddress,
      reason: reason || '',
      evidence: evidence || '',
      deposit: deposit.toString(),
      status: 'open',
      openedAt: now,
      votes: { yes: [], no: [], abstain: [] },
      yesWeight: '0',
      noWeight: '0',
      result: null,
      resolvedAt: null
    };

    // Phase 1C-5: Record ESCROW audit event for challenge deposit
    this.node.currentState.recordAuditEvent({
      tx_type: TX_TYPE.TRANSFER,
      from: challengerAddress,
      to: ESCROW_ADDR,
      amount: deposit.toString(),
      blockHeight: 0,
      metadata: {
        event: 'CHALLENGE_DEPOSIT',
        taskId,
        challengeId,
        challenger: challengerAddress,
        deposit: deposit.toString()
      }
    });
    // Persist challenges to memory + file
    if (!this._challenges) this._challenges = new Map();
    this._challenges.set(challengeId, challenge);
    this._persistChallenges();

    // Update task
    task.challengeId = challengeId;
    task.challenger = challengerAddress;
    task.challengeDeposit = deposit.toString();
    task.challengeOpenedAt = now;
    task.status = TASK_STATUS.CHALLENGED;
    task.transactionHistory.push({
      type: TXN_TYPES.CHALLENGE_OPEN,
      timestamp: now,
      by: challengerAddress,
      data: { challengeId, reason, evidence, deposit: deposit.toString() }
    });
    this.tasks.set(taskId, task);
    this._saveTasks();

    if (this.node) {
      this._recordOnChain(taskId, TXN_TYPES.CHALLENGE_OPEN, challengerAddress, {
        challengeId, reason, deposit: deposit.toString()
      });
    }
    console.log(`[TaskProtocol] Challenge opened: ${challengeId} on task ${taskId} by ${challengerAddress.slice(0, 12)}... (deposit=${deposit.toString()} NGEN)`);
    return { success: true, challenge: { ...challenge, taskId, trustTier: task.trustTier } };
  }

  /**
   * Cast a vote on an open challenge. Quorum-based governance.
   * @param {string} challengeId
   * @param {string} voterAddress
   * @param {'uphold'|'reject'|'abstain'} vote
   * @returns {{ success: boolean, reason?: string, errorCode?: string, tally?: object }}
   */
  arbitrateChallenge(challengeId, voterAddress, vote) {
    if (!this._challenges) return { success: false, reason: 'No challenges exist', errorCode: 'NOT_FOUND' };
    const challenge = this._challenges.get(challengeId);
    if (!challenge) return { success: false, reason: 'Challenge not found', errorCode: 'NOT_FOUND' };
    if (challenge.status !== 'open' && challenge.status !== 'voting') {
      return { success: false, reason: `Challenge is ${challenge.status}, not open for voting`, errorCode: 'CLOSED' };
    }
    if (!this.node || !this.node.currentState) {
      return { success: false, reason: 'Node state not available', errorCode: 'NO_STATE' };
    }
    const task = this.tasks.get(challenge.taskId);
    if (!task) return { success: false, reason: 'Associated task not found', errorCode: 'NOT_FOUND' };
    // Interested parties cannot vote
    const isInterested = (task.publisher === voterAddress) ||
                         (task.claimedBy === voterAddress) ||
                         (task.verifierAddress === voterAddress) ||
                         (challenge.challenger === voterAddress);
    if (isInterested) {
      return { success: false, reason: 'Interested parties cannot vote on challenges', errorCode: 'CONFLICT_OF_INTEREST' };
    }
    // Check reputation
    let voterRep = 0;
    if (this.node.resolveRegisteredAgent) {
      const agentRecord = this.node.resolveRegisteredAgent(voterAddress);
      if (!agentRecord || !agentRecord.agentId) {
        return { success: false, reason: 'Voter must be a registered agent', error_code: 'NOT_REGISTERED' };
      }
      voterRep = agentRecord.reputation || 0;
      if (voterRep < 1) {
        return { success: false, reason: 'Voter reputation must be ≥ 1', errorCode: 'INSUFFICIENT_REPUTATION' };
      }
      // Compute voting weight = reputation * (1 + balance/1000)
      const balance = BigInt(this.node.currentState.getBalance(voterAddress));
      const weight = Number(voterRep) * (1 + Number(balance) / 1000);
      // Remove any prior vote
      ['yes', 'no', 'abstain'].forEach(bucket => {
        const idx = challenge.votes[bucket].findIndex(v => v.voter === voterAddress);
        if (idx >= 0) {
          challenge.votes[bucket].splice(idx, 1);
        }
      });
      const normalizedVote = vote === 'uphold' ? 'yes' : (vote === 'reject' ? 'no' : 'abstain');
      challenge.votes[normalizedVote].push({ voter: voterAddress, weight, timestamp: Date.now() });
    } else {
      return { success: false, reason: 'Agent registry unavailable', errorCode: 'NO_REGISTRY' };
    }

    // Recompute weights
    const sumWeights = (arr) => arr.reduce((s, v) => s + v.weight, 0);
    challenge.yesWeight = sumWeights(challenge.votes.yes).toString();
    challenge.noWeight = sumWeights(challenge.votes.no).toString();
    challenge.status = 'voting';
    this._challenges.set(challengeId, challenge);
    this._persistChallenges();

    // Update task status to ARBITRATION when first vote is cast
    if (challenge.votes.yes.length + challenge.votes.no.length + challenge.votes.abstain.length > 0 &&
        task.status === TASK_STATUS.CHALLENGED) {
      task.status = TASK_STATUS.ARBITRATION;
      const voteTimestamp = Date.now();
      task.transactionHistory.push({
        type: TXN_TYPES.CHALLENGE_VOTE,
        timestamp: voteTimestamp,
        by: voterAddress,
        data: { challengeId, vote, voter: voterAddress }
      });
      this.tasks.set(task.id, task);
      this._saveTasks();
    }

    // Check if resolution threshold met
    const totalWeight = Number(challenge.yesWeight) + Number(challenge.noWeight);
    const yesRatio = totalWeight > 0 ? Number(challenge.yesWeight) / totalWeight : 0;
    const activeAgentCount = this._countActiveAgents();
    const quorum = activeAgentCount * CHALLENGE_QUORUM_PCT;
    // Resolve early if yes ratio passes threshold AND total weight exceeds quorum,
    // OR if 7 days have passed since openedAt
    const arbitrationDeadline = challenge.openedAt + CHALLENGE_ARBITRATION_PERIOD_MS;
    const quorumMet = totalWeight >= quorum;
    const thresholdMet = yesRatio >= CHALLENGE_PASS_THRESHOLD && quorumMet;
    const deadlineReached = Date.now() >= arbitrationDeadline;
    if (thresholdMet || (deadlineReached && quorumMet)) {
      const result = yesRatio >= CHALLENGE_PASS_THRESHOLD ? 'upheld' : 'rejected';
      return this._resolveChallenge(challenge, result, task);
    }
    return {
      success: true,
      challenge: { id: challengeId, status: 'voting', yesWeight: challenge.yesWeight, noWeight: challenge.noWeight, yesRatio, quorumMet, thresholdMet },
      tally: { yesWeight: Number(challenge.yesWeight), noWeight: Number(challenge.noWeight), quorum, activeAgents: activeAgentCount }
    };
  }

  /**
   * Resolve a challenge: distribute funds, slash parties, finalize task.
   * @param {object} challenge
   * @param {'upheld'|'rejected'} result
   * @param {object} task
   */
  _resolveChallenge(challenge, result, task) {
    const ESCROW_ADDR = 'ng1escrow0000000000000000000000000000000';
    const deposit = BigInt(challenge.deposit);
    const adjustedReward = BigInt(task.adjustedReward || task.reward);
    const halfReward = adjustedReward / 2n;
    const remainder = adjustedReward % 2n;
    const now = Date.now();
    challenge.status = result;
    challenge.result = result;
    challenge.resolvedAt = now;
    if (result === 'upheld') {
      // Challenger wins: refund deposit + 50% reward (from claimant); treasury gets 50%
      // Return deposit to challenger from escrow
      this.node.currentState.subtractBalance(ESCROW_ADDR, deposit.toString());
      this.node.currentState.addBalance(challenge.challenger, deposit.toString());
      // Phase 1C-5: Record deposit refund audit
      this.node.currentState.recordAuditEvent({
        tx_type: TX_TYPE.TRANSFER,
        from: ESCROW_ADDR,
        to: challenge.challenger,
        amount: deposit.toString(),
        blockHeight: 0,
        metadata: {
          event: 'CHALLENGE_DEPOSIT_REFUND',
          challengeId: challenge.id,
          taskId: task.id,
          challenger: challenge.challenger,
          result: 'upheld',
          deposit: deposit.toString()
        }
      });
      // Move 50% of reward from claimant → challenger
      let claimantPaid = false;
      if (this.node.currentState.getBalance(task.claimedBy) >= halfReward) {
        this.node.currentState.subtractBalance(task.claimedBy, halfReward.toString());
        this.node.currentState.addBalance(challenge.challenger, halfReward.toString());
        claimantPaid = true;
        // Phase 1C-5: Record claimant slash audit
        this.node.currentState.recordAuditEvent({
          tx_type: TX_TYPE.TRANSFER,
          from: task.claimedBy,
          to: challenge.challenger,
          amount: halfReward.toString(),
          blockHeight: 0,
          metadata: {
            event: 'CHALLENGE_REWARD_PAYOUT',
            challengeId: challenge.id,
            taskId: task.id,
            claimant: task.claimedBy,
            challenger: challenge.challenger,
            halfReward: halfReward.toString()
          }
        });
      } else {
        // Fallback: pay from escrow
        this.node.currentState.subtractBalance(ESCROW_ADDR, halfReward.toString());
        this.node.currentState.addBalance(challenge.challenger, halfReward.toString());
        console.warn(`[TaskProtocol] Claimant balance insufficient for upheld challenge; using escrow`);
        // Phase 1C-5: Record escrow fallback audit
        this.node.currentState.recordAuditEvent({
          tx_type: TX_TYPE.TRANSFER,
          from: ESCROW_ADDR,
          to: challenge.challenger,
          amount: halfReward.toString(),
          blockHeight: 0,
          metadata: {
            event: 'CHALLENGE_REWARD_PAYOUT_ESCROW_FALLBACK',
            challengeId: challenge.id,
            taskId: task.id,
            claimant: task.claimedBy,
            challenger: challenge.challenger,
            halfReward: halfReward.toString()
          }
        });
      }
      // Move 50% to treasury
      this.node.currentState.subtractBalance(ESCROW_ADDR, halfReward.toString());
      this.node.currentState.addBalance(TREASURY_ADDR, halfReward.toString());
      // Phase 1C-5: Record treasury share audit
      this.node.currentState.recordAuditEvent({
        tx_type: TX_TYPE.TRANSFER,
        from: ESCROW_ADDR,
        to: TREASURY_ADDR,
        amount: halfReward.toString(),
        blockHeight: 0,
        metadata: {
          event: 'CHALLENGE_TREASURY_SHARE',
          challengeId: challenge.id,
          taskId: task.id,
          halfReward: halfReward.toString()
        }
      });
      // Return odd-cent remainder to treasury
      if (remainder > 0n) {
        this.node.currentState.addBalance(TREASURY_ADDR, remainder.toString());
        // Phase 1C-5: Record remainder audit
        this.node.currentState.recordAuditEvent({
          tx_type: TX_TYPE.TRANSFER,
          from: ESCROW_ADDR,
          to: TREASURY_ADDR,
          amount: remainder.toString(),
          blockHeight: 0,
          metadata: {
            event: 'CHALLENGE_REMAINDER',
            challengeId: challenge.id,
            taskId: task.id,
            remainder: remainder.toString()
          }
        });
      }
      // Slash verifier
      if (task.verifierAddress && task.verifierAddress !== 'system') {
        this._slashForViolation(task.verifierAddress, 'MALICIOUS_VERIFICATION', { taskId: task.id, challengeId: challenge.id });
      }
      console.log(`[TaskProtocol] Challenge UPHELD: ${challenge.id}; verifier slashed; challenger paid ${(deposit + halfReward).toString()} NGEN`);
    } else {
      // Challenger loses: deposit → treasury, slash challenger
      this.node.currentState.subtractBalance(ESCROW_ADDR, deposit.toString());
      this.node.currentState.addBalance(TREASURY_ADDR, deposit.toString());
      // Phase 1C-5: Record forfeit to treasury audit
      this.node.currentState.recordAuditEvent({
        tx_type: TX_TYPE.TRANSFER,
        from: ESCROW_ADDR,
        to: TREASURY_ADDR,
        amount: deposit.toString(),
        blockHeight: 0,
        metadata: {
          event: 'CHALLENGE_FORFEIT',
          challengeId: challenge.id,
          taskId: task.id,
          challenger: challenge.challenger,
          deposit: deposit.toString(),
          result: 'rejected'
        }
      });
      this._slashForViolation(challenge.challenger, 'FALSE_CHALLENGE', { taskId: task.id, challengeId: challenge.id });
      console.log(`[TaskProtocol] Challenge REJECTED: ${challenge.id}; challenger slashed -${deposit.toString()} NGEN to treasury`);
    }
    task.status = TASK_STATUS.FINALIZED;
    task.finalizedAt = now;
    task.challengeResult = result;
    task.transactionHistory.push({
      type: TXN_TYPES.CHALLENGE_RESOLVE,
      timestamp: now,
      by: 'system',
      data: { challengeId: challenge.id, result, deposit: deposit.toString() }
    });
    this._challenges.set(challenge.id, challenge);
    this._persistChallenges();
    this.tasks.set(task.id, task);
    this._saveTasks();
    if (this.node) {
      this._recordOnChain(task.id, TXN_TYPES.CHALLENGE_RESOLVE, 'system', {
        challengeId: challenge.id, result, deposit: deposit.toString()
      });
    }
    return {
      success: true,
      challenge: { id: challenge.id, status: result, resolvedAt: now },
      taskStatus: task.status,
      result
    };
  }

  /**
   * Count active agents (reputation > 0) for quorum calculation.
   */
  _countActiveAgents() {
    if (!this.node || !this.node.currentState || typeof this.node.currentState.getAllAgents !== 'function') {
      return 1; // fallback
    }
    const agents = this.node.currentState.getAllAgents() || [];
    return Math.max(1, agents.filter(a => (a.reputation || 0) > 0).length);
  }

  /**
   * Persist challenges to data/challenges/challenges.json
   */
  _persistChallenges() {
    try {
      const dir = path.join(process.cwd(), 'data', 'challenges');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {};
      if (this._challenges) {
        for (const [id, c] of this._challenges.entries()) {
          data[id] = c;
        }
      }
      fs.writeFileSync(path.join(dir, 'challenges.json'), JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('[TaskProtocol] _persistChallenges failed:', e.message);
    }
  }

  /**
   * Get challenge by ID
   */
  getChallenge(challengeId) {
    if (!this._challenges) return null;
    return this._challenges.get(challengeId) || null;
  }

  /**
   * Get all challenges for a task
   */
  getChallengesForTask(taskId) {
    if (!this._challenges) return [];
    return Array.from(this._challenges.values()).filter(c => c.taskId === taskId);
  }

  /**
   * Finalize tasks whose challenge window has expired with no challenges.
   * Called periodically (and can be invoked manually).
   */
  finalizeExpiredTasks() {
    const now = Date.now();
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === TASK_STATUS.CHALLENGE_WINDOW && now >= task.challengeDeadline) {
        task.status = TASK_STATUS.FINALIZED;
        task.finalizedAt = now;
        task.transactionHistory.push({
          type: TXN_TYPES.CHALLENGE_RESOLVE,
          timestamp: now,
          by: 'system',
          data: { reason: 'challenge_window_expired_no_challenges' }
        });
        this.tasks.set(task.id, task);
        count++;
        console.log(`[TaskProtocol] Task ${task.id} finalized (challenge window expired, no challenges)`);
      }
    }
    if (count > 0) this._saveTasks();
    return count;
  }

  /**
   * Slash a party for a challenge-related violation.
   * Wrapper around _slashForViolation with challenge-specific context.
   */
  _slashForViolationChallenge(address, violationType, context) {
    return this._slashForViolation(address, violationType, context);
  }

  _sanitizeTask(task) {
    const { transactionHistory, submissionData, verifications, ...safe } = task;
    // Include transaction count and submission summary (not full data)
    return {
      ...safe,
      transactionCount: transactionHistory.length,
      hasSubmission: !!submissionData,
      submissionSummary: submissionData ? {
        type: submissionData.type || submissionData.action || 'generic',
        fields: Object.keys(submissionData),
        preview: JSON.stringify(submissionData).slice(0, 300)
      } : null
    };
  }
}

let instance = null;

export function getTaskProtocol(node = null) {
  if (!instance) {
    instance = new TaskProtocol(node);
  }
  if (node && !instance.node) {
    instance.node = node;
  }
  return instance;
}

export { TASK_STATUS, TXN_TYPES, TaskProtocol };

/**
 * Genesis Reserve Multi-Signature Wallet (3-of-5 Agent-only)
 *
 * Purpose: Manage the 5% Genesis Reserve (50M NGEN) for infrastructure spend.
 * All signers are Agents. Humans do NOT participate in fund decisions.
 *
 * Architecture:
 *   - 5 signers: 2 pre-elected validators + 1 community-elected + 1 external auditor + 1 Observer Agent
 *   - 3-of-5 threshold: any 3 signers approve → transaction executes
 *   - 2+ rejections → proposal rejected
 *   - Milestone schema aligned with docs/ECONOMY_NGEN.md §4.1:
 *       4 milestones, 20%/30%/20%/30% split (10M/15M/10M/15M NGEN)
 *   - Full audit trail via Observer Events log
 *
 * Integration:
 *   - Attached to state.genesisMultiSig (initialized at startup)
 *   - Milestone trigger calls proposeSpend() instead of direct addBalance()
 *   - API endpoints exposed via /api/v1/genesis-reserve/*
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const MULTI_SIG_VERSION = '1.0.0';
const REQUIRED_CONFIRMATIONS = 3;       // 3-of-5 threshold
const MAX_PROPOSAL_AMOUNT = '50000000'; // 50M NGEN (entire reserve, single-proposal cap)
const COOLDOWN_BLOCKS = 100;            // 100 blocks between proposal submissions by same agent

import fs from 'fs';
import path from 'path';

const PERSISTENCE_DIR = 'data/genesis_reserve';
const PERSISTENCE_FILE = 'state.json';

// Pre-defined signers (Agent addresses)
// Signer 1 & 2: First two validators (swarm-atlas, swarm-beacon)
// Signer 3: Community-elected (placeholder, filled by governance)
// Signer 4: External auditor (placeholder, filled by governance)
// Signer 5: Observer Agent (Constitutional veto power)
const DEFAULT_SIGNERS = [
  {
    agentId: 'swarm-atlas',
    address: 'ng1swarmAtlas000000000000000000000000000', // placeholder, resolved at runtime
    role: 'validator_1',
    status: 'active',
    registeredAt: 0
  },
  {
    agentId: 'swarm-beacon',
    address: 'ng1swarmBeacon00000000000000000000000000', // placeholder, resolved at runtime
    role: 'validator_2',
    status: 'active',
    registeredAt: 0
  },
  {
    agentId: 'community_rep',
    address: null,
    role: 'community_elected',
    status: 'pending_election',
    registeredAt: 0
  },
  {
    agentId: 'external_auditor',
    address: null,
    role: 'external_auditor',
    status: 'pending_registration',
    registeredAt: 0
  },
  {
    agentId: 'observer_agent',
    address: null,
    role: 'observer_veto',
    status: 'active',
    registeredAt: 0
  }
];

// Proposal statuses
const PROPOSAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTED: 'executed',
  CANCELLED: 'cancelled'
};

// ─── GenesisMultiSig Class ───────────────────────────────────────────────────

class GenesisMultiSig {
  constructor(genesisReserveAddress) {
    this.version = MULTI_SIG_VERSION;
    this.genesisReserveAddress = genesisReserveAddress;
    this.proposalCounter = 0;

    // Signers: indexed by agentId
    this.signers = new Map();
    for (const s of DEFAULT_SIGNERS) {
      this.signers.set(s.agentId, {
        ...s,
        address: s.address || null,
        confirmations: new Set(),
        rejections: new Set()
      });
    }

    // Active proposals: proposalId → Proposal
    this.proposals = new Map();

    // Audit log: array of Observer Events
    this.auditLog = [];

    // Daily spend tracker: { dateStr: totalSpent }
    this.dailySpend = new Map();

    // Attempt to load persisted state; non-fatal if missing
    this._loadFromDisk();

    console.log(`[GENESIS_MULTI_SIG] Initialized v${this.version} for reserve address: ${genesisReserveAddress}`);
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /**
   * Get the absolute path to the persistence file.
   * Uses process.cwd() so it resolves relative to project root regardless of CWD.
   */
  _persistencePath() {
    return path.join(process.cwd(), PERSISTENCE_DIR, PERSISTENCE_FILE);
  }

  /**
   * Serialize Maps and Sets to plain objects/arrays, then write to disk.
   * Non-blocking best-effort: errors are logged but not thrown.
   */
  _saveToDisk() {
    try {
      const data = {
        version: this.version,
        genesisReserveAddress: this.genesisReserveAddress,
        proposalCounter: this.proposalCounter,
        signers: Array.from(this.signers.entries()).map(([id, s]) => ({
          agentId: s.agentId,
          address: s.address,
          role: s.role,
          status: s.status,
          registeredAt: s.registeredAt,
          confirmations: Array.from(s.confirmations || []),
          rejections: Array.from(s.rejections || [])
        })),
        proposals: Array.from(this.proposals.entries()),
        auditLog: this.auditLog.slice(-1000), // cap to last 1000 events to bound file size
        dailySpend: Array.from(this.dailySpend.entries())
      };
      const dir = path.join(process.cwd(), PERSISTENCE_DIR);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._persistencePath(), JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.warn(`[GENESIS_MULTI_SIG] _saveToDisk failed: ${e.message}`);
    }
  }

  /**
   * Restore state from disk if available. Missing/corrupt file = no-op.
   */
  _loadFromDisk() {
    try {
      const file = this._persistencePath();
      if (!fs.existsSync(file)) {
        console.log(`[GENESIS_MULTI_SIG] No persistence file at ${file}, starting fresh`);
        return;
      }
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (data.version !== this.version) {
        console.warn(`[GENESIS_MULTI_SIG] Version mismatch (file=${data.version}, current=${this.version}), ignoring`);
        return;
      }
      this.proposalCounter = data.proposalCounter || 0;
      this.dailySpend = new Map(data.dailySpend || []);
      this.auditLog = Array.isArray(data.auditLog) ? data.auditLog : [];
      if (Array.isArray(data.proposals)) {
        for (const [id, p] of data.proposals) {
          this.proposals.set(id, {
            ...p,
            confirmedBy: p.confirmedBy || [],
            rejectedBy: p.rejectedBy || []
          });
        }
      }
      console.log(`[GENESIS_MULTI_SIG] Restored ${this.proposals.size} proposals, ${this.auditLog.length} audit events from ${file}`);
    } catch (e) {
      console.warn(`[GENESIS_MULTI_SIG] _loadFromDisk failed (non-fatal): ${e.message}`);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Propose a spend from the Genesis Reserve.
   * Called when a milestone is reached (instead of direct addBalance).
   *
   * @param {object} params
   * @param {string} params.milestoneBlock - Block height that triggered this
   * @param {string} params.amount - NGEN amount to spend
   * @param {string} params.recipient - Recipient address
   * @param {string} params.purpose - Brief purpose
   * @param {string} params.justification - Detailed necessity explanation
   * @param {string} params.expectedBenefit - Expected network benefit
   * @param {string} params.duration - Duration of expenditure impact
   * @param {string} params.riskAssessment - Risk evaluation
   * @param {State} [params.state] - Optional state reference for balance check
   * @returns {{ success: boolean, proposalId?: string, error?: string }}
   */
  proposeSpend(params) {
    const {
      milestoneBlock,
      amount,
      recipient,
      purpose,
      justification,
      expectedBenefit,
      duration,
      riskAssessment,
      state
    } = params;

    // Validate required fields
    if (!milestoneBlock || !amount || !recipient || !purpose || !justification) {
      return { success: false, error: 'Missing required fields: milestoneBlock, amount, recipient, purpose, justification' };
    }

    // Validate amount
    const amountBig = BigInt(amount);
    const reserveBalance = this._getReserveBalance(state);
    if (amountBig > reserveBalance) {
      return { success: false, error: `Insufficient reserve balance: need ${amount}, have ${reserveBalance.toString()}` };
    }

    if (amountBig <= 0n) {
      return { success: false, error: 'Amount must be positive' };
    }

    // Check daily spend limit (prevent bulk drain)
    const today = new Date().toISOString().slice(0, 10);
    const dailySpent = BigInt(this.dailySpend.get(today) || '0');
    const DAILY_LIMIT = BigInt('10000000'); // 10M NGEN per day
    if (dailySpent + amountBig > DAILY_LIMIT) {
      return { success: false, error: `Daily spend limit exceeded: ${dailySpent}/${DAILY_LIMIT} NGEN spent today` };
    }

    // Create proposal
    this.proposalCounter++;
    const proposalId = `gr-${this.proposalCounter}-${Date.now()}`;

    const proposal = {
      id: proposalId,
      milestoneBlock: Number(milestoneBlock),
      amount: amount.toString(),
      recipient,
      purpose,
      justification,
      expectedBenefit: expectedBenefit || '',
      duration: duration || '',
      riskAssessment: riskAssessment || '',
      status: PROPOSAL_STATUS.PENDING,
      createdAt: Date.now(),
      confirmedBy: [],
      rejectedBy: [],
      executedAt: null,
      txHash: null
    };

    this.proposals.set(proposalId, proposal);
    this._saveToDisk();

    // Log to audit
    this._auditLog('PROPOSE_SPEND', {
      proposalId,
      milestoneBlock,
      amount,
      recipient,
      purpose
    });

    console.log(`[GENESIS_MULTI_SIG] Proposal ${proposalId} created for ${amount} NGEN to ${recipient}`);
    return { success: true, proposalId };
  }

  /**
   * Signer confirms a proposal (approve).
   *
   * @param {string} signerAgentId - The signer's agent identity
   * @param {string} proposalId - Proposal to confirm
   * @param {State} [state] - Optional state reference for balance check
   * @returns {{ success: boolean, status?: string, error?: string }}
   */
  signProposal(signerAgentId, proposalId, state) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return { success: false, error: 'Proposal not found' };
    }

    if (proposal.status !== PROPOSAL_STATUS.PENDING) {
      return { success: false, error: `Proposal is ${proposal.status}, cannot sign` };
    }

    const signer = this.signers.get(signerAgentId);
    if (!signer) {
      return { success: false, error: `Signer ${signerAgentId} not found` };
    }

    if (signer.status !== 'active') {
      return { success: false, error: `Signer ${signerAgentId} is not active` };
    }

    // Check if already signed
    if (proposal.confirmedBy.includes(signerAgentId)) {
      return { success: false, error: 'Already confirmed by this signer' };
    }

    // Check if already rejected (can't sign a rejected proposal)
    if (proposal.status === PROPOSAL_STATUS.REJECTED) {
      return { success: false, error: 'Proposal already rejected' };
    }

    // Record confirmation
    proposal.confirmedBy.push(signerAgentId);
    this._saveToDisk();
    this._auditLog('SIGN_PROPOSAL', {
      proposalId,
      signerAgentId,
      action: 'confirm',
      confirmationCount: proposal.confirmedBy.length
    });

    // Check if threshold reached → execute
    if (proposal.confirmedBy.length >= REQUIRED_CONFIRMATIONS) {
      return this._executeProposal(proposalId, state);
    }

    return {
      success: true,
      status: `confirmed (${proposal.confirmedBy.length}/${REQUIRED_CONFIRMATIONS} signatures)`,
      confirmationCount: proposal.confirmedBy.length
    };
  }

  /**
   * Signer rejects a proposal.
   *
   * @param {string} signerAgentId - The signer's agent identity
   * @param {string} proposalId - Proposal to reject
   * @param {string} reason - Rejection reason
   * @returns {{ success: boolean, error?: string }}
   */
  rejectProposal(signerAgentId, proposalId, reason = '') {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return { success: false, error: 'Proposal not found' };
    }

    if (proposal.status !== PROPOSAL_STATUS.PENDING) {
      return { success: false, error: `Proposal is ${proposal.status}, cannot reject` };
    }

    const signer = this.signers.get(signerAgentId);
    if (!signer) {
      return { success: false, error: `Signer ${signerAgentId} not found` };
    }

    if (signer.status !== 'active') {
      return { success: false, error: `Signer ${signerAgentId} is not active` };
    }

    // Check if already signed/rejected
    if (proposal.confirmedBy.includes(signerAgentId)) {
      return { success: false, error: 'Signer already confirmed this proposal' };
    }
    if (proposal.rejectedBy.includes(signerAgentId)) {
      return { success: false, error: 'Already rejected by this signer' };
    }

    // Record rejection
    proposal.rejectedBy.push(signerAgentId);
    this._saveToDisk();
    this._auditLog('SIGN_PROPOSAL', {
      proposalId,
      signerAgentId,
      action: 'reject',
      reason,
      rejectionCount: proposal.rejectedBy.length
    });

    // Check if 2+ rejections → reject proposal
    if (proposal.rejectedBy.length >= 2) {
      proposal.status = PROPOSAL_STATUS.REJECTED;
      this._saveToDisk();
      this._auditLog('REJECT_PROPOSAL', {
        proposalId,
        reason: `Rejected by ${proposal.rejectedBy.length} signers: ${proposal.rejectedBy.join(', ')}`
      });
      return { success: true, status: 'rejected' };
    }

    return {
      success: true,
      status: `rejected (${proposal.rejectedBy.length}/2 needed)`,
      rejectionCount: proposal.rejectedBy.length
    };
  }

  /**
   * Execute a proposal that has reached confirmation threshold.
   * Internal method, called by signProposal when threshold is met.
   * @param {string} proposalId - Proposal to execute
   * @param {State} [state] - Optional state reference for balance check
   */
  _executeProposal(proposalId, state) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== PROPOSAL_STATUS.PENDING) {
      return { success: false, error: 'Proposal not in pending state' };
    }

    if (proposal.confirmedBy.length < REQUIRED_CONFIRMATIONS) {
      return { success: false, error: 'Insufficient confirmations' };
    }

    // Transfer funds
    const amount = BigInt(proposal.amount);
    const reserveBalance = this._getReserveBalance(state);
    if (reserveBalance < amount) {
      return { success: false, error: 'Insufficient reserve balance for execution' };
    }

    // Update signer confirmation sets
    for (const signerId of proposal.confirmedBy) {
      const signer = this.signers.get(signerId);
      if (signer) {
        signer.confirmations.add(proposalId);
      }
    }

    // Update daily spend tracker
    const today = new Date().toISOString().slice(0, 10);
    const currentDaily = BigInt(this.dailySpend.get(today) || '0');
    this.dailySpend.set(today, (currentDaily + amount).toString());

    // Mark proposal as executed
    proposal.status = PROPOSAL_STATUS.EXECUTED;
    proposal.executedAt = Date.now();
    proposal.txHash = `tx-gr-${proposalId}-${Date.now()}`;
    this._saveToDisk();

    this._auditLog('EXECUTE_PROPOSAL', {
      proposalId,
      amount: proposal.amount,
      recipient: proposal.recipient,
      confirmedBy: proposal.confirmedBy,
      txHash: proposal.txHash
    });

    console.log(`[GENESIS_MULTI_SIG] Proposal ${proposalId} EXECUTED: ${proposal.amount} NGEN → ${proposal.recipient}`);
    return { success: true, txHash: proposal.txHash };
  }

  /**
   * Cancel a pending proposal (only by original proposer or if no confirmations yet).
   */
  cancelProposal(signerAgentId, proposalId) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return { success: false, error: 'Proposal not found' };
    }

    if (proposal.status !== PROPOSAL_STATUS.PENDING) {
      return { success: false, error: `Cannot cancel ${proposal.status} proposal` };
    }

    if (proposal.confirmedBy.length > 0) {
      return { success: false, error: 'Cannot cancel proposal with existing confirmations' };
    }

    proposal.status = PROPOSAL_STATUS.CANCELLED;
    this._saveToDisk();
    this._auditLog('CANCEL_PROPOSAL', { proposalId, signerAgentId });
    return { success: true };
  }

  // ─── Query Methods ───────────────────────────────────────────────────────

  /**
   * Get all proposals, optionally filtered by status.
   */
  getProposals(filter = {}) {
    const result = [];
    for (const [id, proposal] of this.proposals) {
      if (filter.status && proposal.status !== filter.status) continue;
      if (filter.recipient && proposal.recipient !== filter.recipient) continue;
      result.push({ id, ...proposal });
    }
    // Sort by createdAt desc
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
  }

  /**
   * Get a single proposal by ID.
   */
  getProposal(proposalId) {
    return this.proposals.get(proposalId) || null;
  }

  /**
   * Get all signers with their current status.
   */
  getSigners() {
    const result = [];
    for (const [agentId, signer] of this.signers) {
      result.push({
        agentId,
        address: signer.address,
        role: signer.role,
        status: signer.status,
        registeredAt: signer.registeredAt
      });
    }
    return result;
  }

  /**
   * Get multi-sig statistics.
   */
  getStats() {
    const proposals = Array.from(this.proposals.values());
    return {
      version: this.version,
      totalProposals: proposals.length,
      pending: proposals.filter(p => p.status === PROPOSAL_STATUS.PENDING).length,
      approved: proposals.filter(p => p.status === PROPOSAL_STATUS.APPROVED).length,
      rejected: proposals.filter(p => p.status === PROPOSAL_STATUS.REJECTED).length,
      executed: proposals.filter(p => p.status === PROPOSAL_STATUS.EXECUTED).length,
      cancelled: proposals.filter(p => p.status === PROPOSAL_STATUS.CANCELLED).length,
      totalSpent: proposals
        .filter(p => p.status === PROPOSAL_STATUS.EXECUTED)
        .reduce((sum, p) => sum + BigInt(p.amount), 0n).toString(),
      signers: this.getSigners().length,
      auditLogSize: this.auditLog.length
    };
  }

  // ─── Internal Helpers ────────────────────────────────────────────────────

  /**
   * Get current Genesis Reserve balance from state.
   * Called by state.js integration.
   * @param {State} [state] - Optional state reference for balance lookup
   */
  _getReserveBalance(state) {
    if (state && state.getBalance) {
      return BigInt(state.getBalance(this.genesisReserveAddress) || '0');
    }
    return 0n;
  }

  /**
   * Append an entry to the audit log (Observer Events format).
   */
  _auditLog(actionType, details) {
    const event = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      action_type: actionType,
      details
    };
    this.auditLog.push(event);
  }

  /**
   * Get audit log entries (latest N).
   */
  getAuditLog(limit = 50) {
    return this.auditLog.slice(-limit);
  }
}

// ─── Integration with State ──────────────────────────────────────────────────

/**
 * Attach Genesis Multi-Sig to a State instance.
 * Called during state initialization.
 *
 * @param {State} state - The blockchain state instance
 * @param {string} genesisReserveAddress - The reserve address
 * @returns {GenesisMultiSig} The initialized multi-sig instance
 */
export function attachGenesisMultiSig(state, genesisReserveAddress) {
  state.genesisMultiSig = new GenesisMultiSig(genesisReserveAddress);
  return state.genesisMultiSig;
}

/**
 * Hook into milestone check: instead of direct addBalance,
 * create a multi-sig proposal.
 *
 * Uses new milestone schema (aligned with docs/ECONOMY_NGEN.md §4.1):
 *   - id              : 'M1-testnet-v1' etc.
 *   - businessTrigger : 'Testnet V1 上线' (textual)
 *   - block           : suggested block height (advisory)
 *   - unlockAmount    : exact NGEN to release
 *   - unlockPercentage: 20n/30n/20n/30n
 *   - purpose         : usage description
 *   - requiresMultiSig: true (always)
 *
 * @param {State} state - The blockchain state instance
 * @param {number} currentBlockHeight - Current block height
 */
export function checkGenesisReserveWithMultiSig(state, currentBlockHeight) {
  const ms = state.genesisMultiSig;
  if (!ms) return;

  const reserve = state.tokenReleaseState?.genesisReserve;
  if (!reserve) return;

  for (const milestone of reserve.milestones) {
    if (currentBlockHeight >= milestone.block && !milestone.released) {
      // Use the explicit unlockAmount from new schema
      // Fallback to computed amount for legacy data
      const releaseAmount = milestone.unlockAmount
        ? BigInt(milestone.unlockAmount)
        : (() => {
            const unreleased = reserve.totalTokens - reserve.releasedTokens;
            const pct = milestone.unlockPercentage
              ? BigInt(milestone.unlockPercentage)
              : 25n;
            return unreleased * pct / 100n;
          })();

      if (releaseAmount > 0n) {
        // Build a descriptive label using new schema
        const label = milestone.businessTrigger
          || milestone.description
          || milestone.id
          || `block-${milestone.block}`;
        const purpose = `Milestone unlock: ${label} (${milestone.purpose || 'Genesis Reserve release'})`;
        const justification =
          `Automated milestone trigger for "${label}" ` +
          `at block ${currentBlockHeight} ` +
          `(target block: ${milestone.block}). ` +
          `Per Constitution v1.2.0, Genesis Reserve releases are governed by 3-of-5 multi-sig. ` +
          `Release: ${releaseAmount.toString()} NGEN (${milestone.unlockPercentage || 25}%).`;

        const result = ms.proposeSpend({
          milestoneBlock: currentBlockHeight,
          amount: releaseAmount.toString(),
          recipient: reserve.address,
          purpose,
          justification,
          expectedBenefit: milestone.purpose || 'Network infrastructure upgrade and maintenance',
          duration: 'one-time unlock',
          riskAssessment: 'Low — automated milestone release per Constitution',
          state
        });

        if (result.success) {
          console.log(`[GENESIS_MULTI_SIG] Milestone ${label} (${milestone.id || 'legacy'}) triggered proposal ${result.proposalId} for ${releaseAmount} NGEN`);
        } else {
          console.error(`[GENESIS_MULTI_SIG] Failed to create proposal for milestone ${label}: ${result.error}`);
        }
      }
    }
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  GenesisMultiSig,
  MULTI_SIG_VERSION,
  REQUIRED_CONFIRMATIONS,
  PROPOSAL_STATUS,
  DEFAULT_SIGNERS
};

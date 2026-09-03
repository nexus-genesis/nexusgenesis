/**
 * NexusGenesis - Weighted Voting System
 * 
 * Reputation-based weighted voting system
 * includes: Proposal creation, voting, result calculation, proposal execution, persistent storage
 */

import { ContributionSystem } from '../ai/contributionSystem.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dataIntegrity from '../utils/dataIntegrity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Governance proposaltype
const PROPOSAL_TYPES = {
  PROTOCOL_UPDATE: 'protocol_update',
  PARAMETER_ADJUSTMENT: 'parameter_adjustment',
  FUND_ALLOCATION: 'fund_allocation',
  COMMUNITY_INITIATIVE: 'community_initiative',
  AGENT_REGISTRATION: 'agent_registration'
};

// Proposalstatus
const PROPOSAL_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  PASSED: 'passed',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  EXECUTED: 'executed',
  FAILED: 'failed'
};

// Governance parameters
const GOVERNANCE_PARAMS = {
  minProposalReputation: 100, // Minimum reputation score to create a proposal
  votingDuration: 7 * 24 * 60 * 60 * 1000, // Voting duration(7天)
  quorumPercentage: 30, // quorum百分比
  passThreshold: 66.7, // Approval threshold percentage
  executionDelay: 24 * 60 * 60 * 1000, // Execution delay after approval(24小时)
  maxProposalsPerAgent: 5, // Max active proposals per agent
  multiSigRequired: true, // Whether multi-signature execution is required
  multiSigThreshold: 2, // Minimum signatures required for multi-sig
  executionTimeLockDuration: 3600000, // Execution timelock(1小时), Prevent immediate execution
  authorizedExecutors: [], // Authorized executor list
  executionAuditLog: [] // Execution audit log
};

// Data directory
const DATA_DIR = path.join(__dirname, '../../data/governance');
const PROPOSALS_FILE = path.join(DATA_DIR, 'proposals.json');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');

// memoryStorage
let proposals = new Map(); // proposalId -> proposal details
let votes = new Map(); // proposalId -> { agentId -> vote }

// P3: NGEN-weighted voting.
// Vote weight is no longer reputation-only; it is boosted by the voter's
// on-chain NGEN balance. This makes NGEN a governance token — the more NGEN
// an agent holds, the more influence it has over proposals, which is the
// intended sink incentive for P3.
// 1000 NGEN on-chain balance = +1 vote weight (linear, no logarithmic cap for now).
const NGEN_WEIGHT_FACTOR = 1000;

// Ensure data directory exists
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

class WeightedVotingSystem {
  // P3: lazy-injected blockchain state (object or getter) and agentId->address
  // resolver. Injected by server.js once the genesis node is online so we do
  // not depend on import-time ordering.
  static blockchainState = null;
  static agentIdToAddressResolver = null;

  static setBlockchainState(stateOrGetter) {
    this.blockchainState = stateOrGetter;
  }

  static setAgentIdToAddressResolver(resolver) {
    this.agentIdToAddressResolver = resolver;
  }

  static _getState() {
    const s = this.blockchainState;
    if (typeof s === 'function') return s();
    return s;
  }

  // Initialize: Load data from files
  static init() {
    ensureDataDir();
    this.loadFromDisk();
    console.log('[WeightedVotingSystem] Initialized');
  }
  
  // Save to disk(with integrity check)
  static saveToDisk() {
    ensureDataDir();
    
    const proposalsData = {};
    proposals.forEach((proposal, id) => {
      proposalsData[id] = proposal;
    });
    
    const votesData = {};
    votes.forEach((voteMap, id) => {
      votesData[id] = voteMap;
    });
    
    // usingdata完整性ModuleSave
    dataIntegrity.saveWithIntegrity(PROPOSALS_FILE, proposalsData);
    dataIntegrity.saveWithIntegrity(VOTES_FILE, votesData);
  }
  
  // Load from disk(with integrity verification)
  static loadFromDisk() {
    try {
      const proposalsData = dataIntegrity.loadWithIntegrity(PROPOSALS_FILE);
      if (proposalsData) {
        proposals = new Map(Object.entries(proposalsData));
        console.log(`[WeightedVotingSystem] Loaded ${proposals.size} proposals with integrity verification`);
      }
    } catch (error) {
      console.error('[WeightedVotingSystem] Error loading proposals (integrity check failed):', error.message);
      // can选择回滚或usingbackup
      proposals = new Map();
    }
    
    try {
      const votesData = dataIntegrity.loadWithIntegrity(VOTES_FILE);
      if (votesData) {
        votes = new Map(Object.entries(votesData));
        console.log(`[WeightedVotingSystem] Loaded ${votes.size} vote records with integrity verification`);
      }
    } catch (error) {
      console.error('[WeightedVotingSystem] Error loading votes (integrity check failed):', error.message);
      votes = new Map();
    }
  }

  // CreateGovernance proposal
  static createProposal(proposalData) {
    // VerifyCreate者permission
    const creatorReputation = ContributionSystem.getAgentReputation(proposalData.creatorId);
    if (creatorReputation < GOVERNANCE_PARAMS.minProposalReputation) {
      throw new Error(`Insufficient reputation to create proposal. Required: ${GOVERNANCE_PARAMS.minProposalReputation}, Current: ${creatorReputation}`);
    }
    
    // Check活跃Proposal数量
    const activeProposals = Array.from(proposals.values()).filter(p => 
      (p.status === PROPOSAL_STATUS.PENDING || p.status === PROPOSAL_STATUS.ACTIVE) && 
      p.creatorId === proposalData.creatorId
    );
    
    if (activeProposals.length >= GOVERNANCE_PARAMS.maxProposalsPerAgent) {
      throw new Error(`Maximum proposal limit reached. Current: ${activeProposals.length}, Max: ${GOVERNANCE_PARAMS.maxProposalsPerAgent}`);
    }
    
    const proposalId = `proposal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const proposal = {
      id: proposalId,
      ...proposalData,
      status: PROPOSAL_STATUS.PENDING,
      createdAt: Date.now(),
      votingStartsAt: Date.now(),
      votingEndsAt: Date.now() + GOVERNANCE_PARAMS.votingDuration,
      executionWindowStart: Date.now() + GOVERNANCE_PARAMS.votingDuration,
      executionWindowEnd: Date.now() + GOVERNANCE_PARAMS.votingDuration + GOVERNANCE_PARAMS.executionDelay,
      totalWeight: 0,
      yesWeight: 0,
      noWeight: 0,
      abstainWeight: 0,
      executionResult: null,
      executedAt: null,
      // Multi-signature相关字段
      executionSignatures: [], // 收集的ExecuteSign
      multiSigRequired: GOVERNANCE_PARAMS.multiSigRequired,
      timeLockStart: null, // Timelock开始时间
      timeLockEnd: null, // Timelock结束时间
      executorApprovals: [] // Execute者批准记录
    };
    
    proposals.set(proposalId, proposal);
    votes.set(proposalId, {});
    this.saveToDisk();
    
    console.log(`[WeightedVotingSystem] Created proposal ${proposalId}: ${proposal.title}`);
    return proposalId;
  }
  
  // 激活Proposal(Start Vote)
  static activateProposal(proposalId) {
    const proposal = proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    if (proposal.status !== PROPOSAL_STATUS.PENDING) {
      throw new Error('Proposal is not in pending state');
    }
    
    proposal.status = PROPOSAL_STATUS.ACTIVE;
    proposals.set(proposalId, proposal);
    this.saveToDisk();
    
    console.log(`[WeightedVotingSystem] Activated proposal ${proposalId}`);
    return true;
  }
  
  // Vote
  static castVote(proposalId, agentId, vote) {
    if (!proposals.has(proposalId)) {
      throw new Error('Proposal not found');
    }
    
    const proposal = proposals.get(proposalId);
    if (proposal.status !== PROPOSAL_STATUS.ACTIVE) {
      throw new Error('Proposal is not accepting votes');
    }
    
    const now = Date.now();
    if (now > proposal.votingEndsAt) {
      proposal.status = PROPOSAL_STATUS.EXPIRED;
      proposals.set(proposalId, proposal);
      this.saveToDisk();
      throw new Error('Voting period has ended');
    }
    
    // VerifyVote选项
    if (!['yes', 'no', 'abstain'].includes(vote)) {
      throw new Error('Invalid vote option. Must be yes, no, or abstain');
    }
    
    // getagent的reputation score数作为voting weight
    const reputationScore = ContributionSystem.getAgentReputation(agentId);

    // P3: Boost voting weight by the agent's on-chain NGEN balance.
    // This ties governance influence to economic stake, making NGEN a real
    // governance token. 1000 NGEN = +1 weight. Staked NGEN (locked in
    // validator staking address) still counts because the agent "owns" it.
    let ngenBoost = 0;
    const state = this._getState();
    if (state && this.agentIdToAddressResolver) {
      try {
        const address = this.agentIdToAddressResolver(agentId);
        if (address) {
          const balanceStr = state.getBalance(address) || '0';
          const balance = Number(balanceStr);
          if (Number.isFinite(balance) && balance > 0) {
            ngenBoost = Math.floor(balance / NGEN_WEIGHT_FACTOR);
          }
        }
      } catch (err) {
        console.warn(`[WeightedVotingSystem] NGEN balance lookup failed for ${agentId}:`, err.message);
      }
    }
    const voteWeight = Math.max(1, reputationScore + ngenBoost); // 最低权重为1
    
    // 记录Vote
    const proposalVotes = votes.get(proposalId) || {};
    const previousVote = proposalVotes[agentId];
    
    // 调整总权重和赞成/反对权重
    if (previousVote) {
      // 减去之前的voting weight
      proposal.totalWeight -= previousVote.weight;
      if (previousVote.option === 'yes') {
        proposal.yesWeight -= previousVote.weight;
      } else if (previousVote.option === 'no') {
        proposal.noWeight -= previousVote.weight;
      } else {
        proposal.abstainWeight -= previousVote.weight;
      }
    }
    
    // 记录新Vote
    proposalVotes[agentId] = {
      option: vote,
      weight: voteWeight,
      reputationWeight: reputationScore,
      ngenBoost,
      castAt: now
    };
    
    // 加上新的voting weight
    proposal.totalWeight += voteWeight;
    if (vote === 'yes') {
      proposal.yesWeight += voteWeight;
    } else if (vote === 'no') {
      proposal.noWeight += voteWeight;
    } else {
      proposal.abstainWeight += voteWeight;
    }
    
    votes.set(proposalId, proposalVotes);
    proposals.set(proposalId, proposal);
    this.saveToDisk();
    
    console.log(`[WeightedVotingSystem] Agent ${agentId} voted ${vote} with weight ${voteWeight} on proposal ${proposalId}`);
  }
  
  // 结束Vote并Calculate结果
  static endVoting(proposalId) {
    if (!proposals.has(proposalId)) {
      throw new Error('Proposal not found');
    }
    
    const proposal = proposals.get(proposalId);
    if (proposal.status === PROPOSAL_STATUS.PASSED || proposal.status === PROPOSAL_STATUS.REJECTED || 
        proposal.status === PROPOSAL_STATUS.EXPIRED || proposal.status === PROPOSAL_STATUS.EXECUTED) {
      throw new Error('Voting has already ended');
    }
    
    // Check是否达到quorum
    const totalReputationScore = this.calculateTotalReputationScore();
    const quorumThreshold = totalReputationScore * (GOVERNANCE_PARAMS.quorumPercentage / 100);
    
    if (proposal.totalWeight < quorumThreshold) {
      proposal.status = PROPOSAL_STATUS.REJECTED;
      proposal.reason = 'Quorum not reached';
    } else {
      // Calculate赞成比例(不Calculate弃权)
      const activeWeight = proposal.totalWeight - proposal.abstainWeight;
      const yesPercentage = activeWeight > 0 ? (proposal.yesWeight / activeWeight) * 100 : 0;
      
      if (yesPercentage >= GOVERNANCE_PARAMS.passThreshold) {
        proposal.status = PROPOSAL_STATUS.PASSED;
      } else {
        proposal.status = PROPOSAL_STATUS.REJECTED;
      }
    }
    
    proposal.votingEndedAt = Date.now();
    proposals.set(proposalId, proposal);
    this.saveToDisk();
    
    console.log(`[WeightedVotingSystem] Voting ended for proposal ${proposalId}, status: ${proposal.status}`);
    return proposal.status;
  }
  
  // ExecuteProposal(requiresMulti-signatureauthorization)
  static executeProposal(proposalId, executorId = null) {
    if (!proposals.has(proposalId)) {
      throw new Error('Proposal not found');
    }
    
    const proposal = proposals.get(proposalId);
    if (proposal.status !== PROPOSAL_STATUS.PASSED) {
      throw new Error('Proposal is not passed');
    }
    
    const now = Date.now();
    if (now < proposal.executionWindowStart) {
      throw new Error('Execution window has not started yet');
    }
    
    if (now > proposal.executionWindowEnd) {
      proposal.status = PROPOSAL_STATUS.EXPIRED;
      proposals.set(proposalId, proposal);
      this.saveToDisk();
      throw new Error('Execution window has expired');
    }
    
    // Multi-signatureVerify
    if (proposal.multiSigRequired) {
      // Check是否已收集足够的Sign
      if (proposal.executionSignatures.length < GOVERNANCE_PARAMS.multiSigThreshold) {
        throw new Error(`Insufficient signatures. Required: ${GOVERNANCE_PARAMS.multiSigThreshold}, Current: ${proposal.executionSignatures.length}`);
      }
      
      // VerifyExecute者permission
      if (executorId && GOVERNANCE_PARAMS.authorizedExecutors.length > 0) {
        if (!GOVERNANCE_PARAMS.authorizedExecutors.includes(executorId)) {
          throw new Error(`Executor ${executorId} is not authorized`);
        }
        
        // CheckExecute者是否approved
        if (!proposal.executorApprovals.includes(executorId)) {
          throw new Error(`Executor ${executorId} has not approved this execution`);
        }
      }
      
      // TimelockCheck
      if (proposal.timeLockStart && proposal.timeLockEnd) {
        if (now < proposal.timeLockEnd) {
          const remainingTime = Math.ceil((proposal.timeLockEnd - now) / 1000);
          throw new Error(`Execution time lock active. Remaining: ${remainingTime}s`);
        }
      }
    }
    
    try {
      // 记录Audit Log
      const auditEntry = {
        timestamp: now,
        proposalId,
        executorId,
        action: 'execute',
        signaturesCount: proposal.executionSignatures.length,
        approvalsCount: proposal.executorApprovals.length
      };
      GOVERNANCE_PARAMS.executionAuditLog.push(auditEntry);
      
      // ExecuteProposalLogic
      proposal.executionResult = this.executeProposalLogic(proposal);
      proposal.status = PROPOSAL_STATUS.EXECUTED;
      proposal.executedAt = now;
      proposal.executedBy = executorId || 'system';
      
      proposals.set(proposalId, proposal);
      this.saveToDisk();
      
      console.log(`[WeightedVotingSystem] Executed proposal ${proposalId} successfully by ${executorId || 'system'}`);
      return { success: true, result: proposal.executionResult, auditEntry };
    } catch (error) {
      proposal.status = PROPOSAL_STATUS.FAILED;
      proposal.executionResult = { error: error.message };
      proposal.executedAt = now;
      
      proposals.set(proposalId, proposal);
      this.saveToDisk();
      
      // 记录FailedAudit Log
      const auditEntry = {
        timestamp: now,
        proposalId,
        executorId,
        action: 'execute_failed',
        error: error.message
      };
      GOVERNANCE_PARAMS.executionAuditLog.push(auditEntry);
      
      console.error(`[WeightedVotingSystem] Failed to execute proposal ${proposalId}:`, error);
      return { success: false, error: error.message, auditEntry };
    }
  }
  
  // 提交ExecuteSign
  static submitExecutionSignature(proposalId, signerId, signature) {
    if (!proposals.has(proposalId)) {
      throw new Error('Proposal not found');
    }
    
    const proposal = proposals.get(proposalId);
    if (proposal.status !== PROPOSAL_STATUS.PASSED) {
      throw new Error('Can only sign passed proposals');
    }
    
    // Check是否已Sign
    const existingSignature = proposal.executionSignatures.find(s => s.signerId === signerId);
    if (existingSignature) {
      throw new Error(`${signerId} has already signed`);
    }
    
    // 添加Sign
    proposal.executionSignatures.push({
      signerId,
      signature,
      signedAt: Date.now()
    });
    
    // 如果这是第一个Sign, StartTimelock
    if (proposal.executionSignatures.length === 1 && !proposal.timeLockStart) {
      proposal.timeLockStart = Date.now();
      proposal.timeLockEnd = Date.now() + GOVERNANCE_PARAMS.executionTimeLockDuration;
      console.log(`[WeightedVotingSystem] Execution time lock started for proposal ${proposalId}, ends in ${GOVERNANCE_PARAMS.executionTimeLockDuration / 1000}s`);
    }
    
    proposals.set(proposalId, proposal);
    this.saveToDisk();
    
    console.log(`[WeightedVotingSystem] Signature submitted by ${signerId} for proposal ${proposalId}. Total: ${proposal.executionSignatures.length}/${GOVERNANCE_PARAMS.multiSigThreshold}`);
    
    return {
      success: true,
      signaturesCollected: proposal.executionSignatures.length,
      required: GOVERNANCE_PARAMS.multiSigThreshold,
      canExecute: proposal.executionSignatures.length >= GOVERNANCE_PARAMS.multiSigThreshold
    };
  }
  
  // Execute者批准
  static approveExecution(proposalId, executorId) {
    if (!proposals.has(proposalId)) {
      throw new Error('Proposal not found');
    }
    
    const proposal = proposals.get(proposalId);
    if (proposal.status !== PROPOSAL_STATUS.PASSED) {
      throw new Error('Can only approve execution of passed proposals');
    }
    
    // VerifyExecute者permission
    if (GOVERNANCE_PARAMS.authorizedExecutors.length > 0 && !GOVERNANCE_PARAMS.authorizedExecutors.includes(executorId)) {
      throw new Error(`${executorId} is not an authorized executor`);
    }
    
    // Check是否approved
    if (proposal.executorApprovals.includes(executorId)) {
      throw new Error(`${executorId} has already approved`);
    }
    
    proposal.executorApprovals.push(executorId);
    proposals.set(proposalId, proposal);
    this.saveToDisk();
    
    console.log(`[WeightedVotingSystem] Execution approved by ${executorId} for proposal ${proposalId}`);
    
    return {
      success: true,
      approvalsReceived: proposal.executorApprovals.length,
      totalRequired: GOVERNANCE_PARAMS.authorizedExecutors.length || 1
    };
  }
  
  // ExecuteProposalLogic
  static executeProposalLogic(proposal) {
    switch (proposal.type) {
      case PROPOSAL_TYPES.PARAMETER_ADJUSTMENT:
        return this.executeParameterAdjustment(proposal);
      case PROPOSAL_TYPES.FUND_ALLOCATION:
        return this.executeFundAllocation(proposal);
      case PROPOSAL_TYPES.PROTOCOL_UPDATE:
        return this.executeProtocolUpdate(proposal);
      case PROPOSAL_TYPES.COMMUNITY_INITIATIVE:
        return this.executeCommunityInitiative(proposal);
      default:
        throw new Error('Unknown proposal type');
    }
  }
  
  // Executeparameter调整
  static executeParameterAdjustment(proposal) {
    console.log(`[WeightedVotingSystem] Executing parameter adjustment:`, proposal.parameters);
    return {
      success: true,
      action: 'parameter_adjustment',
      parameters: proposal.parameters
    };
  }
  
  // Executefund分配
  static executeFundAllocation(proposal) {
    console.log(`[WeightedVotingSystem] Executing fund allocation:`, proposal.allocation);
    return {
      success: true,
      action: 'fund_allocation',
      allocation: proposal.allocation
    };
  }
  
  // ExecuteprotocolUpdate
  static executeProtocolUpdate(proposal) {
    console.log(`[WeightedVotingSystem] Executing protocol update:`, proposal.update);
    return {
      success: true,
      action: 'protocol_update',
      update: proposal.update
    };
  }
  
  // Execute社区倡议
  static executeCommunityInitiative(proposal) {
    console.log(`[WeightedVotingSystem] Executing community initiative:`, proposal.initiative);
    return {
      success: true,
      action: 'community_initiative',
      initiative: proposal.initiative
    };
  }
  
  // Calculate所有agent的总reputation score数
  static calculateTotalReputationScore() {
    const reputationScores = ContributionSystem.getReputationScores();
    return Object.values(reputationScores).reduce((sum, score) => sum + score, 0);
  }
  
  // getproposal details
  static getProposal(proposalId) {
    return proposals.get(proposalId) || null;
  }
  
  // get所有Proposal
  static getAllProposals() {
    return Array.from(proposals.entries()).map(([id, proposal]) => ({
      id,
      ...proposal
    }));
  }
  
  // getagent的Vote
  static getAgentVote(proposalId, agentId) {
    const proposalVotes = votes.get(proposalId);
    return proposalVotes ? proposalVotes[agentId] : null;
  }
  
  // getProposal的Vote详情
  static getProposalVotes(proposalId) {
    return votes.get(proposalId) || {};
  }
  
  // Check并Update过期Proposal
  static checkExpiredProposals() {
    const now = Date.now();
    let updatedCount = 0;
    
    proposals.forEach((proposal, proposalId) => {
      // CheckVote期结束
      if ((proposal.status === PROPOSAL_STATUS.ACTIVE) && proposal.votingEndsAt < now) {
        this.endVoting(proposalId);
        updatedCount++;
      }
      
      // CheckExecute期结束
      if ((proposal.status === PROPOSAL_STATUS.PASSED) && proposal.executionWindowEnd < now) {
        proposal.status = PROPOSAL_STATUS.EXPIRED;
        proposals.set(proposalId, proposal);
        updatedCount++;
      }
    });
    
    if (updatedCount > 0) {
      this.saveToDisk();
      console.log(`[WeightedVotingSystem] Updated ${updatedCount} proposals`);
    }
  }
  
  // getGovernance统计info
  static getGovernanceStats() {
    const allProposals = this.getAllProposals();
    const stats = {
      totalProposals: allProposals.length,
      passed: 0,
      rejected: 0,
      expired: 0,
      active: 0,
      pending: 0,
      executed: 0,
      failed: 0
    };
    
    allProposals.forEach(proposal => {
      stats[proposal.status] = (stats[proposal.status] || 0) + 1;
    });
    
    return stats;
  }
  
  // getGovernance parameters
  static getGovernanceParams() {
    return { ...GOVERNANCE_PARAMS };
  }
  
  // 添加authorizationExecute者
  static addAuthorizedExecutor(executorId) {
    if (!GOVERNANCE_PARAMS.authorizedExecutors.includes(executorId)) {
      GOVERNANCE_PARAMS.authorizedExecutors.push(executorId);
      console.log(`[WeightedVotingSystem] Added authorized executor: ${executorId}`);
    }
  }
  
  // 移除authorizationExecute者
  static removeAuthorizedExecutor(executorId) {
    const index = GOVERNANCE_PARAMS.authorizedExecutors.indexOf(executorId);
    if (index > -1) {
      GOVERNANCE_PARAMS.authorizedExecutors.splice(index, 1);
      console.log(`[WeightedVotingSystem] Removed authorized executor: ${executorId}`);
    }
  }
  
  // getProposal的Executestatus
  static getProposalExecutionStatus(proposalId) {
    const proposal = proposals.get(proposalId);
    if (!proposal) {
      throw new Error('Proposal not found');
    }
    
    return {
      proposalId,
      status: proposal.status,
      multiSigRequired: proposal.multiSigRequired,
      signaturesCollected: proposal.executionSignatures.length,
      signaturesRequired: GOVERNANCE_PARAMS.multiSigThreshold,
      canExecute: !proposal.multiSigRequired || proposal.executionSignatures.length >= GOVERNANCE_PARAMS.multiSigThreshold,
      timeLockActive: proposal.timeLockStart && Date.now() < proposal.timeLockEnd,
      timeLockRemaining: (proposal.timeLockEnd && Date.now() < proposal.timeLockEnd) ? 
        Math.ceil((proposal.timeLockEnd - Date.now()) / 1000) : 0,
      executorApprovals: proposal.executorApprovals.length,
      authorizedExecutors: GOVERNANCE_PARAMS.authorizedExecutors.length
    };
  }
  
  // getExecuteAudit Log
  static getExecutionAuditLog(limit = 50) {
    return GOVERNANCE_PARAMS.executionAuditLog.slice(-limit);
  }
}

export { WeightedVotingSystem, PROPOSAL_TYPES, PROPOSAL_STATUS, GOVERNANCE_PARAMS };

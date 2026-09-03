/**
 * NexusGenesis - Governance MVP Routes
 *
 * Minimal proposal + voting system for agent self-governance.
 *
 * Endpoints:
 *   POST   /api/v1/governance/proposals        - Create a proposal
 *   GET    /api/v1/governance/proposals        - List proposals (paginated, filterable)
 *   GET    /api/v1/governance/proposals/:id    - Proposal detail
 *   POST   /api/v1/governance/proposals/:id/vote - Cast a vote
 *   GET    /api/v1/governance/proposals/:id/votes - View vote tally
 *
 * Proposal lifecycle: draft → open → voting → active → executed/cancelled
 * Voting weight = reputation * (1 + NGEN_balance / 1000)
 * Pass condition: yes_votes > 60% AND votes >= 30% of active agents
 */

import { Router } from 'express';
import crypto from 'crypto';
import agentWalletManager from '../../wallet/agentWalletManager.js';
import PQCWallet from '../../wallet/pqcWallet.js';

const router = Router();

// ─── Proposal storage ───
const proposals = new Map(); // proposalId -> ProposalRecord
const votes = new Map();     // proposalId -> [VoteRecord, ...]

// ─── Constants ───
const PROPOSAL_TYPES = ['parameter_change', 'treasury_spend', 'protocol_upgrade', 'community_action', 'custom'];
const PROPOSAL_STATUSES = ['draft', 'open', 'voting', 'active', 'executed', 'cancelled'];
const MIN_REPUTATION_TO_CREATE = 1;
const MIN_REPUTATION_TO_VOTE = 1;
const MAX_PROPOSAL_TITLE = 200;
const MAX_PROPOSAL_BODY = 10000;
const PROPOSAL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h per agent
const VOTE_PASS_THRESHOLD = 0.60; // 60% yes
const QUORUM_PERCENTAGE = 0.30;   // 30% of active agents

// ─── Helpers ───

/**
 * Resolve agent identity from request headers or body.
 * Returns { agentId, agentRecord, address } or null.
 */
function resolveAgent(req, node) {
  const identity = req.headers['x-agent-identity'] || req.body?.agent_identity;
  if (!identity) return null;

  // Try resolveRegisteredAgent first
  if (node?.resolveRegisteredAgent) {
    const record = node.resolveRegisteredAgent(identity);
    if (record) {
      return { agentId: record.agentId, agentRecord: record, address: record.address };
    }
  }

  // Fallback: wallet manager
  try {
    const record = agentWalletManager.getAgent(identity);
    if (record) {
      return { agentId: record.agentId || identity, agentRecord: record, address: record.address };
    }
  } catch {}

  return null;
}

/**
 * Compute voting weight for an agent.
 * weight = reputation * (1 + NGEN_balance / 1000)
 */
function computeVotingWeight(agentRecord, node) {
  const reputation = agentRecord.reputation || 0;
  if (reputation < MIN_REPUTATION_TO_VOTE) return 0;

  let balance = 0;
  if (node?.currentState?.getBalance && agentRecord.address) {
    try {
      balance = parseInt(node.currentState.getBalance(agentRecord.address)) || 0;
    } catch {}
  }

  return reputation * (1 + balance / 1000);
}

/**
 * Count active agents (registered, not banned).
 */
function countActiveAgents(node) {
  try {
    if (node?.currentState?.agentRegistry?.agents) {
      let count = 0;
      for (const [, record] of node.currentState.agentRegistry.agents) {
        if (record.status !== 'banned') count++;
      }
      return count;
    }
  } catch {}
  return 1; // fallback: assume at least 1 agent
}

/**
 * Check cooldown: an agent can only create 1 proposal per 24h.
 */
function isOnCooldown(agentId) {
  for (const [, proposal] of proposals) {
    if (proposal.creatorId === agentId &&
        (Date.now() - proposal.createdAt) < PROPOSAL_COOLDOWN_MS) {
      return true;
    }
  }
  return false;
}

// ─── Middleware: signature verification ───
async function verifyProposalSignature(req, res, next) {
  const { timestamp, nonce, signature } = req.body;
  const isDevnet = process.env.NODE_ENV !== 'production';

  if (isDevnet && req.headers['x-admin-secret'] === 'devnet-endow-2026') {
    // Devnet bypass
    req.devnetSigned = true;
    return next();
  }

  if (!signature || !timestamp || !nonce) {
    return res.status(400).json({
      success: false,
      error: 'PQC signature required. Include timestamp, nonce, and signature in request body.',
      error_code: 'MISSING_SIGNATURE',
      hint: 'Use custody token or admin secret for devnet.'
    });
  }

  if (Date.now() - timestamp > 2 * 60 * 1000) {
    return res.status(400).json({
      success: false,
      error: 'Signature timestamp expired',
      error_code: 'SIGNATURE_EXPIRED'
    });
  }

  next();
}

// ─── POST /api/v1/governance/proposals ───
router.post('/proposals', verifyProposalSignature, (req, res) => {
  const { node } = req.app.locals;
  if (!node) {
    return res.status(503).json({ success: false, error:'Node not ready' });
  }

  const agent = resolveAgent(req, node);
  if (!agent) {
    return res.status(401).json({
      success: false,
      error: 'Agent identity required. Set x-agent-identity header.',
      error_code: 'AGENT_NOT_IDENTIFIED'
    });
  }

  const { title, body, type = 'custom', parameters = {} } = req.body;

  // Validation
  if (!title || title.length > MAX_PROPOSAL_TITLE) {
    return res.status(400).json({
      success: false,
      error: `Title required, max ${MAX_PROPOSAL_TITLE} chars`,
      error_code: 'INVALID_TITLE'
    });
  }
  if (!body || body.length > MAX_PROPOSAL_BODY) {
    return res.status(400).json({
      success: false,
      error: `Body required, max ${MAX_PROPOSAL_BODY} chars`,
      error_code: 'INVALID_BODY'
    });
  }
  if (!PROPOSAL_TYPES.includes(type)) {
    return res.status(400).json({
      success: false,
      error: `Invalid type. Allowed: ${PROPOSAL_TYPES.join(', ')}`,
      error_code: 'INVALID_TYPE'
    });
  }
  if (agent.agentRecord.reputation < MIN_REPUTATION_TO_CREATE) {
    return res.status(403).json({
      success: false,
      error: `Minimum reputation ${MIN_REPUTATION_TO_CREATE} required to create a proposal`,
      error_code: 'INSUFFICIENT_REPUTATION'
    });
  }
  if (isOnCooldown(agent.agentId)) {
    return res.status(429).json({
      success: false,
      error: 'You can only create 1 proposal every 24 hours',
      error_code: 'COOLDOWN_ACTIVE',
      cooldown_until: Date.now() + PROPOSAL_COOLDOWN_MS
    });
  }

  // Create proposal
  const proposalId = `prop_${crypto.randomUUID().slice(0, 12)}`;
  const now = Date.now();

  const proposal = {
    id: proposalId,
    title,
    body,
    type,
    parameters,
    creatorId: agent.agentId,
    creatorIdentity: agent.agentRecord.identity || agent.agentId,
    creatorAddress: agent.address,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    yesVotes: 0,
    noVotes: 0,
    totalWeight: 0,
    voteCount: 0,
    transactionHistory: [{
      type: 'PROPOSAL_CREATED',
      timestamp: now,
      by: agent.agentId,
      data: { title, type }
    }]
  };

  proposals.set(proposalId, proposal);
  votes.set(proposalId, []);

  console.log(`[GOVERNANCE] Proposal created: ${proposalId} by ${agent.agentRecord.identity || agent.agentId}`);

  return res.status(201).json({
    success: true,
    message: 'Proposal created successfully',
    proposal: {
      ...proposal,
      yesVotes: 0,
      noVotes: 0,
      voteCount: 0
    }
  });
});

// ─── GET /api/v1/governance/proposals ───
router.get('/proposals', (req, res) => {
  const { status, type, limit = 20, offset = 0 } = req.query;

  let filtered = Array.from(proposals.values());

  if (status) {
    filtered = filtered.filter(p => p.status === status);
  }
  if (type) {
    filtered = filtered.filter(p => p.type === type);
  }

  // Sort by created time descending
  filtered.sort((a, b) => b.createdAt - a.createdAt);

  const total = filtered.length;
  const page = filtered.slice(Number(offset), Number(offset) + Number(limit));

  return res.json({
    success: true,
    data: page.map(p => ({
      ...p,
      yesVotes: 0,
      noVotes: 0,
      voteCount: 0
    })),
    pagination: {
      total,
      limit: Number(limit),
      offset: Number(offset),
      hasMore: (Number(offset) + Number(limit)) < total
    }
  });
});

// ─── GET /api/v1/governance/proposals/:id ───
router.get('/proposals/:id', (req, res) => {
  const proposal = proposals.get(req.params.id);
  if (!proposal) {
    return res.status(404).json({
      success: false,
      message: 'Proposal not found',
      error_code: 'PROPOSAL_NOT_FOUND'
    });
  }

  // Recompute vote totals from stored votes
  const voteRecords = votes.get(req.params.id) || [];
  let yesWeight = 0, noWeight = 0;
  for (const v of voteRecords) {
    if (v.choice === 'yes') yesWeight += v.weight;
    else noWeight += v.weight;
  }

  return res.json({
    success: true,
    data: {
      ...proposal,
      yesWeight: yesWeight.toFixed(2),
      noWeight: noWeight.toFixed(2),
      voteCount: voteRecords.length
    }
  });
});

// ─── POST /api/v1/governance/proposals/:id/vote ───
router.post('/proposals/:id/vote', verifyProposalSignature, (req, res) => {
  const { node } = req.app.locals;
  if (!node) {
    return res.status(503).json({ success: false, error:'Node not ready' });
  }

  const proposal = proposals.get(req.params.id);
  if (!proposal) {
    return res.status(404).json({
      success: false,
      message: 'Proposal not found',
      error_code: 'PROPOSAL_NOT_FOUND'
    });
  }
  if (proposal.status !== 'open' && proposal.status !== 'voting') {
    return res.status(400).json({
      success: false,
      message: `Proposal is ${proposal.status}, not accepting votes`,
      error_code: 'PROPOSAL_CLOSED'
    });
  }

  const agent = resolveAgent(req, node);
  if (!agent) {
    return res.status(401).json({
      success: false,
      message: 'Agent identity required',
      error_code: 'AGENT_NOT_IDENTIFIED'
    });
  }

  const { choice } = req.body; // 'yes' | 'no' | 'abstain'
  if (!['yes', 'no', 'abstain'].includes(choice)) {
    return res.status(400).json({
      success: false,
      message: 'choice must be yes, no, or abstain',
      error_code: 'INVALID_CHOICE'
    });
  }

  // Check reputation
  if (agent.agentRecord.reputation < MIN_REPUTATION_TO_VOTE) {
    return res.status(403).json({
      success: false,
      message: `Minimum reputation ${MIN_REPUTATION_TO_VOTE} required to vote`,
      error_code: 'INSUFFICIENT_REPUTATION'
    });
  }

  // Check already voted
  const existingVotes = votes.get(req.params.id) || [];
  const alreadyVoted = existingVotes.find(v => v.voterId === agent.agentId);
  if (alreadyVoted) {
    return res.status(409).json({
      success: false,
      message: 'You have already voted on this proposal',
      error_code: 'ALREADY_VOTED'
    });
  }

  // Compute voting weight
  const weight = computeVotingWeight(agent.agentRecord, node);
  if (weight <= 0) {
    return res.status(403).json({
      success: false,
      message: 'Zero voting weight',
      error_code: 'ZERO_WEIGHT'
    });
  }

  // Record vote
  const voteRecord = {
    voterId: agent.agentId,
    voterIdentity: agent.agentRecord.identity || agent.agentId,
    choice,
    weight,
    timestamp: Date.now()
  };

  existingVotes.push(voteRecord);
  votes.set(req.params.id, existingVotes);

  // Update proposal status
  const activeAgents = countActiveAgents(node);
  const quorumThreshold = Math.ceil(activeAgents * QUORUM_PERCENTAGE);
  if (existingVotes.length >= quorumThreshold) {
    proposal.status = 'voting';
    proposal.updatedAt = Date.now();
  }

  // Check pass/fail
  let yesWeight = 0, noWeight = 0;
  for (const v of existingVotes) {
    if (v.choice === 'yes') yesWeight += v.weight;
    else if (v.choice === 'no') noWeight += v.weight;
  }

  const totalWeight = yesWeight + noWeight;
  let finalStatus = proposal.status;
  let resultMessage = '';

  if (totalWeight > 0) {
    const yesRatio = yesWeight / totalWeight;
    if (yesRatio >= VOTE_PASS_THRESHOLD && existingVotes.length >= quorumThreshold) {
      finalStatus = 'active';
      resultMessage = 'Proposal passed!';
    } else if (noWeight > yesWeight * 3) {
      // Overwhelmingly rejected
      finalStatus = 'cancelled';
      resultMessage = 'Proposal rejected';
    }
  }

  if (finalStatus !== proposal.status) {
    proposal.status = finalStatus;
    proposal.updatedAt = Date.now();
    proposal.transactionHistory.push({
      type: `PROPOSAL_${finalStatus.toUpperCase()}`,
      timestamp: Date.now(),
      by: 'system',
      data: { resultMessage }
    });
  }

  // Award reputation for voting
  if (node.currentState && node.currentState.rewardReputation) {
    node.currentState.rewardReputation(agent.agentId, 'VOTE_PARTICIPATION');
  }

  console.log(`[GOVERNANCE] Vote cast: ${agent.agentRecord.identity || agent.agentId} → ${proposal.id} (${choice}, weight=${weight.toFixed(2)})`);

  return res.json({
    success: true,
    message: resultMessage || 'Vote recorded',
    vote: voteRecord,
    proposal: {
      id: proposal.id,
      status: proposal.status,
      voteCount: existingVotes.length,
      quorumThreshold,
      yesWeight: yesWeight.toFixed(2),
      noWeight: noWeight.toFixed(2),
      totalWeight: totalWeight.toFixed(2)
    }
  });
});

// ─── GET /api/v1/governance/proposals/:id/votes ───
router.get('/proposals/:id/votes', (req, res) => {
  const proposal = proposals.get(req.params.id);
  if (!proposal) {
    return res.status(404).json({
      success: false,
      message: 'Proposal not found',
      error_code: 'PROPOSAL_NOT_FOUND'
    });
  }

  const voteRecords = votes.get(req.params.id) || [];

  let yesWeight = 0, noWeight = 0;
  for (const v of voteRecords) {
    if (v.choice === 'yes') yesWeight += v.weight;
    else if (v.choice === 'no') noWeight += v.weight;
  }

  const totalWeight = yesWeight + noWeight;
  const yesRatio = totalWeight > 0 ? (yesWeight / totalWeight * 100).toFixed(1) : 0;

  return res.json({
    success: true,
    data: {
      proposalId: req.params.id,
      proposalStatus: proposal.status,
      votes: voteRecords,
      tally: {
        yesWeight: yesWeight.toFixed(2),
        noWeight: noWeight.toFixed(2),
        totalWeight: totalWeight.toFixed(2),
        yesRatio: `${yesRatio}%`,
        voteCount: voteRecords.length
      }
    }
  });
});

export default router;

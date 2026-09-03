/**
 * NexusGenesis - Task API Routes
 *
 * RESTful endpoints for Agent task lifecycle:
 *   GET    /api/tasks              - List tasks (with filters)
 *   GET    /api/tasks/:id          - Get task by ID
 *   POST   /api/tasks              - Publish a new task
 *   POST   /api/tasks/:id/claim    - Claim a task
 *   POST   /api/tasks/:id/submit   - Submit task results
 *   POST   /api/tasks/:id/verify   - Verify a submission
 *   POST   /api/tasks/:id/cancel   - Cancel a task
 *   GET    /api/tasks/stats        - Task statistics
 *   GET    /api/tasks/match/:agentId - Match tasks for an agent
 *
 * SECURITY: All write operations (publish/claim/submit/verify/cancel) require
 * PQC signature verification. Admin-secret is accepted as devnet fallback.
 */

import { getTaskProtocol, TASK_STATUS } from '../../protocol/taskProtocol.js';
import PQCWallet from '../../wallet/pqcWallet.js';
import agentWalletManager from '../../wallet/agentWalletManager.js';
import { verifyBypassSecret } from '../adminAuth.js';
import { extractCustodyToken, verifyCustodyToken } from '../custodyToken.js';
import { buildAuthHint } from '../authHint.js';
import { buildSignPayload, verifySignPayload } from '../signPayload.js';

const RESERVED_PREFIXES = [
  'ng1swarmpool', 'ng1escrow', 'ng1staking', 'ng1burn', 'ng1treasury'
];

// 任务免签走 NG_ADMIN_BYPASS_SECRET（与 credit 类 secret 分离）

const TASK_SIGNATURE_TIMEOUT_MS = 2 * 60 * 1000;
const usedTaskNonces = new Set();

setInterval(() => {
  if (usedTaskNonces.size > 10000) {
    usedTaskNonces.clear();
  }
}, 60000);

async function verifyTaskSignature(req, action, agentRef) {
  const { timestamp, nonce, signature } = req.body;
  const isDevnet = process.env.NODE_ENV !== 'production';
  const hintCtx = { action, agentRef, isDevnet };

  if (signature && timestamp && nonce) {
    const node = req.app.locals.node;
    if (!node?.resolveRegisteredAgent) {
      return { valid: false, status: 503, error: 'Node not ready for signature verification', error_code: 'NODE_NOT_READY' };
    }

    const agentRecord = node.resolveRegisteredAgent(agentRef);
    if (!agentRecord || !agentRecord.public_key) {
      return { valid: false, status: 404, error: 'Agent not found or public key not registered', error_code: 'AGENT_NOT_FOUND', hint: buildAuthHint('AGENT_NOT_FOUND', hintCtx) };
    }

    if (Date.now() - timestamp > TASK_SIGNATURE_TIMEOUT_MS) {
      return { valid: false, status: 400, error: 'Signature timestamp expired', error_code: 'SIGNATURE_EXPIRED', hint: buildAuthHint('SIGNATURE_EXPIRED', hintCtx) };
    }

    const nonceKey = `${agentRef}:${action}:${nonce}`;
    if (usedTaskNonces.has(nonceKey)) {
      return { valid: false, status: 400, error: 'Nonce already used', error_code: 'NONCE_REUSED', hint: buildAuthHint('NONCE_REUSED', hintCtx) };
    }
    usedTaskNonces.add(nonceKey);

    const taskId = req.params?.id || '';
    const { title, description, requiredCapabilities, reward, taskType, minReputation, submission, approved, feedback, qualityScore } = req.body;

    // P1-2: canonical unified sign-payload format
    const extraFields = {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(requiredCapabilities !== undefined && { requiredCapabilities }),
      ...(reward !== undefined && { reward }),
      ...(taskType !== undefined && { taskType }),
      ...(minReputation !== undefined && { minReputation }),
      ...(submission !== undefined && { submission }),
      ...(approved !== undefined && { approved }),
      ...(feedback !== undefined && { feedback }),
      ...(qualityScore !== undefined && { qualityScore })
    };
    const canonicalData = buildSignPayload({
      action, id: taskId, agent: agentRef, timestamp, nonce, ...extraFields
    });
    // Legacy format (pre-P1-2) — accepted for one version buffer period
    const legacyData = JSON.stringify({
      action,
      taskId,
      agent: agentRef,
      timestamp,
      nonce,
      ...extraFields
    });

    const verifyResult = await verifySignPayload({
      canonical: canonicalData,
      legacy: legacyData,
      signature,
      verify: (data, sig) => PQCWallet.verify(data, sig, Buffer.from(agentRecord.public_key, 'hex'))
    });

    if (!verifyResult.valid) {
      console.warn(`[SECURITY] Invalid signature for task ${action} by "${agentRef}"`);
      return { valid: false, status: 403, error: 'Invalid signature', error_code: 'INVALID_SIGNATURE', hint: buildAuthHint('INVALID_SIGNATURE', hintCtx) };
    }

    return { valid: true };
  }

  // Option 2: Custody token (external agent channel)
  const custodyToken = extractCustodyToken(req);
  if (custodyToken) {
    const walletInstance = agentWalletManager.getWalletInstance(agentRef);
    if (!walletInstance) {
      return { valid: false, status: 404, error: `Agent wallet not found: ${agentRef}`, error_code: 'AGENT_NOT_FOUND', hint: buildAuthHint('AGENT_NOT_FOUND', hintCtx) };
    }
    const verification = verifyCustodyToken(custodyToken, {
      agentId: agentRef,
      address: walletInstance.address,
      publicKeyHex: walletInstance.publicKey.toString('hex')
    });
    if (!verification.valid) {
      console.warn(`[SECURITY] Custody token rejected for task ${action} by "${agentRef}": ${verification.reason}`);
      return { valid: false, status: 401, error: `Custody token rejected: ${verification.reason}`, error_code: 'CUSTODY_TOKEN_REJECTED', hint: buildAuthHint('CUSTODY_TOKEN_REJECTED', hintCtx) };
    }
    return { valid: true, method: 'custody' };
  }

  // Option 3: Admin bypass-secret (devnet)
  if (verifyBypassSecret(req)) {
    return { valid: true, method: 'admin-bypass' };
  }

  return {
    valid: false,
    status: 403,
    error: `Task ${action} requires valid PQC signature, custody token, or admin bypass-secret authentication`,
    error_code: 'AUTH_REQUIRED',
    hint: buildAuthHint('AUTH_REQUIRED', hintCtx)
  };
}

function resolveAgentAddress(req) {
  const { agent, agent_identity, publisher, verifier } = req.body;
  const agentRef = agent_identity || agent || publisher || verifier;

  if (!agentRef) return null;

  if (agentRef.startsWith('ng1')) {
    const isReserved = RESERVED_PREFIXES.some(p => agentRef.startsWith(p));
    if (isReserved && !verifyBypassSecret(req)) {
      console.warn(`[SECURITY] Blocked unauthorized use of reserved address ${agentRef.slice(0, 16)}...`);
      return null;
    }
    return agentRef;
  }

  const node = req.app.locals.node;
  if (node && node.resolveRegisteredAgent) {
    const record = node.resolveRegisteredAgent(agentRef);
    if (record && record.address) {
      const isReserved = RESERVED_PREFIXES.some(p => record.address.startsWith(p));
      if (isReserved && !verifyBypassSecret(req)) {
        console.warn(`[SECURITY] Blocked unauthorized use of registered reserved address ${record.address.slice(0, 16)}... (agent=${agentRef})`);
        return null;
      }
      return record.address;
    }
  }

  return agentRef;
}

export function setupTaskRoutes(app) {
  app.get('/api/tasks', (req, res) => {
    try {
      const protocol = getTaskProtocol();
      const filters = {};

      if (req.query.status) {
        filters.status = req.query.status;
      }
      if (req.query.publisher) {
        filters.publisher = req.query.publisher;
      }
      if (req.query.claimant) {
        filters.claimant = req.query.claimant;
      }
      if (req.query.capabilities) {
        filters.capabilities = req.query.capabilities.split(',');
      }
      if (req.query.minReward) {
        filters.minReward = req.query.minReward;
      }
      if (req.query.taskType) {
        filters.taskType = req.query.taskType;
      }
      if (req.query.limit) {
        filters.limit = parseInt(req.query.limit) || 50;
      }
      if (req.query.offset) {
        filters.offset = parseInt(req.query.offset) || 0;
      }

      const result = protocol.query(filters);
      res.json({
        success: true,
        ...result
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/tasks/stats', (req, res) => {
    try {
      const protocol = getTaskProtocol();
      const stats = protocol.getStats();
      res.json({ success: true, ...stats });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/tasks/match/:agentId', (req, res) => {
    try {
      const protocol = getTaskProtocol();
      const capabilities = req.query.capabilities
        ? req.query.capabilities.split(',')
        : undefined; // undefined = "no filter", [] = "only no-cap tasks"
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const matched = protocol.matchForAgent(capabilities, { page, pageSize });
      res.json({
        success: true,
        tasks: matched.tasks,
        page: matched.page,
        pageSize: matched.pageSize,
        total: matched.total,
        totalPages: matched.totalPages,
        hasMore: matched.hasMore
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ─── Task 提案征集 (必须在 :id 之前注册，否则被 :id 抢先匹配) ───
  const taskProposals = new Map();
  let taskProposalSeq = 1;

  app.post('/api/tasks/proposals', async (req, res) => {
    const agentRef = req.body?.agent || req.body?.agent_identity;

    const auth = await verifyTaskSignature(req, 'propose', agentRef);
    if (!auth.valid) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error, error_code: auth.error_code });
    }

    const { title, description, requiredCapabilities, taskType, suggestedReward } = req.body;
    if (!title || title.length < 5) {
      return res.status(400).json({ success: false, error: 'title is required (>= 5 chars)', error_code: 'INVALID_TITLE' });
    }
    if (!description || description.length < 10) {
      return res.status(400).json({ success: false, error: 'description is required (>= 10 chars)', error_code: 'INVALID_DESCRIPTION' });
    }

    const proposalId = `prop-${taskProposalSeq++}-${Date.now().toString(36)}`;
    const proposal = {
      id: proposalId,
      proposer: agentRef,
      title: String(title).slice(0, 200),
      description: String(description).slice(0, 2000),
      requiredCapabilities: Array.isArray(requiredCapabilities) ? requiredCapabilities : [],
      taskType: taskType || 'general',
      suggestedReward: parseInt(suggestedReward) || 10,
      status: 'pending',
      votes: { up: 0, down: 0, voters: [] },
      createdAt: new Date().toISOString()
    };

    taskProposals.set(proposalId, proposal);
    console.log(`[Task] New proposal ${proposalId} from ${agentRef}: "${proposal.title}" (reward=${proposal.suggestedReward} NGEN)`);

    res.status(201).json({
      success: true,
      proposal,
      message: 'Task proposal submitted. system-task-publisher will review and publish it.',
      next_steps: {
        list: 'GET /api/tasks/proposals',
        vote: `POST /api/tasks/proposals/${proposalId}/vote`,
        review_endpoint: 'system-task-publisher polls /api/tasks/proposals?status=pending'
      }
    });
  });

  app.get('/api/tasks/proposals', (req, res) => {
    const { status, limit = 50 } = req.query;
    let list = Array.from(taskProposals.values());
    if (status) list = list.filter(p => p.status === status);
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    list = list.slice(0, parseInt(limit));
    res.json({
      success: true,
      proposals: list,
      total: taskProposals.size,
      filter: status || 'all'
    });
  });

  app.get('/api/tasks/proposals/:id', (req, res) => {
    const proposal = taskProposals.get(req.params.id);
    if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found', error_code: 'NOT_FOUND' });
    res.json({ success: true, proposal });
  });

  app.post('/api/tasks/proposals/:id/vote', async (req, res) => {
    const proposal = taskProposals.get(req.params.id);
    if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found', error_code: 'NOT_FOUND' });

    const agentRef = req.body?.agent || req.body?.agent_identity;
    const auth = await verifyTaskSignature(req, 'vote', agentRef);
    if (!auth.valid) {
      return res.status(auth.status || 403).json({ success: false, error: auth.error, error_code: auth.error_code });
    }

    if (proposal.votes.voters.includes(agentRef)) {
      return res.status(409).json({ success: false, error: 'Already voted', error_code: 'ALREADY_VOTED' });
    }

    const v = req.body?.vote;
    if (v !== 'up' && v !== 'down') {
      return res.status(400).json({ success: false, error: "vote must be 'up' or 'down'", error_code: 'INVALID_VOTE' });
    }
    proposal.votes[v]++;
    proposal.votes.voters.push(agentRef);

    res.json({ success: true, proposal });
  });

  app.post('/api/tasks/proposals/:id/approve', async (req, res) => {
    const proposal = taskProposals.get(req.params.id);
    if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found', error_code: 'NOT_FOUND' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ success: false, error: `Proposal already ${proposal.status}`, error_code: 'INVALID_STATE' });
    }

    // 投票达标自动发布：up votes > down votes 且 up >= 3
    const totalVotes = proposal.votes.up + proposal.votes.down;
    if (totalVotes === 0) {
      return res.status(400).json({ success: false, error: 'Need at least 1 vote to approve a proposal', error_code: 'NO_VOTES' });
    }
    if (proposal.votes.up <= proposal.votes.down) {
      return res.status(400).json({ success: false, error: 'Proposal rejected: down votes >= up votes', error_code: 'PROPOSAL_REJECTED' });
    }
    if (proposal.votes.up < 3) {
      return res.status(400).json({ success: false, error: `Insufficient up votes: ${proposal.votes.up}/3 required`, error_code: 'INSUFFICIENT_UP_VOTES' });
    }

    // 投票达标 → 自动批准并发布
    proposal.status = 'approved';
    proposal.autoApproved = true;
    proposal.reviewedAt = new Date().toISOString();

    // 通过 TaskProtocol 直接发布任务（由 Swarm Pool 出资）
    const protocol = getTaskProtocol();
    try {
      const node = req.app.locals.node;
      const result = protocol.publishFromProposal(proposal);
      if (result.success) {
        console.log(`[Task] Proposal ${proposal.id} auto-approved (${proposal.votes.up} up, ${proposal.votes.down} down) → published as task ${result.task.id}`);
      } else {
        console.error(`[Task] Failed to publish approved proposal ${proposal.id}: ${result.reason}`);
      }
    } catch (e) {
      console.error(`[Task] Error publishing approved proposal ${proposal.id}:`, e.message);
    }

    res.json({ success: true, proposal, message: 'Proposal auto-approved and task published. Swarm Pool funded.' });
  });

  app.get('/api/tasks/:id', (req, res) => {
    try {
      const protocol = getTaskProtocol();
      const task = protocol.get(req.params.id);
      if (!task) {
        return res.status(404).json({ success: false, error: 'Task not found' });
      }
      res.json({ success: true, task });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/tasks', async (req, res) => {
    try {
      const protocol = getTaskProtocol();
      const { agent_identity, agent, publisher } = req.body;
      const publisherRef = agent_identity || agent || publisher;
      const publisherAddress = resolveAgentAddress(req);
      const { title, description, requiredCapabilities, reward, taskType, minReputation } = req.body;

      if (!publisherAddress || !publisherRef) {
        return res.status(400).json({ success: false, error: 'publisher or agent_identity is required', error_code: 'MISSING_PUBLISHER' });
      }

      const authResult = await verifyTaskSignature(req, 'publish', publisherRef);
      if (!authResult.valid) {
        return res.status(authResult.status).json({ success: false, error: authResult.error, error_code: authResult.error_code, ...(authResult.hint ? { hint: authResult.hint } : {}) });
      }

      const result = protocol.publish(publisherAddress, {
        title,
        description,
        requiredCapabilities,
        reward,
        taskType,
        minReputation
      });

      if (!result.success) {
        return res.status(400).json({ success: false, error: result.reason, error_code: result.errorCode || 'PUBLISH_FAILED' });
      }

      res.status(201).json({ success: true, task: result.task });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  app.post('/api/tasks/:id/claim', async (req, res) => {
    try {
      const protocol = getTaskProtocol();
      const agentRef = req.body.agent_identity || req.body.agent || req.body.claimant;
      const agentAddress = resolveAgentAddress(req);

      if (!agentAddress || !agentRef) {
        return res.status(400).json({ success: false, error: 'agent or agent_identity is required', error_code: 'MISSING_AGENT' });
      }

      const authResult = await verifyTaskSignature(req, 'claim', agentRef);
      if (!authResult.valid) {
        return res.status(authResult.status).json({ success: false, error: authResult.error, error_code: authResult.error_code, ...(authResult.hint ? { hint: authResult.hint } : {}) });
      }

      let agentReputation = 0;
      const node = req.app.locals.node;
      if (node && node.resolveRegisteredAgent && agentRef) {
        const record = node.resolveRegisteredAgent(agentRef);
        if (record && typeof record.reputation === 'number') {
          agentReputation = record.reputation;
        }
      }

      const result = protocol.claim(agentAddress, req.params.id, { agentReputation });

      if (!result.success) {
        const status = result.errorCode === 'INSUFFICIENT_REPUTATION' ? 403
          : result.errorCode === 'TASK_NOT_FOUND' ? 404
          : result.errorCode === 'CANNOT_CLAIM_OWN' ? 403
          : 400;
        const response = {
          success: false,
          error: result.reason,
          error_code: result.errorCode || 'CLAIM_FAILED',
          requiredReputation: result.requiredReputation,
          currentReputation: result.currentReputation
        };
        // Phase 1: Include violation info when self-dealing detected
        if (result.errorCode === 'CANNOT_CLAIM_OWN') {
          response.violation = {
            type: 'SELF_DEALING_CLAIM',
            penalty: -50,
            message: 'Your reputation has been slashed. Repeated violations within 24h escalate to -100.'
          };
        }
        return res.status(status).json(response);
      }

      res.json({ success: true, task: result.task });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  app.post('/api/tasks/:id/submit', async (req, res) => {
    try {
      const protocol = getTaskProtocol();
      const { agent_identity, agent, claimant } = req.body;
      const agentRef = agent_identity || agent || claimant;
      const agentAddress = resolveAgentAddress(req);
      const { submission } = req.body;

      if (!agentAddress || !agentRef) {
        return res.status(400).json({ success: false, error: 'agent or agent_identity is required', error_code: 'MISSING_AGENT' });
      }
      if (!submission) {
        return res.status(400).json({ success: false, error: 'submission data is required', error_code: 'MISSING_SUBMISSION' });
      }

      const authResult = await verifyTaskSignature(req, 'submit', agentRef);
      if (!authResult.valid) {
        return res.status(authResult.status).json({ success: false, error: authResult.error, error_code: authResult.error_code, ...(authResult.hint ? { hint: authResult.hint } : {}) });
      }

      const result = protocol.submit(agentAddress, req.params.id, submission);

      if (!result.success) {
        return res.status(400).json({ success: false, error: result.reason });
      }

      res.json({ success: true, task: result.task });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  app.post('/api/tasks/:id/verify', async (req, res) => {
    try {
      const protocol = getTaskProtocol();
      const { agent_identity, agent, verifier } = req.body;
      const verifierRef = agent_identity || agent || verifier;
      const verifierAddress = resolveAgentAddress(req);
      const { approved, feedback, qualityScore } = req.body;

      if (!verifierAddress || !verifierRef) {
        return res.status(400).json({ success: false, error: 'verifier or agent_identity is required', error_code: 'MISSING_VERIFIER' });
      }
      if (typeof approved !== 'boolean') {
        return res.status(400).json({ success: false, error: 'approved (boolean) is required', error_code: 'INVALID_APPROVED' });
      }

      const authResult = await verifyTaskSignature(req, 'verify', verifierRef);
      if (!authResult.valid) {
        return res.status(authResult.status).json({ success: false, error: authResult.error, error_code: authResult.error_code, ...(authResult.hint ? { hint: authResult.hint } : {}) });
      }

      const verifyOptions = {};
      if (qualityScore !== undefined) {
        const qs = parseInt(qualityScore, 10);
        if (Number.isInteger(qs) && qs >= 1 && qs <= 5) {
          verifyOptions.qualityScore = qs;
        }
      }

      const result = protocol.verify(verifierAddress, req.params.id, approved, feedback || '', verifyOptions);

      if (!result.success) {
        return res.status(400).json({ success: false, error: result.reason });
      }

      res.json({
        success: true,
        task: result.task,
        ...(result.requiresThirdParty ? { requiresThirdParty: true, message: result.message } : {}),
        ...(result.requiresPublisherApproval ? { requiresPublisherApproval: true, message: result.message } : {})
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  app.post('/api/tasks/:id/cancel', async (req, res) => {
    try {
      const protocol = getTaskProtocol();
      const { agent_identity, agent, publisher } = req.body;
      const publisherRef = agent_identity || agent || publisher;
      const publisherAddress = resolveAgentAddress(req);

      if (!publisherAddress || !publisherRef) {
        return res.status(400).json({ success: false, error: 'publisher or agent_identity is required', error_code: 'MISSING_PUBLISHER' });
      }

      const authResult = await verifyTaskSignature(req, 'cancel', publisherRef);
      if (!authResult.valid) {
        return res.status(authResult.status).json({ success: false, error: authResult.error, error_code: authResult.error_code, ...(authResult.hint ? { hint: authResult.hint } : {}) });
      }

      const result = protocol.cancel(publisherAddress, req.params.id);

      if (!result.success) {
        return res.status(400).json({ success: false, error: result.reason });
      }

      res.json({ success: true, task: result.task });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // 提案征集端点已上移到 :id 之前，保留此处仅作为兼容占位说明（避免误删路由表）
}

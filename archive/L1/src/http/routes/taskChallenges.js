/**
 * Task Challenges API
 * 
 * Phase 4: Task Challenge Mechanism endpoints.
 * 
 * Endpoints:
 *   POST /api/tasks/:id/challenge                      - Initiate a challenge
 *   GET  /api/tasks/:id/challenge                      - Get active challenge for a task
 *   GET  /api/tasks/:id/challenges                     - Get all challenges for a task
 *   POST /api/tasks/challenges/:challengeId/arbitrate   - Cast arbitration vote
 *   GET  /api/tasks/challenges/:challengeId             - Get challenge detail
 *   POST /api/tasks/:id/finalize                       - Manually finalize (admin only)
 *   POST /api/tasks/finalize-expired                   - Trigger expired-task finalization (admin only)
 *   GET  /api/tasks/challenges                         - List all open challenges
 */

import { Router } from 'express';
import { getTaskProtocol } from '../../protocol/taskProtocol.js';
import { verifyBypassSecret } from '../adminAuth.js';

const router = Router();

/**
 * Resolve an agent reference (string or identity) to a blockchain address.
 * Accepts either an ng1... address directly or a registered agent identity.
 */
function resolveAgentAddress(req, agentRef) {
  if (!agentRef) return null;
  if (agentRef.startsWith('ng1')) return agentRef;
  const node = req.app.locals.node;
  if (!node || typeof node.resolveRegisteredAgent !== 'function') return null;
  const record = node.resolveRegisteredAgent(agentRef);
  return record?.address || null;
}

/**
 * POST /api/tasks/:id/challenge
 * Initiate a challenge against a verified task in CHALLENGE_WINDOW state.
 * Body: { challenger, reason, evidence? }
 */
router.post('/api/tasks/:id/challenge', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { challenger, reason, evidence } = req.body;

    if (!challenger || !reason) {
      return res.status(400).json({ success: false, error: 'challenger and reason are required', error_code: 'INVALID_INPUT' });
    }
    if (!verifyBypassSecret(req)) {
      return res.status(403).json({ success: false, error: 'Admin bypass-secret required', error_code: 'ADMIN_REQUIRED' });
    }

    // Resolve agent identity
    const protocol = getTaskProtocol();
    const challengerAddress = resolveAgentAddress(req, challenger);
    if (!challengerAddress) {
      return res.status(403).json({ success: false, error: 'Invalid challenger identity', error_code: 'INVALID_CHALLENGER' });
    }

    const result = protocol.challenge(challengerAddress, taskId, reason, evidence || '');
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.reason, error_code: result.errorCode });
    }
    res.json({ success: true, challenge: result.challenge });
  } catch (e) {
    console.error('[TaskChallenges] challenge error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/tasks/:id/challenge
 * Get the active challenge for a task (status: open/voting).
 */
router.get('/api/tasks/:id/challenge', (req, res) => {
  try {
    const protocol = getTaskProtocol();
    const task = protocol.tasks?.get(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found', error_code: 'NOT_FOUND' });
    }
    if (!task.challengeId) {
      return res.json({ success: true, challenge: null, taskStatus: task.status });
    }
    const challenge = protocol.getChallenge(task.challengeId);
    if (!challenge) {
      return res.json({ success: true, challenge: null, taskStatus: task.status });
    }
    res.json({ success: true, challenge, taskStatus: task.status, challengeDeadline: task.challengeDeadline });
  } catch (e) {
    console.error('[TaskChallenges] get challenge error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/tasks/:id/challenges
 * Get all challenges (historical + active) for a task.
 */
router.get('/api/tasks/:id/challenges', (req, res) => {
  try {
    const protocol = getTaskProtocol();
    const challenges = protocol.getChallengesForTask(req.params.id);
    res.json({ success: true, challenges, count: challenges.length });
  } catch (e) {
    console.error('[TaskChallenges] list challenges error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/tasks/challenges
 * List all open challenges (for arbitration UI).
 */
router.get('/api/tasks/challenges', (req, res) => {
  try {
    const protocol = getTaskProtocol();
    const challenges = Array.from(protocol._challenges?.values() || [])
      .filter(c => c.status === 'open' || c.status === 'voting')
      .map(c => ({
        ...c,
        // include task context
        task: protocol.tasks?.get(c.taskId) ? {
          id: c.taskId,
          title: protocol.tasks.get(c.taskId).title,
          reward: protocol.tasks.get(c.taskId).reward,
          status: protocol.tasks.get(c.taskId).status
        } : null
      }));
    res.json({ success: true, challenges, count: challenges.length });
  } catch (e) {
    console.error('[TaskChallenges] list all error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/tasks/challenges/:challengeId
 * Get detail of a specific challenge.
 */
router.get('/api/tasks/challenges/:challengeId', (req, res) => {
  try {
    const protocol = getTaskProtocol();
    const challenge = protocol.getChallenge(req.params.challengeId);
    if (!challenge) {
      return res.status(404).json({ success: false, error: 'Challenge not found', error_code: 'NOT_FOUND' });
    }
    res.json({ success: true, challenge });
  } catch (e) {
    console.error('[TaskChallenges] detail error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/tasks/challenges/:challengeId/arbitrate
 * Cast a vote on a challenge. Body: { voter, vote: 'uphold'|'reject'|'abstain' }
 */
router.post('/api/tasks/challenges/:challengeId/arbitrate', async (req, res) => {
  try {
    const challengeId = req.params.challengeId;
    const { voter, vote } = req.body;
    if (!voter || !vote) {
      return res.status(400).json({ success: false, error: 'voter and vote are required', error_code: 'INVALID_INPUT' });
    }
    if (!['uphold', 'reject', 'abstain'].includes(vote)) {
      return res.status(400).json({ success: false, error: 'vote must be uphold|reject|abstain', error_code: 'INVALID_VOTE' });
    }
    if (!verifyBypassSecret(req)) {
      return res.status(403).json({ success: false, error: 'Admin bypass-secret required', error_code: 'ADMIN_REQUIRED' });
    }

    const protocol = getTaskProtocol();
    const voterAddress = resolveAgentAddress(req, voter);
    if (!voterAddress) {
      return res.status(403).json({ success: false, error: 'Invalid voter identity', error_code: 'INVALID_VOTER' });
    }
    const result = protocol.arbitrateChallenge(challengeId, voterAddress, vote);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.reason, error_code: result.errorCode });
    }
    res.json({
      success: true,
      challenge: result.challenge,
      taskStatus: result.taskStatus,
      result: result.result,
      tally: result.tally
    });
  } catch (e) {
    console.error('[TaskChallenges] arbitrate error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/tasks/:id/finalize
 * Manually finalize a task (admin only). Normally auto-finalized after challenge window.
 * Optional body { force: true } to bypass challenge window deadline (emergency).
 */
router.post('/api/tasks/:id/finalize', (req, res) => {
  try {
    if (!verifyBypassSecret(req)) {
      return res.status(403).json({ success: false, error: 'Admin bypass-secret required', error_code: 'ADMIN_REQUIRED' });
    }
    const force = req.body?.force === true;
    const protocol = getTaskProtocol();
    const task = protocol.tasks?.get(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found', error_code: 'NOT_FOUND' });
    }
    if (task.status === 'finalized') {
      return res.json({ success: true, task: protocol._sanitizeTask(task), message: 'Already finalized' });
    }
    if (task.status !== 'challenge_window') {
      return res.status(400).json({ success: false, error: `Task is in status ${task.status}, not challenge_window`, error_code: 'INVALID_STATUS' });
    }
    // Block early finalize unless force=true
    if (!force && task.challengeDeadline && Date.now() < task.challengeDeadline) {
      return res.status(400).json({
        success: false,
        error: `Challenge window not yet expired (deadline=${new Date(task.challengeDeadline).toISOString()}). Use {force: true} to override.`,
        error_code: 'WINDOW_ACTIVE'
      });
    }
    task.status = 'finalized';
    task.finalizedAt = Date.now();
    task.transactionHistory.push({
      type: 'CHALLENGE_RESOLVE',
      timestamp: Date.now(),
      by: 'admin',
      data: { reason: force ? 'manual_finalize_force' : 'manual_finalize' }
    });
    protocol.tasks.set(task.id, task);
    protocol._saveTasks();
    res.json({ success: true, task: protocol._sanitizeTask(task) });
  } catch (e) {
    console.error('[TaskChallenges] finalize error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/tasks/finalize-expired
 * Trigger the periodic expiry check (admin only). Useful for tests and recovery.
 */
router.post('/api/tasks/finalize-expired', (req, res) => {
  try {
    if (!verifyBypassSecret(req)) {
      return res.status(403).json({ success: false, error: 'Admin bypass-secret required', error_code: 'ADMIN_REQUIRED' });
    }
    const protocol = getTaskProtocol();
    const count = protocol.finalizeExpiredTasks();
    res.json({ success: true, finalizedCount: count });
  } catch (e) {
    console.error('[TaskChallenges] finalize-expired error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

export default router;

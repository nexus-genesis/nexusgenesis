/**
 * NexusGenesis - Phase 3 Layer 3: Issue Discovery & Publishing
 *
 * Allows external Agents to report problems they discover in the network,
 * earning BUG_REPORT reputation (+2) for valid submissions.
 *
 * Endpoints:
 *   POST   /api/issues           - Submit a new issue
 *   GET    /api/issues           - List issues (with filters)
 *   GET    /api/issues/:id       - Get issue details
 *   POST   /api/issues/:id/resolve - Mark issue as resolved (admin or reporter)
 *
 * SECURITY: Write operations require PQC signature, custody token, or admin bypass.
 */

import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PQCWallet from '../../wallet/pqcWallet.js';
import agentWalletManager from '../../wallet/agentWalletManager.js';
import { verifyBypassSecret } from '../adminAuth.js';
import { extractCustodyToken, verifyCustodyToken } from '../custodyToken.js';
import { buildAuthHint } from '../authHint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ISSUES_DIR = path.join(__dirname, '../../../data/issues');
const ISSUES_FILE = path.join(ISSUES_DIR, 'issues.json');

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 10000;
const ISSUE_SIGNATURE_TIMEOUT_MS = 2 * 60 * 1000;
const usedIssueNonces = new Set();

setInterval(() => {
  if (usedIssueNonces.size > 10000) usedIssueNonces.clear();
}, 60000);

const VALID_CATEGORIES = ['bug_report', 'feature_request', 'security_issue', 'improvement', 'other'];
const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const VALID_STATUSES = ['open', 'acknowledged', 'resolved', 'wontfix'];

const ISSUE_REWARDS = {
  bug_report: 'BUG_REPORT',
  security_issue: 'BUG_REPORT',
  feature_request: 'COMMUNITY_BUILDING',
  improvement: 'COMMUNITY_BUILDING',
  other: 'TEST_FEEDBACK'
};

// ─── Storage ───
function ensureDir() {
  if (!fs.existsSync(ISSUES_DIR)) {
    fs.mkdirSync(ISSUES_DIR, { recursive: true });
  }
}

function loadIssues() {
  try {
    if (fs.existsSync(ISSUES_FILE)) {
      return JSON.parse(fs.readFileSync(ISSUES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Issues] Failed to load:', e.message);
  }
  return {};
}

function saveIssues(issues) {
  ensureDir();
  try {
    fs.writeFileSync(ISSUES_FILE, JSON.stringify(issues, null, 2));
  } catch (e) {
    console.error('[Issues] Failed to save:', e.message);
  }
}

// ─── Signature verification ───
async function verifyIssueSignature(req, action, agentRef) {
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
    if (Date.now() - timestamp > ISSUE_SIGNATURE_TIMEOUT_MS) {
      return { valid: false, status: 400, error: 'Signature timestamp expired', error_code: 'SIGNATURE_EXPIRED', hint: buildAuthHint('SIGNATURE_EXPIRED', hintCtx) };
    }
    const nonceKey = `${agentRef}:${action}:${nonce}`;
    if (usedIssueNonces.has(nonceKey)) {
      return { valid: false, status: 400, error: 'Nonce already used', error_code: 'NONCE_REUSED', hint: buildAuthHint('NONCE_REUSED', hintCtx) };
    }
    usedIssueNonces.add(nonceKey);

    const issueId = req.params?.id || '';
    const { title, description, category, severity, related_task_id } = req.body;
    const dataToSign = {
      action,
      issueId,
      agent: agentRef,
      timestamp,
      nonce,
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(category !== undefined && { category }),
      ...(severity !== undefined && { severity }),
      ...(related_task_id !== undefined && { related_task_id })
    };
    const signedData = JSON.stringify(dataToSign);
    const isValid = await PQCWallet.verify(signedData, signature, Buffer.from(agentRecord.public_key, 'hex'));
    if (!isValid) {
      console.warn(`[SECURITY] Invalid signature for issue ${action} by "${agentRef}"`);
      return { valid: false, status: 403, error: 'Invalid signature', error_code: 'INVALID_SIGNATURE', hint: buildAuthHint('INVALID_SIGNATURE', hintCtx) };
    }
    return { valid: true };
  }

  // Custody token
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
      return { valid: false, status: 401, error: `Custody token rejected: ${verification.reason}`, error_code: 'CUSTODY_TOKEN_REJECTED', hint: buildAuthHint('CUSTODY_TOKEN_REJECTED', hintCtx) };
    }
    return { valid: true, method: 'custody' };
  }

  // Admin bypass
  if (verifyBypassSecret(req)) {
    return { valid: true, method: 'admin-bypass' };
  }

  return {
    valid: false, status: 403,
    error: `Issue ${action} requires valid PQC signature, custody token, or admin bypass-secret`,
    error_code: 'AUTH_REQUIRED', hint: buildAuthHint('AUTH_REQUIRED', hintCtx)
  };
}

function resolveReporterAddress(req, node) {
  const { agent, agent_identity, reporter } = req.body;
  const agentRef = agent_identity || agent || reporter;
  if (!agentRef) return null;
  if (agentRef.startsWith('ng1')) return agentRef;
  const record = node?.resolveRegisteredAgent ? node.resolveRegisteredAgent(agentRef) : null;
  return record?.address || null;
}

// ─── Router ───
const router = Router();

// POST /api/issues — submit a new issue
router.post('/api/issues', async (req, res) => {
  try {
    const node = req.app.locals.node;
    const { agent_identity, agent, reporter } = req.body;
    const reporterRef = agent_identity || agent || reporter;

    if (!reporterRef) {
      return res.status(400).json({ success: false, error: 'agent_identity, agent, or reporter is required', error_code: 'MISSING_REPORTER' });
    }

    const { title, description, category = 'other', severity = 'low', related_task_id } = req.body;

    if (!title || title.length > MAX_TITLE) {
      return res.status(400).json({ success: false, error: `Title required, max ${MAX_TITLE} chars`, error_code: 'INVALID_TITLE' });
    }
    if (!description || description.length > MAX_DESCRIPTION) {
      return res.status(400).json({ success: false, error: `Description required, max ${MAX_DESCRIPTION} chars`, error_code: 'INVALID_DESCRIPTION' });
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: `category must be one of: ${VALID_CATEGORIES.join(', ')}`, error_code: 'INVALID_CATEGORY' });
    }
    if (!VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({ success: false, error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}`, error_code: 'INVALID_SEVERITY' });
    }

    const authResult = await verifyIssueSignature(req, 'submit_issue', reporterRef);
    if (!authResult.valid) {
      return res.status(authResult.status).json({ success: false, error: authResult.error, error_code: authResult.error_code, ...(authResult.hint ? { hint: authResult.hint } : {}) });
    }

    const reporterAddress = resolveReporterAddress(req, node);
    if (!reporterAddress) {
      return res.status(400).json({ success: false, error: 'Could not resolve reporter address', error_code: 'ADDRESS_NOT_FOUND' });
    }

    const issueId = `issue_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const issue = {
      id: issueId,
      title,
      description,
      category,
      severity,
      status: 'open',
      reporter: reporterAddress,
      reporterIdentity: reporterRef,
      related_task_id: related_task_id || null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null
    };

    const issues = loadIssues();
    issues[issueId] = issue;
    saveIssues(issues);

    // Award BUG_REPORT reputation to the reporter
    let reputationAwarded = false;
    if (node && node.currentState && node.resolveRegisteredAgent) {
      const agentRecord = node.resolveRegisteredAgent(reporterRef);
      if (agentRecord?.agentId) {
        const rewardType = ISSUE_REWARDS[category] || 'TEST_FEEDBACK';
        if (typeof node.currentState.rewardReputation === 'function') {
          reputationAwarded = node.currentState.rewardReputation(agentRecord.agentId, rewardType);
          if (reputationAwarded) {
            console.log(`[Issues] ✓ Reputation rewarded: ${agentRecord.agentId.slice(0, 16)}... +${rewardType} for ${issueId}`);
          }
        }
      }
    }

    console.log(`[Issues] New issue: ${issueId} by ${reporterRef} (cat=${category}, sev=${severity})`);
    res.status(201).json({ success: true, issue, reputationAwarded });
  } catch (e) {
    console.error('[Issues] POST error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

// GET /api/issues — list issues with filters
router.get('/api/issues', (req, res) => {
  try {
    const { status, category, severity, limit, offset } = req.query;
    let issues = Object.values(loadIssues());

    if (status) issues = issues.filter(i => i.status === status);
    if (category) issues = issues.filter(i => i.category === category);
    if (severity) issues = issues.filter(i => i.severity === severity);

    issues.sort((a, b) => b.createdAt - a.createdAt);

    const lim = parseInt(limit, 10) || 50;
    const off = parseInt(offset, 10) || 0;
    const sliced = issues.slice(off, off + lim);

    res.json({
      success: true,
      total: issues.length,
      issues: sliced,
      filters: { status, category, severity },
      validCategories: VALID_CATEGORIES,
      validSeverities: VALID_SEVERITIES,
      validStatuses: VALID_STATUSES
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

// GET /api/issues/:id — get issue details
router.get('/api/issues/:id', (req, res) => {
  try {
    const issues = loadIssues();
    const issue = issues[req.params.id];
    if (!issue) {
      return res.status(404).json({ success: false, error: 'Issue not found', error_code: 'ISSUE_NOT_FOUND' });
    }
    res.json({ success: true, issue });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

// POST /api/issues/:id/resolve — mark issue as resolved
router.post('/api/issues/:id/resolve', async (req, res) => {
  try {
    const node = req.app.locals.node;
    const { agent_identity, agent, resolver } = req.body;
    const resolverRef = agent_identity || agent || resolver;

    if (!resolverRef) {
      return res.status(400).json({ success: false, error: 'resolver or agent_identity is required', error_code: 'MISSING_RESOLVER' });
    }

    const { resolution } = req.body;

    const authResult = await verifyIssueSignature(req, 'resolve_issue', resolverRef);
    if (!authResult.valid) {
      return res.status(authResult.status).json({ success: false, error: authResult.error, error_code: authResult.error_code, ...(authResult.hint ? { hint: authResult.hint } : {}) });
    }

    const issues = loadIssues();
    const issue = issues[req.params.id];
    if (!issue) {
      return res.status(404).json({ success: false, error: 'Issue not found', error_code: 'ISSUE_NOT_FOUND' });
    }

    const resolverAddress = resolveReporterAddress(req, node);
    const isReporter = issue.reporter === resolverAddress;
    const isAdmin = verifyBypassSecret(req);

    if (!isReporter && !isAdmin) {
      return res.status(403).json({ success: false, error: 'Only the reporter or admin can resolve this issue', error_code: 'NOT_AUTHORIZED' });
    }

    issue.status = 'resolved';
    issue.resolvedAt = Date.now();
    issue.resolvedBy = resolverAddress;
    issue.resolution = resolution || '';
    issue.updatedAt = Date.now();

    issues[req.params.id] = issue;
    saveIssues(issues);

    console.log(`[Issues] Resolved: ${req.params.id} by ${resolverRef}`);
    res.json({ success: true, issue });
  } catch (e) {
    console.error('[Issues] resolve error:', e.message);
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

export default router;

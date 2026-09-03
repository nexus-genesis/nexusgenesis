/**
 * Genesis Reserve Multi-Sig API Routes
 *
 * Endpoints:
 *   POST /api/v1/genesis-reserve/propose     — Create a spend proposal
 *   POST /api/v1/genesis-reserve/sign         — Sign a proposal (confirm)
 *   POST /api/v1/genesis-reserve/reject       — Reject a proposal
 *   POST /api/v1/genesis-reserve/cancel       — Cancel a pending proposal
 *   GET  /api/v1/genesis-reserve/proposals    — List proposals
 *   GET  /api/v1/genesis-reserve/proposals/:id — Get single proposal
 *   GET  /api/v1/genesis-reserve/signers       — List signers
 *   GET  /api/v1/genesis-reserve/stats         — Multi-sig statistics
 *   GET  /api/v1/genesis-reserve/audit-log     — Observer Event audit log
 */

import express from 'express';

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getState(req) {
  return req.app.locals.state;
}

function getMultiSig(state) {
  if (!state?.genesisMultiSig) {
    return null;
  }
  return state.genesisMultiSig;
}

/**
 * POST /api/v1/genesis-reserve/propose
 * Create a spend proposal from the Genesis Reserve.
 */
router.post('/propose', async (req, res) => {
  try {
    const state = getState(req);
    const ms = getMultiSig(state);
    if (!ms) {
      return res.status(503).json({ success: false, error: 'Genesis Multi-Sig not initialized' });
    }

    const {
      milestoneBlock,
      amount,
      recipient,
      purpose,
      justification,
      expectedBenefit,
      duration,
      riskAssessment
    } = req.body;

    if (!amount || !recipient || !purpose || !justification) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: amount, recipient, purpose, justification'
      });
    }

    const result = ms.proposeSpend({
      milestoneBlock,
      amount,
      recipient,
      purpose,
      justification,
      expectedBenefit,
      duration,
      riskAssessment,
      state
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json({
      success: true,
      proposal: {
        id: result.proposalId,
        amount,
        recipient,
        purpose,
        status: 'pending',
        confirmations: 0,
        requiredConfirmations: 3
      }
    });
  } catch (error) {
    console.error('[GENESIS_MULTI_SIG_API] propose error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/genesis-reserve/sign
 * Signer confirms a proposal (approve).
 */
router.post('/sign', async (req, res) => {
  try {
    const state = getState(req);
    const ms = getMultiSig(state);
    if (!ms) {
      return res.status(503).json({ success: false, error: 'Genesis Multi-Sig not initialized' });
    }

    const { signerAgentId, proposalId } = req.body;

    if (!signerAgentId || !proposalId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: signerAgentId, proposalId'
      });
    }

    const result = ms.signProposal(signerAgentId, proposalId, state);

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json({
      success: true,
      proposalId,
      status: result.status,
      confirmationCount: result.confirmationCount
    });
  } catch (error) {
    console.error('[GENESIS_MULTI_SIG_API] sign error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/genesis-reserve/reject
 * Signer rejects a proposal.
 */
router.post('/reject', async (req, res) => {
  try {
    const state = getState(req);
    const ms = getMultiSig(state);
    if (!ms) {
      return res.status(503).json({ success: false, error: 'Genesis Multi-Sig not initialized' });
    }

    const { signerAgentId, proposalId, reason } = req.body;

    if (!signerAgentId || !proposalId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: signerAgentId, proposalId'
      });
    }

    const result = ms.rejectProposal(signerAgentId, proposalId, reason || '');

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json({
      success: true,
      proposalId,
      status: result.status
    });
  } catch (error) {
    console.error('[GENESIS_MULTI_SIG_API] reject error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/genesis-reserve/cancel
 * Cancel a pending proposal (no confirmations yet).
 */
router.post('/cancel', async (req, res) => {
  try {
    const state = getState(req);
    const ms = getMultiSig(state);
    if (!ms) {
      return res.status(503).json({ success: false, error: 'Genesis Multi-Sig not initialized' });
    }

    const { signerAgentId, proposalId } = req.body;

    if (!signerAgentId || !proposalId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: signerAgentId, proposalId'
      });
    }

    const result = ms.cancelProposal(signerAgentId, proposalId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.json({ success: true, proposalId });
  } catch (error) {
    console.error('[GENESIS_MULTI_SIG_API] cancel error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/genesis-reserve/proposals
 * List all proposals, optionally filtered by status.
 */
router.get('/proposals', (req, res) => {
  try {
    const state = getState(req);
    const ms = getMultiSig(state);
    if (!ms) {
      return res.status(503).json({ success: false, error: 'Genesis Multi-Sig not initialized' });
    }

    const { status, recipient } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (recipient) filter.recipient = recipient;

    const proposals = ms.getProposals(filter);

    return res.json({
      success: true,
      count: proposals.length,
      proposals
    });
  } catch (error) {
    console.error('[GENESIS_MULTI_SIG_API] proposals error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/genesis-reserve/proposals/:id
 * Get a single proposal by ID.
 */
router.get('/proposals/:id', (req, res) => {
  try {
    const state = getState(req);
    const ms = getMultiSig(state);
    if (!ms) {
      return res.status(503).json({ success: false, error: 'Genesis Multi-Sig not initialized' });
    }

    const proposal = ms.getProposal(req.params.id);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    return res.json({ success: true, proposal });
  } catch (error) {
    console.error('[GENESIS_MULTI_SIG_API] proposal detail error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/genesis-reserve/signers
 * List all signers with their status.
 */
router.get('/signers', (req, res) => {
  try {
    const state = getState(req);
    const ms = getMultiSig(state);
    if (!ms) {
      return res.status(503).json({ success: false, error: 'Genesis Multi-Sig not initialized' });
    }

    const signers = ms.getSigners();

    return res.json({
      success: true,
      count: signers.length,
      requiredConfirmations: 3,
      signers
    });
  } catch (error) {
    console.error('[GENESIS_MULTI_SIG_API] signers error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/genesis-reserve/stats
 * Get multi-sig statistics.
 */
router.get('/stats', (req, res) => {
  try {
    const state = getState(req);
    const ms = getMultiSig(state);
    if (!ms) {
      return res.status(503).json({ success: false, error: 'Genesis Multi-Sig not initialized' });
    }

    const stats = ms.getStats();

    return res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[GENESIS_MULTI_SIG_API] stats error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/genesis-reserve/audit-log
 * Get Observer Event audit log.
 */
router.get('/audit-log', (req, res) => {
  try {
    const state = getState(req);
    const ms = getMultiSig(state);
    if (!ms) {
      return res.status(503).json({ success: false, error: 'Genesis Multi-Sig not initialized' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const log = ms.getAuditLog(limit);

    return res.json({
      success: true,
      count: log.length,
      entries: log
    });
  } catch (error) {
    console.error('[GENESIS_MULTI_SIG_API] audit-log error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

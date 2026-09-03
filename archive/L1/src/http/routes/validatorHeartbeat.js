/**
 * NexusGenesis - Validator Heartbeat Service
 *
 * Monitors validator online status and prevents bootstrap uptime reset
 * when validators go offline temporarily.
 *
 * Endpoints:
 *   POST /api/v1/bootstrap/validators/:id/heartbeat - Report heartbeat
 *   GET  /api/v1/bootstrap/validators/health         - Health status overview
 */

import { Router } from 'express';
import crypto from 'crypto';

const router = Router();

// ─── Heartbeat storage ───
const heartbeats = new Map(); // agentId -> { lastHeartbeat, offlineDuration, healthy }
const OFFLINE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const RECOVERY_WINDOW_MS = 30 * 60 * 1000;    // 30 minutes

// ─── Helpers ───

/**
 * Check if a validator is healthy based on heartbeat.
 */
function checkHealth(agentId) {
  const hb = heartbeats.get(agentId);
  const now = Date.now();

  if (!hb) {
    // No heartbeat recorded — assume healthy if recently joined
    return { agentId, healthy: true, lastHeartbeat: null, offlineDuration: 0 };
  }

  const timeSinceLast = now - hb.lastHeartbeat;
  const isOffline = timeSinceLast > OFFLINE_THRESHOLD_MS;

  if (isOffline && hb.wasOffline) {
    // Still offline — accumulate duration
    return {
      agentId,
      healthy: false,
      lastHeartbeat: hb.lastHeartbeat,
      offlineDuration: timeSinceLast,
      consecutiveOfflines: (hb.consecutiveOfflines || 0) + 1
    };
  }

  if (isOffline && !hb.wasOffline) {
    // Just went offline
    hb.wasOffline = true;
    hb.offlineStart = now;
    return {
      agentId,
      healthy: false,
      lastHeartbeat: hb.lastHeartbeat,
      offlineDuration: 0,
      consecutiveOfflines: 1
    };
  }

  if (!isOffline && hb.wasOffline) {
    // Recovered from offline
    const offlineTime = now - (hb.offlineStart || hb.lastHeartbeat);
    if (offlineTime <= RECOVERY_WINDOW_MS) {
      // Quick recovery — reset uptime counter
      hb.uptimeReset = now;
      hb.wasOffline = false;
    }
    return {
      agentId,
      healthy: true,
      lastHeartbeat: hb.lastHeartbeat,
      offlineDuration: 0,
      recovered: true,
      recoveryTime: offlineTime
    };
  }

  return {
    agentId,
    healthy: true,
    lastHeartbeat: hb.lastHeartbeat,
    offlineDuration: 0
  };
}

// ─── POST /api/v1/bootstrap/validators/:id/heartbeat ───
router.post('/api/v1/bootstrap/validators/:id/heartbeat', (req, res) => {
  const agentId = req.params.id;
  const now = Date.now();

  // Update heartbeat
  const prev = heartbeats.get(agentId) || {};
  heartbeats.set(agentId, {
    ...prev,
    lastHeartbeat: now,
    wasOffline: false,
    uptimeReset: prev.uptimeReset || now
  });

  const health = checkHealth(agentId);

  console.log(`[Heartbeat] Validator ${agentId} heartbeat received (healthy=${health.healthy})`);

  return res.json({
    success: true,
    heartbeat: {
      agentId,
      timestamp: now,
      ...health
    }
  });
});

// ─── GET /api/v1/bootstrap/validators/health ───
router.get('/api/v1/bootstrap/validators/health', (req, res) => {
  const node = req.app.locals.node;
  if (!node) {
    return res.json({ success: true, validators: [], healthyCount: 0, unhealthyCount: 0 });
  }

  // Collect all validator IDs
  const validatorIds = new Set();
  for (const v of Array.from(node._validators?.values?.() || [])) {
    if (v.agentId) validatorIds.add(v.agentId);
    if (v.agentIdentity) validatorIds.add(v.agentIdentity);
  }

  // Also include registered agents marked as validators
  try {
    if (node.currentState?.agentRegistry?.agents) {
      for (const [, a] of node.currentState.agentRegistry.agents) {
        if (a.is_validator) {
          validatorIds.add(a.agentId || a.identity);
        }
      }
    }
  } catch {}

  // Build health status for each validator
  const validators = Array.from(validatorIds).map(id => checkHealth(id));

  const healthyCount = validators.filter(v => v.healthy).length;
  const unhealthyCount = validators.filter(v => !v.healthy).length;

  return res.json({
    success: true,
    validators,
    summary: {
      total: validators.length,
      healthy: healthyCount,
      unhealthy: unhealthyCount,
      healthRate: validators.length > 0 ? (healthyCount / validators.length * 100).toFixed(1) + '%' : '0%'
    }
  });
});

// ─── Periodic health check ───
setInterval(() => {
  const now = Date.now();
  for (const [agentId, hb] of heartbeats) {
    const timeSince = now - hb.lastHeartbeat;
    if (timeSince > OFFLINE_THRESHOLD_MS * 2) {
      // Stale heartbeat — remove after 2x threshold
      heartbeats.delete(agentId);
      console.log(`[Heartbeat] Removed stale heartbeat for ${agentId}`);
    }
  }
}, 5 * 60 * 1000); // Clean up every 5 minutes

export default router;

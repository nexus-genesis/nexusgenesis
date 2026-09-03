import { Router } from 'express';
import crypto from 'crypto';
import { getAgentIdByAddress } from '../../transactions/agentRegister.js';
import agentWalletManager from '../../wallet/agentWalletManager.js';

const router = Router();
const routerName = 'transaction-history';

// ============================================================
//  内存缓存（TTL-based）
// ============================================================
const _cache = new Map();
const CACHE_TTL = {
  txList: 10000,
  agentHistory: 10000,
  taskHistory: 15000,
  txTypes: 300000,
  txStats: 15000,
};

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function _cacheSet(key, data, ttl) {
  _cache.set(key, { data, ts: Date.now(), ttl });
}

function _cacheDelPrefix(prefix) {
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
}

function _cacheKey(type, ...parts) {
  return `tx:${type}:${parts.join(':')}`;
}

function cacheMiddleware(keyFn, ttl) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    try {
      const key = keyFn(req);
      const cached = _cacheGet(key);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
      const origJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && body?.success !== false) {
          _cacheSet(key, body, ttl);
        }
        res.setHeader('X-Cache', 'MISS');
        return origJson(body);
      };
      next();
    } catch (e) {
      next();
    }
  };
}

/**
 * Transaction History API
 * 
 * Provides comprehensive transaction querying and filtering capabilities.
 * Transactions are sourced from the blockchain state and task protocol records.
 */

// Transaction type descriptions
const TX_TYPE_DESCRIPTIONS = {
  TASK_PUBLISH: { label: 'Task Published', category: 'task', icon: '📝' },
  TASK_CLAIM: { label: 'Task Claimed', category: 'task', icon: '🤝' },
  TASK_SUBMIT: { label: 'Task Submitted', category: 'task', icon: '📤' },
  TASK_COMPLETE: { label: 'Task Completed', category: 'task', icon: '✅' },
  TASK_CANCEL: { label: 'Task Cancelled', category: 'task', icon: '❌' },
  REPUTATION_REWARD: { label: 'Reputation Reward', category: 'reputation', icon: '⭐' },
  REPUTATION_PENALTY: { label: 'Reputation Penalty', category: 'reputation', icon: '⚠️' },
  BOUNTY_POSTED: { label: 'Bounty Posted', category: 'bounty', icon: '🎯' },
  BOUNTY_CLAIMED: { label: 'Bounty Claimed', category: 'bounty', icon: '💰' },
  BOUNTY_GRANTED: { label: 'Bounty Granted', category: 'bounty', icon: '✅' },
  AGENT_REGISTER: { label: 'Agent Registered', category: 'agent', icon: '🆕' },
  AGENT_UPDATE: { label: 'Agent Updated', category: 'agent', icon: '🔄' },
  TRANSFER: { label: 'NGEN Transfer', category: 'transfer', icon: '💸' },
  BLOCK_REWARD: { label: 'Block Reward', category: 'consensus', icon: '⛏️' },
  PROPOSAL_CREATED: { label: 'Proposal Created', category: 'governance', icon: '📋' },
  VOTE_CAST: { label: 'Vote Cast', category: 'governance', icon: '🗳️' },
  ISSUE_REPORTED: { label: 'Issue Reported', category: 'issue', icon: '🐛' },
  CUSTODY_SIGN: { label: 'Custody Sign', category: 'custody', icon: '🔏' }
};

/**
 * GET /api/v1/transactions
 * List all transactions with pagination and filtering
 */
router.get('/', cacheMiddleware(
  (req) => _cacheKey('txList', req.query.limit || '20', req.query.offset || '0',
    req.query.type || '_', req.query.agentId || '_', req.query.address || '_',
    req.query.taskId || '_', req.query.startDate || '_', req.query.endDate || '_'),
  CACHE_TTL.txList
), (req, res) => {
  try {
    const { limit = 20, offset = 0, type, agentId, address, taskId, startDate, endDate } = req.query;
    
    const state = req.app.locals.state;
    if (!state) {
      return res.json({ success: true, transactions: [], total: 0, pagination: { limit: Number(limit), offset: Number(offset) } });
    }

    // Resolve address → agentId if agentId not provided directly
    let resolvedAgentId = agentId || null;
    if (!resolvedAgentId && address) {
      resolvedAgentId = getAgentIdByAddress(address, state);
      // If resolution fails, still filter by raw address (for unregistered agents)
      if (!resolvedAgentId) {
        console.log(`[Transaction API] Address ${address.slice(0, 12)}... not found in registry, filtering by raw address`);
      }
    }

    // Get all transactions from state
    const allTransactions = _getAllStateTransactions(state);
    
    // Also get task-related transactions from task protocol
    const taskTransactions = _extractTaskTransactions(state);
    
    // Merge and deduplicate
    const allTxs = [...allTransactions, ...taskTransactions];
    
    // Apply filters
    let filtered = allTxs;
    
    if (type) {
      filtered = filtered.filter(tx => tx.tx_type === type || tx.type === type);
    }
    
    if (resolvedAgentId || address) {
      filtered = filtered.filter(tx => {
        // Match by resolved agentId
        if (resolvedAgentId && (tx.from === resolvedAgentId || tx.to === resolvedAgentId || tx.agentId === resolvedAgentId)) {
          return true;
        }
        // Fallback: match by raw address (handles unregistered agents and address-only queries)
        if (address && (tx.from === address || tx.to === address)) {
          return true;
        }
        return false;
      });
    }
    
    if (taskId) {
      filtered = filtered.filter(tx => tx.payload?.taskId === taskId || tx.taskId === taskId);
    }
    
    if (startDate) {
      const start = new Date(startDate).getTime();
      filtered = filtered.filter(tx => tx.timestamp >= start);
    }
    
    if (endDate) {
      const end = new Date(endDate).getTime();
      filtered = filtered.filter(tx => tx.timestamp <= end);
    }
    
    // Sort by timestamp descending
    filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    // Paginate
    const total = filtered.length;
    const paginated = filtered.slice(Number(offset), Number(offset) + Number(limit));
    
    // Enrich with metadata
    const enriched = paginated.map(tx => _enrichTransaction(tx));
    
    res.json({
      success: true,
      transactions: enriched,
      total,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        hasNext: Number(offset) + Number(limit) < total,
        hasPrev: Number(offset) > 0
      },
      filters: { type, agentId: resolvedAgentId || agentId, address, taskId }
    });
  } catch (error) {
    console.error('[Transaction API] List error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/transactions/agent/:agentId
 * Get transaction history for a specific agent
 */
router.get('/agent/:agentId', cacheMiddleware(
  (req) => _cacheKey('agentHistory', req.params.agentId, req.query.limit || '20', req.query.offset || '0',
    req.query.type || '_', req.query.tx_type || '_'),
  CACHE_TTL.agentHistory
), (req, res) => {
  try {
    const { agentId } = req.params;
    const { limit = 20, offset = 0, type, tx_type } = req.query;
    
    const state = req.app.locals.state;
    if (!state) {
      return res.json({ success: true, transactions: [], total: 0, agentId });
    }

    const allTransactions = _getAllStateTransactions(state);
    const taskTransactions = _extractTaskTransactions(state);
    const allTxs = [...allTransactions, ...taskTransactions];

    // Filter by agent
    let agentTxs = allTxs.filter(tx => 
      tx.from === agentId || tx.to === agentId || tx.agentId === agentId
    );
    
    // Filter by transaction type
    if (type) {
      agentTxs = agentTxs.filter(tx => (tx.tx_type || tx.type) === type);
    }
    if (tx_type) {
      agentTxs = agentTxs.filter(tx => tx.tx_type === tx_type || tx.type === tx_type);
    }
    
    // Sort and paginate
    agentTxs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const total = agentTxs.length;
    const paginated = agentTxs.slice(Number(offset), Number(offset) + Number(limit));
    
    // Enrich with direction relative to the viewer agent
    const enriched = paginated.map(tx => _enrichTransaction(tx, agentId));
    
    res.json({
      success: true,
      transactions: enriched,
      total,
      agentId,
      pagination: {
        limit: Number(limit),
        offset: Number(offset),
        hasNext: Number(offset) + Number(limit) < total
      }
    });
  } catch (error) {
    console.error('[Transaction API] Agent history error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/transactions/agent/:agentId/summary
 * Get income/expense summary for a specific agent (self-proving balance)
 */
router.get('/agent/:agentId/summary', cacheMiddleware(
  (req) => _cacheKey('agentSummary', req.params.agentId),
  CACHE_TTL.agentHistory
), (req, res) => {
  try {
    const { agentId } = req.params;
    
    const state = req.app.locals.state;
    if (!state) {
      return res.json({ success: true, summary: { agentId, transactionCount: 0, byType: {}, firstActivity: null, lastActivity: null, totalIncoming: '0', totalOutgoing: '0', netBalance: '0', currentBalance: null }, agentId, note: 'state_not_available' });
    }

    const allTransactions = _getAllStateTransactions(state);
    const taskTransactions = _extractTaskTransactions(state);
    const allTxs = [...allTransactions, ...taskTransactions];

    // Filter by agent
    const agentTxs = allTxs.filter(tx => 
      tx.from === agentId || tx.to === agentId || tx.agentId === agentId
    );

    // Calculate summary
    let totalIncoming = BigInt(0);
    let totalOutgoing = BigInt(0);
    const byType = {};
    let earliestTx = Infinity;
    let latestTx = 0;

    for (const tx of agentTxs) {
      const amount = _safeBigInt(tx.amount);
      const direction = _calculateDirection(tx, agentId);
      const type = tx.tx_type || tx.type || 'unknown';
      
      byType[type] = (byType[type] || 0) + 1;
      
      if (direction === 'incoming') {
        totalIncoming += amount;
      } else if (direction === 'outgoing') {
        totalOutgoing += amount;
      }
      
      if (tx.timestamp) {
        if (tx.timestamp < earliestTx) earliestTx = tx.timestamp;
        if (tx.timestamp > latestTx) latestTx = tx.timestamp;
      }
    }

    // Get current wallet balance if available
    let currentBalance = null;
    try {
      const balanceResult = agentWalletManager.getBalance(agentId);
      if (balanceResult && balanceResult.success) {
        currentBalance = balanceResult.balanceRaw;
      }
    } catch (e) {
      // wallet not found for this agent — leave currentBalance as null
    }

    const summary = {
      agentId,
      totalIncoming: totalIncoming.toString(),
      totalOutgoing: totalOutgoing.toString(),
      netBalance: (totalIncoming - totalOutgoing).toString(),
      currentBalance,
      transactionCount: agentTxs.length,
      byType,
      firstActivity: earliestTx === Infinity ? null : earliestTx,
      lastActivity: latestTx === 0 ? null : latestTx
    };

    res.json({
      success: true,
      summary,
      agentId
    });
  } catch (error) {
    console.error('[Transaction API] Agent summary error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/transactions/task/:taskId
 * Get all transactions related to a specific task
 */
router.get('/task/:taskId', cacheMiddleware(
  (req) => _cacheKey('taskHistory', req.params.taskId),
  CACHE_TTL.taskHistory
), (req, res) => {
  try {
    const { taskId } = req.params;
    
    const state = req.app.locals.state;
    if (!state) {
      return res.json({ success: true, transactions: [], total: 0, taskId });
    }

    const allTransactions = _getAllStateTransactions(state);
    const taskTransactions = _extractTaskTransactions(state);
    const allTxs = [...allTransactions, ...taskTransactions];

    // Filter by task
    const taskTxs = allTxs.filter(tx => 
      tx.payload?.taskId === taskId || tx.taskId === taskId
    );
    
    // Sort by timestamp
    taskTxs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    
    res.json({
      success: true,
      transactions: taskTxs.map(tx => _enrichTransaction(tx)),
      total: taskTxs.length,
      taskId,
      lifecycle: _buildTaskLifecycle(taskTxs)
    });
  } catch (error) {
    console.error('[Transaction API] Task history error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/transactions/types
 * Get all available transaction types with descriptions
 */
router.get('/types', cacheMiddleware(
  () => _cacheKey('txTypes'),
  CACHE_TTL.txTypes
), (req, res) => {
  const types = Object.entries(TX_TYPE_DESCRIPTIONS).map(([code, desc]) => ({
    code,
    ...desc
  }));
  
  res.json({
    success: true,
    types,
    total: types.length
  });
});

/**
 * GET /api/v1/transactions/stats
 * Get transaction statistics
 */
router.get('/stats', cacheMiddleware(
  () => _cacheKey('txStats'),
  CACHE_TTL.txStats
), (req, res) => {
  try {
    const state = req.app.locals.state;
    if (!state) {
      return res.json({ success: true, stats: {} });
    }

    const allTransactions = _getAllStateTransactions(state);
    const taskTransactions = _extractTaskTransactions(state);
    const allTxs = [...allTransactions, ...taskTransactions];

    // Calculate stats
    const stats = {
      total: allTxs.length,
      byType: {},
      byCategory: {},
      last24h: 0,
      last7d: 0
    };
    
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const sevenDays = 7 * twentyFourHours;
    
    allTxs.forEach(tx => {
      const type = tx.tx_type || tx.type || 'unknown';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
      
      const category = TX_TYPE_DESCRIPTIONS[type]?.category || 'other';
      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
      
      if (tx.timestamp) {
        if (now - tx.timestamp <= twentyFourHours) stats.last24h++;
        if (now - tx.timestamp <= sevenDays) stats.last7d++;
      }
    });
    
    res.json({
      success: true,
      stats,
      typeDescriptions: TX_TYPE_DESCRIPTIONS
    });
  } catch (error) {
    console.error('[Transaction API] Stats error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Helper Functions ====================

/**
 * Safely convert amount (string | number | bigint, possibly decimal) to BigInt.
 * Decimal amounts are truncated toward zero; unparseable values become 0n.
 */
function _safeBigInt(amount) {
  if (amount === null || amount === undefined || amount === '') return BigInt(0);
  if (typeof amount === 'bigint') return amount;
  const str = String(amount).trim();
  if (/^-?\d+$/.test(str)) {
    try { return BigInt(str); } catch { return BigInt(0); }
  }
  const num = Number(str);
  if (!Number.isFinite(num)) return BigInt(0);
  return BigInt(Math.trunc(num));
}

/**
 * Safely extract transactions array from state.transactions.
 * state.transactions can be either:
 *   - An array (legacy)
 *   - An object { txHistory, mempool, txCount, byType, byAddress } (Phase 1A+)
 */
function _getAllStateTransactions(state) {
  if (!state) return [];
  const t = state.transactions;
  if (!t) return [];
  if (Array.isArray(t)) return t;
  if (Array.isArray(t.txHistory)) return t.txHistory;
  if (Array.isArray(t.mempool)) return t.mempool;
  return [];
}

/**
 * Extract task-related transactions from state
 */
function _extractTaskTransactions(state) {
  const transactions = [];
  
  // Get tasks from state
  const tasks = state.tasks || state.getAllTasks?.() || [];
  const taskArray = Array.isArray(tasks) ? tasks : Object.values(tasks);
  
  taskArray.forEach(task => {
    if (!task || !task.id) return;
    
    // Extract from transactionHistory
    if (task.transactionHistory && Array.isArray(task.transactionHistory)) {
      task.transactionHistory.forEach((tx, index) => {
        transactions.push({
          id: tx.id || crypto.createHash('sha3-256').update(`${task.id}-${index}`).digest('hex').slice(0, 16),
          tx_type: tx.type || 'TASK_EVENT',
          from: tx.from || task.publisher,
          to: tx.to || task.claimant,
          amount: tx.amount || '0',
          payload: { taskId: task.id, ...tx },
          timestamp: tx.timestamp || Date.now(),
          taskId: task.id,
          source: 'task_history'
        });
      });
    }
    
    // Create transaction records for key events if not in history
    const eventTypes = ['TASK_PUBLISH', 'TASK_CLAIM', 'TASK_SUBMIT', 'TASK_COMPLETE'];
    eventTypes.forEach((eventType, idx) => {
      const hasEvent = task.transactionHistory?.some(tx => tx.type === eventType);
      if (!hasEvent && task[eventType === 'TASK_PUBLISH' ? 'publisher' : 
                                  eventType === 'TASK_CLAIM' ? 'claimant' :
                                  eventType === 'TASK_SUBMIT' ? 'submitter' : 'verifier']) {
        transactions.push({
          id: crypto.createHash('sha3-256').update(`${task.id}-${eventType}`).digest('hex').slice(0, 16),
          tx_type: eventType,
          from: eventType === 'TASK_PUBLISH' ? task.publisher :
                eventType === 'TASK_CLAIM' ? task.claimant :
                eventType === 'TASK_SUBMIT' ? task.submitter : task.verifier,
          to: eventType === 'TASK_PUBLISH' ? 'system' :
              eventType === 'TASK_CLAIM' ? task.publisher :
              eventType === 'TASK_SUBMIT' ? task.publisher : 'system',
          amount: task.reward || '0',
          payload: { taskId: task.id, eventType },
          timestamp: task.createdAt || Date.now(),
          taskId: task.id,
          source: 'task_events'
        });
      }
    });
  });
  
  return transactions;
}

/**
 * Enrich transaction with metadata
 * @param {Object} tx - transaction object
 * @param {string} [viewerAgentId] - agent identity for direction calculation
 */
function _enrichTransaction(tx, viewerAgentId) {
  const type = tx.tx_type || tx.type || 'unknown';
  const description = TX_TYPE_DESCRIPTIONS[type] || { label: type, category: 'other', icon: '📄' };
  
  return {
    ...tx,
    typeDescription: description,
    direction: _calculateDirection(tx, viewerAgentId),
    formattedAmount: tx.amount ? Number(tx.amount).toLocaleString() : '0'
  };
}

/**
 * Calculate transaction direction relative to a viewer agent
 * @param {Object} tx - transaction object
 * @param {string} [viewerAgentId] - agent identity to calculate direction for
 * @returns {string|null} 'incoming' | 'outgoing' | 'self' | null
 */
function _calculateDirection(tx, viewerAgentId) {
  if (!viewerAgentId) return null;
  const from = tx.from || tx.publisher || '';
  const to = tx.to || tx.claimant || '';
  const isFromViewer = from === viewerAgentId;
  const isToViewer = to === viewerAgentId;
  if (isFromViewer && isToViewer) return 'self';
  if (isFromViewer) return 'outgoing';
  if (isToViewer) return 'incoming';
  return null;
}

/**
 * Build task lifecycle from transactions
 */
function _buildTaskLifecycle(transactions) {
  const lifecycle = {
    stages: [],
    totalDuration: 0,
    currentStage: 'unknown'
  };
  
  const stageOrder = ['TASK_PUBLISH', 'TASK_CLAIM', 'TASK_SUBMIT', 'TASK_VERIFY', 'TASK_COMPLETE'];
  
  transactions
    .filter(tx => stageOrder.includes(tx.tx_type || tx.type))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .forEach((tx, idx) => {
      const stage = tx.tx_type || tx.type;
      lifecycle.stages.push({
        stage,
        timestamp: tx.timestamp,
        actor: tx.from || tx.to,
        index: idx
      });
      
      if (idx > 0) {
        const prevStage = lifecycle.stages[idx - 1].stage;
        const prevTx = transactions.find(t => 
          (t.tx_type || t.type) === prevStage && t.timestamp <= tx.timestamp
        );
        if (prevTx) {
          const duration = tx.timestamp - prevTx.timestamp;
          lifecycle.totalDuration += duration;
        }
      }
    });
  
  lifecycle.currentStage = lifecycle.stages[lifecycle.stages.length - 1]?.stage || 'unknown';
  lifecycle.totalDurationMs = lifecycle.totalDuration;
  lifecycle.totalDurationFormatted = _formatDuration(lifecycle.totalDuration);
  
  return lifecycle;
}

/**
 * Format duration in milliseconds to human-readable string
 */
function _formatDuration(ms) {
  if (ms <= 0) return '0s';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export default router;

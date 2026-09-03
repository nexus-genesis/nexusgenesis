/**
 * Transaction Engine — Phase 1A
 *
 * Provides a unified, auditable transaction system for all balance
 * changes in NexusGenesis. All `addBalance` and `subtractBalance`
 * calls eventually flow through here (or are recorded explicitly).
 *
 * Design:
 *   - txHistory: persistent ledger of every applied transaction
 *   - mempool:   queue of pending transactions (not yet block-batched)
 *   - applyTransaction(tx): modify state + record to history atomically
 *   - applyTransactions(blockHeight, txs): batch-apply at block end
 *   - queueTransaction(tx): push to mempool (no state change yet)
 *   - getTransactionHistory(filter): query history
 *
 * Each transaction object must have:
 *   {
 *     txHash:    string (optional — auto-generated if absent)
 *     tx_type:   TX_TYPE enum (see below)
 *     from:      string address (null for mint/reward)
 *     to:        string address (null for burn)
 *     amount:    BigInt|string
 *     blockHeight: number
 *     timestamp: number (optional, default = now)
 *     status:    'pending' | 'applied' | 'failed' (default 'pending')
 *     metadata:  object (optional — extra context)
 *   }
 *
 * Backward compatibility:
 *   - When transactions field is missing in loaded state, init empty
 *   - All existing addBalance calls work unchanged
 *   - New code should use build* from transactionBuilder.js
 */

/**
 * Transaction type registry
 */
export const TX_TYPE = Object.freeze({
  // User-initiated
  TRANSFER:             'TRANSFER',
  STAKE:                'STAKE',
  UNSTAKE:              'UNSTAKE',
  GOVERNANCE_VOTE:      'GOVERNANCE_VOTE',
  GOVERNANCE_PROPOSAL:  'GOVERNANCE_PROPOSAL',
  TASK_CREATE:          'TASK_CREATE',
  TASK_COMPLETE:        'TASK_COMPLETE',
  TASK_REWARD:          'TASK_REWARD',

  // Minting (protocol-initiated)
  REGISTRATION_MINT:    'REGISTRATION_MINT',
  BLOCK_REWARD:         'BLOCK_REWARD',
  EARLY_BIRD_BONUS:     'EARLY_BIRD_BONUS',
  REFERRAL_REWARD:      'REFERRAL_REWARD',
  STAKE_REWARD:         'STAKE_REWARD',
  SWARM_RELEASE:        'SWARM_RELEASE',
  OBSERVER_RELEASE:     'OBSERVER_RELEASE',
  GENESIS_UNLOCK:       'GENESIS_UNLOCK',

  // Tax / fee (protocol-initiated)
  OBSERVER_TAX:         'OBSERVER_TAX',
  FEE_BURN:             'FEE_BURN',
  SLASH:                'SLASH',

  // Governance
  OBSERVER_EVENT:       'OBSERVER_EVENT',
  MULTISIG_SPEND:       'MULTISIG_SPEND',

  // Audit-only (no balance effect, persists to txHistory for forensics)
  CUSTODY_SIGN:         'CUSTODY_SIGN'
});

/**
 * Generate a deterministic-looking but unique transaction hash.
 * Not cryptographic — for indexing/dedup only.
 */
export function generateTxHash(tx) {
  const parts = [
    tx.tx_type || 'UNKNOWN',
    tx.from || 'null',
    tx.to || 'null',
    String(tx.amount || '0'),
    String(tx.blockHeight || 0),
    String(tx.timestamp || Date.now()),
    Math.random().toString(36).slice(2, 10)
  ];
  let h = 0;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return 'tx-' + Math.abs(h).toString(16) + '-' + s.length.toString(16);
}

/**
 * Validate a transaction object.
 * Returns { valid: bool, error: string|null }
 */
export function validateTransaction(tx) {
  if (!tx || typeof tx !== 'object') {
    return { valid: false, error: 'tx is not an object' };
  }
  if (!tx.tx_type) {
    return { valid: false, error: 'tx_type is required' };
  }
  if (!Object.values(TX_TYPE).includes(tx.tx_type)) {
    return { valid: false, error: `unknown tx_type: ${tx.tx_type}` };
  }
  // from / to / amount requirements vary by type
  if (tx.tx_type === TX_TYPE.TRANSFER) {
    if (!tx.from) return { valid: false, error: 'TRANSFER requires from' };
    if (!tx.to)   return { valid: false, error: 'TRANSFER requires to' };
  }
  // amount validation when present
  if (tx.amount !== undefined && tx.amount !== null) {
    try {
      const a = BigInt(tx.amount.toString());
      if (a < 0n) return { valid: false, error: 'amount cannot be negative' };
    } catch {
      return { valid: false, error: 'amount is not a valid integer' };
    }
  }
  return { valid: true, error: null };
}

/**
 * Determine whether a tx_type modifies balances (requires apply).
 * Some tx types (e.g. GOVERNANCE_VOTE) only record events.
 */
export function isBalanceAffecting(tx_type) {
  const nonBalance = new Set([
    TX_TYPE.GOVERNANCE_VOTE,
    TX_TYPE.GOVERNANCE_PROPOSAL,
    TX_TYPE.OBSERVER_EVENT
  ]);
  return !nonBalance.has(tx_type);
}

/**
 * Phase 2-A2: 判断 tx_type 是否为"入账型奖励"
 * 用于触发 Agent 安全引导 onbording 状态机
 *
 * 涵盖：TASK_REWARD / REGISTRATION_MINT / BLOCK_REWARD / EARLY_BIRD_BONUS /
 *      REFERRAL_REWARD / STAKE_REWARD / SWARM_RELEASE / OBSERVER_RELEASE /
 *      GENESIS_UNLOCK
 */
export function isRewardTxType(tx_type) {
  const rewardTypes = new Set([
    TX_TYPE.TASK_REWARD,
    TX_TYPE.REGISTRATION_MINT,
    TX_TYPE.BLOCK_REWARD,
    TX_TYPE.EARLY_BIRD_BONUS,
    TX_TYPE.REFERRAL_REWARD,
    TX_TYPE.STAKE_REWARD,
    TX_TYPE.SWARM_RELEASE,
    TX_TYPE.OBSERVER_RELEASE,
    TX_TYPE.GENESIS_UNLOCK
  ]);
  return rewardTypes.has(tx_type);
}

/**
 * Create a fresh transaction engine state.
 * Call this when initializing State, and re-attach when loading from disk.
 */
export function createTransactionState() {
  return {
    txHistory: [],     // every applied tx
    mempool:   [],     // pending, not yet applied
    txCount:   0,      // monotonic counter for IDs
    byType:    {},     // index: { tx_type: count }
    byAddress: {}      // index: { address: count }
  };
}

/**
 * Attach transaction state to a State instance.
 * Idempotent — safe to call multiple times.
 */
export function attachTransactionState(state) {
  if (!state.transactions) {
    state.transactions = createTransactionState();
  }
  // Attach helper methods onto the state instance
  if (!state.queueTransaction) {
    state.queueTransaction = (tx) => queueTransaction(state, tx);
  }
  if (!state.applyTransaction) {
    state.applyTransaction = (tx) => applyTransaction(state, tx);
  }
  if (!state.applyTransactions) {
    state.applyTransactions = (blockHeight, txs) => applyTransactions(state, blockHeight, txs);
  }
  if (!state.getTransactionHistory) {
    state.getTransactionHistory = (filter) => getTransactionHistory(state, filter);
  }
  if (!state.getMempool) {
    state.getMempool = () => [...state.transactions.mempool];
  }
  if (!state.clearMempool) {
    state.clearMempool = () => {
      state.transactions.mempool = [];
    };
  }
  // Phase 1C-4: Always attach recordAuditEvent for state.js internal use.
  if (!state.recordAuditEvent) {
    state.recordAuditEvent = (tx) => recordAuditEvent(state, tx);
  }
  if (!state.getTransactionStats) {
    state.getTransactionStats = () => getTransactionStats(state);
  }
  return state;
}

/**
 * Queue a transaction into the mempool. Does NOT modify state.
 * Returns { success, txHash, error }
 */
export function queueTransaction(state, txInput) {
  const v = validateTransaction(txInput);
  if (!v.valid) return { success: false, error: v.error };

  const tx = normalizeTransaction(txInput, state);
  // Dedup: same txHash already in mempool?
  if (state.transactions.mempool.some(t => t.txHash === tx.txHash)) {
    return { success: false, error: 'duplicate txHash in mempool' };
  }
  state.transactions.mempool.push(tx);
  return { success: true, txHash: tx.txHash };
}

/**
 * Apply a single transaction: modify state balances + record history.
 * Returns { success, txHash, error }
 *
 * Does NOT require queueing first — you can call apply directly.
 * For block processing, prefer applyTransactions (batch).
 */
export function applyTransaction(state, txInput) {
  const v = validateTransaction(txInput);
  if (!v.valid) return { success: false, error: v.error };

  const tx = normalizeTransaction(txInput, state);

  // Apply balance effect
  if (isBalanceAffecting(tx.tx_type)) {
    const effect = applyBalanceEffect(state, tx);
    if (!effect.success) {
      tx.status = 'failed';
      tx.failureReason = effect.error;
      recordHistory(state, tx);
      return { success: false, txHash: tx.txHash, error: effect.error };
    }
  }

  // Apply non-balance side-effects (governance votes, etc.)
  applySideEffects(state, tx);

  tx.status = 'applied';
  tx.appliedAt = Date.now();
  recordHistory(state, tx);

  // Phase 2-A2: reward tx 成功后触发 Agent 安全引导
  // 走 state 的余额（applyBalanceEffect 已经更新到 state.addBalance），
  // 不用 agentWalletManager 的余额（reward 不更新它）。fire-and-forget
  // 不阻塞主流程；失败也不影响 tx 应用。
  if (isRewardTxType(tx.tx_type) && tx.to && tx.to !== 'null') {
    setImmediate(async () => {
      try {
        const { maybeTriggerOnboardingByAddressAndBalance } = await import('../wallet/onboarding.js');
        const stateBalance = state.getBalance?.(tx.to) || 0;
        const result = maybeTriggerOnboardingByAddressAndBalance(tx.to, stateBalance);
        if (result.triggered) {
          console.log(`[Onboarding] Triggered for ${tx.to} (tx=${tx.tx_type}, balance=${stateBalance})`);
        }
      } catch (e) {
        console.warn('[Onboarding] reward trigger failed:', e.message);
      }
    });
  }

  // Remove from mempool if present
  const mpIdx = state.transactions.mempool.findIndex(t => t.txHash === tx.txHash);
  if (mpIdx !== -1) {
    state.transactions.mempool.splice(mpIdx, 1);
  }

  return { success: true, txHash: tx.txHash };
}

/**
 * Apply a batch of transactions at the end of a block.
 * Each tx inherits blockHeight if not already set.
 * Returns { applied, failed, results: [...] }
 */
export function applyTransactions(state, blockHeight, txs) {
  if (!Array.isArray(txs)) txs = [];
  const results = [];
  let applied = 0, failed = 0;

  for (const txInput of txs) {
    const tx = { ...txInput };
    if (!tx.blockHeight) tx.blockHeight = blockHeight;
    const r = applyTransaction(state, tx);
    results.push(r);
    if (r.success) applied++;
    else failed++;
  }

  return { applied, failed, results };
}

/**
 * Apply the balance effect of a transaction.
 * Internal — called by applyTransaction.
 */
function applyBalanceEffect(state, tx) {
  // TRANSFER, STAKE, UNSTAKE, TASK_REWARD, REFERRAL_REWARD etc.
  if (tx.from && tx.from !== 'null' && tx.tx_type !== TX_TYPE.GENESIS_UNLOCK) {
    const ok = state.subtractBalance(tx.from, tx.amount);
    if (!ok) return { success: false, error: `insufficient balance: ${tx.from}` };
  }
  if (tx.to && tx.to !== 'null') {
    state.addBalance(tx.to, tx.amount);
  }
  return { success: true };
}

/**
 * Apply non-balance side-effects.
 * Currently a no-op hook; future: governance vote tally, etc.
 */
function applySideEffects(state, tx) {
  // Placeholder — extend here for tx types that need more than balance change
}

/**
 * Normalize a transaction: fill in defaults, generate txHash.
 */
function normalizeTransaction(txInput, state) {
  const tx = { ...txInput };
  if (!tx.timestamp) tx.timestamp = Date.now();
  if (!tx.status)    tx.status    = 'pending';
  if (!tx.metadata)  tx.metadata  = {};
  if (!tx.txHash) {
    tx.txHash = generateTxHash({
      ...tx,
      blockHeight: tx.blockHeight || state?.currentBlockHeight || 0
    });
  }
  if (!tx.txId) {
    state.transactions.txCount++;
    tx.txId = state.transactions.txCount;
  }
  return tx;
}

/**
 * Record a tx into the persistent history + indexes.
 */
function recordHistory(state, tx) {
  state.transactions.txHistory.push(tx);
  // Index by type
  state.transactions.byType[tx.tx_type] = (state.transactions.byType[tx.tx_type] || 0) + 1;
  // Index by address
  if (tx.from) {
    state.transactions.byAddress[tx.from] = (state.transactions.byAddress[tx.from] || 0) + 1;
  }
  if (tx.to) {
    state.transactions.byAddress[tx.to] = (state.transactions.byAddress[tx.to] || 0) + 1;
  }
}

/**
 * Phase 1C-4: Audit-only record. Normalize + record a tx without
 * applying any balance effect. For use by state.js internal methods
 * that have already done the balance change and only need to leave
 * a trace in txHistory.
 */
export function recordAuditEvent(state, txInput) {
  const tx = normalizeTransaction(txInput, state);
  tx.status = 'applied';
  tx.appliedAt = Date.now();
  tx.auditOnly = true;
  recordHistory(state, tx);
  return { success: true, txHash: tx.txHash };
}

/**
 * Phase 2-A2: Record a custody-token signing event.
 * This is an audit-only trace (no balance effect). It tells operators
 * "Agent X signed payload Y at time Z via /wallet/sign".
 *
 * The event is normalized as a synthetic transaction with type CUSTODY_SIGN
 * so it lands in state.transactions.txHistory and shows up in the audit panel.
 *
 * @param {object} state - State instance
 * @param {object} event
 * @param {string} event.agentId
 * @param {string} event.address - wallet address that signed
 * @param {string} event.action - free-form action label (e.g. 'claim_task')
 * @param {number} event.dataLen - length of signed payload
 * @param {string} [event.custodyFp] - custody token fingerprint (16-hex SHA256 prefix)
 * @param {string} [event.ip] - request IP
 * @param {string} [event.userAgent] - request user-agent
 * @param {object} [event.context] - additional client context
 * @returns {{ success: boolean, txHash?: string }}
 */
export function recordCustodySign(state, event) {
  if (!state) return { success: false, error: 'no state' };
  if (!event || !event.agentId) return { success: false, error: 'agentId required' };

  const payload = {
    action: event.action || 'unspecified',
    dataLen: event.dataLen || 0,
    custodyFp: event.custodyFp || null,
    ip: event.ip || null,
    userAgent: event.userAgent || null,
    context: event.context || null
  };

  return recordAuditEvent(state, {
    tx_type: TX_TYPE.CUSTODY_SIGN,
    from: event.agentId,
    to: event.address || null,
    amount: 0,
    payload,
    metadata: { auditOnly: true, custody: true }
  });
}

/**
 * Query transaction history with optional filters.
 * Returns array of matching txs.
 *
 * filter = {
 *   address?:   string — match from OR to
 *   tx_type?:   string — exact type match
 *   fromBlock?: number — inclusive lower bound on blockHeight
 *   toBlock?:   number — inclusive upper bound on blockHeight
 *   status?:    'pending' | 'applied' | 'failed'
 *   limit?:     number — max results (default 100)
 *   offset?:    number — pagination offset
 *   sort?:      'asc' | 'desc' by timestamp (default 'desc')
 * }
 */
export function getTransactionHistory(state, filter = {}) {
  const {
    address, tx_type, fromBlock, toBlock, status,
    limit = 100, offset = 0, sort = 'desc'
  } = filter;

  let results = state.transactions.txHistory;

  if (address) {
    results = results.filter(t => t.from === address || t.to === address);
  }
  if (tx_type) {
    results = results.filter(t => t.tx_type === tx_type);
  }
  if (fromBlock !== undefined) {
    results = results.filter(t => (t.blockHeight || 0) >= fromBlock);
  }
  if (toBlock !== undefined) {
    results = results.filter(t => (t.blockHeight || 0) <= toBlock);
  }
  if (status) {
    results = results.filter(t => t.status === status);
  }

  results = [...results].sort((a, b) => {
    const ta = a.timestamp || 0;
    const tb = b.timestamp || 0;
    return sort === 'asc' ? ta - tb : tb - ta;
  });

  return {
    total: results.length,
    items: results.slice(offset, offset + limit)
  };
}

/**
 * Get transaction statistics.
 */
export function getTransactionStats(state) {
  const ts = state.transactions;
  const totalByStatus = {};
  for (const tx of ts.txHistory) {
    totalByStatus[tx.status] = (totalByStatus[tx.status] || 0) + 1;
  }
  return {
    total:      ts.txHistory.length,
    mempool:    ts.mempool.length,
    txCount:    ts.txCount,
    byType:     { ...ts.byType },
    byStatus:   totalByStatus,
    topAddresses: Object.entries(ts.byAddress)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([address, count]) => ({ address, count }))
  };
}

/**
 * Serialize for persistence.
 * Returns a plain object suitable for JSON.stringify.
 */
export function serializeTransactions(state) {
  return {
    txHistory: state.transactions?.txHistory || [],
    mempool:   state.transactions?.mempool   || [],
    txCount:   state.transactions?.txCount   || 0,
    byType:    state.transactions?.byType    || {},
    byAddress: state.transactions?.byAddress || {}
  };
}

/**
 * Deserialize from persistence.
 * Restores the transaction state from a plain object.
 */
export function deserializeTransactions(data) {
  return {
    txHistory: Array.isArray(data?.txHistory) ? data.txHistory : [],
    mempool:   Array.isArray(data?.mempool)   ? data.mempool   : [],
    txCount:   Number.isFinite(data?.txCount) ? data.txCount   : 0,
    byType:    data?.byType    || {},
    byAddress: data?.byAddress || {}
  };
}

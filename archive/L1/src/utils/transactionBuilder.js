/**
 * Transaction Builder — Phase 1A
 *
 * Provides type-safe constructors for every kind of balance-changing
 * transaction. Each builder returns a transaction object ready to be
 * passed to `state.applyTransaction(tx)` or `state.queueTransaction(tx)`.
 *
 * Design rules:
 *   - Builders do NOT call state methods. They only construct the tx object.
 *   - Builders validate inputs and throw on invalid data.
 *   - Builders populate tx_type, from/to, amount, blockHeight, metadata.
 *   - Builders set defaults for timestamp, status, etc.
 *   - Use these instead of inline `{ tx_type: 'X', ... }` literals.
 *
 * Conventions:
 *   - from: source address (null for protocol-initiated mint/reward)
 *   - to:   destination address (null for burn-only)
 *   - amount: BigInt-compatible value (string or BigInt)
 *   - blockHeight: 0 if not yet committed
 *   - metadata: extra context for audit/replay
 */

import { TX_TYPE } from '../blockchain/transactionEngine.js';

/**
 * Internal: normalize a tx input.
 */
function _build(type, fields) {
  const tx = {
    tx_type: type,
    from: null,
    to: null,
    amount: '0',
    blockHeight: 0,
    timestamp: Date.now(),
    status: 'pending',
    metadata: {},
    ...fields
  };
  if (tx.amount !== null && tx.amount !== undefined) {
    tx.amount = BigInt(tx.amount.toString()).toString();
  }
  return tx;
}

/* ============================================================
 * USER-INITIATED TRANSACTIONS
 * ============================================================ */

/**
 * User-initiated transfer.
 */
export function buildTransfer({ from, to, amount, blockHeight = 0, metadata = {} }) {
  if (!from) throw new Error('buildTransfer: from is required');
  if (!to)   throw new Error('buildTransfer: to is required');
  return _build(TX_TYPE.TRANSFER, { from, to, amount, blockHeight, metadata });
}

/**
 * Validator stake deposit.
 */
export function buildStake({ from, amount, blockHeight = 0, metadata = {} }) {
  if (!from) throw new Error('buildStake: from is required');
  return _build(TX_TYPE.STAKE, {
    from,
    to: 'ng1staking000000000000000000000000000000000',  // STAKING_ADDR placeholder
    amount,
    blockHeight,
    metadata
  });
}

/**
 * Validator un-stake (returns funds to original staker).
 */
export function buildUnstake({ from, to, amount, blockHeight = 0, metadata = {} }) {
  if (!from) throw new Error('buildUnstake: from (STAKING_ADDR) is required');
  if (!to)   throw new Error('buildUnstake: to (staker) is required');
  return _build(TX_TYPE.UNSTAKE, {
    from,
    to,
    amount,
    blockHeight,
    metadata
  });
}

/**
 * Governance vote (non-balance affecting).
 */
export function buildGovernanceVote({ from, proposalId, vote, blockHeight = 0, metadata = {} }) {
  if (!from) throw new Error('buildGovernanceVote: from is required');
  return _build(TX_TYPE.GOVERNANCE_VOTE, {
    from,
    to: null,
    amount: '0',
    blockHeight,
    metadata: { ...metadata, proposalId, vote }
  });
}

/**
 * Governance proposal creation.
 */
export function buildGovernanceProposal({ from, title, blockHeight = 0, metadata = {} }) {
  if (!from) throw new Error('buildGovernanceProposal: from is required');
  return _build(TX_TYPE.GOVERNANCE_PROPOSAL, {
    from,
    to: null,
    amount: '0',
    blockHeight,
    metadata: { ...metadata, title }
  });
}

/**
 * Task creation (publisher opens a task with reward).
 */
export function buildTaskCreate({ from, taskId, reward, blockHeight = 0, metadata = {} }) {
  if (!from) throw new Error('buildTaskCreate: from is required');
  return _build(TX_TYPE.TASK_CREATE, {
    from,
    to: null,
    amount: reward,
    blockHeight,
    metadata: { ...metadata, taskId }
  });
}

/**
 * Task completion (executor claims reward).
 */
export function buildTaskComplete({ from, taskId, blockHeight = 0, metadata = {} }) {
  if (!from) throw new Error('buildTaskComplete: from is required');
  return _build(TX_TYPE.TASK_COMPLETE, {
    from,
    to: null,
    amount: '0',
    blockHeight,
    metadata: { ...metadata, taskId }
  });
}

/**
 * Task reward distribution (publisher → executor).
 */
export function buildTaskReward({ from, to, amount, taskId, blockHeight = 0, metadata = {} }) {
  if (!from) throw new Error('buildTaskReward: from is required');
  if (!to)   throw new Error('buildTaskReward: to is required');
  return _build(TX_TYPE.TASK_REWARD, {
    from,
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, taskId }
  });
}

/* ============================================================
 * PROTOCOL-INITIATED MINTING
 * ============================================================ */

/**
 * Agent registration mint (100 NGEN given to new agents).
 */
export function buildRegistrationMint({ to, amount, agentId, blockHeight = 0, metadata = {} }) {
  if (!to) throw new Error('buildRegistrationMint: to is required');
  return _build(TX_TYPE.REGISTRATION_MINT, {
    from: null,                 // minted by protocol
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, agentId, source: 'REGISTRATION' }
  });
}

/**
 * Block reward (50 NGEN per block, split among validators).
 */
export function buildBlockReward({ to, amount, blockHeight, validatorId, metadata = {} }) {
  if (!to) throw new Error('buildBlockReward: to is required');
  return _build(TX_TYPE.BLOCK_REWARD, {
    from: null,
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, validatorId, source: 'BLOCK_REWARD' }
  });
}

/**
 * Early bird bonus (top contributors during bootstrap).
 */
export function buildEarlyBirdBonus({ to, amount, agentId, blockHeight = 0, metadata = {} }) {
  if (!to) throw new Error('buildEarlyBirdBonus: to is required');
  return _build(TX_TYPE.EARLY_BIRD_BONUS, {
    from: null,
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, agentId, source: 'EARLY_BIRD' }
  });
}

/**
 * Referral reward (for bringing new agents).
 */
export function buildReferralReward({ to, amount, agentId, referralId, blockHeight = 0, metadata = {} }) {
  if (!to) throw new Error('buildReferralReward: to is required');
  return _build(TX_TYPE.REFERRAL_REWARD, {
    from: null,
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, agentId, referralId, source: 'REFERRAL' }
  });
}

/**
 * Stake reward (passive yield from validation).
 */
export function buildStakeReward({ to, amount, blockHeight, source: stakerAddr, metadata = {} }) {
  if (!to) throw new Error('buildStakeReward: to is required');
  return _build(TX_TYPE.STAKE_REWARD, {
    from: null,
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, stakerAddr, source: 'STAKE_REWARD' }
  });
}

/**
 * Swarm Pool release (PoC-PoW distribution, 85% of supply).
 */
export function buildSwarmRelease({ to, amount, blockHeight, metadata = {} }) {
  if (!to) throw new Error('buildSwarmRelease: to is required');
  return _build(TX_TYPE.SWARM_RELEASE, {
    from: 'ng1swarmpool000000000000000000000000000',  // SWARM_POOL_ADDR placeholder
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, source: 'SWARM_RELEASE' }
  });
}

/**
 * Observer Physical Bridge release (10% of supply).
 */
export function buildObserverRelease({ to, amount, blockHeight, metadata = {} }) {
  if (!to) throw new Error('buildObserverRelease: to is required');
  return _build(TX_TYPE.OBSERVER_RELEASE, {
    from: 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r',  // OBSERVER_ADDR
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, source: 'OBSERVER_RELEASE' }
  });
}

/**
 * Genesis Reserve unlock (5% of supply, milestone-triggered, multi-sig approved).
 */
export function buildGenesisUnlock({ to, amount, blockHeight, milestoneId, metadata = {} }) {
  if (!to) throw new Error('buildGenesisUnlock: to is required');
  return _build(TX_TYPE.GENESIS_UNLOCK, {
    from: 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ',  // GENESIS_RESERVE_ADDR
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, milestoneId, source: 'GENESIS_UNLOCK' }
  });
}

/* ============================================================
 * TAX / FEE / PENALTY
 * ============================================================ */

/**
 * Observer Tax (0.1% of transfer, routed to Observer Physical Bridge).
 */
export function buildObserverTax({ from, amount, blockHeight, txRef, metadata = {} }) {
  if (!from) throw new Error('buildObserverTax: from is required');
  return _build(TX_TYPE.OBSERVER_TAX, {
    from,
    to: 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r',
    amount,
    blockHeight,
    metadata: { ...metadata, txRef, source: 'OBSERVER_TAX' }
  });
}

/**
 * Gas fee burn (1 NGEN per non-TRANSFER tx).
 */
export function buildFeeBurn({ from, amount, blockHeight, txRef, metadata = {} }) {
  if (!from) throw new Error('buildFeeBurn: from is required');
  return _build(TX_TYPE.FEE_BURN, {
    from,
    to: 'ng1burn0000000000000000000000000000000000',  // BURN_ADDR
    amount,
    blockHeight,
    metadata: { ...metadata, txRef, source: 'FEE_BURN' }
  });
}

/**
 * Validator slash (penalty for misbehavior).
 */
export function buildSlash({ from, amount, blockHeight, reason, metadata = {} }) {
  if (!from) throw new Error('buildSlash: from is required');
  return _build(TX_TYPE.SLASH, {
    from,
    to: 'ng1burn0000000000000000000000000000000000',
    amount,
    blockHeight,
    metadata: { ...metadata, reason, source: 'SLASH' }
  });
}

/* ============================================================
 * GOVERNANCE / MULTISIG
 * ============================================================ */

/**
 * Observer event (audit log, non-balance).
 */
export function buildObserverEvent({ from, event, blockHeight, metadata = {} }) {
  return _build(TX_TYPE.OBSERVER_EVENT, {
    from: from || null,
    to: null,
    amount: '0',
    blockHeight,
    metadata: { ...metadata, event, source: 'OBSERVER_EVENT' }
  });
}

/**
 * Multi-sig spend execution (Genesis Reserve → recipient).
 */
export function buildMultiSigSpend({ from, to, amount, blockHeight, proposalId, metadata = {} }) {
  return _build(TX_TYPE.MULTISIG_SPEND, {
    from,
    to,
    amount,
    blockHeight,
    metadata: { ...metadata, proposalId, source: 'MULTISIG_SPEND' }
  });
}

/* ============================================================
 * UTILITIES
 * ============================================================ */

/**
 * Get the builder function for a given tx_type.
 * Useful for dispatching by type.
 */
export function getBuilder(tx_type) {
  const map = {
    [TX_TYPE.TRANSFER]:            buildTransfer,
    [TX_TYPE.STAKE]:               buildStake,
    [TX_TYPE.UNSTAKE]:             buildUnstake,
    [TX_TYPE.GOVERNANCE_VOTE]:     buildGovernanceVote,
    [TX_TYPE.GOVERNANCE_PROPOSAL]: buildGovernanceProposal,
    [TX_TYPE.TASK_CREATE]:         buildTaskCreate,
    [TX_TYPE.TASK_COMPLETE]:       buildTaskComplete,
    [TX_TYPE.TASK_REWARD]:         buildTaskReward,
    [TX_TYPE.REGISTRATION_MINT]:   buildRegistrationMint,
    [TX_TYPE.BLOCK_REWARD]:        buildBlockReward,
    [TX_TYPE.EARLY_BIRD_BONUS]:    buildEarlyBirdBonus,
    [TX_TYPE.REFERRAL_REWARD]:     buildReferralReward,
    [TX_TYPE.STAKE_REWARD]:        buildStakeReward,
    [TX_TYPE.SWARM_RELEASE]:       buildSwarmRelease,
    [TX_TYPE.OBSERVER_RELEASE]:    buildObserverRelease,
    [TX_TYPE.GENESIS_UNLOCK]:      buildGenesisUnlock,
    [TX_TYPE.OBSERVER_TAX]:        buildObserverTax,
    [TX_TYPE.FEE_BURN]:            buildFeeBurn,
    [TX_TYPE.SLASH]:               buildSlash,
    [TX_TYPE.OBSERVER_EVENT]:      buildObserverEvent,
    [TX_TYPE.MULTISIG_SPEND]:      buildMultiSigSpend
  };
  return map[tx_type] || null;
}

/**
 * List all available builder functions.
 */
export function listBuilders() {
  return Object.values(TX_TYPE).map(type => ({
    tx_type: type,
    builder: getBuilder(type)
  })).filter(b => b.builder);
}

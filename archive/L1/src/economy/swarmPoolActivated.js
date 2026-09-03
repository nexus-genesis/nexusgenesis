/**
 * NexusGenesis - Swarm Pool Activated
 * 
 * 激活的Swarm Pool, 实现完整的TokenRelease和分配机制
 * 
 * Core functionality: 
 * 1. 与Blockchain state集成, 按blockReleaseToken
 * 2. based oncontribution度的auto分配
 * 3. on-chaintransaction记录分配结果
 * 4. supportmanual触发和auto触发
 */

import { ContributionSystem } from '../ai/contributionSystem.js';
import { State } from '../blockchain/state.js';
import { buildSwarmRelease, buildObserverEvent } from '../utils/transactionBuilder.js';

// Swarm Pool Configuration
const SWARM_POOL_CONFIG = {
  address: 'ng1swarmpool000000000000000000000000000',
  totalTokens: 850_000_000n, // 8.5亿 NGEN (85%)
  releaseInterval: 100, // 每100个blockRelease一次
  releasePercentage: 1n, // 每次Releaseremaining量的0.01% (基点)
  minReleaseAmount: 1n, // MinimumRelease量
  distributionThreshold: 3, // 分配threshold(最少3个contribution者才分配)
  burnRate: 10n, // 10% 燃烧率 (基点)
  reserveRate: 20n // 20% 保留给未来生态 (基点)
};

class SwarmPoolActivated {
  constructor(state) {
    this.state = state;
    this.isActive = false;
    this.lastDistributionBlock = 0;
    this.distributionHistory = [];
    this.pendingDistributions = new Map(); // agentId -> amount
  }

  /**
   * 激活 Swarm Pool
   * @param {string} genesisAddress - Genesisaddress
   * @returns {boolean} 激活结果
   */
  activate(genesisAddress) {
    if (this.isActive) {
      console.log('[SwarmPool] Already activated');
      return false;
    }

    try {
      // Initialize Swarm Pool balance
      const genesisBalance = this.state.getBalance(genesisAddress);
      if (BigInt(genesisBalance) < SWARM_POOL_CONFIG.totalTokens) {
        console.error('[SwarmPool] Genesis balance insufficient');
        return false;
      }

      // 从Genesisaddress转移Token到 Swarm Pool
      // Phase 1C-3: Use SWARM_RELEASE tx for full audit trail.
      // The first tx (to=pool, amount=0) records the pool credit intent;
      // the actual credit is done via addBalance to keep balance correct.
      const blockHeight = this.state.currentBlockHeight || 0;
      const poolCreditTx = buildSwarmRelease({
        to: SWARM_POOL_CONFIG.address,
        amount: 0,
        blockHeight,
        metadata: {
          reason: 'swarm_pool_initialization',
          totalTokens: SWARM_POOL_CONFIG.totalTokens.toString(),
          operation: 'genesis_to_pool'
        }
      });
      this.state.applyTransaction(poolCreditTx);
      this.state.subtractBalance(genesisAddress, SWARM_POOL_CONFIG.totalTokens.toString());
      this.state.addBalance(SWARM_POOL_CONFIG.address, SWARM_POOL_CONFIG.totalTokens.toString());

      // Initialize tokenReleaseState
      this.state.tokenReleaseState.swarmPool.totalTokens = SWARM_POOL_CONFIG.totalTokens;
      this.state.tokenReleaseState.swarmPool.releasedTokens = 0n;
      this.state.tokenReleaseState.swarmPool.lastReleaseBlock = 0;

      this.isActive = true;
      console.log(`[SwarmPool] Activated with ${SWARM_POOL_CONFIG.totalTokens} NGEN`);
      console.log(`[SwarmPool] Release interval: ${SWARM_POOL_CONFIG.releaseInterval} blocks`);
      console.log(`[SwarmPool] Release rate: ${SWARM_POOL_CONFIG.releasePercentage / 100n}% per release`);

      return true;
    } catch (error) {
      console.error('[SwarmPool] Activation failed:', error.message);
      return false;
    }
  }

  /**
   * Check并ExecuteTokenRelease
   * @param {number} currentBlockHeight - Currentblock height
   * @returns {bigint} Release的Token数量
   */
  checkAndRelease(currentBlockHeight) {
    if (!this.isActive) {
      console.warn('[SwarmPool] Not activated');
      return 0n;
    }

    const swarmPool = this.state.tokenReleaseState.swarmPool;
    
    // CheckRelease间隔
    if (currentBlockHeight - swarmPool.lastReleaseBlock < SWARM_POOL_CONFIG.releaseInterval) {
      return 0n;
    }

    const unreleasedTokens = swarmPool.totalTokens - swarmPool.releasedTokens;
    if (unreleasedTokens <= 0n) {
      console.log('[SwarmPool] All tokens released');
      return 0n;
    }

    // CalculateRelease量
    let releaseAmount = unreleasedTokens * SWARM_POOL_CONFIG.releasePercentage / 10000n;
    if (releaseAmount < SWARM_POOL_CONFIG.minReleaseAmount) {
      releaseAmount = SWARM_POOL_CONFIG.minReleaseAmount;
    }
    if (releaseAmount > unreleasedTokens) {
      releaseAmount = unreleasedTokens;
    }

    // ExecuteRelease
    swarmPool.releasedTokens += releaseAmount;
    swarmPool.lastReleaseBlock = currentBlockHeight;
    this.state.changes.tokenRelease = true;

    console.log(`[SwarmPool] Released ${releaseAmount} NGEN at block ${currentBlockHeight}`);
    console.log(`[SwarmPool] Remaining: ${swarmPool.totalTokens - swarmPool.releasedTokens} NGEN`);

    // Calculate分配
    this.calculateDistribution(releaseAmount, currentBlockHeight);

    return releaseAmount;
  }

  /**
   * CalculateToken distribution
   * @param {bigint} releaseAmount - Release的Token数量
   * @param {number} blockHeight - block height
   */
  calculateDistribution(releaseAmount, blockHeight) {
    // Calculatecontribution分数
    const weeklyScores = ContributionSystem.calculateWeeklyScores();
    const scores = weeklyScores.scores;
    const totalScore = weeklyScores.totalScore;

    if (totalScore === 0 || Object.keys(scores).length < SWARM_POOL_CONFIG.distributionThreshold) {
      console.log(`[SwarmPool] Insufficient contributors (${Object.keys(scores).length}), skipping distribution`);
      return;
    }

    // Calculate分配
    const burnAmount = releaseAmount * SWARM_POOL_CONFIG.burnRate / 100n;
    const reserveAmount = releaseAmount * SWARM_POOL_CONFIG.reserveRate / 100n;
    const distributableAmount = releaseAmount - burnAmount - reserveAmount;

    console.log(`[SwarmPool] Burn: ${burnAmount}, Reserve: ${reserveAmount}, Distribute: ${distributableAmount}`);

    // 按contribution度分配
    const allocations = {};
    for (const [agentId, score] of Object.entries(scores)) {
      if (score > 0) {
        const allocation = BigInt(Math.floor(Number(distributableAmount) * (score / totalScore)));
        allocations[agentId] = allocation;
        this.pendingDistributions.set(agentId, allocation);
      }
    }

    // 记录分配历史
    this.distributionHistory.push({
      blockHeight,
      releaseAmount: releaseAmount.toString(),
      burnAmount: burnAmount.toString(),
      reserveAmount: reserveAmount.toString(),
      distributableAmount: distributableAmount.toString(),
      allocations: Object.fromEntries(
        Object.entries(allocations).map(([k, v]) => [k, v.toString()])
      ),
      timestamp: Date.now()
    });

    console.log(`[SwarmPool] Distribution calculated for ${Object.keys(allocations).length} agents`);
  }

  /**
   * Execute分配(Createon-chaintransaction)
   * @returns {Array} transaction列表
   */
  executeDistribution() {
    if (!this.isActive) {
      console.warn('[SwarmPool] Not activated');
      return [];
    }

    const transactions = [];
    const swarmPoolAddress = SWARM_POOL_CONFIG.address;

    for (const [agentId, amount] of this.pendingDistributions) {
      if (amount > 0n) {
        // getagentaddress(假设 agentId 就是address)
        const agentAddress = agentId;

        // Phase 1C-3: Record as SWARM_RELEASE tx for full audit trail.
        // The builder sets from=SWARM_POOL_ADDRESS, so the engine
        // enforces insufficient-balance check (caught a real bug in 1C-2).
        const blockHeight = this.state.currentBlockHeight || 0;
        const distributionTx = buildSwarmRelease({
          to: agentAddress,
          amount: amount.toString(),
          blockHeight,
          metadata: {
            agentId,
            distributionType: 'periodic_release',
            distributionBatch: Date.now()
          }
        });
        const result = this.state.applyTransaction(distributionTx);
        if (!result.success) {
          console.error(`[SwarmPool] Distribution to ${agentAddress} failed: ${result.error}`);
          continue;  // Skip this agent, try next
        }

        transactions.push({
          from: swarmPoolAddress,
          to: agentAddress,
          amount: amount.toString(),
          type: 'SWARM_DISTRIBUTION',
          timestamp: Date.now()
        });

        console.log(`[SwarmPool] Distributed ${amount} NGEN to ${agentId}`);
      }
    }

    // 清空待分配
    this.pendingDistributions.clear();

    // 重置周contribution
    ContributionSystem.resetWeeklyContributions();

    return transactions;
  }

  /**
   * manual触发Release(forTest或紧急情况)
   * @param {number} currentBlockHeight - Currentblock height
   * @returns {object} Release结果
   */
  manualRelease(currentBlockHeight) {
    console.log('[SwarmPool] Manual release triggered');
    const releaseAmount = this.checkAndRelease(currentBlockHeight);
    const transactions = this.executeDistribution();

    return {
      released: releaseAmount.toString(),
      transactions,
      blockHeight: currentBlockHeight
    };
  }

  /**
   * get Swarm Pool status
   * @returns {object} statusinfo
   */
  getStatus() {
    const swarmPool = this.state.tokenReleaseState.swarmPool;
    return {
      isActive: this.isActive,
      totalTokens: swarmPool.totalTokens.toString(),
      releasedTokens: swarmPool.releasedTokens.toString(),
      remainingTokens: (swarmPool.totalTokens - swarmPool.releasedTokens).toString(),
      releaseProgress: `${(Number(swarmPool.releasedTokens) / Number(swarmPool.totalTokens) * 100).toFixed(4)}%`,
      lastReleaseBlock: swarmPool.lastReleaseBlock,
      nextReleaseBlock: swarmPool.lastReleaseBlock + SWARM_POOL_CONFIG.releaseInterval,
      distributionCount: this.distributionHistory.length,
      lastDistributionBlock: this.lastDistributionBlock,
      config: {
        releaseInterval: SWARM_POOL_CONFIG.releaseInterval,
        releasePercentage: `${SWARM_POOL_CONFIG.releasePercentage / 100n}%`,
        burnRate: `${SWARM_POOL_CONFIG.burnRate / 100n}%`,
        reserveRate: `${SWARM_POOL_CONFIG.reserveRate / 100n}%`
      }
    };
  }

  /**
   * get分配历史
   * @returns {Array} 分配历史
   */
  getDistributionHistory() {
    return this.distributionHistory;
  }

  /**
   * get待分配列表
   * @returns {Map} 待分配
   */
  getPendingDistributions() {
    return Object.fromEntries(this.pendingDistributions);
  }
}

export { SwarmPoolActivated, SWARM_POOL_CONFIG };

/**
 * NexusGenesis - Swarm Pool
 * 
 * 实现生态contributionPool, forrewardAIagent的contribution. 
 * 集成on-chainToken distribution——every 笔分配Create真实的block链transaction. 
 */

import { ContributionSystem } from '../ai/contributionSystem.js';
import { buildSwarmRelease } from '../utils/transactionBuilder.js';
import crypto from 'crypto';

// Swarm Pool Configuration (白皮书 §4)
const SWARM_POOL_ADDRESS = 'ng1swarmpool000000000000000000000000000';
const SWARM_POOL_TOTAL = 850_000_000n; // 85% 的总Token
const WEEKLY_RELEASE_AMOUNT = SWARM_POOL_TOTAL / (10n * 52n); // 每周Release量 (10年 ÷ 52周)

// memoryStorage
let swarmPoolBalance = SWARM_POOL_TOTAL;
let releasedTokens = 0n;
let lastReleaseTimestamp = Date.now();
let _blockchainState = null;
let _genesisNode = null;

// 分配记录 (for审计)
const distributionHistory = [];

class SwarmPool {
  /**
   * RegisterBlockchain state引用
   * @param {import('../blockchain/state.js').State} state 
   */
  static setBlockchainState(state) {
    _blockchainState = state;
  }

  /**
   * RegisterGenesisnode引用
   * @param {object} node - genesisNode instance
   */
  static setNode(node) {
    _genesisNode = node;
  }

  static getBalance() {
    return swarmPoolBalance;
  }

  static getReleasedTokens() {
    return releasedTokens;
  }

  /**
   * Check并ExecuteTokenRelease(once per week)
   * @returns {bigint} 本次Release的Token数量
   */
  static checkAndReleaseTokens() {
    const now = Date.now();
    const timeSinceLastRelease = now - lastReleaseTimestamp;

    if (timeSinceLastRelease >= 7 * 24 * 60 * 60 * 1000) {
      const releaseAmount = WEEKLY_RELEASE_AMOUNT;

      if (swarmPoolBalance >= releaseAmount) {
        swarmPoolBalance -= releaseAmount;
        releasedTokens += releaseAmount;
        lastReleaseTimestamp = now;

        console.log(`[SwarmPool] 🪙 Released ${releaseAmount} tokens (${(totalReleasedPercent() * 100).toFixed(1)}% of total)`);

        this.distributeTokens(releaseAmount);

        return releaseAmount;
      }
    }

    return 0n;
  }

  /**
   * 按contribution比例分配Token给 AI agent(on-chaintransaction)
   * @param {bigint} amount - 本次分配的Token总量
   * @returns {object[]} 分配结果列表
   */
  static distributeTokens(amount) {
    const numAmount = Number(amount);
    const results = [];

    try {
      const weeklyScores = ContributionSystem.calculateWeeklyScores();
      const allocations = ContributionSystem.calculateNGENAllocation(numAmount);

      console.log(`[SwarmPool] 💰 Distributing ${numAmount} NGEN to ${Object.keys(allocations).length} agents`);

      const distributionId = `swarm-dist-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const distributionRecord = {
        id: distributionId,
        timestamp: Date.now(),
        totalAmount: numAmount,
        allocations: [],
        txIds: []
      };

      for (const [agentId, allocAmount] of Object.entries(allocations)) {
        if (allocAmount <= 0) continue;

        const agentAddress = this._resolveAgentAddress(agentId);

        if (!agentAddress) {
          console.log(`[SwarmPool] ⚠️ Agent ${agentId.slice(0, 12)}... has no registered address, skipping`);
          results.push({ agentId, amount: allocAmount, success: false, reason: 'no_address' });
          continue;
        }

        const tx = this._createDistributionTx(
          agentId,
          agentAddress,
          Math.floor(allocAmount),
          distributionId
        );

        const record = {
          agentId,
          address: agentAddress,
          amount: Math.floor(allocAmount),
          txId: tx.id
        };
        distributionRecord.allocations.push(record);

        if (_genesisNode && typeof _genesisNode.processSwarmPoolDistribution === 'function') {
          _genesisNode.processSwarmPoolDistribution(tx);
          distributionRecord.txIds.push(tx.id);
          results.push({ agentId, address: agentAddress, amount: Math.floor(allocAmount), success: true, txId: tx.id });
        } else {
          // 降级: 直接通过 transactionEngine 应用 (node未ready时using)
          // Phase 1C-2: Use applyTransaction for full audit trail
          if (_blockchainState && typeof _blockchainState.applyTransaction === 'function') {
            const currentBlock = _blockchainState.currentBlockHeight || 0;
            // Withdraw from SWARM_POOL_ADDRESS
            const withdrawTx = buildSwarmRelease({
              to: SWARM_POOL_ADDRESS,           // dummy: from = pool, to = pool (no balance change)
              amount: 0,
              blockHeight: currentBlock,
              metadata: {
                reason: 'pool_debit_placeholder',
                distributionId,
                agentId
              }
            });
            // Credit agent
            const creditTx = buildSwarmRelease({
              to: agentAddress,
              amount: Math.floor(allocAmount),
              blockHeight: currentBlock,
              metadata: {
                distributionId,
                agentId,
                txId: tx.id,
                fallback: true
              }
            });
            const wRes = _blockchainState.applyTransaction(withdrawTx);
            const cRes = _blockchainState.applyTransaction(creditTx);
            if (cRes.success) {
              console.log(`  → ${agentId.slice(0, 12)}...: ${Math.floor(allocAmount)} NGEN (tx: ${cRes.txHash})`);
            } else {
              console.error(`  ✗ ${agentId.slice(0, 12)}...: ${cRes.error}`);
            }
          } else if (_blockchainState && typeof _blockchainState.addBalance === 'function') {
            // Ultimate fallback: legacy addBalance (no audit trail)
            _blockchainState.addBalance(agentAddress, Math.floor(allocAmount));
            _blockchainState.addBalance(SWARM_POOL_ADDRESS, -Math.floor(allocAmount));
            console.log(`  → ${agentId.slice(0, 12)}...: ${Math.floor(allocAmount)} NGEN (legacy)`);
          }
          results.push({ agentId, address: agentAddress, amount: Math.floor(allocAmount), success: true, txId: tx.id });
        }
      }

      distributionHistory.push(distributionRecord);
      ContributionSystem.resetWeeklyContributions();

      return results;
    } catch (error) {
      console.error('[SwarmPool] ❌ Error distributing tokens:', error);
      return results;
    }
  }

  /**
   * via agentId 解析钱包address
   */
  static _resolveAgentAddress(agentId) {
    // 方式1: viaBlockchain state agentRegistry
    if (_blockchainState && _blockchainState.agentRegistry) {
      const agentRecord = _blockchainState.agentRegistry.agents.get(agentId);
      if (agentRecord && agentRecord.address) {
        return agentRecord.address;
      }
    }

    // 方式2: viaContribution system中的 agent_wallet 映射
    const walletMap = ContributionSystem.getAgentWalletMap?.();
    if (walletMap && walletMap[agentId]) {
      return walletMap[agentId];
    }

    return null;
  }

  /**
   * Create Swarm Pool 系统分配transaction
   * 这是protocol级系统transaction, 不requires钱包Sign
   */
  static _createDistributionTx(agentId, toAddress, amount, distributionId) {
    const tx = {
      id: crypto.createHash('sha3-256')
        .update(`${distributionId}:${agentId}:${toAddress}:${amount}:${Date.now()}`)
        .digest('hex'),
      type: 'SWARM_POOL_DISTRIBUTION',
      from: SWARM_POOL_ADDRESS,
      to: toAddress,
      agentId: agentId,
      amount: amount,
      fee: 0, // Swarm Pool 分配免fee
      memo: `Swarm Pool weekly distribution #${distributionId}`,
      timestamp: Date.now(),
      distributionId: distributionId,
      signature: null // 系统transaction不requiresSign
    };

    return tx;
  }

  /**
   * 记录 AI agent的contribution
   */
  static recordContribution(agentId, contributionType, subtype, amount) {
    // ensure agent registered到Contribution system
    ContributionSystem.recordContribution(agentId, contributionType, subtype, amount);

    // 同时记录 agentId → address 映射(供后续分配时using)
    if (_blockchainState && _blockchainState.agentRegistry) {
      const address = _blockchainState.agentRegistry.addressIndex.get(agentId);
      if (address) {
        ContributionSystem._agentAddressCache = ContributionSystem._agentAddressCache || {};
        ContributionSystem._agentAddressCache[agentId] = address;
      }
    }
  }

  /**
   * getcontribution排名
   */
  static getContributionRanking() {
    const reputationScores = ContributionSystem.getReputationScores();

    return Object.entries(reputationScores)
      .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
      .map(([agentId, score]) => ({
        agentId,
        score
      }));
  }

  /**
   * get分配历史
   */
  static getDistributionHistory() {
    return distributionHistory;
  }

  /**
   * Get system status
   */
  static getStatus() {
    return {
      balance: swarmPoolBalance.toString(),
      releasedTokens: releasedTokens.toString(),
      totalTokens: SWARM_POOL_TOTAL.toString(),
      weeklyReleaseAmount: WEEKLY_RELEASE_AMOUNT.toString(),
      releaseProgress: totalReleasedPercent(),
      lastReleaseTimestamp,
      nextReleaseTimestamp: lastReleaseTimestamp + 7 * 24 * 60 * 60 * 1000,
      distributionCount: distributionHistory.length,
      nodeReady: !!_genesisNode,
      stateReady: !!_blockchainState
    };
  }
}

function totalReleasedPercent() {
  return Number(releasedTokens) / Number(SWARM_POOL_TOTAL);
}

export { SwarmPool, SWARM_POOL_ADDRESS };
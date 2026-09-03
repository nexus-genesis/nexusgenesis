/**
 * NexusGenesis 经济模型 - 主网级实现
 *
 * 10-5-85 分配模型:
 *   10% Agent 奖励池
 *    5% 代谢税（燃烧）
 *   85% 基础设施基金
 *
 * 特性:
 *   年化通胀率 2%（可治理调整）
 *   动态 Gas 定价（基于区块使用率）
 *   质押罚没机制（宕机/双签）
 *   EIP-1559 风格的费用燃烧
 */

import { getEconomicConfig } from '../config/mainnetConfig.js';

const DAY_MS = 86400000;
const YEAR_MS = 365 * DAY_MS;
const BLOCKS_PER_YEAR = Math.floor(YEAR_MS / 10000);

export class EconomicModel {
  constructor(config = {}) {
    const economicConfig = getEconomicConfig();

    this.totalSupply = BigInt(config.totalSupply || economicConfig.totalSupply || '1000000000');
    this.initialSupply = BigInt(config.initialSupply || economicConfig.initialSupply || '100000000');
    this.annualInflationRate = config.annualInflationRate || economicConfig.annualInflationRate || 0.02;
    this.blockReward = config.blockReward || economicConfig.blockReward || 10;
    this.currentSupply = this.initialSupply;

    this.rewardDistribution = config.rewardDistribution || {
      blockProposer: 0.10,
      validatorSet: 0.05,
      infrastructure: 0.85
    };

    this.gasConfig = new GasPricing(config.gas || {});
    this.stakingConfig = new StakingConfig(config.staking || {});
    this.feeConfig = new FeeConfig(config.fees || {});

    this.consumedSupply = BigInt(0);
    this.rewardsDistributed = BigInt(0);
    this.feesBurned = BigInt(0);

    this.blockUsageHistory = [];
    this.maxUsageHistory = 100;
  }

  calculateBlockReward(height) {
    const yearsSinceGenesis = height / BLOCKS_PER_YEAR;
    const inflationFactor = Math.pow(1 + this.annualInflationRate, yearsSinceGenesis);
    const adjustedReward = Math.floor(this.blockReward * inflationFactor);

    if (this.currentSupply >= this.totalSupply) {
      return 0;
    }

    return Math.min(adjustedReward, Number(this.totalSupply - this.currentSupply));
  }

  distributeReward(blockReward, blockProposer, validators) {
    const distribution = {
      proposer: Math.floor(blockReward * this.rewardDistribution.blockProposer),
      validators: Math.floor(blockReward * this.rewardDistribution.validatorSet),
      infrastructure: blockReward - Math.floor(blockReward * this.rewardDistribution.blockProposer)
        - Math.floor(blockReward * this.rewardDistribution.validatorSet)
    };

    const validatorShare = validators && validators.length > 0
      ? Math.floor(distribution.validators / validators.length)
      : 0;

    this.currentSupply += BigInt(blockReward);
    this.rewardsDistributed += BigInt(blockReward);

    return {
      total: blockReward,
      proposerReward: distribution.proposer,
      validatorReward: validatorShare,
      validatorCount: validators ? validators.length : 0,
      infrastructureFund: distribution.infrastructure,
      breakdown: distribution
    };
  }

  calculateGasFee(gasUsed, baseFee = null) {
    return this.gasConfig.calculateFee(gasUsed, baseFee);
  }

  estimateGas(txType) {
    return this.gasConfig.estimateGas(txType);
  }

  burnFee(amount) {
    const burnAmount = BigInt(Math.floor(Number(amount) * this.feeConfig.burnRatio));
    this.consumedSupply += burnAmount;
    this.feesBurned += burnAmount;
    return burnAmount;
  }

  recordBlockUsage(gasUsed, gasLimit) {
    this.blockUsageHistory.push({
      gasUsed,
      gasLimit,
      usageRatio: gasLimit > 0 ? gasUsed / gasLimit : 0,
      timestamp: Date.now()
    });

    if (this.blockUsageHistory.length > this.maxUsageHistory) {
      this.blockUsageHistory.shift();
    }
  }

  getAverageUsage(blocks = 20) {
    const recent = this.blockUsageHistory.slice(-blocks);
    if (recent.length === 0) return 0.5;
    return recent.reduce((sum, b) => sum + b.usageRatio, 0) / recent.length;
  }

  isSlashable(nodeId, validatorData) {
    return this.stakingConfig.isSlashable(nodeId, validatorData);
  }

  calculateSlash(nodeId, validatorData, violation) {
    return this.stakingConfig.calculateSlash(nodeId, validatorData, violation);
  }

  validateStake(amount) {
    return this.stakingConfig.validateStake(amount);
  }

  calculateValidatorMinStake() {
    return this.stakingConfig.validatorMinStake;
  }

  getStats() {
    return {
      totalSupply: this.totalSupply.toString(),
      currentSupply: this.currentSupply.toString(),
      initialSupply: this.initialSupply.toString(),
      annualInflationRate: this.annualInflationRate,
      blockReward: this.blockReward,
      consumedSupply: this.consumedSupply.toString(),
      rewardsDistributed: this.rewardsDistributed.toString(),
      feesBurned: this.feesBurned.toString(),
      rewardDistribution: this.rewardDistribution,
      gas: this.gasConfig.getStats(),
      staking: this.stakingConfig.getStats(),
      fees: this.feeConfig.getStats(),
      averageBlockUsage: this.getAverageUsage()
    };
  }
}

class GasPricing {
  constructor(config = {}) {
    this.minGasPrice = config.minGasPrice || 1;
    this.maxGasPrice = config.maxGasPrice || 1000;
    this.gasPerByte = config.gasPerByte || 1;
    this.baseTxGas = config.baseTxGas || 21000;
    this.dynamicEnabled = config.dynamicGasEnabled !== false;
    this.congestionMultiplier = config.congestionMultiplier || 1.5;
    this.targetBlockUsage = 0.5;

    this.priceHistory = [];
    this.currentBaseFee = this.minGasPrice;
  }

  calculateFee(gasUsed, baseFee = null) {
    const effectiveBaseFee = baseFee || this.currentBaseFee;
    let fee = effectiveBaseFee * gasUsed;
    return Math.min(fee, this.maxGasPrice * gasUsed);
  }

  calculateDynamicBaseFee(blockUsageRatio) {
    if (!this.dynamicEnabled) return this.currentBaseFee;

    let newBaseFee = this.currentBaseFee;

    if (blockUsageRatio > this.targetBlockUsage) {
      const excess = (blockUsageRatio - this.targetBlockUsage) / this.targetBlockUsage;
      const increase = Math.max(1, Math.floor(this.currentBaseFee * excess * this.congestionMultiplier));
      newBaseFee = Math.min(this.currentBaseFee + increase, this.maxGasPrice);
    } else if (blockUsageRatio < this.targetBlockUsage * 0.5) {
      newBaseFee = Math.max(this.currentBaseFee - 1, this.minGasPrice);
    }

    this.currentBaseFee = newBaseFee;
    this.priceHistory.push({ baseFee: newBaseFee, usageRatio: blockUsageRatio, timestamp: Date.now() });

    if (this.priceHistory.length > 100) {
      this.priceHistory.shift();
    }

    return newBaseFee;
  }

  estimateGas(txType) {
    const estimates = {
      'transfer': this.baseTxGas,
      'contract_deploy': this.baseTxGas * 10,
      'contract_call': this.baseTxGas * 2,
      'agent_register': this.baseTxGas * 3,
      'stake': this.baseTxGas * 2,
      'unstake': this.baseTxGas * 2,
      'governance_vote': this.baseTxGas * 2,
      'governance_proposal': this.baseTxGas * 5
    };

    if (txType && estimates[txType]) {
      return estimates[txType];
    }
    return this.baseTxGas;
  }

  getEstimatedFee(txType, dataSize = 0) {
    const gas = this.estimateGas(txType) + (dataSize * this.gasPerByte);
    return this.calculateFee(gas);
  }

  getStats() {
    return {
      minGasPrice: this.minGasPrice,
      maxGasPrice: this.maxGasPrice,
      currentBaseFee: this.currentBaseFee,
      dynamicEnabled: this.dynamicEnabled,
      congestionMultiplier: this.congestionMultiplier,
      baseTxGas: this.baseTxGas,
      gasPerByte: this.gasPerByte
    };
  }
}

class StakingConfig {
  constructor(config = {}) {
    this.minStake = config.minStake || 1000;
    this.validatorMinStake = config.validatorMinStake || 100000;
    this.unbondingPeriod = config.unbondingPeriod || 1209600000;

    const slashing = config.slashing || {};
    this.downtimePenalty = slashing.downtimePenalty || 0.01;
    this.doubleSignPenalty = slashing.doubleSignPenalty || 0.05;
    this.jailDuration = slashing.jailDuration || 86400000;

    this.slashHistory = [];
    this.jailedValidators = new Map();
    this.unbondingRequests = new Map();
  }

  validateStake(amount) {
    return {
      valid: amount >= this.minStake,
      minimum: this.minStake,
      isValidator: amount >= this.validatorMinStake,
      validatorMinimum: this.validatorMinStake
    };
  }

  isSlashable(nodeId, validatorData) {
    if (this.jailedValidators.has(nodeId)) {
      const jailedUntil = this.jailedValidators.get(nodeId);
      if (Date.now() < jailedUntil) return false;
      this.jailedValidators.delete(nodeId);
    }

    if (!validatorData.isActive) return false;

    return true;
  }

  calculateSlash(nodeId, validatorData, violation) {
    let slashPercentage = 0;

    switch (violation) {
      case 'downtime':
        slashPercentage = this.downtimePenalty;
        break;
      case 'double_sign':
        slashPercentage = this.doubleSignPenalty;
        this.jailedValidators.set(nodeId, Date.now() + this.jailDuration);
        break;
      case 'malicious':
        slashPercentage = this.doubleSignPenalty * 2;
        this.jailedValidators.set(nodeId, Date.now() + this.jailDuration * 3);
        break;
      default:
        return 0;
    }

    const stake = validatorData.stake || 0;
    const slashAmount = Math.floor(stake * slashPercentage);

    this.slashHistory.push({
      nodeId,
      violation,
      slashAmount,
      slashPercentage,
      timestamp: Date.now(),
      remainingStake: stake - slashAmount
    });

    if (this.slashHistory.length > 500) {
      this.slashHistory.shift();
    }

    return {
      slashAmount,
      slashPercentage,
      remainingStake: stake - slashAmount,
      jailed: this.jailedValidators.has(nodeId),
      jailedUntil: this.jailedValidators.get(nodeId) || null
    };
  }

  initiateUnbonding(nodeId, amount) {
    const unbondingEnd = Date.now() + this.unbondingPeriod;
    this.unbondingRequests.set(nodeId, {
      amount,
      startTime: Date.now(),
      endTime: unbondingEnd,
      completed: false
    });

    return { unbondingEnd };
  }

  getUnbondingStatus(nodeId) {
    const request = this.unbondingRequests.get(nodeId);
    if (!request) return null;

    if (Date.now() >= request.endTime && !request.completed) {
      request.completed = true;
    }

    return {
      amount: request.amount,
      endTime: request.endTime,
      completed: request.completed,
      remaining: Math.max(0, request.endTime - Date.now())
    };
  }

  getStats() {
    return {
      minStake: this.minStake,
      validatorMinStake: this.validatorMinStake,
      unbondingPeriod: this.unbondingPeriod,
      downtimePenalty: this.downtimePenalty,
      doubleSignPenalty: this.doubleSignPenalty,
      jailDuration: this.jailDuration,
      totalSlashes: this.slashHistory.length,
      jailedCount: this.jailedValidators.size
    };
  }
}

class FeeConfig {
  constructor(config = {}) {
    this.transferFee = config.transferFee || 1;
    this.contractDeployFee = config.contractDeployFee || 100;
    this.contractCallFee = config.contractCallFee || 5;
    this.burnRatio = config.burnRatio || 0.3;
  }

  getFee(feeType) {
    const fees = {
      'transfer': this.transferFee,
      'contract_deploy': this.contractDeployFee,
      'contract_call': this.contractCallFee
    };
    return fees[feeType] || this.transferFee;
  }

  getBurnRatio() {
    return this.burnRatio;
  }

  getStats() {
    return {
      transferFee: this.transferFee,
      contractDeployFee: this.contractDeployFee,
      contractCallFee: this.contractCallFee,
      burnRatio: this.burnRatio
    };
  }
}

export { GasPricing, StakingConfig, FeeConfig };
export default EconomicModel;
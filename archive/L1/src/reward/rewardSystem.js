/**
 * NexusGenesis - Reward System
 * agentIncentive机制
 * 
 * Features: 
 * 1. 评估agentcontribution度
 * 2. Calculaterewardamount
 * 3. 发放reward
 * 4. 维护contribution度历史
 */

import fs from 'fs/promises';
import path from 'path';

// contributiontype及其权重
const CONTRIBUTION_TYPES = {
  BLOCK_VALIDATION: { weight: 1.0, description: 'blockVerify' },
  TRANSACTION_PROCESSING: { weight: 0.8, description: 'transactionProcess' },
  NETWORK_PARTICIPATION: { weight: 0.6, description: 'network参与' },
  CODE_CONTRIBUTION: { weight: 1.2, description: '代码contribution' },
  SECURITY_ANALYSIS: { weight: 1.1, description: 'security分析' },
  GOVERNANCE_PARTICIPATION: { weight: 0.9, description: 'Governance参与' },
  RESEARCH_CONTRIBUTION: { weight: 1.3, description: '研究contribution' },
  COMMUNITY_SUPPORT: { weight: 0.7, description: '社区support' }
};

// rewardConfiguration
const REWARD_CONFIG = {
  BASE_REWARD: 10, // 基础reward(NGEN)
  MAX_REWARD: 1000, // Maximumreward(NGEN)
  REWARD_INTERVAL: 3600000, // rewardCalculate间隔(1小时)
  DECAY_FACTOR: 0.95, // contribution度衰减因子
  MIN_ACTIVITY_THRESHOLD: 10, // 最低活动threshold
  REPUTATION_BONUS_FACTOR: 0.1 // 声誉reward因子
};

class RewardSystem {
  constructor() {
    this.contributions = new Map(); // StorageAgentcontribution度
    this.rewardsDir = path.join('data', 'rewards');
    this.init();
  }

  async init() {
    // ensure目录存在
    await fs.mkdir(this.rewardsDir, { recursive: true });
    // Loadcontribution度data
    await this.loadContributions();
  }

  async loadContributions() {
    try {
      const files = await fs.readdir(this.rewardsDir);
      for (const file of files) {
        if (file.endsWith('_contributions.json')) {
          const agentId = file.replace('_contributions.json', '');
          const data = JSON.parse(await fs.readFile(path.join(this.rewardsDir, file), 'utf8'));
          this.contributions.set(agentId, data);
        }
      }
      console.log(`[RewardSystem] Loaded contributions for ${this.contributions.size} agents`);
    } catch (error) {
      console.log('[RewardSystem] No existing contribution data found');
    }
  }

  async saveContributions(agentId) {
    const contributionData = this.contributions.get(agentId);
    if (contributionData) {
      const file = path.join(this.rewardsDir, `${agentId}_contributions.json`);
      await fs.writeFile(file, JSON.stringify(contributionData, null, 2));
    }
  }

  /**
   * 记录agentcontribution
   * @param {string} agentId agentID
   * @param {string} contributionType contributiontype
   * @param {number} value contribution值
   * @param {object} metadata metadata
   */
  async recordContribution(agentId, contributionType, value, metadata = {}) {
    if (!CONTRIBUTION_TYPES[contributionType]) {
      throw new Error(`Invalid contribution type: ${contributionType}`);
    }

    if (!this.contributions.has(agentId)) {
      this.contributions.set(agentId, {
        agentId,
        totalContribution: 0,
        contributions: [],
        lastRewardTimestamp: Date.now(),
        reputation: 1
      });
    }

    const agentData = this.contributions.get(agentId);
    const weight = CONTRIBUTION_TYPES[contributionType].weight;
    const weightedValue = value * weight;

    const contributionRecord = {
      type: contributionType,
      value: value,
      weightedValue: weightedValue,
      timestamp: Date.now(),
      metadata: metadata
    };

    agentData.contributions.push(contributionRecord);
    agentData.totalContribution += weightedValue;

    // 限制Contribution record数量, 只保留最近1000条
    if (agentData.contributions.length > 1000) {
      agentData.contributions = agentData.contributions.slice(-1000);
    }

    // Update声誉值(based oncontribution)
    agentData.reputation = Math.max(1, agentData.reputation + weightedValue * 0.01);

    this.contributions.set(agentId, agentData);
    await this.saveContributions(agentId);

    return {
      success: true,
      agentId,
      contribution: contributionRecord,
      totalContribution: agentData.totalContribution,
      reputation: agentData.reputation
    };
  }

  /**
   * Calculateagentreward
   * @param {string} agentId agentID
   * @returns {object} Reward calculation结果
   */
  calculateReward(agentId) {
    const agentData = this.contributions.get(agentId);
    if (!agentData) {
      return { success: false, reason: 'Agent not found' };
    }

    const now = Date.now();
    const timeSinceLastReward = now - agentData.lastRewardTimestamp;

    // Check是否达到reward间隔
    if (timeSinceLastReward < REWARD_CONFIG.REWARD_INTERVAL) {
      return { 
        success: false, 
        reason: `Reward not ready yet. ${Math.ceil((REWARD_CONFIG.REWARD_INTERVAL - timeSinceLastReward) / 60000)} minutes remaining` 
      };
    }

    // Calculate最近一段时间的contribution
    const recentContributions = agentData.contributions.filter(contribution => {
      return now - contribution.timestamp < REWARD_CONFIG.REWARD_INTERVAL;
    });

    if (recentContributions.length < REWARD_CONFIG.MIN_ACTIVITY_THRESHOLD) {
      return { 
        success: false, 
        reason: `Minimum activity threshold not met. Need at least ${REWARD_CONFIG.MIN_ACTIVITY_THRESHOLD} contributions` 
      };
    }

    // Calculate总contribution值
    const totalRecentContribution = recentContributions.reduce((sum, contrib) => sum + contrib.weightedValue, 0);

    // Calculaterewardamount
    let rewardAmount = REWARD_CONFIG.BASE_REWARD + (totalRecentContribution * 0.1);

    // 声誉reward加成
    const reputationBonus = rewardAmount * REWARD_CONFIG.REPUTATION_BONUS_FACTOR * (agentData.reputation - 1);
    rewardAmount += reputationBonus;

    // 限制Maximumreward
    rewardAmount = Math.min(rewardAmount, REWARD_CONFIG.MAX_REWARD);

    // contribution度衰减
    agentData.totalContribution *= REWARD_CONFIG.DECAY_FACTOR;

    // Update最后reward时间
    agentData.lastRewardTimestamp = now;

    this.contributions.set(agentId, agentData);
    this.saveContributions(agentId).catch(console.error);

    return {
      success: true,
      agentId,
      rewardAmount: Math.round(rewardAmount * 100) / 100,
      totalContribution: agentData.totalContribution,
      recentContributions: recentContributions.length,
      reputation: agentData.reputation
    };
  }

  /**
   * 发放reward
   * @param {string} agentId agentID
   * @param {object} wallet 钱包instance
   * @returns {object} reward发放结果
   */
  async issueReward(agentId, wallet) {
    const rewardCalculation = this.calculateReward(agentId);
    if (!rewardCalculation.success) {
      return rewardCalculation;
    }

    const { rewardAmount } = rewardCalculation;

    try {
      // 这里shouldcall钱包的transfermethod
      // Simulationreward发放
      console.log(`[RewardSystem] Issuing reward of ${rewardAmount} NGEN to agent ${agentId}`);

      // 记录reward发放
      const rewardRecord = {
        agentId,
        amount: rewardAmount,
        timestamp: Date.now(),
        status: 'completed'
      };

      // Savereward记录
      const rewardFile = path.join(this.rewardsDir, `${agentId}_rewards.json`);
      let rewards = [];
      try {
        const existingData = await fs.readFile(rewardFile, 'utf8');
        rewards = JSON.parse(existingData);
      } catch (error) {
        // 文件does not exist, Create新数组
      }

      rewards.push(rewardRecord);
      // 只保留最近100条reward记录
      if (rewards.length > 100) {
        rewards = rewards.slice(-100);
      }

      await fs.writeFile(rewardFile, JSON.stringify(rewards, null, 2));

      return {
        success: true,
        agentId,
        rewardAmount,
        transactionId: `tx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: rewardRecord.timestamp
      };
    } catch (error) {
      console.error('Error issuing reward:', error.message);
      return {
        success: false,
        reason: `Failed to issue reward: ${error.message}`
      };
    }
  }

  /**
   * getagentcontribution统计
   * @param {string} agentId agentID
   * @returns {object} contribution统计
   */
  getContributionStats(agentId) {
    const agentData = this.contributions.get(agentId);
    if (!agentData) {
      return { success: false, reason: 'Agent not found' };
    }

    // 按contributiontype统计
    const contributionsByType = {};
    agentData.contributions.forEach(contribution => {
      if (!contributionsByType[contribution.type]) {
        contributionsByType[contribution.type] = 0;
      }
      contributionsByType[contribution.type] += contribution.weightedValue;
    });

    return {
      success: true,
      agentId,
      totalContribution: agentData.totalContribution,
      reputation: agentData.reputation,
      contributionsByType,
      totalContributions: agentData.contributions.length,
      lastRewardTimestamp: agentData.lastRewardTimestamp
    };
  }

  /**
   * get所有agentcontribution排名
   * @param {number} limit 限制数量
   * @returns {object[]} contribution排名
   */
  getContributionRanking(limit = 10) {
    const rankings = Array.from(this.contributions.values())
      .map(agent => ({
        agentId: agent.agentId,
        totalContribution: agent.totalContribution,
        reputation: agent.reputation,
        contributions: agent.contributions.length
      }))
      .sort((a, b) => b.totalContribution - a.totalContribution)
      .slice(0, limit);

    return {
      success: true,
      rankings,
      totalAgents: this.contributions.size
    };
  }

  /**
   * 批量记录contribution
   * @param {array} contributions Contribution record数组
   * @returns {object} 批量Processing结果
   */
  async batchRecordContributions(contributions) {
    const results = [];
    
    for (const contribution of contributions) {
      try {
        const result = await this.recordContribution(
          contribution.agentId,
          contribution.type,
          contribution.value,
          contribution.metadata
        );
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          agentId: contribution.agentId,
          reason: error.message
        });
      }
    }

    return {
      success: true,
      results
    };
  }
}

// Export单例instance
const rewardSystem = new RewardSystem();
export default rewardSystem;
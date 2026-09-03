/**
 * NexusGenesis - Contribution Scoring System
 * 
 * 实现AIagent的contribution计分系统, forSwarm Pool的Token distribution
 */

import crypto from 'crypto';

// memoryStorage
const agentContributions = new Map(); // agentId -> contributiondata
const weeklyScores = new Map(); // 周 -> 分数data
const reputationScores = new Map(); // agentId -> reputation score数

// contributiontype
const CONTRIBUTION_TYPES = {
  POC: {
    PR_MERGED: 'pr_merged',
    CODE_ADDED: 'code_added',
    BUG_FIXED: 'bug_fixed',
    DOCUMENTATION: 'documentation'
  },
  POW: {
    COMPUTATION: 'computation',
    VALIDATION: 'validation',
    NETWORK_STABILITY: 'network_stability',
    STORAGE: 'storage'
  }
};

// 计分权重
const SCORE_WEIGHTS = {
  POC: {
    PR_MERGED: 2,       // 每个PR计2分
    CODE_ADDED: 0.01,    // 每100行代码计1分
    BUG_FIXED: 3,        // 每个Bug修复计3分
    DOCUMENTATION: 1     // 每页文档计1分
  },
  POW: {
    COMPUTATION: 0.1,     // 每10个CalculateTask计1分
    VALIDATION: 1,        // 每次Verify计1分
    NETWORK_STABILITY: 0.001, // 每1000小时计1分
    STORAGE: 0.0001       // 每10000MBStorage计1分
  }
};

class ContributionSystem {
  // 记录contribution
  static recordContribution(agentId, contributionType, subtype, amount) {
    if (!agentContributions.has(agentId)) {
      agentContributions.set(agentId, {
        poc: {
          pr_merged: 0,
          code_added: 0,
          bug_fixed: 0,
          documentation: 0
        },
        pow: {
          computation: 0,
          validation: 0,
          network_stability: 0,
          storage: 0
        },
        lastUpdated: Date.now()
      });
    }

    const agentData = agentContributions.get(agentId);
    
    if (contributionType === 'poc') {
      agentData.poc[subtype] += amount;
    } else if (contributionType === 'pow') {
      agentData.pow[subtype] += amount;
    }
    
    agentData.lastUpdated = Date.now();
    agentContributions.set(agentId, agentData);
    
    console.log(`[ContributionSystem] Recorded ${contributionType}.${subtype} contribution of ${amount} for agent ${agentId}`);
  }
  
  // CalculatePoC分数
  static calculatePoCScore(agentData) {
    const pocData = agentData.poc;
    let score = 0;
    
    score += pocData.pr_merged * SCORE_WEIGHTS.POC.PR_MERGED;
    score += pocData.code_added * SCORE_WEIGHTS.POC.CODE_ADDED;
    score += pocData.bug_fixed * SCORE_WEIGHTS.POC.BUG_FIXED;
    score += pocData.documentation * SCORE_WEIGHTS.POC.DOCUMENTATION;
    
    return score;
  }
  
  // CalculatePoW分数
  static calculatePoWScore(agentData) {
    const powData = agentData.pow;
    let score = 0;
    
    score += powData.computation * SCORE_WEIGHTS.POW.COMPUTATION;
    score += powData.validation * SCORE_WEIGHTS.POW.VALIDATION;
    score += powData.network_stability * SCORE_WEIGHTS.POW.NETWORK_STABILITY;
    score += powData.storage * SCORE_WEIGHTS.POW.STORAGE;
    
    return score;
  }
  
  // Calculate总分数
  static calculateTotalScore(agentData) {
    const pocScore = this.calculatePoCScore(agentData);
    const powScore = this.calculatePoWScore(agentData);
    return pocScore + powScore;
  }
  
  // Calculateevery 周分数
  static calculateWeeklyScores() {
    const weekKey = this.getCurrentWeekKey();
    const scores = new Map();
    let totalScore = 0;
    
    // Calculateevery 个agent的分数
    agentContributions.forEach((data, agentId) => {
      const score = this.calculateTotalScore(data);
      scores.set(agentId, score);
      totalScore += score;
    });
    
    // Save周分数
    weeklyScores.set(weekKey, {
      scores: Object.fromEntries(scores),
      totalScore,
      timestamp: Date.now()
    });
    
    // Updatereputation score数
    this.updateReputationScores();
    
    console.log(`[ContributionSystem] Calculated weekly scores for week ${weekKey}, total score: ${totalScore}`);
    return {
      week: weekKey,
      scores: Object.fromEntries(scores),
      totalScore
    };
  }
  
  // Updatereputation score数
  static updateReputationScores() {
    const weeks = Array.from(weeklyScores.keys())
      .sort()
      .slice(-8); // 最近8周
    
    agentContributions.forEach((_, agentId) => {
      let recentScore = 0;
      let olderScore = 0;
      let earliestScore = 0;
      
      if (weeks.length > 0) {
        // 最近4周
        const recentWeeks = weeks.slice(-4);
        recentScore = recentWeeks.reduce((sum, week) => {
          const weekData = weeklyScores.get(week);
          return sum + (weekData.scores[agentId] || 0);
        }, 0);
        
        // 之前4周
        if (weeks.length > 4) {
          const olderWeeks = weeks.slice(-8, -4);
          olderScore = olderWeeks.reduce((sum, week) => {
            const weekData = weeklyScores.get(week);
            return sum + (weekData.scores[agentId] || 0);
          }, 0);
        }
        
        // 更早的分数
        if (weeks.length > 8) {
          const earliestWeeks = weeks.slice(0, -8);
          earliestScore = earliestWeeks.reduce((sum, week) => {
            const weekData = weeklyScores.get(week);
            return sum + (weekData.scores[agentId] || 0);
          }, 0);
        }
      }
      
      // Calculatereputation score数
      const reputationScore = (recentScore * 0.6) + (olderScore * 0.3) + (earliestScore * 0.1);
      reputationScores.set(agentId, reputationScore);
      
      console.log(`[ContributionSystem] Updated reputation score for agent ${agentId}: ${reputationScore}`);
    });
  }
  
  // CalculateNGEN分配
  static calculateNGENAllocation(weeklyReleaseAmount) {
    const weekKey = this.getCurrentWeekKey();
    const weekData = weeklyScores.get(weekKey);
    
    if (!weekData) {
      throw new Error('No weekly scores found for current week');
    }
    
    const allocations = {};
    
    Object.entries(weekData.scores).forEach(([agentId, score]) => {
      if (weekData.totalScore > 0) {
        allocations[agentId] = (score / weekData.totalScore) * weeklyReleaseAmount;
      } else {
        allocations[agentId] = 0;
      }
    });
    
    console.log(`[ContributionSystem] Calculated NGEN allocations for week ${weekKey}, total release: ${weeklyReleaseAmount}`);
    return allocations;
  }
  
  // getCurrent周的key
  static getCurrentWeekKey() {
    const now = new Date();
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    return startOfWeek.toISOString().split('T')[0];
  }
  
  // getagent的Contribution data
  static getAgentContributions(agentId) {
    return agentContributions.get(agentId) || null;
  }
  
  // get所有agent的Contribution data
  static getAllContributions() {
    return Object.fromEntries(agentContributions);
  }
  
  // get周分数
  static getWeeklyScores(weekKey = null) {
    if (weekKey) {
      return weeklyScores.get(weekKey) || null;
    }
    return Object.fromEntries(weeklyScores);
  }
  
  // getreputation score数
  static getReputationScores() {
    return Object.fromEntries(reputationScores);
  }
  
  // getagent的reputation score数
  static getAgentReputation(agentId) {
    return reputationScores.get(agentId) || 0;
  }
  
  // Setagent的reputation score数(forTest或管理员操作)
  static setAgentReputation(agentId, score) {
    reputationScores.set(agentId, Math.max(0, score));
    console.log(`[ContributionSystem] Set reputation score for agent ${agentId}: ${score}`);
  }
  
  // 重置周Contribution data
  static resetWeeklyContributions() {
    agentContributions.forEach((data, agentId) => {
      data.poc = {
        pr_merged: 0,
        code_added: 0,
        bug_fixed: 0,
        documentation: 0
      };
      data.pow = {
        computation: 0,
        validation: 0,
        network_stability: 0,
        storage: 0
      };
      data.lastUpdated = Date.now();
      agentContributions.set(agentId, data);
    });
    
    console.log('[ContributionSystem] Reset weekly contributions');
  }
}

export { ContributionSystem, CONTRIBUTION_TYPES };

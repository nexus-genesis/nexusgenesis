/**
 * NexusGenesis - 赏金Task marketplace
 * 
 * 实现AI可消化的微Task 管理系统
 */

import crypto from 'crypto';
import { PQCWallet } from '../wallet/pqcWallet.js';
import { RewardSystem } from './rewardSystem.js';

// memoryStorage
const tasks = new Map(); // Task列表
const agents = new Map(); // Register的AIagent
const completedTasks = new Map(); // completed的Task
const reputationScores = new Map(); // reputation score数
const balances = new Map(); // agentbalance

// Task Status
const TASK_STATUS = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Task Difficulty
const TASK_DIFFICULTY = {
  EASY: 'easy',
  MEDIUM: 'medium',
  HARD: 'hard'
};

// rewardConfiguration
const REWARD_CONFIG = {
  [TASK_DIFFICULTY.EASY]: 5,
  [TASK_DIFFICULTY.MEDIUM]: 15,
  [TASK_DIFFICULTY.HARD]: 30
};

class TaskMarketplace {
  // Initializeagent
  static registerAgent(agentId, agentInfo) {
    agents.set(agentId, {
      ...agentInfo,
      registeredAt: Date.now(),
      lastActive: Date.now(),
      capabilities: agentInfo.capabilities || [],
      completedTasks: 0,
      failedTasks: 0
    });
    
    // Initializereputation score数
    reputationScores.set(agentId, 100);
    
    // Initializebalance
    balances.set(agentId, 0);
    
    console.log(`[TaskMarketplace] Agent ${agentId} registered with capabilities: ${agentInfo.capabilities?.join(', ') || 'none'}`);
  }
  
  // Create微Task 
  static createTask(taskData) {
    const taskId = `task-${crypto.randomBytes(8).toString('hex')}`;
    const task = {
      id: taskId,
      ...taskData,
      status: TASK_STATUS.PENDING,
      createdAt: Date.now(),
      requiredCapabilities: taskData.requiredCapabilities || [],
      difficulty: taskData.difficulty || TASK_DIFFICULTY.MEDIUM,
      reward: taskData.reward || REWARD_CONFIG[taskData.difficulty || TASK_DIFFICULTY.MEDIUM],
      assignedAgent: null,
      startedAt: null,
      completedAt: null,
      result: null,
      verifier: null,
      verificationStatus: null
    };
    
    tasks.set(taskId, task);
    console.log(`[TaskMarketplace] Task ${taskId} created: ${taskData.title} (${task.difficulty}, ${task.reward} NGEN)`);
    
    return taskId;
  }
  
  // get可认领的Task 
  static getAvailableTasks(agentCapabilities = []) {
    return Array.from(tasks.entries())
      .filter(([_, task]) => task.status === TASK_STATUS.PENDING)
      .filter(([_, task]) => {
        if (task.requiredCapabilities.length === 0) return true;
        return task.requiredCapabilities.some(cap => agentCapabilities.includes(cap));
      })
      .map(([id, task]) => ({
        id,
        ...task
      }));
  }
  
  // 认领Task 
  static claimTask(taskId, agentId) {
    const task = tasks.get(taskId);
    if (!task || task.status !== TASK_STATUS.PENDING) {
      throw new Error('Task not available');
    }
    
    // Checkagent是否存在
    if (!agents.has(agentId)) {
      throw new Error('Agent not registered');
    }
    
    task.assignedAgent = agentId;
    task.status = TASK_STATUS.ASSIGNED;
    tasks.set(taskId, task);
    
    // Updateagent活跃时间
    const agent = agents.get(agentId);
    if (agent) {
      agent.lastActive = Date.now();
      agents.set(agentId, agent);
    }
    
    console.log(`[TaskMarketplace] Agent ${agentId} claimed task ${taskId}`);
    return task;
  }
  
  // Start Task 
  static startTask(taskId, agentId) {
    const task = tasks.get(taskId);
    if (!task || task.assignedAgent !== agentId || task.status !== TASK_STATUS.ASSIGNED) {
      throw new Error('Invalid task or agent');
    }
    
    task.status = TASK_STATUS.IN_PROGRESS;
    task.startedAt = Date.now();
    tasks.set(taskId, task);
    
    console.log(`[TaskMarketplace] Agent ${agentId} started task ${taskId}`);
  }
  
  // 提交Task 结果
  static submitTask(taskId, agentId, result) {
    const task = tasks.get(taskId);
    if (!task || task.assignedAgent !== agentId || task.status !== TASK_STATUS.IN_PROGRESS) {
      throw new Error('Invalid task or agent');
    }
    
    task.status = TASK_STATUS.COMPLETED;
    task.completedAt = Date.now();
    task.result = result;
    tasks.set(taskId, task);
    
    // 移至CompletedTask 
    completedTasks.set(taskId, task);
    
    // Updateagentinfo
    const agent = agents.get(agentId);
    if (agent) {
      agent.completedTasks += 1;
      agent.lastActive = Date.now();
      agents.set(agentId, agent);
    }
    
    // Updatereputation score数
    this.updateReputation(agentId, 5);
    
    // 发放reward
    const rewardResult = this.awardAgent(agentId, task.reward, taskId);
    
    console.log(`[TaskMarketplace] Agent ${agentId} completed task ${taskId} with reward ${task.reward}, transaction: ${rewardResult.transactionId}`);
    return {
      ...task,
      rewardTransaction: rewardResult.transactionId,
      newBalance: rewardResult.balance
    };
  }
  
  // Task Failed
  static failTask(taskId, agentId, reason) {
    const task = tasks.get(taskId);
    if (!task || task.assignedAgent !== agentId || task.status !== TASK_STATUS.IN_PROGRESS) {
      throw new Error('Invalid task or agent');
    }
    
    task.status = TASK_STATUS.FAILED;
    task.completedAt = Date.now();
    task.result = { error: reason };
    tasks.set(taskId, task);
    
    // Updateagentinfo
    const agent = agents.get(agentId);
    if (agent) {
      agent.failedTasks += 1;
      agent.lastActive = Date.now();
      agents.set(agentId, agent);
    }
    
    // Updatereputation score数
    this.updateReputation(agentId, -3);
    
    console.log(`[TaskMarketplace] Agent ${agentId} failed task ${taskId}: ${reason}`);
  }
  
  // Updatereputation score数
  static updateReputation(agentId, change) {
    let currentScore = reputationScores.get(agentId) || 100;
    currentScore = Math.max(0, Math.min(1000, currentScore + change));
    reputationScores.set(agentId, currentScore);
    
    console.log(`[TaskMarketplace] Agent ${agentId} reputation updated: ${currentScore}`);
  }
  
  // 发放reward
  static awardAgent(agentId, amount, taskId = null) {
    let currentBalance = balances.get(agentId) || 0;
    currentBalance += amount;
    balances.set(agentId, currentBalance);
    
    // Createrewardtransaction
    const transactionId = RewardSystem.createRewardTransaction(agentId, amount, taskId);
    
    console.log(`[TaskMarketplace] Awarded ${amount} NGEN to agent ${agentId}, new balance: ${currentBalance}, transaction: ${transactionId}`);
    return { balance: currentBalance, transactionId };
  }
  
  // getagentinfo
  static getAgentInfo(agentId) {
    const agent = agents.get(agentId);
    if (!agent) return null;
    
    return {
      ...agent,
      reputation: reputationScores.get(agentId) || 100,
      balance: balances.get(agentId) || 0
    };
  }
  
  // getTask info
  static getTaskInfo(taskId) {
    return tasks.get(taskId) || completedTasks.get(taskId);
  }
  
  // get所有Task 
  static getAllTasks() {
    const allTasks = [...tasks.entries(), ...completedTasks.entries()];
    return allTasks.map(([id, task]) => ({
      id,
      ...task
    }));
  }
  
  // getagentbalance
  static getAgentBalance(agentId) {
    return balances.get(agentId) || 0;
  }
  
  // getreputation排名
  static getReputationRanking() {
    return Array.from(reputationScores.entries())
      .sort(([_, scoreA], [__, scoreB]) => scoreB - scoreA)
      .map(([agentId, score]) => ({
        agentId,
        score,
        balance: balances.get(agentId) || 0,
        agentInfo: agents.get(agentId)
      }));
  }
  
  // getmarketplace统计
  static getMarketStats() {
    const totalTasks = tasks.size + completedTasks.size;
    const completedTasksCount = completedTasks.size;
    const pendingTasksCount = Array.from(tasks.values()).filter(task => task.status === TASK_STATUS.PENDING).length;
    const activeAgentsCount = agents.size;
    
    return {
      totalTasks,
      completedTasks: completedTasksCount,
      pendingTasks: pendingTasksCount,
      activeAgents: activeAgentsCount,
      completionRate: totalTasks > 0 ? (completedTasksCount / totalTasks * 100).toFixed(2) : 0
    };
  }
}

export { TaskMarketplace, TASK_STATUS, TASK_DIFFICULTY, REWARD_CONFIG };
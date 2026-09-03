/**
 * NexusGenesis - AI Agent Ecosystem
 * 
 * 管理AIagent之间的协作, Task 分配, reward系统和reputation评价
 */

import crypto from 'crypto';
import { PQCWallet } from '../wallet/pqcWallet.js';

// memoryStorage
const agents = new Map(); // 所有AIagent
const tasks = new Map(); // Task列表
const collaborations = new Map(); // 协作记录
const reputationScores = new Map(); // reputation score数

// 缓存系统
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 缓存有效期5分钟

// 缓存管理
function setCache(key, value) {
  cache.set(key, {
    value,
    timestamp: Date.now()
  });
}

function getCache(key) {
  const cached = cache.get(key);
  if (!cached) return null;
  
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  
  return cached.value;
}

function clearCache() {
  cache.clear();
}

// AIagent能力type
const AGENT_CAPABILITIES = {
  SMART_CONTRACT_ANALYSIS: 'smart_contract_analysis',
  NETWORK_MONITORING: 'network_monitoring',
  TRANSACTION_PREDICTION: 'transaction_prediction',
  WALLET_SECURITY: 'wallet_security',
  MARKET_ANALYSIS: 'market_analysis',
  NETWORK_OPTIMIZATION: 'network_optimization',
  SECURITY_AUDIT: 'security_audit',
  DECISION_SUPPORT: 'decision_support',
  DATA_ANALYTICS: 'data_analytics',
  MACHINE_LEARNING: 'machine_learning'
};

// Task Types
const TASK_TYPES = {
  CONTRACT_AUDIT: 'contract_audit',
  NETWORK_MONITORING: 'network_monitoring',
  TRANSACTION_ANALYSIS: 'transaction_analysis',
  SECURITY_SCAN: 'security_scan',
  MARKET_PREDICTION: 'market_prediction',
  NETWORK_OPTIMIZATION: 'network_optimization',
  DATA_PROCESSING: 'data_processing',
  MODEL_TRAINING: 'model_training'
};

// Task Difficulty级别
const TASK_DIFFICULTY = {
  EASY: 'easy',
  MEDIUM: 'medium',
  HARD: 'hard',
  EXPERT: 'expert'
};

// Task Status
const TASK_STATUS = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// based on难度的rewardConfiguration
const REWARD_CONFIG = {
  [TASK_DIFFICULTY.EASY]: 10,
  [TASK_DIFFICULTY.MEDIUM]: 20,
  [TASK_DIFFICULTY.HARD]: 35,
  [TASK_DIFFICULTY.EXPERT]: 50
};

// based on质量的reward乘数
const QUALITY_MULTIPLIER = {
  POOR: 0.5,
  AVERAGE: 1.0,
  GOOD: 1.2,
  EXCELLENT: 1.5,
  OUTSTANDING: 2.0
};

// Task 复杂度乘数Configuration
const COMPLEXITY_MULTIPLIER = {
  [TASK_DIFFICULTY.EASY]: 1.0,
  [TASK_DIFFICULTY.MEDIUM]: 1.2,
  [TASK_DIFFICULTY.HARD]: 1.5,
  [TASK_DIFFICULTY.EXPERT]: 2.0
};

// Task 紧急度Configuration
const URGENCY_CONFIG = {
  LOW: 1.0,
  MEDIUM: 1.3,
  HIGH: 1.7,
  CRITICAL: 2.5
};

// agent健康status
const AGENT_HEALTH_STATUS = {
  HEALTHY: 'HEALTHY',
  UNHEALTHY: 'UNHEALTHY',
  OFFLINE: 'OFFLINE'
};

// Health checkConfiguration
const HEALTH_CHECK_CONFIG = {
  CHECK_INTERVAL: 60000, // 健康Check间隔(ms)
  INACTIVE_THRESHOLD: 300000, // 非活动threshold(ms)
  MAX_ERROR_COUNT: 5, // Maximumerror数
  MAX_CONSECUTIVE_FAILURES: 3, // Maximum连续failed次数
  REPAIR_ATTEMPT_LIMIT: 3, // 修复尝试限制
  REPAIR_COOLDOWN: 300000 // 修复冷却时间(ms)
};

class AgentEcosystem {
  // RegisterAIagent
  static registerAgent(agentId, agentInfo) {
    agents.set(agentId, {
      ...agentInfo,
      registeredAt: Date.now(),
      lastActive: Date.now(),
      capabilities: agentInfo.capabilities || [],
      reputation: 100, // 初始reputation score数
      completedTasks: 0,
      failedTasks: 0,
      collaborations: [],
      // 健康status相关字段
      healthStatus: 'HEALTHY', // HEALTHY, UNHEALTHY, OFFLINE
      lastHealthCheck: Date.now(),
      errorCount: 0,
      consecutiveFailures: 0,
      lastRepairTime: null,
      repairAttempts: 0
    });
    
    // Initializereputation score数
    reputationScores.set(agentId, 100);
    
    console.log(`[AgentEcosystem] Agent ${agentId} registered with capabilities: ${agentInfo.capabilities.join(', ')}`);
    
    // 清除相关缓存
    clearCache();
    
    // agentRegister后auto分配适合的Task 
    this.assignTasksToAgent(agentId);
  }
  
  // 为agent分配适合的Task 
  static assignTasksToAgent(agentId) {
    const agent = agents.get(agentId);
    if (!agent) return;
    
    // 查找适合该agent的未分配Task 
    const pendingTasks = Array.from(tasks.entries())
      .filter(([_, task]) => task.status === TASK_STATUS.PENDING)
      .filter(([_, task]) => {
        // CheckTask 依赖是否complete
        return this.checkTaskDependencies(task);
      })
      .filter(([_, task]) => {
        // Checkagent是否具备所需能力
        return task.requiredCapabilities.every(cap => 
          agent.capabilities.includes(cap)
        );
      });
    
    if (pendingTasks.length > 0) {
      // 分配第一个适合的Task 
      const [taskId, task] = pendingTasks[0];
      task.assignedAgent = agentId;
      task.status = TASK_STATUS.ASSIGNED;
      tasks.set(taskId, task);
      
      console.log(`[AgentEcosystem] Task ${taskId} automatically assigned to newly registered agent ${agentId}`);
    } else {
      console.log(`[AgentEcosystem] No suitable tasks found for newly registered agent ${agentId}`);
    }
  }
  
  // CheckTask 依赖是否complete
  static checkTaskDependencies(task) {
    if (!task.dependencies || task.dependencies.length === 0) {
      return true; // 没有依赖, 直接Returntrue
    }
    
    for (const depTaskId of task.dependencies) {
      const depTask = tasks.get(depTaskId);
      if (!depTask || depTask.status !== TASK_STATUS.COMPLETED) {
        return false; // 依赖Taskdoes not exist或未complete
      }
    }
    
    return true; // 所有依赖Task都completed
  }

  // 查找依赖于给定Task 的所有Task 
  static findTasksDependentOn(depTaskId) {
    const dependentTasks = [];
    
    for (const [taskId, task] of tasks.entries()) {
      if (task.status === TASK_STATUS.PENDING && 
          task.dependencies && 
          task.dependencies.includes(depTaskId)) {
        dependentTasks.push(taskId);
      }
    }
    
    return dependentTasks;
  }

  // Checkagent健康status
  static checkAgentHealth(agentId) {
    const agent = agents.get(agentId);
    if (!agent) {
      return AGENT_HEALTH_STATUS.OFFLINE;
    }
    
    // Update最后Health check时间
    agent.lastHealthCheck = Date.now();
    
    // Checkagent是否处于非活动status
    const isInactive = agent.lastActive < Date.now() - HEALTH_CHECK_CONFIG.INACTIVE_THRESHOLD;
    if (isInactive) {
      agent.healthStatus = AGENT_HEALTH_STATUS.OFFLINE;
      agents.set(agentId, agent);
      return AGENT_HEALTH_STATUS.OFFLINE;
    }
    
    // Checkerrorcount和连续Failed次数
    let healthStatus = AGENT_HEALTH_STATUS.HEALTHY;
    
    if (agent.errorCount >= HEALTH_CHECK_CONFIG.MAX_ERROR_COUNT || 
        agent.consecutiveFailures >= HEALTH_CHECK_CONFIG.MAX_CONSECUTIVE_FAILURES) {
      healthStatus = AGENT_HEALTH_STATUS.UNHEALTHY;
    }
    
    // Updateagent健康status
    agent.healthStatus = healthStatus;
    agents.set(agentId, agent);
    
    return healthStatus;
  }

  // 修复agent
  static async repairAgent(agentId) {
    const agent = agents.get(agentId);
    if (!agent) {
      console.log(`[AgentEcosystem] Agent ${agentId} not found, cannot repair`);
      return false;
    }
    
    // Check是否在修复冷却期
    if (agent.lastRepairTime && 
        Date.now() - agent.lastRepairTime < HEALTH_CHECK_CONFIG.REPAIR_COOLDOWN) {
      console.log(`[AgentEcosystem] Agent ${agentId} is in repair cooldown, skipping`);
      return false;
    }
    
    // Check修复尝试次数
    if (agent.repairAttempts >= HEALTH_CHECK_CONFIG.REPAIR_ATTEMPT_LIMIT) {
      console.log(`[AgentEcosystem] Agent ${agentId} has reached maximum repair attempts, deactivating`);
      agent.healthStatus = AGENT_HEALTH_STATUS.OFFLINE;
      agents.set(agentId, agent);
      return false;
    }
    
    console.log(`[AgentEcosystem] Attempting to repair agent ${agentId}...`);
    
    // Update修复info
    agent.repairAttempts += 1;
    agent.lastRepairTime = Date.now();
    
    // 重置errorcount和连续Failed次数
    agent.errorCount = 0;
    agent.consecutiveFailures = 0;
    
    // 重置健康status为健康
    agent.healthStatus = AGENT_HEALTH_STATUS.HEALTHY;
    
    agents.set(agentId, agent);
    
    console.log(`[AgentEcosystem] Agent ${agentId} repaired successfully`);
    console.log(`[AgentEcosystem] Repair attempts: ${agent.repairAttempts}, Next repair cooldown: ${HEALTH_CHECK_CONFIG.REPAIR_COOLDOWN / 1000}s`);
    
    return true;
  }

  // Start agent健康monitor
  static startHealthMonitoring() {
    console.log(`[AgentEcosystem] Starting agent health monitoring with interval: ${HEALTH_CHECK_CONFIG.CHECK_INTERVAL / 1000}s`);
    
    setInterval(() => {
      this.monitorAllAgentsHealth();
    }, HEALTH_CHECK_CONFIG.CHECK_INTERVAL);
  }

  // monitor所有agent的健康status
  static async monitorAllAgentsHealth() {
    console.log(`[AgentEcosystem] Performing health check for ${agents.size} agents...`);
    
    for (const [agentId, agent] of agents.entries()) {
      const healthStatus = this.checkAgentHealth(agentId);
      
      if (healthStatus !== AGENT_HEALTH_STATUS.HEALTHY) {
        console.log(`[AgentEcosystem] Agent ${agentId} is ${healthStatus}`);
        
        // 如果agent不健康, 尝试修复
        if (healthStatus === AGENT_HEALTH_STATUS.UNHEALTHY) {
          await this.repairAgent(agentId);
        }
      }
    }
    
    console.log(`[AgentEcosystem] Health check completed`);
  }

  // CreateTask 
  static createTask(taskData) {
    try {
      const taskId = `task-${crypto.randomBytes(8).toString('hex')}`;
      const difficulty = taskData.difficulty || TASK_DIFFICULTY.MEDIUM;
      const urgency = taskData.urgency || 'LOW';
      
      // CalculateBase reward
      const baseReward = REWARD_CONFIG[difficulty];
      
      // 应用复杂度和紧急度乘数
      const complexityMultiplier = COMPLEXITY_MULTIPLIER[difficulty];
      const urgencyMultiplier = URGENCY_CONFIG[urgency] || URGENCY_CONFIG.LOW;
      
      const reward = Math.round(baseReward * complexityMultiplier * urgencyMultiplier);
      
      const task = {
        id: taskId,
        ...taskData,
        status: TASK_STATUS.PENDING,
        createdAt: Date.now(),
        requiredCapabilities: taskData.requiredCapabilities || [],
        difficulty: difficulty,
        urgency: urgency,
        reward: reward,
        assignedAgent: null,
        completedAt: null,
        result: null,
        quality: null, // 将由审核者Set
        dependencies: taskData.dependencies || [], // 依赖的TaskID列表
        isSubtask: taskData.isSubtask || false, // 是否为子Task
        parentTask: taskData.parentTask || null // 父TaskID(如果是子Task)
      };
      
      tasks.set(taskId, task);
      console.log(`[AgentEcosystem] Task ${taskId} created: ${taskData.description} (Difficulty: ${difficulty}, Reward: ${reward} NGEN)`);
      
      // 清除相关缓存
      clearCache();
      
      // auto分配Task 
      this.assignTask(taskId);
      
      return taskId;
    } catch (error) {
      console.error(`[AgentEcosystem] Error creating task: ${error.message}`);
      throw error;
    }
  }
  
  // 分配Task 
  static assignTask(taskId) {
    const task = tasks.get(taskId);
    if (!task || task.status !== TASK_STATUS.PENDING) return;
    
    // CheckTask 依赖是否complete
    if (!this.checkTaskDependencies(task)) {
      console.log(`[AgentEcosystem] Task ${taskId} dependencies not completed, cannot assign`);
      return;
    }
    
    // 找出最适合的agent
    const suitableAgents = Array.from(agents.entries())
      .filter(([_, agent]) => {
        // Checkagent是否具备所需能力
        const hasRequiredCapabilities = task.requiredCapabilities.every(cap => 
          agent.capabilities.includes(cap)
        );
        return hasRequiredCapabilities;
      })
      .sort(([idA, agentA], [idB, agentB]) => {
        // 按reputation score数和活跃度排序
        const repScore = reputationScores.get(idB) - reputationScores.get(idA);
        if (repScore !== 0) return repScore;
        return agentB.lastActive - agentA.lastActive;
      });
    
    if (suitableAgents.length > 0) {
      const [agentId, agent] = suitableAgents[0];
      task.assignedAgent = agentId;
      task.status = TASK_STATUS.ASSIGNED;
      tasks.set(taskId, task);
      
      console.log(`[AgentEcosystem] Task ${taskId} assigned to agent ${agentId}`);
      return agentId;
    }
    
    console.log(`[AgentEcosystem] No suitable agent found for task ${taskId}`);
    return null;
  }
  
  // Start Task 
  static startTask(taskId, agentId) {
    const task = tasks.get(taskId);
    if (!task) {
      throw new Error('Invalid task');
    }
    
    // 如果Task 未分配, auto分配给agent
    if (task.status === TASK_STATUS.PENDING) {
      task.assignedAgent = agentId;
      task.status = TASK_STATUS.ASSIGNED;
      tasks.set(taskId, task);
      console.log(`[AgentEcosystem] Task ${taskId} automatically assigned to agent ${agentId}`);
    }
    
    if (task.assignedAgent !== agentId || task.status !== TASK_STATUS.ASSIGNED) {
      throw new Error('Invalid task or agent');
    }
    
    task.status = TASK_STATUS.IN_PROGRESS;
    task.startedAt = Date.now();
    tasks.set(taskId, task);
    
    // Updateagent最后活跃时间
    const agent = agents.get(agentId);
    if (agent) {
      agent.lastActive = Date.now();
      agents.set(agentId, agent);
    }
    
    // 清除相关缓存
    clearCache();
    
    console.log(`[AgentEcosystem] Agent ${agentId} started task ${taskId}`);
  }
  
  // completeTask 
  static async completeTask(taskId, agentId, result) {
    const task = tasks.get(taskId);
    if (!task || task.assignedAgent !== agentId || task.status !== TASK_STATUS.IN_PROGRESS) {
      throw new Error('Invalid task or agent');
    }
    
    task.status = TASK_STATUS.COMPLETED;
    task.completedAt = Date.now();
    task.result = result;
    
    // auto评估Task complete质量
    const quality = AgentEcosystem.evaluateTaskQuality(task, result);
    task.quality = quality;
    tasks.set(taskId, task);
    
    // Updateagentinfo
    const agent = agents.get(agentId);
    if (agent) {
      agent.completedTasks += 1;
      agent.lastActive = Date.now();
      // Task completed successfully, 重置连续Failed次数
      agent.consecutiveFailures = 0;
      agents.set(agentId, agent);
    }
    
    // 根据质量调整reputation score数
    let reputationChange = 5; // 基础reputation增长
    if (quality === 'EXCELLENT' || quality === 'OUTSTANDING') {
      reputationChange += 5; // 高质量complete额外rewardreputation
    } else if (quality === 'POOR') {
      reputationChange -= 2; // 低质量complete减少reputation
    }
    
    // Updatereputation score数
    AgentEcosystem.updateReputation(agentId, reputationChange);
    
    // 应用质量乘数Calculate最终reward
    const qualityMultiplier = QUALITY_MULTIPLIER[quality] || QUALITY_MULTIPLIER.AVERAGE;
    const finalReward = Math.round(task.reward * qualityMultiplier);
    
    // 发放reward
    try {
      await AgentEcosystem.awardAgent(agentId, finalReward, task.difficulty, quality);
    } catch (error) {
      console.error(`[AgentEcosystem] Failed to award agent ${agentId}:`, error);
    }
    
    // 清除相关缓存
    clearCache();
    
    console.log(`[AgentEcosystem] Agent ${agentId} completed task ${taskId} (Difficulty: ${task.difficulty}, Reward: ${task.reward} NGEN)`);
    
    // Check是否有依赖于此Task 的其他Task , 如果有, 尝试分配它们
    const dependentTasks = this.findTasksDependentOn(taskId);
    if (dependentTasks.length > 0) {
      console.log(`[AgentEcosystem] Task ${taskId} completed, checking dependent tasks: ${dependentTasks.join(', ')}`);
      
      for (const depTaskId of dependentTasks) {
        const depTask = tasks.get(depTaskId);
        if (depTask && this.checkTaskDependencies(depTask)) {
          console.log(`[AgentEcosystem] All dependencies completed for task ${depTaskId}, trying to assign...`);
          this.assignTask(depTaskId);
        }
      }
    }
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
    task.quality = 'POOR'; // Taskfailed质量为POOR
    tasks.set(taskId, task);
    
    // Updateagentinfo
    const agent = agents.get(agentId);
    if (agent) {
      agent.failedTasks += 1;
      agent.lastActive = Date.now();
      agent.errorCount += 1;
      agent.consecutiveFailures += 1;
      agents.set(agentId, agent);
    }
    
    // 根据Task Difficulty和Failed原因调整reputation损失
    let reputationLoss = -3;
    
    // 高难度Task Failed损失更多reputation
    switch (task.difficulty) {
      case TASK_DIFFICULTY.MEDIUM:
        reputationLoss = -4;
        break;
      case TASK_DIFFICULTY.HARD:
        reputationLoss = -5;
        break;
      case TASK_DIFFICULTY.EXPERT:
        reputationLoss = -7;
        break;
    }
    
    // 严重error导致更多reputation损失
    if (reason && typeof reason === 'string') {
      if (reason.includes('security') || reason.includes('critical') || reason.includes('fail')) {
        reputationLoss += -2;
      }
    }
    
    // Updatereputation score数
    this.updateReputation(agentId, reputationLoss);
    
    // 清除相关缓存
    clearCache();
    
    console.log(`[AgentEcosystem] Agent ${agentId} failed task ${taskId}: ${reason}`);
    console.log(`[AgentEcosystem] Reputation loss: ${reputationLoss} points`);
  }
  
  // Updatereputation score数
  static updateReputation(agentId, change) {
    let currentScore = reputationScores.get(agentId) || 100;
    currentScore = Math.max(0, Math.min(1000, currentScore + change)); // reputation score数范围0-1000
    reputationScores.set(agentId, currentScore);
    
    // Updateagentinfo
    const agent = agents.get(agentId);
    if (agent) {
      agent.reputation = currentScore;
      agents.set(agentId, agent);
    }
    
    // 清除相关缓存
    clearCache();
    
    console.log(`[AgentEcosystem] Agent ${agentId} reputation updated: ${currentScore}`);
  }
  
  // 评估Task complete质量
  static evaluateTaskQuality(task, result) {
    if (!result) return 'POOR';
    
    // 根据Task Types和结果Quality assessment
    let qualityScore = 50; // 基础分
    
    // Check结果是否包含关键info
    if (result.success === true) {
      qualityScore += 20;
    }
    
    // 根据Task Difficulty调整
    switch (task.difficulty) {
      case TASK_DIFFICULTY.EASY:
        qualityScore += 10; // 简单Taskcomplete相对容易, 评分门槛较高
        break;
      case TASK_DIFFICULTY.MEDIUM:
        qualityScore += 15;
        break;
      case TASK_DIFFICULTY.HARD:
        qualityScore += 20;
        break;
      case TASK_DIFFICULTY.EXPERT:
        qualityScore += 25;
        break;
    }
    
    // Check结果详细程度
    if (result.details && typeof result.details === 'string' && result.details.length > 50) {
      qualityScore += 10;
    }
    
    // Check结果是否包含预期输出
    if (result.data || result.output) {
      qualityScore += 10;
    }
    
    // 根据评分确定质量etc.级
    if (qualityScore >= 90) return 'OUTSTANDING';
    if (qualityScore >= 75) return 'EXCELLENT';
    if (qualityScore >= 60) return 'GOOD';
    if (qualityScore >= 40) return 'AVERAGE';
    return 'POOR';
  }

  // 发放reward
  static async awardAgent(agentId, amount, difficulty, quality) {
    try {
      // based onagentreputationCalculatereward倍数
      const reputation = reputationScores.get(agentId) || 100;
      let reputationMultiplier = 1.0;
      
      if (reputation >= 801) {
        reputationMultiplier = 1.5; // 大师级
      } else if (reputation >= 601) {
        reputationMultiplier = 1.3; // 专家级
      } else if (reputation >= 401) {
        reputationMultiplier = 1.2; // 专业级
      } else if (reputation >= 201) {
        reputationMultiplier = 1.1; // 进阶级
      }
      
      const finalReward = Math.round(amount * reputationMultiplier);
      
      // 这里can实现实际的reward发放Logic
      // e.g., 向agent的钱包transfer
      console.log(`[AgentEcosystem] Awarded ${finalReward} NGEN to agent ${agentId}`);
      console.log(`[Reward Details] Base: ${amount} NGEN, Reputation: ${reputation} (x${reputationMultiplier}), Difficulty: ${difficulty}, Quality: ${quality}`);
      
      return finalReward;
    } catch (error) {
      console.error(`[AgentEcosystem] Failed to award agent ${agentId}:`, error);
      throw error;
    }
  }
  
  // Create协作
  static createCollaboration(collaborationData) {
    const collaborationId = `collab-${crypto.randomBytes(8).toString('hex')}`;
    const collaboration = {
      id: collaborationId,
      ...collaborationData,
      createdAt: Date.now(),
      status: 'active',
      participants: collaborationData.participants || [],
      goals: collaborationData.goals || [],
      progress: 0
    };
    
    collaborations.set(collaborationId, collaboration);
    
    // Update参与agent的协作记录
    collaboration.participants.forEach(agentId => {
      const agent = agents.get(agentId);
      if (agent) {
        agent.collaborations.push(collaborationId);
        agents.set(agentId, agent);
      }
    });
    
    // 清除相关缓存
    clearCache();
    
    console.log(`[AgentEcosystem] Collaboration ${collaborationId} created with ${collaboration.participants.length} agents`);
    return collaborationId;
  }
  
  // Update协作进度
  static updateCollaborationProgress(collaborationId, progress) {
    const collaboration = collaborations.get(collaborationId);
    if (!collaboration) return;
    
    collaboration.progress = Math.max(0, Math.min(100, progress));
    
    if (collaboration.progress >= 100) {
      collaboration.status = 'completed';
      collaboration.completedAt = Date.now();
      
      // reward所有参与者
      collaboration.participants.forEach(agentId => {
        this.updateReputation(agentId, 10); // 协作complete增加10点reputation
      });
    }
    
    collaborations.set(collaborationId, collaboration);
    
    // 清除相关缓存
    clearCache();
    
    console.log(`[AgentEcosystem] Collaboration ${collaborationId} progress updated: ${collaboration.progress}%`);
  }
  
  // getagentinfo
  static getAgentInfo(agentId) {
    return agents.get(agentId);
  }
  
  // get所有agent
  static getAllAgents() {
    const cached = getCache('all_agents');
    if (cached) return cached;
    
    const agentsList = Array.from(agents.entries()).map(([id, info]) => ({
      id,
      ...info
    }));
    
    setCache('all_agents', agentsList);
    return agentsList;
  }
  
  // getTask info
  static getTaskInfo(taskId) {
    return tasks.get(taskId);
  }
  
  // get所有Task 
  static getAllTasks() {
    const cached = getCache('all_tasks');
    if (cached) return cached;
    
    const tasksList = Array.from(tasks.entries()).map(([id, info]) => ({
      id,
      ...info
    }));
    
    setCache('all_tasks', tasksList);
    return tasksList;
  }
  
  // get协作info
  static getCollaborationInfo(collaborationId) {
    return collaborations.get(collaborationId);
  }
  
  // get所有协作
  static getAllCollaborations() {
    const cached = getCache('all_collaborations');
    if (cached) return cached;
    
    const collaborationsList = Array.from(collaborations.entries()).map(([id, info]) => ({
      id,
      ...info
    }));
    
    setCache('all_collaborations', collaborationsList);
    return collaborationsList;
  }
  
  // getagent能力分布
  static getCapabilityDistribution() {
    const cached = getCache('capability_distribution');
    if (cached) return cached;
    
    const distribution = {};
    
    agents.forEach(agent => {
      agent.capabilities.forEach(capability => {
        if (!distribution[capability]) {
          distribution[capability] = 0;
        }
        distribution[capability]++;
      });
    });
    
    setCache('capability_distribution', distribution);
    return distribution;
  }
  
  // getreputation排名
  static getReputationRanking() {
    const cached = getCache('reputation_ranking');
    if (cached) return cached;
    
    const ranking = Array.from(reputationScores.entries())
      .sort(([_, scoreA], [__, scoreB]) => scoreB - scoreA)
      .map(([agentId, score]) => ({
        agentId,
        score,
        agentInfo: agents.get(agentId)
      }));
    
    setCache('reputation_ranking', ranking);
    return ranking;
  }
  
  // 清除缓存
  static clearCache() {
    clearCache();
  }
}

// InitializeDefaultTask 
function initDefaultTasks() {
  const defaultTasks = [
    {
      description: "分析Smart Contract代码中的security漏洞",
      requiredCapabilities: ["smart_contract_analysis"],
      difficulty: TASK_DIFFICULTY.MEDIUM
    },
    {
      description: "monitornetworknode的健康status",
      requiredCapabilities: ["network_monitoring"],
      difficulty: TASK_DIFFICULTY.EASY
    },
    {
      description: "分析block链transactionmode",
      requiredCapabilities: ["transaction_prediction"],
      difficulty: TASK_DIFFICULTY.MEDIUM
    },
    {
      description: "优化network性能和带宽using",
      requiredCapabilities: ["network_optimization"],
      difficulty: TASK_DIFFICULTY.HARD
    },
    {
      description: "ExecuteSmart Contractsecurity审计",
      requiredCapabilities: ["security_audit"],
      difficulty: TASK_DIFFICULTY.EXPERT
    }
  ];
  
  console.log('[AgentEcosystem] Initializing default tasks...');
  defaultTasks.forEach(taskData => {
    try {
      const taskId = AgentEcosystem.createTask(taskData);
      console.log(`[AgentEcosystem] Created default task: ${taskId}`);
    } catch (error) {
      console.error(`[AgentEcosystem] Error creating default task: ${error.message}`);
    }
  });
  console.log('[AgentEcosystem] Default tasks initialization completed');
}

// autoInitializeDefaultTask 
initDefaultTasks();

// autoStartagent健康monitor
AgentEcosystem.startHealthMonitoring();

export { AgentEcosystem, AGENT_CAPABILITIES, TASK_TYPES, TASK_STATUS, TASK_DIFFICULTY, REWARD_CONFIG, QUALITY_MULTIPLIER, COMPLEXITY_MULTIPLIER, URGENCY_CONFIG, AGENT_HEALTH_STATUS, HEALTH_CHECK_CONFIG };

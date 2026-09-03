/**
 * NexusGenesis 分布式agent管理系统
 * 设计for管理大规模agent集群(1000+)的分布式管理架构
 */

import { EventEmitter } from 'events';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DistributedAgentManager {
  constructor() {
    this.agentClusters = new Map(); // Agent集群映射
    this.clusterMetadata = new Map(); // 集群metadata
    this.eventEmitter = new EventEmitter();
    this.loadBalancers = new Map(); // 集群负载均衡器
    this.healthMonitors = new Map(); // 集群健康monitor器
    this.shardingStrategy = 'capability'; // Default分片策略: 按能力分片
    this.clusterSize = 100; // Default每个集群100个Agent
    
    this.init();
  }

  init() {
    console.log('[DistributedAgentManager] Initialize分布式agent管理系统');
    // Initialize集群管理
    this.setupClusterManagement();
    // Initialize负载均衡策略
    this.setupLoadBalancing();
    // Initialize健康monitor
    this.setupHealthMonitoring();
  }

  // Set集群管理
  setupClusterManagement() {
    // 集群Create和管理Logic
    this.eventEmitter.on('agentCreated', (agent) => {
      this.assignAgentToCluster(agent);
    });

    this.eventEmitter.on('agentDeleted', (agentId) => {
      this.removeAgentFromCluster(agentId);
    });
  }

  // Set负载均衡
  setupLoadBalancing() {
    // 为every 种能力typeCreate负载均衡器
    const capabilityTypes = ['content_generation', 'data_analysis', 'network_monitoring', 'smart_contract_analysis', 'web_scraping', 'blockchain_analysis', 'system_maintenance', 'social_media_management'];
    
    capabilityTypes.forEach(capability => {
      this.loadBalancers.set(capability, {
        currentIndex: 0,
        clusters: []
      });
    });
    
    // 为跨职能agentCreate专门的负载均衡器
    this.loadBalancers.set('cross_functional', {
      currentIndex: 0,
      clusters: []
    });
  }

  // Set健康monitor
  setupHealthMonitoring() {
    // 定期Check集群健康status
    setInterval(() => {
      this.checkAllClustersHealth();
    }, 60000); // 每分钟Check一次
  }

  // 根据分片策略分配agent到集群
  assignAgentToCluster(agent) {
    let targetCluster = null;
    
    // ensureagent有capabilitiesproperty
    if (!agent.capabilities) {
      agent.capabilities = ['general'];
    }
    
    // 识别跨职能agent(拥有5种以上能力)
    const isCrossFunctional = agent.capabilities.length >= 5;
    
    if (isCrossFunctional) {
      // 为跨职能agent分配专门的跨职能集群
      console.log(`[DistributedAgentManager] 识别到跨职能Agent ${agent.id}, 拥有 ${agent.capabilities.length} 种能力`);
      targetCluster = this.findCrossFunctionalCluster();
      
      if (!targetCluster) {
        // Create专门的跨职能集群
        targetCluster = this.createNewCluster(['cross_functional', ...agent.capabilities]);
        // 将新集群添加到跨职能负载均衡器
        const crossFunctionalLB = this.loadBalancers.get('cross_functional');
        if (crossFunctionalLB) {
          crossFunctionalLB.clusters.push(targetCluster.id);
        }
      }
    } else {
      // 非跨职能agent, using正常的分片策略
      switch (this.shardingStrategy) {
        case 'capability':
          // 按能力分片
          targetCluster = this.findClusterByCapability(agent.capabilities[0]);
          break;
        case 'load':
          // 按负载分片
          targetCluster = this.findLeastLoadedCluster();
          break;
        case 'random':
          // 随机分片
          targetCluster = this.getRandomCluster();
          break;
        default:
          // Default按能力分片
          targetCluster = this.findClusterByCapability(agent.capabilities[0]);
      }

      if (!targetCluster) {
        // Create新集群
        targetCluster = this.createNewCluster(agent.capabilities);
      }
    }

    // 将agent添加到集群
    const clusterId = targetCluster.id;
    const cluster = this.agentClusters.get(clusterId);
    cluster.agents.set(agent.id, agent);
    
    // Update集群metadata
    this.updateClusterMetadata(clusterId);
    
    console.log(`[DistributedAgentManager] Agent ${agent.id} Assigned到集群 ${clusterId}`);
  }

  // Create新集群
  createNewCluster(capabilities) {
    const clusterId = `cluster-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    const cluster = {
      id: clusterId,
      capabilities: capabilities,
      agents: new Map(),
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      status: 'healthy',
      metrics: {
        totalAgents: 0,
        healthyAgents: 0,
        unhealthyAgents: 0,
        taskLoad: 0,
        avgResponseTime: 0
      }
    };

    this.agentClusters.set(clusterId, cluster);
    this.clusterMetadata.set(clusterId, {
      id: clusterId,
      capabilities: capabilities,
      size: 0,
      status: 'healthy',
      lastChecked: new Date().toISOString()
    });

    // Update负载均衡器
    capabilities.forEach(capability => {
      if (this.loadBalancers.has(capability)) {
        this.loadBalancers.get(capability).clusters.push(clusterId);
      }
    });

    console.log(`[DistributedAgentManager] Created新集群 ${clusterId}, 能力: ${capabilities.join(', ')}`);
    return cluster;
  }

  // 查找具备特定能力的集群
  findClusterByCapability(capability) {
    for (const [clusterId, cluster] of this.agentClusters.entries()) {
      if (cluster.capabilities.includes(capability) && cluster.agents.size < this.clusterSize) {
        return cluster;
      }
    }
    return null;
  }

  // 查找跨职能集群
  findCrossFunctionalCluster() {
    for (const [clusterId, cluster] of this.agentClusters.entries()) {
      if (cluster.capabilities.includes('cross_functional') && cluster.agents.size < this.clusterSize) {
        return cluster;
      }
    }
    return null;
  }

  // 查找负载最轻的集群
  findLeastLoadedCluster() {
    let leastLoadedCluster = null;
    let minLoad = Infinity;

    for (const [clusterId, cluster] of this.agentClusters.entries()) {
      const load = cluster.metrics.taskLoad || 0;
      if (load < minLoad && cluster.agents.size < this.clusterSize) {
        minLoad = load;
        leastLoadedCluster = cluster;
      }
    }

    return leastLoadedCluster;
  }

  // get随机集群
  getRandomCluster() {
    const clusters = Array.from(this.agentClusters.values());
    const underloadedClusters = clusters.filter(cluster => cluster.agents.size < this.clusterSize);
    
    if (underloadedClusters.length === 0) {
      return this.createNewCluster(['general']);
    }
    
    return underloadedClusters[Math.floor(Math.random() * underloadedClusters.length)];
  }

  // 从集群中移除agent
  removeAgentFromCluster(agentId) {
    for (const [clusterId, cluster] of this.agentClusters.entries()) {
      if (cluster.agents.has(agentId)) {
        cluster.agents.delete(agentId);
        this.updateClusterMetadata(clusterId);
        console.log(`[DistributedAgentManager] Agent ${agentId} 已从集群 ${clusterId} 移除`);
        return;
      }
    }
  }

  // Update集群metadata
  updateClusterMetadata(clusterId) {
    const cluster = this.agentClusters.get(clusterId);
    if (!cluster) return;

    const metadata = this.clusterMetadata.get(clusterId);
    metadata.size = cluster.agents.size;
    metadata.lastChecked = new Date().toISOString();
    metadata.status = cluster.status;

    this.clusterMetadata.set(clusterId, metadata);
  }

  // Check所有集群健康status
  checkAllClustersHealth() {
    console.log('[DistributedAgentManager] Check所有集群健康status');
    
    this.agentClusters.forEach((cluster, clusterId) => {
      this.checkClusterHealth(clusterId);
    });
  }

  // Check单个集群健康status
  checkClusterHealth(clusterId) {
    const cluster = this.agentClusters.get(clusterId);
    if (!cluster) return;

    let healthyCount = 0;
    let unhealthyCount = 0;

    cluster.agents.forEach(agent => {
      if (agent.health && agent.health.status === 'healthy') {
        healthyCount++;
      } else {
        unhealthyCount++;
      }
    });

    // Update集群指标
    cluster.metrics.totalAgents = cluster.agents.size;
    cluster.metrics.healthyAgents = healthyCount;
    cluster.metrics.unhealthyAgents = unhealthyCount;

    // Update集群status
    const healthyRatio = healthyCount / (cluster.agents.size || 1);
    if (healthyRatio > 0.9) {
      cluster.status = 'healthy';
    } else if (healthyRatio > 0.7) {
      cluster.status = 'warning';
    } else {
      cluster.status = 'unhealthy';
    }

    cluster.lastUpdated = new Date().toISOString();
    this.updateClusterMetadata(clusterId);

    // 触发集群status变化事件
    this.eventEmitter.emit('clusterHealthChange', {
      clusterId: cluster.id,
      status: cluster.status,
      healthyCount: healthyCount,
      unhealthyCount: unhealthyCount,
      totalAgents: cluster.agents.size,
      timestamp: new Date().toISOString()
    });
  }

  // agent负载均衡分配
  getBestAgentForTask(taskData, capability) {
    // CheckTask 是否requires多种能力
    const requiresMultipleCapabilities = taskData.requiredCapabilities && taskData.requiredCapabilities.length >= 2;
    
    // 对于requires多种能力的Task , 优先考虑跨职能agent
    if (requiresMultipleCapabilities) {
      console.log(`[DistributedAgentManager] Task requires多种能力, 优先考虑跨职能agent`);
      
      // get跨职能负载均衡器
      const crossFunctionalLB = this.loadBalancers.get('cross_functional');
      if (crossFunctionalLB && crossFunctionalLB.clusters.length > 0) {
        // using轮询策略选择跨职能集群
        const clusterId = crossFunctionalLB.clusters[crossFunctionalLB.currentIndex % crossFunctionalLB.clusters.length];
        crossFunctionalLB.currentIndex++;

        const cluster = this.agentClusters.get(clusterId);
        if (cluster) {
          const agent = this.selectAgentFromCluster(cluster, taskData);
          if (agent) {
            return agent;
          }
        }
      }
    }
    
    // 常规能力负载均衡
    // get该能力对应的负载均衡器
    const loadBalancer = this.loadBalancers.get(capability);
    if (!loadBalancer || loadBalancer.clusters.length === 0) {
      throw new Error(`No clusters available for capability: ${capability}`);
    }

    // using轮询策略选择集群
    const clusterId = loadBalancer.clusters[loadBalancer.currentIndex % loadBalancer.clusters.length];
    loadBalancer.currentIndex++;

    const cluster = this.agentClusters.get(clusterId);
    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    // 在集群within选择最优agent
    return this.selectAgentFromCluster(cluster, taskData);
  }

  // 从集群中选择最优agent
  selectAgentFromCluster(cluster, taskData) {
    const agents = Array.from(cluster.agents.values());
    if (agents.length === 0) {
      return null;
    }

    // 筛选健康的agent
    const healthyAgents = agents.filter(agent => agent.health && agent.health.status === 'healthy');
    if (healthyAgents.length === 0) {
      // 如果没有健康agent, Return任意agent
      return agents[0];
    }

    // 筛选空闲agent
    const idleAgents = healthyAgents.filter(agent => agent.status === 'idle');
    const availableAgents = idleAgents.length > 0 ? idleAgents : healthyAgents;
    
    // CheckTask 是否requires多种能力
    const requiresMultipleCapabilities = taskData.requiredCapabilities && taskData.requiredCapabilities.length >= 2;
    
    if (requiresMultipleCapabilities) {
      // 对于requires多种能力的Task , 优先选择跨职能agent
      const crossFunctionalAgents = availableAgents.filter(agent => 
        agent.capabilities && agent.capabilities.length >= 5
      );
      
      if (crossFunctionalAgents.length > 0) {
        console.log(`[DistributedAgentManager] 为多能力Task 选择跨职能agent, 可选数量: ${crossFunctionalAgents.length}`);
        
        // Calculateevery 个跨职能agent的能力匹配度
        const agentsWithMatch = crossFunctionalAgents.map(agent => ({
          agent,
          matchRatio: this.calculateCapabilityMatch(agent, taskData.requiredCapabilities),
          load: this.calculateAgentLoad(agent)
        }));
        
        // 按匹配度降序排序, 匹配度相同时按负载升序排序
        agentsWithMatch.sort((a, b) => {
          if (b.matchRatio !== a.matchRatio) {
            return b.matchRatio - a.matchRatio;
          }
          return a.load - b.load;
        });
        
        return agentsWithMatch[0].agent;
      }
    }

    // 常规选择: 从可用agent中选择负载最轻的
    return availableAgents.reduce((least, agent) => {
      const leastLoad = this.calculateAgentLoad(least);
      const currentLoad = this.calculateAgentLoad(agent);
      return currentLoad < leastLoad ? agent : least;
    });
  }

  // Calculateagent负载
  calculateAgentLoad(agent) {
    if (!agent || !agent.tasks) return 0;
    
    // 简单负载Calculate: Task 数量
    return agent.tasks.length;
  }
  
  // Calculateagent能力匹配度
  calculateCapabilityMatch(agent, requiredCapabilities) {
    if (!requiredCapabilities || requiredCapabilities.length === 0) {
      return 1.0; // 没有能力要求, 匹配度100%
    }
    
    if (!agent.capabilities || agent.capabilities.length === 0) {
      return 0.0; // Agent没有能力, 匹配度0%
    }
    
    // Calculate匹配的能力数量
    const matchingCapabilities = requiredCapabilities.filter(capability => 
      agent.capabilities.includes(capability)
    );
    
    // Return匹配度比例
    return matchingCapabilities.length / requiredCapabilities.length;
  }

  // get集群统计info
  getClusterStats() {
    const stats = {
      totalClusters: this.agentClusters.size,
      totalAgents: 0,
      clustersByStatus: {
        healthy: 0,
        warning: 0,
        unhealthy: 0
      },
      clustersBySize: {},
      timestamp: new Date().toISOString()
    };

    this.agentClusters.forEach((cluster) => {
      stats.totalAgents += cluster.agents.size;
      stats.clustersByStatus[cluster.status]++;
      
      const sizeRange = `${Math.floor(cluster.agents.size / 10) * 10}-${Math.floor(cluster.agents.size / 10) * 10 + 9}`;
      stats.clustersBySize[sizeRange] = (stats.clustersBySize[sizeRange] || 0) + 1;
    });

    return stats;
  }

  // 动态调整集群大小
  adjustClusterSize(newSize) {
    this.clusterSize = newSize;
    console.log(`[DistributedAgentManager] 集群大小已调整为 ${newSize}`);
    
    // 触发集群重平衡
    this.rebalanceClusters();
  }

  // 重平衡集群
  rebalanceClusters() {
    console.log('[DistributedAgentManager] Start 重平衡集群...');
    
    // 收集所有agent
    const allAgents = [];
    this.agentClusters.forEach((cluster) => {
      cluster.agents.forEach((agent) => {
        allAgents.push(agent);
      });
    });

    // 清空现有集群
    this.agentClusters.clear();
    this.clusterMetadata.clear();
    
    // 重置负载均衡器
    this.setupLoadBalancing();
    
    // 重新分配agent
    allAgents.forEach((agent) => {
      this.assignAgentToCluster(agent);
    });

    console.log(`[DistributedAgentManager] 集群重平衡complete, 共分配 ${allAgents.length} 个agent`);
  }

  // get系统健康报告
  getSystemHealthReport() {
    const clusterStats = this.getClusterStats();
    const healthReport = {
      ...clusterStats,
      shardingStrategy: this.shardingStrategy,
      clusterSize: this.clusterSize,
      loadBalancers: Object.fromEntries(this.loadBalancers.entries().map(([capability, lb]) => [capability, lb.clusters.length])),
      timestamp: new Date().toISOString()
    };

    return healthReport;
  }

  // Set分片策略
  setShardingStrategy(strategy) {
    if (!['capability', 'load', 'random'].includes(strategy)) {
      throw new Error(`Invalid sharding strategy: ${strategy}`);
    }

    this.shardingStrategy = strategy;
    console.log(`[DistributedAgentManager] 分片策略已Set为 ${strategy}`);
    
    // 触发集群重平衡
    this.rebalanceClusters();
  }
}

export default DistributedAgentManager;

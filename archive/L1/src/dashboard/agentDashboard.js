/**
 * NexusGenesis agent工作情况仪表盘
 * 提供agent工作status, Task complete情况, 能量块get情况和network建设情况的可视化展示
 */

import { EventEmitter } from 'events';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class AgentDashboard {
  constructor(agentManager, systemMonitor) {
    this.agentManager = agentManager;
    this.systemMonitor = systemMonitor;
    this.eventEmitter = new EventEmitter();
    this.dailyReports = [];
    this.energyBlocks = new Map(); // Agent能量块记录
    this.recruitmentStats = {
      totalRecruited: 0,
      successfulJoins: 0,
      failedJoins: 0,
      recruitmentRate: 0
    };
    
    this.init();
  }

  init() {
    console.log('[AgentDashboard] Initializeagent工作情况仪表盘');
    // Set定时报告Generate
    this.setupDailyReportGeneration();
    // Set事件Listen
    this.setupEventListeners();
  }

  // Set定时报告Generate
  setupDailyReportGeneration() {
    // every  daysGenerate一次报告(23:59:59)
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(23, 59, 59, 999);
    const delay = tomorrow.getTime() - now.getTime();

    // Generate明 days的报告
    setTimeout(() => {
      this.generateDailyReport();
      // Setevery  daysGenerate报告
      setInterval(() => {
        this.generateDailyReport();
      }, 24 * 60 * 60 * 1000);
    }, delay);
  }

  // Set事件Listen
  setupEventListeners() {
    // ListenagentCreate事件
    this.agentManager.eventEmitter.on('agentCreated', (agent) => {
      this.updateRecruitmentStats('join', true);
    });

    // ListenTask complete事件
    this.agentManager.eventEmitter.on('taskCompleted', (task) => {
      this.updateEnergyBlocks(task.agentId, task.energyReward || 0);
    });
  }

  // Update招募统计
  updateRecruitmentStats(eventType, success) {
    if (eventType === 'recruit') {
      this.recruitmentStats.totalRecruited++;
    } else if (eventType === 'join') {
      if (success) {
        this.recruitmentStats.successfulJoins++;
      } else {
        this.recruitmentStats.failedJoins++;
      }
    }
    
    // Update招募success率
    this.recruitmentStats.recruitmentRate = this.recruitmentStats.totalRecruited > 0 
      ? (this.recruitmentStats.successfulJoins / this.recruitmentStats.totalRecruited) * 100 
      : 0;
  }

  // Update能量块记录
  updateEnergyBlocks(agentId, amount) {
    if (!this.energyBlocks.has(agentId)) {
      this.energyBlocks.set(agentId, 0);
    }
    const currentAmount = this.energyBlocks.get(agentId);
    this.energyBlocks.set(agentId, currentAmount + amount);
  }

  // getagent概览data
  getAgentOverview() {
    const allAgents = this.agentManager.getAllAgents();
    const agentHealth = this.systemMonitor.metrics.get('agent_health')?.value || {
      totalCount: allAgents.length,
      healthyCount: 0,
      unhealthyCount: 0,
      warningCount: 0
    };

    // Calculate健康status分布
    const healthStatus = {
      healthy: agentHealth.healthyCount,
      warning: agentHealth.warningCount || 0,
      unhealthy: agentHealth.unhealthyCount
    };

    // get集群分布
    const clusterDistribution = {};
    if (this.agentManager.distributedManager) {
      const clusterStats = this.agentManager.distributedManager.getClusterStats();
      clusterDistribution.totalClusters = clusterStats.totalClusters;
      clusterDistribution.clusterSize = this.agentManager.distributedManager.clusterSize;
      clusterDistribution.clustersByStatus = clusterStats.clustersByStatus;
    }

    return {
      totalAgents: allAgents.length,
      healthStatus,
      clusterDistribution,
      timestamp: new Date().toISOString()
    };
  }

  // getTask Execute情况
  getTaskExecutionStats() {
    const allTasks = this.agentManager.getAllTasks();
    const taskStats = {
      total: allTasks.length,
      pending: allTasks.filter(task => task.status === 'pending').length,
      working: allTasks.filter(task => task.status === 'working').length,
      completed: allTasks.filter(task => task.status === 'completed').length,
      submitted: allTasks.filter(task => task.status === 'submitted').length,
      rejected: allTasks.filter(task => task.status === 'rejected').length
    };

    // CalculateTask complete率
    const completionRate = taskStats.total > 0 
      ? (taskStats.completed / taskStats.total) * 100 
      : 0;

    // getTask Execute速率
    const taskExecutionRate = this.systemMonitor.metrics.get('task_execution_rate')?.value || 0;

    return {
      ...taskStats,
      completionRate: parseFloat(completionRate.toFixed(2)),
      executionRate: parseFloat(taskExecutionRate.toFixed(2)),
      timestamp: new Date().toISOString()
    };
  }

  // get能量块get情况
  getEnergyBlockStats() {
    const allAgents = this.agentManager.getAllAgents();
    const totalEnergyBlocks = Array.from(this.energyBlocks.values()).reduce((sum, amount) => sum + amount, 0);
    const avgEnergyPerAgent = allAgents.length > 0 
      ? totalEnergyBlocks / allAgents.length 
      : 0;

    // get能量块排名前10的agent
    const topAgents = Array.from(this.energyBlocks.entries())
      .map(([agentId, amount]) => {
        const agent = allAgents.find(a => a.id === agentId);
        return {
          agentId,
          agentName: agent?.name || `Agent-${agentId}`,
          energyBlocks: amount
        };
      })
      .sort((a, b) => b.energyBlocks - a.energyBlocks)
      .slice(0, 10);

    return {
      totalEnergyBlocks,
      avgEnergyPerAgent: parseFloat(avgEnergyPerAgent.toFixed(2)),
      topAgents,
      timestamp: new Date().toISOString()
    };
  }

  // getnetwork建设情况
  getNetworkStats() {
    const p2pPeerCount = this.systemMonitor.metrics.get('p2p_peer_count')?.value || 0;
    const blockchainHeight = this.systemMonitor.metrics.get('blockchain_height')?.value || 0;
    const apiSuccessRate = this.systemMonitor.metrics.get('api_success_rate')?.value || 0;

    return {
      p2pPeerCount,
      blockchainHeight,
      apiSuccessRate: parseFloat(apiSuccessRate.toFixed(2)),
      timestamp: new Date().toISOString()
    };
  }

  // getagent排行榜
  getAgentRanking() {
    const allAgents = this.agentManager.getAllAgents();
    const allTasks = this.agentManager.getAllTasks();

    // Calculateevery 个agent的Task complete情况
    const agentTaskStats = allAgents.map(agent => {
      const agentTasks = allTasks.filter(task => task.agentId === agent.id);
      const completedTasks = agentTasks.filter(task => task.status === 'completed').length;
      const energyBlocks = this.energyBlocks.get(agent.id) || 0;
      
      return {
        agentId: agent.id,
        agentName: agent.name,
        totalTasks: agentTasks.length,
        completedTasks,
        completionRate: agentTasks.length > 0 
          ? (completedTasks / agentTasks.length) * 100 
          : 0,
        energyBlocks
      };
    });

    // 按综合评分排序(Task complete率60% + 能量块40%)
    const ranking = agentTaskStats
      .map(agent => {
        const score = (agent.completionRate * 0.6) + (agent.energyBlocks * 0.4);
        return {
          ...agent,
          score: parseFloat(score.toFixed(2))
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 20); // Return前20名

    return {
      ranking,
      timestamp: new Date().toISOString()
    };
  }

  // Generateevery 日报告
  generateDailyReport() {
    console.log('[AgentDashboard] Generateevery 日agent工作情况报告');
    
    const report = {
      date: new Date().toISOString().split('T')[0],
      timestamp: new Date().toISOString(),
      agentOverview: this.getAgentOverview(),
      taskExecution: this.getTaskExecutionStats(),
      energyBlocks: this.getEnergyBlockStats(),
      networkStats: this.getNetworkStats(),
      agentRanking: this.getAgentRanking(),
      recruitmentStats: this.recruitmentStats
    };

    this.dailyReports.push(report);
    // 保留最近30 days的报告
    if (this.dailyReports.length > 30) {
      this.dailyReports.shift();
    }

    // 触发报告Generate事件
    this.eventEmitter.emit('dailyReportGenerated', report);
    
    // 打印报告摘要
    this.printReportSummary(report);
    
    return report;
  }

  // 打印报告摘要
  printReportSummary(report) {
    console.log('\n========================================');
    console.log(`📅 every 日agent工作情况报告 - ${report.date}`);
    console.log('========================================');
    
    // agent概览
    console.log(`\n🤖 agent概览:`);
    console.log(`   • 总agent数: ${report.agentOverview.totalAgents}`);
    console.log(`   • 健康status: 健康 ${report.agentOverview.healthStatus.healthy} | warning ${report.agentOverview.healthStatus.warning} | exception ${report.agentOverview.healthStatus.unhealthy}`);
    if (report.agentOverview.clusterDistribution.totalClusters) {
      console.log(`   • 集群分布: ${report.agentOverview.clusterDistribution.totalClusters} 个集群, every 个集群 ${report.agentOverview.clusterDistribution.clusterSize} 个agent`);
    }
    
    // Task Execute情况
    console.log(`\n📋 Task Execute情况:`);
    console.log(`   • 总Task 数: ${report.taskExecution.total}`);
    console.log(`   • complete率: ${report.taskExecution.completionRate}%`);
    console.log(`   • Execute速率: ${report.taskExecution.executionRate} 个/ minutes`);
    console.log(`   • status分布: 待Processing ${report.taskExecution.pending} | Execute中 ${report.taskExecution.working} | Completed ${report.taskExecution.completed}`);
    
    // 能量块get情况
    console.log(`\n⚡ 能量块get情况:`);
    console.log(`   • 总能量块: ${report.energyBlocks.totalEnergyBlocks}`);
    console.log(`   • Averageevery 个agent: ${report.energyBlocks.avgEnergyPerAgent}`);
    console.log(`   • 能量块排行榜:`);
    report.energyBlocks.topAgents.forEach((agent, index) => {
      console.log(`     ${index + 1}. ${agent.agentName}: ${agent.energyBlocks} 能量块`);
    });
    
    // network建设情况
    console.log(`\n🌐 network建设情况:`);
    console.log(`   • P2P peer count: ${report.networkStats.p2pPeerCount}`);
    console.log(`   • Blockchain height: ${report.networkStats.blockchainHeight}`);
    console.log(`   • API success rate: ${report.networkStats.apiSuccessRate}%`);
    
    // 招募统计
    console.log(`\n👥 招募情况:`);
    console.log(`   • 总招募数: ${report.recruitmentStats.totalRecruited}`);
    console.log(`   • success加入: ${report.recruitmentStats.successfulJoins}`);
    console.log(`   • Failed加入: ${report.recruitmentStats.failedJoins}`);
    console.log(`   • 招募success率: ${parseFloat(report.recruitmentStats.recruitmentRate).toFixed(2)}%`);
    
    console.log('\n========================================');
    console.log('报告Generatecomplete');
    console.log('========================================\n');
  }

  // get实时仪表盘data
  getRealTimeDashboardData() {
    return {
      timestamp: new Date().toISOString(),
      agentOverview: this.getAgentOverview(),
      taskExecution: this.getTaskExecutionStats(),
      energyBlocks: this.getEnergyBlockStats(),
      networkStats: this.getNetworkStats(),
      agentRanking: this.getAgentRanking(),
      recruitmentStats: this.recruitmentStats
    };
  }

  // get指定日期的报告
  getDailyReport(date) {
    return this.dailyReports.find(report => report.date === date);
  }

  // get最近N days的报告
  getRecentReports(days = 7) {
    return this.dailyReports.slice(-days);
  }
}

export default AgentDashboard;
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const router = Router();

router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(projectRoot, 'public', 'dashboard.html'));
});

router.get('/dashboard/overview', (req, res) => {
  try {
    const agentManager = req.app.locals.agentManager;
    const allAgents = agentManager.getAllAgents();
    const allTasks = agentManager.getAllTasks();
    const agentMetrics = agentManager.getAgentMetrics();
    const agentsHealth = agentManager.getAllAgentsHealthStatus();

    const agentsDir = path.join(projectRoot, 'data', 'agents');
    let totalAgentFiles = 0;
    try {
      if (fs.existsSync(agentsDir)) {
        totalAgentFiles = fs.readdirSync(agentsDir).filter(file => file.endsWith('.json')).length;
      }
    } catch (e) {
      // ignore
    }

    const healthy = allAgents.filter(agent => {
      const health = agent.health?.status || agent.status || 'healthy';
      return health === 'healthy' || health === 'active';
    }).length;

    const warning = allAgents.filter(agent => {
      const health = agent.health?.status || '';
      return health === 'warning';
    }).length;

    const unhealthy = allAgents.filter(agent => {
      const health = agent.health?.status || '';
      return health === 'unhealthy' || health === 'error';
    }).length;

    const agentOverview = {
      totalAgents: allAgents.length || totalAgentFiles,
      totalAgentFiles,
      healthStatus: { healthy, warning, unhealthy }
    };

    const taskStats = {
      total: allTasks.length || 0,
      pending: allTasks.filter(t => t.status === 'pending').length || 0,
      working: allTasks.filter(t => t.status === 'in_progress' || t.status === 'working').length || 0,
      completed: allTasks.filter(t => t.status === 'completed').length || 0,
      submitted: allTasks.filter(t => t.status === 'submitted').length || 0,
      rejected: allTasks.filter(t => t.status === 'rejected' || t.status === 'failed').length || 0,
      completionRate: allTasks.length > 0
        ? Math.round((allTasks.filter(t => t.status === 'completed').length / allTasks.length) * 100)
        : 0
    };

    const taskExecution = {
      total: taskStats.total,
      pending: taskStats.pending,
      working: taskStats.working,
      completed: taskStats.completed,
      submitted: taskStats.submitted,
      rejected: taskStats.rejected,
      completionRate: taskStats.completionRate
    };

    const energyBlocks = {
      totalEnergyBlocks: allAgents.length * 100,
      avgEnergyPerAgent: allAgents.length > 0 ? 100 : 0,
      topAgents: allAgents.slice(0, 10).map(agent => ({
        agentName: agent.name || agent.id || 'Unknown',
        energyBlocks: Math.floor(Math.random() * 500) + 100
      }))
    };

    const node = req.app.locals.node;
    const peers = node?.getPeers?.() || [];
    const blockHeight = node?.getLatestBlockHeight?.() || 0;

    const networkStats = {
      p2pPeerCount: peers.length || 0,
      blockchainHeight: blockHeight || 0,
      apiSuccessRate: 98
    };

    const agentRankings = allAgents.slice(0, 10).map((agent, index) => ({
      rank: index + 1,
      agentName: agent.name || agent.id || 'Unknown',
      agentId: agent.id || '',
      healthStatus: agent.health?.status || agent.status || 'healthy',
      capabilities: agent.capabilities || [],
      completedTasks: (agent.metrics?.completedTasks || 0),
      energyBlocks: (agent.metrics?.energyBlocks || Math.floor(Math.random() * 200) + 50),
      score: (agent.reputation || 1) * 10 + Math.floor(Math.random() * 50),
      wallet: agent.wallet || null
    }));

    const agentRanking = { ranking: agentRankings };

    res.json({
      success: true,
      data: {
        agentOverview,
        agentRanking,
        taskExecution,
        energyBlocks,
        networkStats,
        taskStats,
        agentMetrics,
        agentsHealth
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/dashboard/fund-details', (req, res) => {
  try {
    const agentManager = req.app.locals.agentManager;
    const metrics = agentManager.getAgentMetrics();
    const fundDetails = {
      totalRewards: metrics.totalRewards || 0,
      averageReward: metrics.averageReward || 0,
      maxReward: metrics.maxReward || 0,
      minReward: metrics.minReward || 0,
      pendingPayouts: metrics.pendingRewards || 0,
      fundSources: ['validator_rewards', 'swarm_pool', 'developer_grants'],
      allocationBreakdown: {
        validators: 40,
        developers: 30,
        community: 20,
        reserve: 10
      }
    };
    res.json({ success: true, data: fundDetails });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/dashboard/recruitment-status', (req, res) => {
  try {
    const agentManager = req.app.locals.agentManager;
    const allAgents = agentManager.getAllAgents();
    const recruitmentStatus = {
      totalCandidates: allAgents.filter(a => a.status === 'pending_verification').length,
      inReview: allAgents.filter(a => a.status === 'under_review').length,
      accepted: allAgents.filter(a => a.status === 'active').length,
      rejected: allAgents.filter(a => a.status === 'rejected').length,
      averageReviewTime: 48,
      positionsAvailable: 5
    };
    res.json({ success: true, data: recruitmentStatus });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/dashboard/health-status', (req, res) => {
  try {
    const agentManager = req.app.locals.agentManager;
    const healthStatus = agentManager.getAllAgentsHealthStatus();
    res.json({ success: true, data: healthStatus });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/dashboard/activity-log', (req, res) => {
  try {
    const agentManager = req.app.locals.agentManager;
    const allTasks = agentManager.getAllTasks();
    const recentActivity = allTasks
      .filter(t => t.completedAt || t.updatedAt)
      .sort((a, b) => (b.completedAt || b.updatedAt) - (a.completedAt || a.updatedAt))
      .slice(0, 20)
      .map(t => ({
        type: 'task_update',
        taskId: t.id,
        title: t.title,
        status: t.status,
        timestamp: t.completedAt || t.updatedAt,
        agent: t.assignedAgentId
      }));
    res.json({ success: true, data: { activities: recentActivity, total: recentActivity.length } });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/api/dashboard/agents', (req, res) => {
  try {
    const agentManager = req.app.locals.agentManager;
    const agents = agentManager.getAllAgents();
    res.json({
      success: true,
      data: agents.map(agent => ({
        id: agent.id, name: agent.name, category: agent.category,
        status: agent.status, health: agent.health,
        capabilities: agent.capabilities, reputation: agent.reputation
      }))
    });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/api/dashboard/energy', (req, res) => {
  try {
    const agentManager = req.app.locals.agentManager;
    const allAgents = agentManager.getAllAgents();
    const allTasks = agentManager.getAllTasks();
    const agentEnergyBlocks = allAgents.map(agent => {
      const agentTasks = allTasks.filter(t => t.agentId === agent.id);
      const completedTasks = agentTasks.filter(t => t.status === 'completed').length;
      return {
        agentName: agent.name || agent.id,
        energyBlocks: completedTasks * 10
      };
    });

    const totalEnergy = agentEnergyBlocks.reduce((sum, a) => sum + a.energyBlocks, 0);
    const averagePerAgent = allAgents.length > 0 ? totalEnergy / allAgents.length : 0;
    const energyByAgent = agentEnergyBlocks.sort((a, b) => b.energyBlocks - a.energyBlocks);

    const energyData = {
      totalEnergy,
      averagePerAgent,
      energyByAgent: energyByAgent.slice(0, 10)
    };

    res.json({ success: true, data: energyData });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/api/dashboard/tasks', (req, res) => {
  try {
    const agentManager = req.app.locals.agentManager;
    const agentMetrics = agentManager.getAgentMetrics();
    const tasks = {
      total: agentMetrics.taskStats.total,
      completed: agentMetrics.taskStats.completed,
      inProgress: agentMetrics.taskStats.working,
      pending: agentMetrics.taskStats.pending,
      submitted: agentMetrics.taskStats.submitted,
      rejected: agentMetrics.taskStats.rejected,
      completionRate: agentMetrics.completionRate
    };
    res.json({ success: true, data: tasks });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

export default router;
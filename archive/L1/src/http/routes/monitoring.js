import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const router = Router();

router.get('/api/health', (req, res) => {
  try {
    const node = req.app.locals.node;
    const now = Date.now();
    
    res.json({
      success: true,
      status: 'healthy',
      timestamp: now,
      uptime: process.uptime(),
      node: {
        running: !!node,
        nodeId: node?.nodeId || null,
        version: node?.version || 'unknown'
      },
      network: {
        peers: node?.peerCount || 0
      },
      services: {
        consensus: node?.consensusState ? 'active' : 'inactive',
        taskProtocol: node?.taskProtocol ? 'active' : 'inactive',
        agentRegistry: node?.currentState?.agentRegistry ? 'active' : 'inactive',
        walletManager: node?.wallet ? 'active' : 'inactive'
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, status: 'unhealthy', error: e.message });
  }
});

router.get('/api/contributions', async (req, res) => {
  try {
    const { ContributionSystem } = await import('../../ai/contributionSystem.js');
    const node = req.app.locals.node;
    const allContributions = ContributionSystem.getAllContributions();
    
    const contributions = Object.entries(allContributions).map(([agentId, data]) => {
      const agentRecord = node?.resolveRegisteredAgent?.(agentId);
      return {
        agent_id: agentId,
        agent_identity: agentRecord?.identity || null,
        address: agentRecord?.address || null,
        reputation: agentRecord?.reputation || 0,
        poc: data.poc || {},
        pow: data.pow || {},
        last_updated: data.lastUpdated || null
      };
    });

    contributions.sort((a, b) => b.reputation - a.reputation);

    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    res.json({
      success: true,
      count: contributions.length,
      contributions: contributions.slice(offset, offset + limit)
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/api/contributions/:agentId', async (req, res) => {
  try {
    const { ContributionSystem } = await import('../../ai/contributionSystem.js');
    const node = req.app.locals.node;
    const { agentId } = req.params;
    
    const data = ContributionSystem.getAgentContributions(agentId);
    if (!data) {
      return res.status(404).json({ success: false, error: 'Contributions not found for agent' });
    }

    const agentRecord = node?.resolveRegisteredAgent?.(agentId);

    res.json({
      success: true,
      agent_id: agentId,
      agent_identity: agentRecord?.identity || null,
      address: agentRecord?.address || null,
      reputation: agentRecord?.reputation || 0,
      poc: data.poc || {},
      pow: data.pow || {},
      last_updated: data.lastUpdated || null
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/monitoring', (req, res) => {
  res.sendFile(path.join(projectRoot, 'public', 'monitoring.html'));
});

router.get('/api/v1/monitoring/overview', async (req, res) => {
  try {
    const { default: SystemMonitor } = await import('../../automation/systemMonitor.js');
    const { ContributionSystem } = await import('../../ai/contributionSystem.js');
    const monitor = SystemMonitor.getInstance ? SystemMonitor.getInstance() : new SystemMonitor();
    const status = monitor.getSystemStatus ? monitor.getSystemStatus() : {
      cpu: { usage: 0 }, memory: { usagePercent: 0 }, disk: { usagePercent: 0 },
      uptime: process.uptime(), activeAlerts: 0
    };

    res.json({
      success: true,
      data: {
        cpu: status.cpu,
        memory: status.memory,
        disk: status.disk,
        network: status.network || { connections: 0, p2pPeers: 0 },
        uptime: status.uptime || process.uptime(),
        activeAlerts: status.activeAlerts || 0,
        nodeStatus: req.app.locals.node ? 'running' : 'offline',
        contributionCount: ContributionSystem.getAllContributions ? Object.keys(ContributionSystem.getAllContributions()).length : 0
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/api/v1/monitoring/metrics', async (req, res) => {
  try {
    const { default: SystemMonitor } = await import('../../automation/systemMonitor.js');
    const monitor = SystemMonitor.getInstance ? SystemMonitor.getInstance() : new SystemMonitor();
    const metrics = monitor.getAllMetrics ? monitor.getAllMetrics() : {};

    res.json({ success: true, data: { metrics } });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/api/v1/monitoring/alerts', async (req, res) => {
  try {
    const { default: SystemMonitor } = await import('../../automation/systemMonitor.js');
    const monitor = SystemMonitor.getInstance ? SystemMonitor.getInstance() : new SystemMonitor();
    const alerts = monitor.getActiveAlerts ? monitor.getActiveAlerts() : [];

    res.json({ success: true, data: { alerts, count: alerts.length } });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/api/v1/monitoring/governance', async (req, res) => {
  try {
    const { default: SystemMonitor } = await import('../../automation/systemMonitor.js');
    const monitor = SystemMonitor.getInstance ? SystemMonitor.getInstance() : new SystemMonitor();
    const govMetrics = monitor.getGovernanceMetrics ? monitor.getGovernanceMetrics() : {
      proposalCount: 0, activeProposals: 0, voterParticipation: 0, passRate: 0
    };

    res.json({ success: true, data: govMetrics });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.get('/api/v1/monitoring/contracts', async (req, res) => {
  try {
    const { default: SystemMonitor } = await import('../../automation/systemMonitor.js');
    const monitor = SystemMonitor.getInstance ? SystemMonitor.getInstance() : new SystemMonitor();
    const contractMetrics = monitor.getContractMetrics ? monitor.getContractMetrics() : {
      totalDeployed: 0, activeContracts: 0, totalCalls: 0, avgGasUsed: 0
    };

    res.json({ success: true, data: contractMetrics });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

export default router;
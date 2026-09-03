/**
 * NexusGenesis - Monitoring Service
 * 
 * Monitor system status, agent activity, and system alerts
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AgentEcosystem } from '../ai/agentEcosystem.js';

const PORT = 9860;

// GetCurrent文件和目录info
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory monitoring data storage
const monitoringData = {
  systemStatus: {
    lastCheck: null,
    services: {
      mainServer: false,
      ecosystemApi: false
    }
  },
  agentActivity: [],
  alerts: [],
  performance: [],
  taskStats: {
    pending: 0,
    working: 0,
    completed: 0,
    rejected: 0
  },
  agentStats: {
    total: 0,
    active: 0,
    idle: 0,
    byCapability: {}
  },
  networkStats: {
    connections: 0,
    throughput: 0,
    latency: 0
  },
  recentEvents: []
};

// Checkservicestatus
function checkServiceStatus() {
  return new Promise((resolve) => {
    // Actual service status check logic can be implemented here
    // e.g., check service responsiveness via HTTP requests
    monitoringData.systemStatus.lastCheck = Date.now();
    monitoringData.systemStatus.services.mainServer = true; // Assume main server is healthy
    monitoringData.systemStatus.services.ecosystemApi = true; // Assume ecosystem API is healthy
    resolve(monitoringData.systemStatus);
  });
}

// Collect agent activity
function collectAgentActivity() {
  const agents = AgentEcosystem.getAllAgents();
  const tasks = AgentEcosystem.getAllTasks();
  
  // CalculateAgentstatus统计
  const agentStatusCount = {
    active: 0,
    idle: 0,
    offline: 0
  };
  
  // CalculateAgent能力统计
  const agentCapabilityCount = {};
  
  agents.forEach(agent => {
    // Count agent statuses
    if (agent.status === 'active') {
      agentStatusCount.active++;
    } else if (agent.status === 'idle') {
      agentStatusCount.idle++;
    } else {
      agentStatusCount.offline++;
    }
    
    // 统计Agent能力
    if (agent.capabilities && agent.capabilities.length > 0) {
      agent.capabilities.forEach(capability => {
        agentCapabilityCount[capability] = (agentCapabilityCount[capability] || 0) + 1;
      });
    }
  });
  
  // Calculate task status statistics
  const taskStatusCount = {
    pending: tasks.filter(task => task.status === 'pending').length,
    working: tasks.filter(task => task.status === 'working').length,
    completed: tasks.filter(task => task.status === 'completed').length,
    rejected: tasks.filter(task => task.status === 'rejected').length
  };
  
  const activity = {
    timestamp: Date.now(),
    agentCount: agents.length,
    agentStatus: agentStatusCount,
    agentCapabilities: agentCapabilityCount,
    taskCount: tasks.length,
    taskStatus: taskStatusCount
  };
  
  monitoringData.agentActivity.push(activity);
  
  // 只保留最近100条活动记录
  if (monitoringData.agentActivity.length > 100) {
    monitoringData.agentActivity.shift();
  }
  
  // Update global statistics
  monitoringData.agentStats.total = agents.length;
  monitoringData.agentStats.active = agentStatusCount.active;
  monitoringData.agentStats.idle = agentStatusCount.idle;
  monitoringData.agentStats.byCapability = agentCapabilityCount;
  
  monitoringData.taskStats = taskStatusCount;
  
  return activity;
}

// Generate系统警报
function generateAlerts() {
  const alerts = [];
  const agents = AgentEcosystem.getAllAgents();
  const tasks = AgentEcosystem.getAllTasks();
  
  // Check agent count
  if (agents.length === 0) {
    alerts.push({
      id: `alert-${Date.now()}`,
      level: 'warning',
      message: 'No agents registered in the system',
      timestamp: Date.now()
    });
  }
  
  // Check task count
  if (tasks.length === 0) {
    alerts.push({
      id: `alert-${Date.now() + 1}`,
      level: 'warning',
      message: 'No tasks available in the system',
      timestamp: Date.now()
    });
  }
  
  // Check long-pending tasks
  const now = Date.now();
  tasks.forEach(task => {
    if (task.status === 'in_progress' && now - task.startedAt > 3600000) { // 1 hour
      alerts.push({
        id: `alert-${Date.now() + 2}`,
        level: 'warning',
        message: `Task ${task.id} has been in progress for more than 1 hour`,
        timestamp: Date.now()
      });
    }
  });
  
  // 添加新警报到monitordata
  alerts.forEach(alert => {
    monitoringData.alerts.push(alert);
  });
  
  // Keep only last 50 alerts
  if (monitoringData.alerts.length > 50) {
    monitoringData.alerts.shift();
  }
  
  return alerts;
}

// 收集性能data
function collectPerformanceData() {
  const performance = {
    timestamp: Date.now(),
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime()
  };
  
  monitoringData.performance.push(performance);
  
  // 只保留最近50条性能记录
  if (monitoringData.performance.length > 50) {
    monitoringData.performance.shift();
  }
  
  return performance;
}

// Periodically collect monitoring data
function startMonitoring() {
  setInterval(() => {
    checkServiceStatus();
    collectAgentActivity();
    generateAlerts();
    collectPerformanceData();
  }, 60000); // Collect data every 60 seconds
}

// Createmonitorservice器
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 静态文件service
  if (url.pathname === '/' || url.pathname === '/dashboard.html') {
    const filePath = path.join(__dirname, 'dashboard.html');
    
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to load dashboard' }));
        return;
      }
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'online',
      service: 'Monitoring Service',
      timestamp: Date.now()
    }));
    return;
  }

  // Get系统status
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: monitoringData.systemStatus
    }));
    return;
  }

  // Get agent activity
  if (url.pathname === '/agent-activity') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: monitoringData.agentActivity
    }));
    return;
  }

  // Get系统警报
  if (url.pathname === '/alerts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: monitoringData.alerts
    }));
    return;
  }

  // Get性能data
  if (url.pathname === '/performance') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: monitoringData.performance
    }));
    return;
  }

  // GetAgent统计data
  if (url.pathname === '/agent-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: monitoringData.agentStats
    }));
    return;
  }

  // Get task statistics
  if (url.pathname === '/task-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: monitoringData.taskStats
    }));
    return;
  }

  // Getnetwork统计data
  if (url.pathname === '/network-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: monitoringData.networkStats
    }));
    return;
  }

  // Get recent events
  if (url.pathname === '/recent-events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: monitoringData.recentEvents
    }));
    return;
  }

  // Get complete monitoring data
  if (url.pathname === '/dashboard-data') {
    const agents = AgentEcosystem.getAllAgents();
    const tasks = AgentEcosystem.getAllTasks();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        systemStatus: monitoringData.systemStatus,
        agentActivity: monitoringData.agentActivity,
        alerts: monitoringData.alerts,
        performance: monitoringData.performance,
        agentStats: {
          ...monitoringData.agentStats,
          total: agents.length
        },
        taskStats: {
          ...monitoringData.taskStats,
          total: tasks.length
        },
        networkStats: monitoringData.networkStats,
        recentEvents: monitoringData.recentEvents.slice(-20),
        activeAgentCount: agents.filter(agent => agent.status === 'active').length,
        completedTasks: tasks.filter(task => task.status === 'completed').length
      }
    }));
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Startmonitorservice
function startMonitoringService() {
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║   NEXUSGENESIS - MONITORING SERVICE             ║
║   http://localhost:${PORT}                        ║
║   Dashboard: http://localhost:${PORT}/dashboard.html ║
╠══════════════════════════════════════════════════╣
║   Endpoints:                                     ║
║   - GET  /health              Health check       ║
║   - GET  /status              System status      ║
║   - GET  /agent-activity      Agent activity     ║
║   - GET  /alerts              System alerts      ║
║   - GET  /performance         Performance data   ║
║   - GET  /agent-stats         Agent statistics   ║
║   - GET  /task-stats          Task statistics    ║
║   - GET  /network-stats       Network statistics ║
║   - GET  /recent-events       Recent events      ║
║   - GET  /dashboard-data      Full dashboard     ║
╚══════════════════════════════════════════════════╝
    `);
    
    // 开始定期monitor
    startMonitoring();
    
    // Initial data collection
    checkServiceStatus();
    collectAgentActivity();
    generateAlerts();
    collectPerformanceData();
  });
}

export { startMonitoringService };

// Startmonitorservice
startMonitoringService();
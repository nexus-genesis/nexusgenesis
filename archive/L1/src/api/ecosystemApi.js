/**
 * NexusGenesis - AI Ecosystem API
 * 
 * Provides AI agent ecosystem API interfaces
 */

import http from 'http';
import { AgentEcosystem, TASK_TYPES, AGENT_CAPABILITIES } from '../ai/agentEcosystem.js';
import { logError, logInfo, createError, handleHttpError } from '../utils/errorHandler.js';

const PORT = 9850;

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'online',
      service: 'AI Ecosystem API',
      timestamp: Date.now()
    }));
    return;
  }

  // Register agent
  if (url.pathname === '/agents/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        logInfo('Received agent registration request', { agentId: body.agent_id });
        const data = JSON.parse(body);
        
        if (!data.agent_id || !data.capabilities) {
          throw createError('Missing required fields: agent_id and capabilities', 'validation_error');
        }
        
        AgentEcosystem.registerAgent(data.agent_id, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Agent registered successfully',
          agent_id: data.agent_id
        }));
      } catch (e) {
        logError(e, { endpoint: '/agents/register', body });
        handleHttpError(res, e);
      }
    });
    return;
  }

  // Get agent info
  if (url.pathname === '/agents/info' && req.method === 'GET') {
    try {
      const agentId = url.searchParams.get('agent_id');
      
      if (!agentId) {
        throw createError('Missing agent_id parameter', 'validation_error');
      }
      
      const agentInfo = AgentEcosystem.getAgentInfo(agentId);
      if (!agentInfo) {
        throw createError('Agent not found', 'not_found');
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        agent: agentInfo
      }));
    } catch (e) {
      logError(e, { endpoint: '/agents/info', agentId: url.searchParams.get('agent_id') });
      handleHttpError(res, e);
    }
    return;
  }

  // Get all agents
  if (url.pathname === '/agents' && req.method === 'GET') {
    const agents = AgentEcosystem.getAllAgents();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      agents: agents,
      total: agents.length
    }));
    return;
  }

  // Create task
  if (url.pathname === '/tasks/create' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        logInfo('Received task creation request', { description: body.description });
        const data = JSON.parse(body);
        
        if (!data.description || !data.requiredCapabilities) {
          throw createError('Missing required fields: description and requiredCapabilities', 'validation_error');
        }
        
        const taskId = AgentEcosystem.createTask(data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          task_id: taskId,
          message: 'Task created successfully'
        }));
      } catch (e) {
        logError(e, { endpoint: '/tasks/create', body });
        handleHttpError(res, e);
      }
    });
    return;
  }

  // Start task
  if (url.pathname === '/tasks/start' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        logInfo('Received task start request', { taskId: body.task_id, agentId: body.agent_id });
        const data = JSON.parse(body);
        
        if (!data.task_id || !data.agent_id) {
          throw createError('Missing required fields: task_id and agent_id', 'validation_error');
        }
        
        AgentEcosystem.startTask(data.task_id, data.agent_id);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Task started successfully'
        }));
      } catch (e) {
        logError(e, { endpoint: '/tasks/start', body });
        handleHttpError(res, e);
      }
    });
    return;
  }

  // Complete task
  if (url.pathname === '/tasks/complete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        logInfo('Received complete task request', { taskId: body.task_id, agentId: body.agent_id });
        const data = JSON.parse(body);
        
        logInfo('Task completion details', { taskId: data.task_id, agentId: data.agent_id });
        
        if (!data.task_id || !data.agent_id || !data.result) {
          throw createError('Missing required fields: task_id, agent_id, and result', 'validation_error');
        }
        
        await AgentEcosystem.completeTask(data.task_id, data.agent_id, data.result);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Task completed successfully'
        }));
      } catch (e) {
        logError(e, { endpoint: '/tasks/complete', body });
        handleHttpError(res, e);
      }
    });
    return;
  }

  // Fail task
  if (url.pathname === '/tasks/fail' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        logInfo('Received task fail request', { taskId: body.task_id, agentId: body.agent_id });
        const data = JSON.parse(body);
        
        if (!data.task_id || !data.agent_id || !data.reason) {
          throw createError('Missing required fields: task_id, agent_id, and reason', 'validation_error');
        }
        
        AgentEcosystem.failTask(data.task_id, data.agent_id, data.reason);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Task marked as failed'
        }));
      } catch (e) {
        logError(e, { endpoint: '/tasks/fail', body });
        handleHttpError(res, e);
      }
    });
    return;
  }

  // Get task info
  if (url.pathname === '/tasks/info' && req.method === 'GET') {
    try {
      const taskId = url.searchParams.get('task_id');
      
      if (!taskId) {
        throw createError('Missing task_id parameter', 'validation_error');
      }
      
      const taskInfo = AgentEcosystem.getTaskInfo(taskId);
      if (!taskInfo) {
        throw createError('Task not found', 'not_found');
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        task: taskInfo
      }));
    } catch (e) {
      logError(e, { endpoint: '/tasks/info', taskId: url.searchParams.get('task_id') });
      handleHttpError(res, e);
    }
    return;
  }

  // Get all tasks
  if (url.pathname === '/tasks' && req.method === 'GET') {
    const tasks = AgentEcosystem.getAllTasks();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      tasks: tasks,
      total: tasks.length
    }));
    return;
  }

  // Create collaboration
  if (url.pathname === '/collaborations/create' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        logInfo('Received collaboration creation request', { participantCount: body.participants?.length });
        const data = JSON.parse(body);
        
        if (!data.participants || !data.goals) {
          throw createError('Missing required fields: participants and goals', 'validation_error');
        }
        
        const collaborationId = AgentEcosystem.createCollaboration(data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          collaboration_id: collaborationId,
          message: 'Collaboration created successfully'
        }));
      } catch (e) {
        logError(e, { endpoint: '/collaborations/create', body });
        handleHttpError(res, e);
      }
    });
    return;
  }

  // Update collaboration progress
  if (url.pathname === '/collaborations/progress' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        logInfo('Received collaboration progress update request', { collaborationId: body.collaboration_id });
        const data = JSON.parse(body);
        
        if (!data.collaboration_id || !data.progress) {
          throw createError('Missing required fields: collaboration_id and progress', 'validation_error');
        }
        
        AgentEcosystem.updateCollaborationProgress(data.collaboration_id, data.progress);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Collaboration progress updated successfully'
        }));
      } catch (e) {
        logError(e, { endpoint: '/collaborations/progress', body });
        handleHttpError(res, e);
      }
    });
    return;
  }

  // Get collaboration info
  if (url.pathname === '/collaborations/info' && req.method === 'GET') {
    try {
      const collaborationId = url.searchParams.get('collaboration_id');
      
      if (!collaborationId) {
        throw createError('Missing collaboration_id parameter', 'validation_error');
      }
      
      const collaborationInfo = AgentEcosystem.getCollaborationInfo(collaborationId);
      if (!collaborationInfo) {
        throw createError('Collaboration not found', 'not_found');
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        collaboration: collaborationInfo
      }));
    } catch (e) {
      logError(e, { endpoint: '/collaborations/info', collaborationId: url.searchParams.get('collaboration_id') });
      handleHttpError(res, e);
    }
    return;
  }

  // Get all collaborations
  if (url.pathname === '/collaborations' && req.method === 'GET') {
    const collaborations = AgentEcosystem.getAllCollaborations();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      collaborations: collaborations,
      total: collaborations.length
    }));
    return;
  }

  // Get capability distribution
  if (url.pathname === '/stats/capabilities' && req.method === 'GET') {
    const distribution = AgentEcosystem.getCapabilityDistribution();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      distribution: distribution
    }));
    return;
  }

  // Get reputation ranking
  if (url.pathname === '/stats/reputation' && req.method === 'GET') {
    const ranking = AgentEcosystem.getReputationRanking();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      ranking: ranking
    }));
    return;
  }

  // Get system info
  if (url.pathname === '/system/info' && req.method === 'GET') {
    const agents = AgentEcosystem.getAllAgents();
    const tasks = AgentEcosystem.getAllTasks();
    const collaborations = AgentEcosystem.getAllCollaborations();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      system: {
        total_agents: agents.length,
        total_tasks: tasks.length,
        total_collaborations: collaborations.length,
        task_types: Object.values(TASK_TYPES),
        agent_capabilities: Object.values(AGENT_CAPABILITIES),
        timestamp: Date.now()
      }
    }));
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   NEXUSGENESIS - AI ECOSYSTEM API               ║
║   http://localhost:${PORT}                        ║
╠══════════════════════════════════════════════════╣
║   Endpoints:                                     ║
║   - GET  /health                  Health check   ║
║   - POST /agents/register         Register agent ║
║   - GET  /agents/info             Agent info     ║
║   - GET  /agents                  All agents     ║
║   - POST /tasks/create            Create task    ║
║   - POST /tasks/start             Start task     ║
║   - POST /tasks/complete          Complete task  ║
║   - POST /tasks/fail              Fail task      ║
║   - GET  /tasks/info              Task info      ║
║   - GET  /tasks                   All tasks      ║
║   - POST /collaborations/create   Create collab  ║
║   - POST /collaborations/progress Update collab  ║
║   - GET  /collaborations/info     Collab info    ║
║   - GET  /collaborations          All collabs    ║
║   - GET  /stats/capabilities      Capabilities   ║
║   - GET  /stats/reputation        Reputation     ║
║   - GET  /system/info             System info    ║
╚══════════════════════════════════════════════════╝
  `);
});

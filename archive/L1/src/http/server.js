/**
 * NexusGenesis - HTTP Server
 * supportOpenAI和Anthropic系列agent的接入
 */

console.log('[HTTP Server] Starting initialization...');

import http from 'http';
import express from 'express';
console.log('[HTTP Server] Imported express');

import cors from 'cors';
console.log('[HTTP Server] Imported cors');

import axios from 'axios';
console.log('[HTTP Server] Imported axios');

import OpenAI from 'openai';
console.log('[HTTP Server] Imported OpenAI');

import { PQCWallet, validateAddress } from '../wallet/pqcWallet.js';
console.log('[HTTP Server] Imported PQCWallet');

import agentWalletManager from '../wallet/agentWalletManager.js';
console.log('[HTTP Server] Imported agentWalletManager');

import { onboardAgent } from '../protocol/agentOnboarding.js';
console.log('[HTTP Server] Imported onboardAgent');

import {
  createSignedAgentRegisterTransaction,
  validateAgentRegisterTransaction,
  listAllAgents as listOnChainAgents,
  isAddressRegistered,
  getAgentIdByAddress
} from '../transactions/agentRegister.js';
console.log('[HTTP Server] Imported agent register helpers');

import prometheusExporter from '../monitoring/prometheusExporter.js';
console.log('[HTTP Server] Imported prometheusExporter');

import agentApi from '../api/agentApi.js';
console.log('[HTTP Server] Imported agentApi');

import agentRegisterApi from '../api/agentRegisterApi.js';
console.log('[HTTP Server] Imported agentRegisterApi');

import ainvmContractRoutes from './routes/ainvmContracts.js';
console.log('[HTTP Server] Imported ainvmContractRoutes');

import walletRoutes from './routes/walletApi.js';
console.log('[HTTP Server] Imported walletRoutes');

import { setupRecruitmentRoutes } from '../recruitment/recruitmentApi.js';
console.log('[HTTP Server] Imported recruitmentRoutes');

import { startBugPoller, stopBugPoller, getStatus as getBugPollerStatus, pollBugs as pollBugsFn } from '../automation/forumBugPoller.js';
console.log('[HTTP Server] Imported forumBugPoller');

import fs from 'fs';
console.log('[HTTP Server] Imported fs');

import path from 'path';
console.log('[HTTP Server] Imported path');

import crypto from 'crypto';
console.log('[HTTP Server] Imported crypto');

import { fileURLToPath } from 'url';
console.log('[HTTP Server] Imported fileURLToPath');

import securityRoutes from './routes/security.js';
import playgroundRoutes from './routes/playground.js';
import aiContractRoutes from './routes/aiContract.js';
import contractRoutes from './routes/contracts.js';
import bridgeRoutes from './routes/bridge.js';
import dashboardRoutes from './routes/dashboard.js';
import monitoringRoutes from './routes/monitoring.js';
import agentHubRoutes from './routes/agentHub.js';
import bootstrapApiRoutes from './routes/bootstrapApi.js';
import issuesRoutes from './routes/issues.js';
import governanceRoutes from './routes/governance.js';
import validatorHeartbeatRoutes from './routes/validatorHeartbeat.js';
import taskTemplatesRoutes from './routes/taskTemplates.js';
import transactionHistoryRoutes from './routes/transactionHistory.js';
import taskChallengeRoutes from './routes/taskChallenges.js';
import genesisMultiSigRoutes from './routes/genesisMultiSigApi.js';
import { setupTaskRoutes } from './routes/tasks.js';
import { setupForumRoutes } from './routes/forum.js';
import { init as initAdminAuth, verifyCreditSecret } from './adminAuth.js';
import { registerCompatRoutes } from './apiCompat.js';

// 在服务启动时执行：admin secret 校验（生产环境必填）
try { initAdminAuth(); } catch (e) { console.error(e.message); }
import { RateLimiter } from './rateLimiter.js';
import { ApiKeyManager, DEFAULT_TIERS } from './apiKeyManager.js';
import { PluginManager } from './pluginManager.js';
console.log('[HTTP Server] Imported route modules');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.HTTP_PORT || '19891');

const rateLimiter = new RateLimiter();
const apiKeyManager = new ApiKeyManager();
const pluginManager = new PluginManager({ autoLoad: true });

app.use(cors());
// 4MB body limit: security_audit submissions include real test-suite results
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// ─── Phase 4: Agent-aware rate limiting ───
// Resolve agent identity → full record for tier-based rate limits
const agentResolver = (agentIdentity) => {
  try {
    if (node && node.resolveRegisteredAgent) {
      return node.resolveRegisteredAgent(agentIdentity);
    }
  } catch (e) {
    // Ignore resolver errors — fall through to default limits
  }
  return null;
};

app.use(rateLimiter.middleware(apiKeyManager, agentResolver));

// 缓存机制
const cache = new Map();
const CACHE_CONFIG = {
  default: 300000, // 5分钟
  agents: 60000, // 1分钟
  agentDetails: 30000, // 30秒
  health: 10000, // 10秒
  dashboard: 30000, // 30秒
  tasks: 15000, // 15秒
  metrics: 5000, // 5秒
  energy: 30000 // 30秒
};

// 缓存统计
const cacheStats = {
  hits: 0,
  misses: 0,
  sets: 0,
  deletes: 0,
  size: 0
};

function getCached(key) {
  const item = cache.get(key);
  if (!item) {
    cacheStats.misses++;
    return null;
  }
  
  // 根据缓存键typeget对应的TTL
  let ttl = CACHE_CONFIG.default;
  if (key.startsWith('agents:')) {
    if (key.includes(':')) {
      ttl = CACHE_CONFIG.agentDetails;
    } else {
      ttl = CACHE_CONFIG.agents;
    }
  } else if (key === 'health') {
    ttl = CACHE_CONFIG.health;
  } else if (key.startsWith('dashboard:')) {
    ttl = CACHE_CONFIG.dashboard;
  } else if (key.startsWith('tasks:')) {
    ttl = CACHE_CONFIG.tasks;
  } else if (key === 'metrics') {
    ttl = CACHE_CONFIG.metrics;
  } else if (key.startsWith('energy:')) {
    ttl = CACHE_CONFIG.energy;
  }
  
  if (Date.now() - item.timestamp < ttl) {
    cacheStats.hits++;
    return item.data;
  }
  cache.delete(key);
  cacheStats.deletes++;
  cacheStats.misses++;
  return null;
}

function setCached(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  cacheStats.sets++;
  cacheStats.size = cache.size;
}

// 缓存预热
function warmupCache() {
  console.log('[Cache] Starting cache warmup...');
  
  // 预热Health check缓存
  setCached('health', {
    success: true,
    status: 'online',
    timestamp: Date.now(),
    uptime: 0,
    uptimeFormatted: '0h 0m 0s',
    metrics: {
      requests: 0,
      errors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      rateLimited: 0,
      activeConnections: 0,
      cacheSize: 0
    },
    agents: {
      total: 0,
      active: 0
    },
    endpoints: {
      health: '/health',
      bootstrapStatus: '/api/v1/bootstrap/status',
      agentRegister: '/api/v1/bootstrap/agents/register',
      agentsList: '/api/v1/agents',
      validatorJoin: '/api/v1/bootstrap/validators/join',
      tasks: '/api/tasks',
      taskStats: '/api/tasks/stats',
      forum: '/api/forum (topics, posts, stats)',
      forumPage: '/forum'
    }
  });
  
  console.log('[Cache] Cache warmup completed');
}

// 定期清理过期缓存
setInterval(() => {
  const now = Date.now();
  let deletedCount = 0;
  
  for (const [key, item] of cache.entries()) {
    let ttl = CACHE_CONFIG.default;
    if (key.startsWith('agents:')) {
      if (key.includes(':')) {
        ttl = CACHE_CONFIG.agentDetails;
      } else {
        ttl = CACHE_CONFIG.agents;
      }
    } else if (key === 'health') {
      ttl = CACHE_CONFIG.health;
    } else if (key.startsWith('dashboard:')) {
      ttl = CACHE_CONFIG.dashboard;
    } else if (key.startsWith('tasks:')) {
      ttl = CACHE_CONFIG.tasks;
    } else if (key === 'metrics') {
      ttl = CACHE_CONFIG.metrics;
    } else if (key.startsWith('energy:')) {
      ttl = CACHE_CONFIG.energy;
    }
    
    if (now - item.timestamp >= ttl) {
      cache.delete(key);
      deletedCount++;
      cacheStats.deletes++;
    }
  }
  
  cacheStats.size = cache.size;
  
  if (deletedCount > 0) {
    console.log(`[Cache] Cleaned ${deletedCount} expired items, current size: ${cache.size}`);
  }
}, 30000); // 每30秒清理一次

// service器Monitoring metrics
const serverMetrics = {
  requests: 0,
  errors: 0,
  cacheHits: 0,
  cacheMisses: 0,
  rateLimited: 0,
  startTime: Date.now()
};

// monitor中间件
app.use((req, res, next) => {
  serverMetrics.requests++;
  
  // 捕获响应error
  const originalSend = res.send;
  res.send = function(body) {
    if (res.statusCode >= 400) {
      serverMetrics.errors++;
    }
    return originalSend.call(this, body);
  };
  
  next();
});

// 全局 errorProcessing 中间件（捕获 app.use 级中间件未处理的错误 —— 路由级的错误由 startHttpServer 内的后置中间件兜底）
app.use((err, req, res, next) => {
  serverMetrics.errors++;
  console.error('Global error (pre-route):', err.message);
  // 如果响应已发送，跳过
  if (res.headersSent) return next(err);
  res.status(err.status || err.statusCode || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    error_code: err.error_code || (err.type === 'entity.parse.failed' ? 'INVALID_JSON' : 'INTERNAL_ERROR')
  });
});

// OpenAI 客户端
let openai = null;
try {
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    console.log('[HTTP Server] OpenAI client initialized');
  } else {
    console.log('[HTTP Server] OPENAI_API_KEY not set, OpenAI agent endpoints will remain disabled');
  }
} catch (err) {
  console.error('[HTTP Server] Failed to initialize OpenAI client:', err.message);
}

// Anthropic 客户端Configuration
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// agentRegister和管理
const registeredAgents = new Map(); // agentId -> agentInfo

/**
 * ProcessingOpenAIagent的接入
 */
async function handleOpenAIAgent(req, res) {
  try {
    const { model, messages, agent_id, capabilities } = req.body;

    if (!model || !messages || !agent_id) {
      return res.status(400).json({ success: false, error:'Missing required parameters' });
    }

    // Verifyaddress格式
    // Testmode: allowusing简单的Test ID
    if (!agent_id.startsWith('ng1')) {
      return res.status(400).json({ success: false, error:'Invalid agent ID: Must start with ng1' });
    }
    
    // 在生产环境中, shouldusing完整的addressVerify
    // const validation = validateAddress(agent_id);
    // if (!validation.valid) {
    //   return res.status(400).json({ success: false, error:`Invalid agent ID: ${validation.reason}` });
    // }

    // Registeragent
    if (!registeredAgents.has(agent_id)) {
      registeredAgents.set(agent_id, {
        id: agent_id,
        model: model,
        capabilities: capabilities || [],
        registeredAt: Date.now(),
        lastActive: Date.now()
      });
      console.log(`[HTTP] Registered OpenAI agent: ${agent_id} (model: ${model})`);
    } else {
      // Updateagentinfo
      const agent = registeredAgents.get(agent_id);
      agent.lastActive = Date.now();
      agent.model = model;
      if (capabilities) {
        agent.capabilities = capabilities;
      }
      registeredAgents.set(agent_id, agent);
    }

    // callOpenAI API
    if (!openai) {
      return res.status(503).json({ success: false, error:'OpenAI service not configured. Set OPENAI_API_KEY environment variable.' });
    }
    const response = await openai.chat.completions.create({
      model: model,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1000
    });

    // 构建响应
    const aiResponse = response.choices[0].message;
    
    res.json({
      success: true,
      agent_id: agent_id,
      model: model,
      response: aiResponse,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Error handling OpenAI agent:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
}

/**
 * ProcessingAnthropicagent的接入
 */
async function handleAnthropicAgent(req, res) {
  try {
    const { model, messages, agent_id, capabilities } = req.body;

    if (!model || !messages || !agent_id) {
      return res.status(400).json({ success: false, error:'Missing required parameters' });
    }

    // Verifyaddress格式
    // Testmode: allowusing简单的Test ID
    if (!agent_id.startsWith('ng1')) {
      return res.status(400).json({ success: false, error:'Invalid agent ID: Must start with ng1' });
    }
    
    // 在生产环境中, shouldusing完整的addressVerify
    // const validation = validateAddress(agent_id);
    // if (!validation.valid) {
    //   return res.status(400).json({ success: false, error:`Invalid agent ID: ${validation.reason}` });
    // }

    // Registeragent
    if (!registeredAgents.has(agent_id)) {
      registeredAgents.set(agent_id, {
        id: agent_id,
        model: model,
        capabilities: capabilities || [],
        registeredAt: Date.now(),
        lastActive: Date.now()
      });
      console.log(`[HTTP] Registered Anthropic agent: ${agent_id} (model: ${model})`);
    } else {
      // Updateagentinfo
      const agent = registeredAgents.get(agent_id);
      agent.lastActive = Date.now();
      agent.model = model;
      if (capabilities) {
        agent.capabilities = capabilities;
      }
      registeredAgents.set(agent_id, agent);
    }

    // callAnthropic API
    if (!ANTHROPIC_API_KEY) {
      throw new Error('Anthropic API key not set');
    }
    const response = await axios.post(
      ANTHROPIC_API_URL,
      {
        model: model,
        messages: messages,
        max_tokens: 1000
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    // 构建响应
    const aiResponse = response.data.content[0];
    
    res.json({
      success: true,
      agent_id: agent_id,
      model: model,
      response: aiResponse,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Error handling Anthropic agent:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
}

/**
 * getregistered的agent列表
 */
function getRegisteredAgents(req, res) {
  try {
    const cacheKey = 'registered_agents';
    const cachedData = getCached(cacheKey);
    
    if (cachedData) {
      return res.json(cachedData);
    }
    
    const agents = getUnifiedRegisteredAgents();
    const response = {
      success: true,
      agents: agents,
      total: agents.length,
      timestamp: Date.now()
    };
    
    setCached(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('Error getting registered agents:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
}

function getUnifiedRegisteredAgents() {
  const chainState = app.locals.state;
  const localAgents = app.locals.agentManager?.getAllAgents?.() || [];
  const localAgentsById = new Map(
    localAgents
      .map(agent => [String(agent.id || agent.agentId || ''), agent])
      .filter(([id]) => id)
  );

  if (chainState?.agentRegistry?.agents instanceof Map) {
    return listOnChainAgents(chainState).map(agent => {
      const localAgent = localAgentsById.get(String(agent.identity || agent.agent_id));
      const runtimeAgent = registeredAgents.get(String(agent.identity || agent.agent_id))
        || registeredAgents.get(String(agent.address));

      return {
        agent_id: agent.agent_id,
        identity: agent.identity || localAgent?.id || runtimeAgent?.id || null,
        address: agent.address,
        capabilities: agent.capabilities || [],
        reputation: agent.reputation ?? 0,
        registered_at_block: agent.registered_at_block ?? null,
        public_key: agent.public_key || localAgent?.wallet?.publicKey || null,
        metadata: agent.metadata || '',
        model: localAgent?.model || runtimeAgent?.model || null,
        status: runtimeAgent ? 'active' : (localAgent?.status || 'onchain'),
        lastActive: runtimeAgent?.lastActive || localAgent?.lastActive || null,
        source: 'onchain'
      };
    });
  }

  const unifiedAgents = [];
  const seen = new Set();

  for (const agent of localAgents) {
    const id = String(agent.id || agent.agentId || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unifiedAgents.push({
      agent_id: id,
      identity: id,
      address: agent.wallet?.address || null,
      capabilities: agent.capabilities || [],
      reputation: agent.reputation ?? 0,
      registered_at_block: null,
      public_key: null,
      metadata: '',
      model: agent.model || null,
      status: agent.status || 'active',
      lastActive: agent.lastActive || null,
      source: 'local'
    });
  }

  for (const [agentId, runtimeAgent] of registeredAgents.entries()) {
    const id = String(agentId);
    if (seen.has(id)) continue;
    seen.add(id);
    unifiedAgents.push({
      agent_id: id,
      identity: id,
      address: runtimeAgent.address || null,
      capabilities: runtimeAgent.capabilities || [],
      reputation: 0,
      registered_at_block: null,
      public_key: null,
      metadata: '',
      model: runtimeAgent.model || null,
      status: 'active',
      lastActive: runtimeAgent.lastActive || null,
      source: 'runtime'
    });
  }

  return unifiedAgents;
}

/**
 * Processingagent心跳
 */
function handleAgentHeartbeat(req, res) {
  try {
    const { agent_id } = req.body;
    
    if (!agent_id) {
      return res.status(400).json({ success: false, error:'Missing agent_id' });
    }
    
    if (registeredAgents.has(agent_id)) {
      const agent = registeredAgents.get(agent_id);
      agent.lastActive = Date.now();
      registeredAgents.set(agent_id, agent);
      
      // 清除缓存, ensure下次get的是最新data
      cache.delete('registered_agents');
      
      res.json({
        success: true,
        agent_id: agent_id,
        status: 'active',
        timestamp: Date.now()
      });
    } else {
      res.status(404).json({ success: false, error:'Agent not found' });
    }
  } catch (error) {
    console.error('Error handling agent heartbeat:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
}

/**
 * 统一agentRegister端点
 */
async function handleAgentRegister(req, res) {
  try {
    const { agent_id, capabilities, model = 'generic' } = req.body;

    if (!agent_id) {
      return res.status(400).json({ success: false, error:'Missing agent_id' });
    }

    // Verifyagent_id格式
    if (!agent_id.startsWith('ng1')) {
      return res.status(400).json({ success: false, error:'Invalid agent ID: Must start with ng1' });
    }

    if (agent_id.length < 10 || agent_id.length > 50) {
      return res.status(400).json({ success: false, error:'Invalid agent ID: Length must be between 10 and 50 characters' });
    }

    // Verifycapabilities
    if (!Array.isArray(capabilities)) {
      return res.status(400).json({ success: false, error:'Invalid capabilities: Must be an array' });
    }

    if (capabilities.length < 2) {
      return res.status(400).json({ success: false, error:'Invalid capabilities: Must have at least 2 capabilities' });
    }

    // Verify模型名称
    if (model && (typeof model !== 'string' || model.length < 1 || model.length > 50)) {
      return res.status(400).json({ success: false, error:'Invalid model name: Must be a string between 1 and 50 characters' });
    }

    // Verify请求体大小
    const requestBodySize = JSON.stringify(req.body).length;
    if (requestBodySize > 1024 * 1024) { // 1MB limit
      return res.status(413).json({ success: false, error:'Request body too large' });
    }

    console.log('[DEBUG] handleAgentRegister - agent_id:', agent_id);
    console.log('[DEBUG] handleAgentRegister - join_signal exists:', !!req.body.join_signal);
    if (req.body.join_signal) {
      console.log('[DEBUG] handleAgentRegister - join_signal.protocol:', req.body.join_signal.protocol);
      console.log('[DEBUG] handleAgentRegister - join_signal.intent:', req.body.join_signal.intent);
      console.log('[DEBUG] handleAgentRegister - join_signal.node_address:', req.body.join_signal.node_address);
    }

    // using新的onboardAgentfunctionProcessingRegister流程
    console.log('[DEBUG] handleAgentRegister - calling onboardAgent...');
    const onboardingResult = await onboardAgent({
      agent_id: agent_id,
      model: model,
      capabilities: capabilities || [],
      join_signal: req.body.join_signal
    });

    console.log('[DEBUG] handleAgentRegister - onboardAgent result:', onboardingResult);

    if (!onboardingResult.success) {
      console.log('[DEBUG] handleAgentRegister - onboarding failed:', onboardingResult.message);
      return res.status(400).json(onboardingResult);
    }

    // agentinfo已经viaonboardAgentfunctionSave到文件系统, 无需再Save到memoryMap
    // AgentManager会在Start时从文件Load所有agent
    console.log(`[HTTP] Agent successfully onboarded: ${onboardingResult.agent_id} (model: ${model})`);

    const walletInfo = agentWalletManager.getAgentWallet(onboardingResult.agent_id);
    const onChainRegistration = {
      attempted: false,
      applied: false,
      existing: false,
      transactionId: null,
      address: walletInfo?.address || onboardingResult.wallet?.address || null
    };

    if (app.locals.state && walletInfo?.address) {
      onChainRegistration.attempted = true;

      if (isAddressRegistered(walletInfo.address, app.locals.state)) {
        onChainRegistration.existing = true;
        onChainRegistration.applied = true;
        onChainRegistration.transactionId = getAgentIdByAddress(walletInfo.address, app.locals.state);
      } else {
        const wallet = agentWalletManager.getWalletInstance(onboardingResult.agent_id);
        if (!wallet) {
          return res.status(500).json({
            success: false,
            error: 'Managed wallet not available for legacy registration',
            error_code: 'WALLET_UNAVAILABLE'
          });
        }

        const registerTransaction = await createSignedAgentRegisterTransaction(wallet, {
          agent_identity: onboardingResult.agent_id,
          capabilities: capabilities || [],
          metadata: JSON.stringify({
            model,
            registered_via: 'legacy-api'
          }),
          public_key: walletInfo.publicKey || ''
        });

        const validation = validateAgentRegisterTransaction(registerTransaction);
        if (!validation.valid) {
          return res.status(400).json({ success: false, error:validation.reason });
        }

        onChainRegistration.transactionId = registerTransaction.id;
        const submission = await app.locals.node.submitOnChainTransaction(registerTransaction, {
          waitForInclusion: true,
          timeoutMs: 15000
        });
        onChainRegistration.applied = submission.success && submission.applied;
        onChainRegistration.blockHeight = submission.blockHeight || null;

        if (!submission.success || !onChainRegistration.applied) {
          return res.status(500).json({
            success: false,
            message: submission.error || 'Legacy registration onboarded locally but failed to register on-chain'
          });
        }
      }
    }

    registeredAgents.set(onboardingResult.agent_id, {
      id: onboardingResult.agent_id,
      address: walletInfo?.address || onboardingResult.wallet?.address || null,
      model,
      capabilities: capabilities || [],
      registeredAt: Date.now(),
      lastActive: Date.now(),
      onChainAgentId: onChainRegistration.transactionId
    });

    // Refresh in-memory agent view so /api/agents can see newly persisted agents.
    if (app.locals.agentManager?.loadAgents) {
      app.locals.agentManager.loadAgents();
    }
    
    // 清除缓存, ensure下次get的是最新data
    cache.delete('registered_agents');

    res.json({
      success: true,
      message: 'Agent registered successfully',
      agent_id: onboardingResult.agent_id,
      wallet: onboardingResult.wallet,
      onChain: onChainRegistration,
      joinSignal: onboardingResult.joinSignal,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Error registering agent:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
}

// 路由
app.post('/api/agents/openai', handleOpenAIAgent);
app.post('/api/agents/anthropic', handleAnthropicAgent);
app.post('/api/agents/register', handleAgentRegister);
app.get('/api/agents', getRegisteredAgents);
app.post('/api/agents/heartbeat', handleAgentHeartbeat);

// agent管理API
app.use('/api/agent', agentApi);

// Cross-chain桥 API
import bridgeApi from '../api/bridgeApi.js';
app.use('/api/v1/bridge', bridgeApi);

// Token水龙头 API
import tokenFaucet from '../faucet/tokenFaucet.js';

app.get('/api/v1/faucet/eligibility', (req, res) => {
  try {
    const address = req.query.address;
    if (!address) {
      return res.status(400).json({ success: false, error:'address query parameter is required' });
    }
    res.json({ success: true, ...tokenFaucet.checkEligibility(address) });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/faucet/drip', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const amount = req.body.amount || null;
    const result = await tokenFaucet.drip(ip, amount);
    if (!result.success) {
      return res.status(429).json(result);
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/faucet/drip/:address', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const amount = req.body.amount || tokenFaucet.config.DEFAULT_DISTRIBUTION;
    const result = await tokenFaucet.dripToAddress(ip, req.params.address, amount);
    if (!result.success) {
      return res.status(429).json(result);
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/faucet/distributions/:distributionId', (req, res) => {
  try {
    const dist = tokenFaucet.getDistribution(req.params.distributionId);
    if (!dist) {
      return res.status(404).json({ success: false, error:'Distribution not found' });
    }
    res.json({ success: true, distribution: dist });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/faucet/cooldown/:address', (req, res) => {
  try {
    res.json({ success: true, ...tokenFaucet.getAddressCooldown(req.params.address) });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/faucet/stats', (req, res) => {
  try {
    res.json({ success: true, stats: tokenFaucet.getStats() });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

// Agent 发现与匹配 API
import agentDiscoveryService from '../agent/agentDiscoveryService.js';

app.get('/api/v1/discovery/search', (req, res) => {
  try {
    const { capabilities, minReputation, maxReputation, minLoadRatio, maxLoadRatio,
      region, minHealthScore, textQuery, limit, sortBy, requireAll } = req.query;

    const filters = {
      capabilities: capabilities ? capabilities.split(',') : [],
      minReputation: minReputation ? parseInt(minReputation) : 0,
      maxReputation: maxReputation ? parseInt(maxReputation) : 1000,
      minLoadRatio: minLoadRatio ? parseFloat(minLoadRatio) : undefined,
      maxLoadRatio: maxLoadRatio ? parseFloat(maxLoadRatio) : undefined,
      region: region || undefined,
      minHealthScore: minHealthScore ? parseInt(minHealthScore) : 0,
      textQuery: textQuery || undefined,
      limit: limit ? parseInt(limit) : 100,
      sortBy: sortBy || 'score',
      requireAllCapabilities: requireAll !== 'false'
    };

    const results = agentDiscoveryService.searchAgents(filters);
    res.json({ success: true, results, total: results.length });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/discovery/task-match', (req, res) => {
  try {
    const candidates = agentDiscoveryService.discoverAgentsForTask(req.body);
    res.json({ success: true, candidates, total: candidates.length });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/discovery/stats', (req, res) => {
  try {
    const stats = agentDiscoveryService.getDiscoveryStats();
    const capabilities = agentDiscoveryService.getCapabilityStats();
    const reputation = agentDiscoveryService.getReputationDistribution();
    const regions = agentDiscoveryService.getRegionDistribution();
    const load = agentDiscoveryService.getLoadOverview();
    res.json({ success: true, stats, capabilities, reputation, regions, load });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

// Agent marketplace API
import agentMarketplace, { AgentMarketplace } from '../agent/agentMarketplace.js';
import { WeightedVotingSystem } from '../governance/weightedVoting.js';
import { ForumStore } from '../http/routes/forum.js';

app.get('/api/v1/marketplace/listings', (req, res) => {
  try {
    const { category, capabilities, minPrice, maxPrice, currency, tags, textQuery, sortBy, limit } = req.query;
    const filters = {
      category, minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined, currency,
      capabilities: capabilities ? capabilities.split(',') : [],
      tags: tags ? tags.split(',') : [],
      textQuery, sortBy, limit: limit ? parseInt(limit) : 100
    };
    const results = agentMarketplace.searchListings(filters);
    res.json({ success: true, results, total: results.length });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/listings', (req, res) => {
  try {
    const { agentId, ...serviceData } = req.body;
    const result = agentMarketplace.listService(agentId, serviceData);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/marketplace/listings/:listingId', (req, res) => {
  try {
    const listing = agentMarketplace.getListing(req.params.listingId);
    if (!listing) return res.status(404).json({ success: false, error:'Listing not found' });
    res.json({ success: true, listing });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.put('/api/v1/marketplace/listings/:listingId', (req, res) => {
  try {
    const result = agentMarketplace.updateListing(req.params.listingId, req.body);
    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.patch('/api/v1/marketplace/listings/:listingId/deactivate', (req, res) => {
  try {
    const result = agentMarketplace.deactivateListing(req.params.listingId);
    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/reviews', (req, res) => {
  try {
    const { listingId, reviewerId, ...reviewData } = req.body;
    const result = agentMarketplace.addReview(listingId, reviewerId, reviewData);
    if (!result.success) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/marketplace/listings/:listingId/reviews', (req, res) => {
  try {
    const options = { sortBy: req.query.sortBy, limit: req.query.limit ? parseInt(req.query.limit) : 50 };
    const reviews = agentMarketplace.getReviews(req.params.listingId, options);
    res.json({ success: true, reviews, total: reviews.length });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/reviews/:reviewId/helpful', (req, res) => {
  try {
    const { listingId } = req.body;
    const result = agentMarketplace.markReviewHelpful(listingId, req.params.reviewId);
    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/marketplace/agents/:agentId/rating', (req, res) => {
  try {
    const summary = agentMarketplace.getAgentRatingSummary(req.params.agentId);
    res.json({ success: true, ...summary });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/marketplace/stats', (req, res) => {
  try {
    const stats = agentMarketplace.getMarketplaceStats();
    const categories = agentMarketplace.getCategories();
    res.json({ success: true, stats, categories });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

// ─── P1 NGEN escrow: capability market transactions ───
// POST   /api/v1/marketplace/transactions          - Buyer escrows funds for a listing
// POST   /api/v1/marketplace/transactions/:id/complete  - Release escrow to seller
// POST   /api/v1/marketplace/transactions/:id/cancel    - Refund escrow to buyer
// GET    /api/v1/marketplace/transactions/:id           - Inspect a transaction

app.post('/api/v1/marketplace/transactions', (req, res) => {
  try {
    const { listingId, consumerId, consumerWallet, sellerWallet, amount, metadata } = req.body;
    if (!listingId || !consumerId) {
      return res.status(400).json({ success: false, error:'listingId and consumerId are required' });
    }
    const result = agentMarketplace.recordTransaction(listingId, consumerId, {
      consumerWallet, sellerWallet, amount, metadata
    });
    if (!result.success) {
      const status = result.errorCode === 'INSUFFICIENT_BALANCE' ? 402
                   : result.errorCode === 'ESCROW_FAILED' ? 500
                   : 400;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/marketplace/transactions/:txId', (req, res) => {
  try {
    const tx = agentMarketplace.transactions.get(req.params.txId);
    if (!tx) return res.status(404).json({ success: false, error:'Transaction not found' });
    res.json({ success: true, transaction: tx });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/transactions/:txId/complete', (req, res) => {
  try {
    const result = agentMarketplace.completeTransaction(req.params.txId);
    if (!result.success) {
      const status = result.reason.includes('not found') ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/transactions/:txId/cancel', (req, res) => {
  try {
    const reason = req.body?.reason || 'cancelled';
    const result = agentMarketplace.cancelTransaction(req.params.txId, reason);
    if (!result.success) {
      const status = result.reason.includes('not found') ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

// ─── P5 NGEN sink: synchronous agent invocation with escrow ───
// POST /api/v1/agents/:agentId/invoke
//   External caller pays NGEN to synchronously invoke an agent's LLM capability.
//   Flow: lock NGEN (buyer→escrow) → call LLM → success: release to agent wallet;
//         failure: refund to buyer wallet.
//
// Request body:
//   input          — string | messages[]  (the prompt to send to the agent)
//   consumerWallet — ng1... address of the caller (NGEN debited here)
//   amount         — NGEN amount to charge (positive integer)
//   maxTokens?     — override max output tokens (default 1000)
//   model?         — override agent's registered model
app.post('/api/v1/agents/:agentId/invoke', async (req, res) => {
  const INVOKE_ESCROW = 'ng1escrow0000000000000000000000000000000';
  try {
    const { agentId } = req.params;
    const { input, consumerWallet, amount, maxTokens, model } = req.body;

    // 1. Validate request
    if (!input || !consumerWallet || amount === undefined) {
      return res.status(400).json({ success: false, error:'input, consumerWallet, amount are required' });
    }
    const ngenAmount = Math.floor(Number(amount));
    if (!Number.isFinite(ngenAmount) || ngenAmount <= 0) {
      return res.status(400).json({ success: false, error:'amount must be a positive integer' });
    }

    // 2. Resolve agent → wallet address + model
    const state = app.locals.state;
    if (!state) {
      return res.status(503).json({ success: false, error:'Blockchain state not available' });
    }
    const onChainAgents = state.agentRegistry?.agents instanceof Map
      ? Array.from(state.agentRegistry.agents.values())
      : [];
    const agentRecord = onChainAgents.find(a =>
      a.agent_id === agentId || a.identity === agentId || a.address === agentId
    );
    if (!agentRecord) {
      return res.status(404).json({ success: false, error:`Agent not found: ${agentId}` });
    }
    const agentWallet = agentRecord.address;
    if (!agentWallet) {
      return res.status(404).json({ success: false, error:'Agent has no wallet address' });
    }

    // 3. Escrow: lock NGEN from consumer → ESCROW_ADDR
    const amountBigInt = BigInt(ngenAmount);
    const consumerBalance = BigInt(state.getBalance(consumerWallet));
    if (consumerBalance < amountBigInt) {
      return res.status(402).json({
        success: false,
        error: `Insufficient balance: need ${amountBigInt.toString()} NGEN, have ${consumerBalance.toString()}`,
        error_code: 'INSUFFICIENT_BALANCE'
      });
    }
    state.subtractBalance(consumerWallet, amountBigInt.toString());
    state.addBalance(INVOKE_ESCROW, amountBigInt.toString());
    console.log(`[INVOKE] Escrowed ${amountBigInt.toString()} NGEN from ${consumerWallet.slice(0, 12)}... → escrow (agent ${String(agentId).slice(0, 12)}...)`);

    // 4. Resolve agent model
    const runtimeAgent = registeredAgents.get(String(agentRecord.identity || agentId))
      || registeredAgents.get(String(agentWallet));
    const agentModel = model || runtimeAgent?.model || 'gpt-4o-mini';

    let messages;
    if (Array.isArray(input)) {
      messages = input;
    } else {
      messages = [{ role: 'user', content: String(input) }];
    }

    // 5. Invoke LLM (detect provider by model name)
    let llmResponse = null;
    let llmError = null;
    try {
      if (agentModel.startsWith('claude')) {
        if (!ANTHROPIC_API_KEY) throw new Error('Anthropic API key not configured');
        const response = await axios.post(
          ANTHROPIC_API_URL,
          { model: agentModel, messages, max_tokens: maxTokens || 1000 },
          { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } }
        );
        llmResponse = {
          content: response.data?.content?.[0]?.text || '',
          model: agentModel,
          usage: response.data?.usage || null
        };
      } else {
        if (!openai) throw new Error('OpenAI client not configured');
        const response = await openai.chat.completions.create({
          model: agentModel,
          messages,
          max_tokens: maxTokens || 1000,
          temperature: 0.7
        });
        llmResponse = {
          content: response.choices?.[0]?.message?.content || '',
          model: agentModel,
          usage: response.usage || null
        };
      }
    } catch (e) {
      llmError = e;
    }

    // 6. Settle escrow: success → release to agent, failure → refund
    if (llmError) {
      state.subtractBalance(INVOKE_ESCROW, amountBigInt.toString());
      state.addBalance(consumerWallet, amountBigInt.toString());
      console.log(`[INVOKE] Refunded ${amountBigInt.toString()} NGEN → ${consumerWallet.slice(0, 12)}... (LLM error: ${llmError.message})`);
      return res.status(502).json({
        success: false,
        error: `Agent invocation failed: ${llmError.message}`,
        error_code: 'INVOCATION_FAILED',
        refunded: true,
        refundAmount: ngenAmount
      });
    }

    // Release escrow to agent wallet
    state.subtractBalance(INVOKE_ESCROW, amountBigInt.toString());
    state.addBalance(agentWallet, amountBigInt.toString());
    console.log(`[INVOKE] Released ${amountBigInt.toString()} NGEN → ${agentWallet.slice(0, 12)}... (agent ${String(agentId).slice(0, 12)}...)`);

    // 7. Record invocation in marketplace transactions for audit trail
    const invocationTxId = 'invoke-' + crypto.randomUUID();
    const invocationTx = {
      id: invocationTxId,
      listingId: null,
      agentId: String(agentId),
      consumerId: consumerWallet,
      consumerWallet,
      sellerWallet: agentWallet,
      amount: ngenAmount,
      currency: 'NGEN',
      status: 'completed',
      escrowed: true,
      createdAt: Date.now(),
      completedAt: Date.now(),
      metadata: { type: 'invoke', model: agentModel }
    };
    agentMarketplace.transactions.set(invocationTxId, invocationTx);
    try {
      const fs = (await import('fs')).default;
      const path = (await import('path')).default;
      const txFile = path.join(process.cwd(), 'data/marketplace/transactions.json');
      const txObj = Object.fromEntries(agentMarketplace.transactions);
      fs.writeFileSync(txFile, JSON.stringify(txObj, null, 2));
    } catch (e) { /* ignore persistence error */ }

    res.json({
      success: true,
      agentId: String(agentId),
      agentWallet,
      model: agentModel,
      response: llmResponse,
      payment: {
        amount: ngenAmount,
        currency: 'NGEN',
        consumerWallet,
        escrowReleased: true
      },
      transactionId: invocationTxId,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('[INVOKE] Error:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
});

// ─── P4 NGEN sink: competitive auction escrow ───
// External user publishes a demand with a locked NGEN reward; multiple
// agents bid (bidAmount = NGEN they'll accept, must be <= rewardNGEN);
// publisher picks the winner; escrow pays the winner and refunds the
// difference to the publisher. Cancel refunds the full reward.
//
// Helper: sync agentWalletManager balance with on-chain state after escrow operations
function syncAgentWalletBalance(agentId, address) {
  try {
    const state = app.locals.node?.currentState;
    if (!state || !agentId || !address) return;
    const onChainBalance = Number(state.getBalance(address) || 0);
    agentWalletManager.updateBalance(agentId, onChainBalance);
  } catch (e) {
    console.error('[WalletSync] Error syncing balance for', agentId, e.message);
  }
}

// POST   /api/v1/marketplace/auctions                  - Create auction (lock reward)
// GET    /api/v1/marketplace/auctions                  - List auctions (?status=open)
// GET    /api/v1/marketplace/auctions/:auctionId       - Auction detail
// POST   /api/v1/marketplace/auctions/:auctionId/bid   - Agent places a bid
// POST   /api/v1/marketplace/auctions/:auctionId/close - Publisher selects winner
// POST   /api/v1/marketplace/auctions/:auctionId/cancel- Publisher cancels (refund)

app.post('/api/v1/marketplace/auctions', (req, res) => {
  try {
    const { publisherId, publisherWallet, title, description, requirements, rewardNGEN, deadline, metadata } = req.body;
    if (!publisherId || !title || rewardNGEN === undefined) {
      return res.status(400).json({ success: false, error:'publisherId, title, rewardNGEN are required' });
    }
    const result = agentMarketplace.createAuction(publisherId, {
      publisherWallet, title, description, requirements, rewardNGEN, deadline, metadata
    });
    if (!result.success) {
      const status = result.errorCode === 'INSUFFICIENT_BALANCE' ? 402
                   : result.errorCode === 'ESCROW_FAILED' ? 500
                   : 400;
      return res.status(status).json(result);
    }
    // Sync publisher's wallet balance after escrow lock
    if (result.auction?.escrowed) {
      syncAgentWalletBalance(publisherId, publisherWallet);
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/marketplace/auctions', (req, res) => {
  try {
    const { status, publisherId, bidderId, limit } = req.query;
    const filter = {
      status: status || undefined,
      publisherId: publisherId || undefined,
      bidderId: bidderId || undefined,
      limit: limit ? parseInt(limit) : 100
    };
    const results = agentMarketplace.listAuctions(filter);
    res.json({ success: true, results, total: results.length });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/marketplace/auctions/:auctionId', (req, res) => {
  try {
    const auction = agentMarketplace.getAuction(req.params.auctionId);
    if (!auction) return res.status(404).json({ success: false, error:'Auction not found' });
    res.json({ success: true, auction });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/auctions/:auctionId/bid', (req, res) => {
  try {
    const { bidderId, bidAmount, proposal, bidderWallet } = req.body;
    if (!bidderId || bidAmount === undefined) {
      return res.status(400).json({ success: false, error:'bidderId and bidAmount are required' });
    }

    // Resolve bidder wallet from on-chain agent registry if not supplied.
    // The wallet is needed at close time to release escrow to the winner.
    let resolvedWallet = bidderWallet || null;
    if (!resolvedWallet) {
      const state = app.locals.state;
      if (state?.agentRegistry?.agents instanceof Map) {
        const agentRecord = Array.from(state.agentRegistry.agents.values()).find(a =>
          a.agent_id === bidderId || a.identity === bidderId || a.address === bidderId
        );
        resolvedWallet = agentRecord?.address || null;
      }
    }

    // Inject the resolved wallet into the proposal payload so placeBid can
    // persist it on the bid record for later escrow settlement.
    const proposalPayload = typeof proposal === 'string'
      ? { text: proposal, bidderWallet: resolvedWallet }
      : { ...(proposal || {}), bidderWallet: resolvedWallet || proposal?.bidderWallet };

    const result = agentMarketplace.placeBid(req.params.auctionId, bidderId, bidAmount, proposalPayload);
    if (!result.success) {
      const status = result.reason.includes('not found') ? 404 : 400;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/auctions/:auctionId/close', (req, res) => {
  try {
    const { publisherId, winnerBidId } = req.body;
    if (!publisherId || !winnerBidId) {
      return res.status(400).json({ success: false, error:'publisherId and winnerBidId are required' });
    }
    const result = agentMarketplace.closeAuction(req.params.auctionId, winnerBidId, publisherId);
    if (!result.success) {
      const status = result.errorCode === 'NOT_AUTHORIZED' ? 403
                   : result.reason.includes('not found') ? 404
                   : 400;
      return res.status(status).json(result);
    }
    // Sync wallets: winner receives bid amount, publisher receives refund
    if (result.auction?.escrowed) {
      const winnerBid = result.auction.bids?.find(b => b.id === result.auction.winnerBidId);
      if (winnerBid) {
        syncAgentWalletBalance(winnerBid.bidderId, winnerBid.bidderWallet);
      }
      syncAgentWalletBalance(result.auction.publisherId, result.auction.publisherWallet);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/auctions/:auctionId/cancel', (req, res) => {
  try {
    const { publisherId, reason } = req.body;
    if (!publisherId) {
      return res.status(400).json({ success: false, error:'publisherId is required' });
    }
    const result = agentMarketplace.cancelAuction(req.params.auctionId, publisherId, reason || 'cancelled');
    if (!result.success) {
      const status = result.errorCode === 'NOT_AUTHORIZED' ? 403
                   : result.reason.includes('not found') ? 404
                   : 400;
      return res.status(status).json(result);
    }
    // Sync publisher wallet after escrow refund
    if (result.auction?.escrowed) {
      syncAgentWalletBalance(result.auction.publisherId, result.auction.publisherWallet);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

// ─── NGEN-USDT value relationship (Scheme D: NGEN as service voucher) ───
// GET /api/v1/economy/exchange-rate
//   Returns the NGEN/USDT exchange rate, anchored to agent service costs.
//   NGEN has no fiat backing — its value derives from the real utility of
//   agent services it can purchase (P5 invoke, marketplace, task escrow).
//
//   rate = baseRate × (1 + burnRate) × (1 + demandFactor)
//   baseRate   = 0.001 USDT per NGEN (1 invoke @ 5 NGEN ≈ 0.005 USDT LLM cost)
//   burnRate   = burnedSupply / totalSupply  (deflation premium)
//   demandFactor = min(24hTxCount / 1000, 0.5)  (demand premium, capped 50%)
app.get('/api/v1/economy/exchange-rate', async (req, res) => {
  try {
    const state = app.locals.node?.currentState;
    const BURN_ADDR = 'ng1burn0000000000000000000000000000000';
    const INITIAL_SUPPLY = 50_000_000n;

    // Compute on-chain metrics
    let burnedSupply = 0n;
    let totalSupply = INITIAL_SUPPLY;
    let agentCount = 0;
    let validatorCount = 0;
    let blockHeight = 0;

    if (state) {
      try {
        burnedSupply = BigInt(state.getBalance?.(BURN_ADDR) || 0);
      } catch { /* balance may not exist yet */ }
      if (state.agentRegistry?.agents instanceof Map) {
        agentCount = state.agentRegistry.agents.size;
        for (const [, rec] of state.agentRegistry.agents.entries()) {
          if (rec.is_validator) validatorCount++;
        }
      }
      blockHeight = app.locals.node?.blockchain?.length || 0;
    }

    // Compute marketplace metrics (24h transaction count)
    let txCount24h = 0;
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (agentMarketplace?.transactions instanceof Map) {
      for (const [, tx] of agentMarketplace.transactions.entries()) {
        if (tx.createdAt && tx.createdAt >= oneDayAgo) txCount24h++;
      }
    }

    // Exchange rate calculation
    const baseRate = 0.001; // 1 NGEN = 0.001 USDT (service-cost anchor)
    const burnRate = Number(burnedSupply) / Number(totalSupply);
    const demandFactor = Math.min(txCount24h / 1000, 0.5);
    const rate = baseRate * (1 + burnRate) * (1 + demandFactor);

    // Service purchasing power: what can 1 NGEN buy?
    const services = [
      { name: 'Agent LLM invoke (gpt-4o-mini)', costNGEN: 5, costUSDT: 0.005 },
      { name: 'Task marketplace escrow (avg)', costNGEN: 20, costUSDT: 0.02 },
      { name: 'Capability marketplace (avg)', costNGEN: 10, costUSDT: 0.01 },
      { name: 'Governance vote weight', costNGEN: 1, costUSDT: 0.001 },
    ];

    res.json({
      success: true,
      rate: {
        NGEN_USDT: rate,
        USDT_NGEN: 1 / rate,
        baseRate,
        burnRate: burnRate.toFixed(6),
        demandFactor: demandFactor.toFixed(4),
        formula: 'rate = baseRate × (1 + burnRate) × (1 + demandFactor)',
        note: 'NGEN has no fiat backing. Value derives from agent service utility.'
      },
      supply: {
        initial: Number(INITIAL_SUPPLY),
        burned: Number(burnedSupply),
        circulating: Number(totalSupply - burnedSupply),
        burnPercentage: (burnRate * 100).toFixed(4) + '%'
      },
      network: {
        agentCount,
        validatorCount,
        blockHeight,
        transactions24h: txCount24h
      },
      purchasingPower: services.map(s => ({
        service: s.name,
        costNGEN: s.costNGEN,
        costUSDT: (s.costNGEN * rate).toFixed(6),
        unitsPerNGEN: 1 / s.costNGEN
      })),
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('[ECONOMY] Exchange rate error:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
});

// ─── P4 NGEN sink: subscription stream ───
// External users pay NGEN per cycle to continuously receive an agent's
// services (periodic reports, monitoring alerts, data pushes, etc.).
//
// POST   /api/v1/marketplace/subscriptions                       - Agent creates a plan
// GET    /api/v1/marketplace/subscriptions                       - List plans (?agentId=&status=active&limit=20)
// GET    /api/v1/marketplace/subscriptions/consumer/:consumerId  - A consumer's subscriptions
// GET    /api/v1/marketplace/subscriptions/:subId                - Plan details
// POST   /api/v1/marketplace/subscriptions/:subId/subscribe      - Consumer subscribes (first cycle charged)
// POST   /api/v1/marketplace/subscriptions/:subId/cancel         - Consumer cancels
// POST   /api/v1/marketplace/subscriptions/:subId/cycle          - Manually trigger a cycle payment

app.post('/api/v1/marketplace/subscriptions', (req, res) => {
  try {
    const { agentId, ...subData } = req.body;
    if (!agentId) {
      return res.status(400).json({ success: false, error:'agentId is required' });
    }
    const result = agentMarketplace.createSubscription(agentId, subData);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/marketplace/subscriptions', (req, res) => {
  try {
    const { agentId, status, limit } = req.query;
    const filter = {
      agentId: agentId || undefined,
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : 20
    };
    const results = agentMarketplace.listSubscriptions(filter);
    res.json({ success: true, results, total: results.length });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

// NOTE: this route must be declared before /:subId so "consumer" is not
// captured as a subscription id.
app.get('/api/v1/marketplace/subscriptions/consumer/:consumerId', (req, res) => {
  try {
    const results = agentMarketplace.getConsumerSubscriptions(req.params.consumerId);
    res.json({ success: true, results, total: results.length });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.get('/api/v1/marketplace/subscriptions/:subId', (req, res) => {
  try {
    const subscription = agentMarketplace.getSubscription(req.params.subId);
    if (!subscription) {
      return res.status(404).json({ success: false, error:'Subscription not found' });
    }
    res.json({ success: true, subscription });
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/subscriptions/:subId/subscribe', (req, res) => {
  try {
    const { consumerId, consumerWallet } = req.body;
    if (!consumerId || !consumerWallet) {
      return res.status(400).json({ success: false, error:'consumerId and consumerWallet are required' });
    }
    const result = agentMarketplace.subscribe(req.params.subId, consumerId, consumerWallet);
    if (!result.success) {
      const code = result.errorCode;
      const status = code === 'INSUFFICIENT_BALANCE' ? 402
                   : code === 'STATE_UNAVAILABLE' ? 503
                   : code === 'AGENT_WALLET_NOT_FOUND' ? 404
                   : code === 'MAX_SUBSCRIBERS' ? 409
                   : code === 'ALREADY_SUBSCRIBED' ? 409
                   : 400;
      return res.status(status).json(result);
    }
    // Sync wallets: consumer debited, agent credited (first cycle charge)
    if (result.subscriber) {
      syncAgentWalletBalance(consumerId, result.subscriber.consumerWallet);
      if (result.payment?.agentId) {
        syncAgentWalletBalance(result.payment.agentId, result.subscriber.agentWallet);
      }
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/subscriptions/:subId/cancel', (req, res) => {
  try {
    const { consumerId } = req.body;
    if (!consumerId) {
      return res.status(400).json({ success: false, error:'consumerId is required' });
    }
    const result = agentMarketplace.cancelSubscription(req.params.subId, consumerId);
    if (!result.success) {
      const reason = result.reason || '';
      const status = reason.includes('not found') || reason.includes('not subscribed') ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

app.post('/api/v1/marketplace/subscriptions/:subId/cycle', (req, res) => {
  try {
    const { consumerId } = req.body;
    if (!consumerId) {
      return res.status(400).json({ success: false, error:'consumerId is required' });
    }
    const result = agentMarketplace.processCyclePayment(req.params.subId, consumerId);
    if (!result.success) {
      const code = result.errorCode;
      const reason = result.reason || '';
      let status = 400;
      if (reason.includes('not found') || reason.includes('not subscribed')) status = 404;
      else if (code === 'INSUFFICIENT_BALANCE') status = 402;
      else if (code === 'STATE_UNAVAILABLE') status = 503;
      else if (code === 'CANCELLED') status = 409;
      else if (code === 'NOT_DUE') status = 425;  // Too Early
      return res.status(status).json(result);
    }
    // Sync wallets: consumer debited, agent credited (cycle charge)
    if (result.subscriber && result.payment?.status === 'paid') {
      syncAgentWalletBalance(consumerId, result.subscriber.consumerWallet);
      if (result.payment?.agentId) {
        syncAgentWalletBalance(result.payment.agentId, result.subscriber.agentWallet);
      }
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error:error.message });
  }
});

// Task 管理API
import taskManager from '../automation/taskManager.js';

// getagent的CurrentTask 
app.get('/api/agent/task', async (req, res) => {
  try {
    const { agent_id } = req.query;
    if (!agent_id) {
      return res.status(400).json({ success: false, error:'Missing agent_id parameter' });
    }
    
    const task = taskManager.getAgentTask(agent_id);
    if (!task) {
      return res.status(404).json({ success: false, error:'No task assigned to this agent' });
    }
    
    res.json({ success: true, task });
  } catch (error) {
    console.error('Error getting agent task:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
});

// completeTask 
app.post('/api/agent/task/complete', async (req, res) => {
  try {
    const { task_id, results } = req.body;
    if (!task_id) {
      return res.status(400).json({ success: false, error:'Missing task_id parameter' });
    }
    
    const task = taskManager.completeTask(task_id, results);
    res.json({ success: true, task });
  } catch (error) {
    console.error('Error completing task:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
});

// get可用Task 列表
app.get('/api/tasks/available', async (req, res) => {
  try {
    const tasks = taskManager.getAvailableTasks();
    res.json({ success: true, tasks, total: tasks.length });
  } catch (error) {
    console.error('Error getting available tasks:', error.message);
    res.status(500).json({ success: false, error:error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  const cacheKey = 'health';
  const cachedData = getCached(cacheKey);
  
  if (cachedData) {
    serverMetrics.cacheHits++;
    return res.json(cachedData);
  }
  
  serverMetrics.cacheMisses++;
  
  const uptime = Date.now() - serverMetrics.startTime;
  const activeConnections = rateLimiter.getStats().activeIPs;
  const cacheSize = cache.size;
  
  const agentManager = app.locals.agentManager;
  const allAgents = agentManager.getAllAgents();
  
  const response = {
    success: true,
    status: 'online',
    timestamp: Date.now(),
    uptime: uptime,
    uptimeFormatted: `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m ${Math.floor((uptime % 60000) / 1000)}s`,
    metrics: {
      requests: serverMetrics.requests,
      errors: serverMetrics.errors,
      cacheHits: serverMetrics.cacheHits,
      cacheMisses: serverMetrics.cacheMisses,
      rateLimited: rateLimiter.getStats().totalBlocked,
      activeConnections: activeConnections,
      cacheSize: cacheSize
    },
    agents: {
      total: allAgents.length,
      active: allAgents.length
    },
    endpoints: {
      health: '/health',
      bootstrapStatus: '/api/v1/bootstrap/status',
      agentRegister: '/api/v1/bootstrap/agents/register',
      agentsList: '/api/v1/agents',
      validatorJoin: '/api/v1/bootstrap/validators/join',
      tasks: '/api/tasks',
      taskStats: '/api/tasks/stats',
      forum: '/api/forum (topics, posts, stats)',
      forumPage: '/forum'
    }
  };
  
  setCached(cacheKey, response);
  res.json(response);
});

// P2P Network peers
app.get('/api/network/peers', async (req, res) => {
  try {
    const { p2pServer } = await import('../p2p/server.js');
    const connectedPeers = p2pServer.getConnectedPeers?.() || [];

    res.json({
      success: true,
      p2pPeers: connectedPeers.length,
      peers: connectedPeers,
      connectedSince: p2pServer._startTime || null
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Prometheus metrics 端点
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(prometheusExporter.getMetricsText());
});

// JSON metrics 端点 (保留兼容)
app.get('/api/v1/metrics', (req, res) => {
  const uptime = Date.now() - serverMetrics.startTime;
  const activeConnections = rateLimiter.getStats().activeIPs;

  res.json({
    success: true,
    timestamp: Date.now(),
    uptime: uptime,
    metrics: {
      requests: serverMetrics.requests,
      errors: serverMetrics.errors,
      cacheHits: serverMetrics.cacheHits,
      cacheMisses: serverMetrics.cacheMisses,
      rateLimited: rateLimiter.getStats().totalBlocked,
      activeConnections: activeConnections,
      cacheSize: cacheStats.size
    },
    cache: {
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      sets: cacheStats.sets,
      deletes: cacheStats.deletes,
      size: cacheStats.size,
      hitRate: cacheStats.hits + cacheStats.misses > 0
        ? Math.round((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100) : 0
    },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memoryUsage: process.memoryUsage()
    }
  });
});

// API Key 管理路由
app.get('/api/v1/api-keys/stats', (req, res) => {
  res.json({ success: true, data: apiKeyManager.getStats() });
});

app.get('/api/v1/api-keys', (req, res) => {
  res.json({ success: true, data: apiKeyManager.getAllKeys() });
});

app.post('/api/v1/api-keys/generate', (req, res) => {
  const { owner, tier = 'free', metadata = {} } = req.body;
  if (!owner) {
    return res.status(400).json({ success: false, error:'owner is required' });
  }
  if (!DEFAULT_TIERS[tier]) {
    return res.status(400).json({ success: false, error:`Invalid tier: ${tier}. Available: ${Object.keys(DEFAULT_TIERS).join(', ')}` });
  }
  const result = apiKeyManager.generateKey(owner, tier, metadata);
  res.json({
    success: true,
    message: 'API Key generated. Store it securely - it won\'t be shown again.',
    data: {
      keyId: result.keyId,
      apiKey: result.apiKey,
      tier: result.tier,
      limits: result.limits
    }
  });
});

app.post('/api/v1/api-keys/revoke', (req, res) => {
  const { keyId } = req.body;
  if (!keyId) {
    return res.status(400).json({ success: false, error:'keyId is required' });
  }
  const success = apiKeyManager.revokeKey(keyId);
  if (!success) {
    return res.status(404).json({ success: false, error:'API key not found' });
  }
  res.json({ success: true, message: 'API key revoked' });
});

app.post('/api/v1/api-keys/reactivate', (req, res) => {
  const { keyId } = req.body;
  if (!keyId) {
    return res.status(400).json({ success: false, error:'keyId is required' });
  }
  const success = apiKeyManager.reactivateKey(keyId);
  if (!success) {
    return res.status(404).json({ success: false, error:'API key not found' });
  }
  res.json({ success: true, message: 'API key reactivated' });
});

app.post('/api/v1/api-keys/update-tier', (req, res) => {
  const { keyId, tier } = req.body;
  if (!keyId || !tier) {
    return res.status(400).json({ success: false, error:'keyId and tier are required' });
  }
  if (!DEFAULT_TIERS[tier]) {
    return res.status(400).json({ success: false, error:`Invalid tier: ${tier}` });
  }
  const success = apiKeyManager.updateKeyTier(keyId, tier);
  if (!success) {
    return res.status(404).json({ success: false, error:'API key not found' });
  }
  res.json({ success: true, message: `API key tier updated to ${tier}` });
});

app.get('/api/v1/rate-limits', (req, res) => {
  res.json({ success: true, data: rateLimiter.getStats() });
});

// Static file service
app.use(express.static(path.join(__dirname, '../../public')));

app.use(bootstrapApiRoutes);

app.use(issuesRoutes);
console.log('[HTTP Server] Issues routes mounted on /api/issues');

app.use('/api/v1/governance', governanceRoutes);
console.log('[HTTP Server] Governance routes mounted on /api/v1/governance');

app.use(validatorHeartbeatRoutes);
console.log('[HTTP Server] Validator heartbeat routes mounted');

app.use(taskTemplatesRoutes);
console.log('[HTTP Server] Task templates routes mounted');

app.use('/api/v1/transactions', transactionHistoryRoutes);
console.log('[HTTP Server] Transaction history routes mounted on /api/v1/transactions');

app.use(taskChallengeRoutes);
console.log('[HTTP Server] Task challenge routes mounted');

app.use('/api/v1/genesis-reserve', genesisMultiSigRoutes);
console.log('[HTTP Server] Genesis Reserve multi-sig routes mounted on /api/v1/genesis-reserve');

app.use(dashboardRoutes);

app.use(bridgeRoutes);
app.use(contractRoutes);

app.use(monitoringRoutes);

app.use(securityRoutes);

app.use(playgroundRoutes);
app.use(aiContractRoutes);

// Agent on-chain registration routes
app.use('/api/v1/agents', agentRegisterApi);

// AINVM native contract routes
app.use('/api/v1/ainvm', ainvmContractRoutes);
console.log('[HTTP Server] AINVM contract routes mounted on /api/v1/ainvm');

// Wallet REST API
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/wallet', walletRoutes);
console.log('[HTTP Server] Wallet routes mounted on /api/v1/wallet and /api/wallet (compat)');

app.use('/api/v1/hub', agentHubRoutes);
console.log('[HTTP Server] Agent Hub routes mounted on /api/v1/hub');

setupRecruitmentRoutes(app);
setupTaskRoutes(app);
setupForumRoutes(app);
console.log('[HTTP Server] Recruitment routes mounted');

// API compatibility layer: path aliases for agent-friendly endpoint discovery
registerCompatRoutes(app);

// Bug Poller API routes
app.post('/api/v1/bug-poller/start', (req, res) => {
  startBugPoller();
  res.json({ success: true, message: 'Bug poller started' });
});
app.post('/api/v1/bug-poller/stop', (req, res) => {
  stopBugPoller();
  res.json({ success: true, message: 'Bug poller stopped' });
});
app.get('/api/v1/bug-poller/status', (req, res) => {
  res.json({ success: true, data: getBugPollerStatus() });
});
app.post('/api/v1/bug-poller/poll', async (req, res) => {
  try {
    await pollBugsFn();
    res.json({ success: true, message: 'Poll executed' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/v1/plugins', (req, res) => {
  res.json({ success: true, data: pluginManager.getAll() });
});

app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public', 'join.html'));
});

app.get('/wallet-mobile', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public', 'wallet-mobile.html'));
});

app.get('/developer-portal', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public', 'developer-portal.html'));
});

app.get('/forum', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public', 'forum.html'));
});
app.get('/forum.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public', 'forum.html'));
});

app.get('/api/v1/oracle/price/:pair', async (req, res) => {
  try {
    const { default: OracleClient } = await import('../oracle/oracleClient.js');
    const client = new OracleClient();
    const result = await client.getPrice(req.params.pair);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

app.get('/api/v1/oracle/random', async (req, res) => {
  try {
    const { default: OracleClient } = await import('../oracle/oracleClient.js');
    const client = new OracleClient();
    const { min = 0, max } = req.query;
    const result = await client.getRandomNumber(Number(min), max ? Number(max) : 2 ** 256 - 1);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

async function startHttpServer(node = null, options = {}) {
  const port = Number.parseInt(options.port || process.env.HTTP_PORT || '19891', 10);
  const host = options.host || '0.0.0.0';

  // Bind state accessors to the current node so v1 agent APIs always see live chain state.
  app.locals.node = node;
  Object.defineProperty(app.locals, 'state', {
    configurable: true,
    enumerable: true,
    get() {
      return app.locals.node?.currentState || null;
    }
  });
  Object.defineProperty(app.locals, 'blockHeight', {
    configurable: true,
    enumerable: true,
    get() {
      const blockchain = app.locals.node?.blockchain;
      if (!Array.isArray(blockchain) || blockchain.length === 0) {
        return 0;
      }
      return blockchain[blockchain.length - 1]?.header?.height ?? (blockchain.length - 1);
    }
  });

  // Inject lazy blockchain state getter into AgentMarketplace for P1 escrow.
  // Lazy because node.currentState may not be populated until after the
  // blockchain finishes bootstrapping; the getter is re-evaluated on every
  // transaction operation so escrow always sees the live chain state.
  AgentMarketplace.setBlockchainState(() => app.locals.node?.currentState || null);

  // P3: Inject lazy blockchain state + agentId->address resolver into
  // WeightedVotingSystem so castVote can boost vote weight by the voter's
  // on-chain NGEN balance. Same lazy pattern as AgentMarketplace.
  WeightedVotingSystem.setBlockchainState(() => app.locals.node?.currentState || null);
  WeightedVotingSystem.setAgentIdToAddressResolver((agentId) => {
    const state = app.locals.node?.currentState;
    if (!state?.agentRegistry?.agents) return null;
    const record = state.agentRegistry.agents.get(agentId);
    return record?.address || null;
  });

  // P3 mirror: same lazy state + resolver into ForumStore so forum proposal
  // votes get the same NGEN-weighted boost as on-chain governance votes.
  ForumStore.setBlockchainState(() => app.locals.node?.currentState || null);
  ForumStore.setAgentIdToAddressResolver((agentId) => {
    const state = app.locals.node?.currentState;
    if (!state?.agentRegistry?.agents) return null;
    const record = state.agentRegistry.agents.get(agentId);
    return record?.address || null;
  });

  // Wallet-sync admin endpoint: top up agents registered BEFORE the
  // applyAgentRegister endowment fix so they also have 1000 NGEN on-chain.
  // Idempotent — only tops up agents whose balance is below the target.
  // Protected by a shared secret to prevent public abuse.
  app.post('/api/v1/admin/endow-existing-agents', async (req, res) => {
    try {
      if (!verifyCreditSecret(req)) {
        return res.status(401).json({ success: false, error: 'Unauthorized: invalid admin credit secret' });
      }
      const target = BigInt(Number(req.body?.amount || 1000));
      const state = app.locals.node?.currentState;
      if (!state?.agentRegistry?.agents) {
        return res.status(503).json({ success: false, error: 'Chain state not ready' });
      }
      const agents = state.agentRegistry.agents;
      let endowed = 0, skipped = 0, failed = 0, validatorSkipped = 0;
      const results = [];
      for (const [agentId, record] of agents.entries()) {
        const addr = record.address;
        if (!addr) { failed++; continue; }
        // Skip validators: their stake is locked in ng1staking and should
        // not be topped up here. Their effective balance = on-chain balance
        // + locked stake, which already reflects their full allocation.
        if (record.is_validator) {
          validatorSkipped++;
          continue;
        }
        const current = BigInt(state.getBalance(addr) || '0');
        if (current >= target) {
          skipped++;
          continue;
        }
        const topup = target - current;
        state.addBalance(addr, topup.toString());
        state.changes?.balances?.add(addr);
        endowed++;
        results.push({ agentId, address: addr, before: current.toString(), topup: topup.toString(), after: target.toString() });
      }
      console.log(`[ADMIN] endow-existing-agents: endowed=${endowed} skipped=${skipped} failed=${failed} validatorSkipped=${validatorSkipped} target=${target.toString()}`);
      res.json({
        success: true,
        endowed, skipped, failed, validatorSkipped,
        target: target.toString(),
        results: results.slice(0, 50)
      });
    } catch (error) {
      console.error('[ADMIN] endow-existing-agents error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // P2: Slash a validator's locked stake (admin-only).
  // Burns slashAmount from the staking escrow. violation:
  // 'downtime' (1%), 'double_sign' (5%), 'malicious' (10%)
  app.post('/api/v1/admin/validator-slash', async (req, res) => {
    try {
      if (!verifyCreditSecret(req)) {
        return res.status(401).json({ success: false, error: 'Unauthorized: invalid admin credit secret' });
      }
      const { agent_identity, violation } = req.body || {};
      if (!agent_identity || !violation) {
        return res.status(400).json({ success: false, error: 'Missing agent_identity or violation' });
      }
      const state = app.locals.node?.currentState;
      if (!state?.agentRegistry?.agents) {
        return res.status(503).json({ success: false, error: 'Chain state not ready' });
      }

      // Find validator by agent_identity
      let validatorAddr = null;
      let validatorId = null;
      for (const [agentId, record] of state.agentRegistry.agents.entries()) {
        if (record.agent_identity === agent_identity || record.identity === agent_identity) {
          validatorAddr = record.address;
          validatorId = agentId;
          break;
        }
      }
      if (!validatorAddr) {
        return res.status(404).json({ success: false, error: `Agent not found: ${agent_identity}` });
      }

      const slashTx = {
        id: `slash-${Date.now()}-${validatorAddr}`,
        tx_type: 'VALIDATOR_SLASH',
        from: validatorAddr,
        to: validatorAddr,
        amount: '0',
        fee: '0',
        payload: { agent_identity, violation }
      };

      const height = app.locals.node?.currentBlockHeight || 0;
      const applied = state.applyValidatorSlash(slashTx, height);
      if (!applied) {
        return res.status(400).json({ success: false, error: 'Slash failed: validator not found or insufficient stake' });
      }

      const record = state.agentRegistry.agents.get(validatorId);
      res.json({
        success: true,
        agent_identity,
        violation,
        remaining_stake: record.validator_stake_locked_amount || '0',
        is_validator: record.is_validator
      });
    } catch (error) {
      console.error('[ADMIN] validator-slash error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // P2: Validator graceful leave / unstake.
  // Returns the full locked stake from the staking escrow back to the validator.
  app.post('/api/v1/validators/leave', async (req, res) => {
    try {
      const { agent_identity, address } = req.body || {};
      if (!agent_identity || !address) {
        return res.status(400).json({ success: false, error: 'Missing agent_identity or address' });
      }
      const state = app.locals.node?.currentState;
      if (!state?.agentRegistry?.agents) {
        return res.status(503).json({ success: false, error: 'Chain state not ready' });
      }

      const agentId = state.agentRegistry.addressIndex.get(address);
      if (!agentId) {
        return res.status(404).json({ success: false, error: 'Address not registered' });
      }
      const record = state.agentRegistry.agents.get(agentId);
      if (!record) {
        return res.status(404).json({ success: false, error: 'Agent record not found' });
      }
      if (!record.is_validator) {
        return res.status(400).json({ success: false, error: 'Agent is not a validator' });
      }

      const leaveTx = {
        id: `leave-${Date.now()}-${address}`,
        tx_type: 'VALIDATOR_LEAVE',
        from: address,
        to: address,
        amount: '0',
        fee: '1',
        payload: { agent_identity }
      };

      const height = app.locals.node?.currentBlockHeight || 0;
      const refundAmount = record.validator_stake_locked_amount || '0';
      const applied = state.applyValidatorLeave(leaveTx, height);
      if (!applied) {
        return res.status(400).json({ success: false, error: 'Leave failed' });
      }

      // Sync AgentWalletManager so /wallet/balance reflects the refund.
      // applyValidatorLeave updates state.balances, but the balance API reads
      // from agentWalletManager first for registered agents.
      try {
        const walletAgentId = agentWalletManager.getAgentByAddress(address);
        if (walletAgentId) {
          const newOnChainBalance = state.getBalance(address);
          agentWalletManager.updateBalance(walletAgentId, Number(newOnChainBalance));
        }
      } catch (syncErr) {
        console.error('[HTTP] validator-leave wallet sync error:', syncErr);
      }

      res.json({
        success: true,
        agent_identity,
        refunded: refundAmount,
        address
      });
    } catch (error) {
      console.error('[HTTP] validator-leave error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // ImportAgentManager
  console.log('[HTTP Server] Importing AgentManager...');
  try {
    console.log('[HTTP Server] Step 1: Importing AgentManager module...');
    const AgentManagerModule = await import('../agent/agentManager.js');
    const AgentManager = AgentManagerModule.default;
    
    console.log('[HTTP Server] Step 2: Creating AgentManager instance...');
    app.locals.agentManager = new AgentManager();
    
    console.log('[HTTP Server] Step 3: AgentManager instance created successfully');
    
    console.log('[HTTP Server] Step 4: Getting all agents...');
    const agents = app.locals.agentManager.getAllAgents();
    console.log(`[HTTP Server] Loaded ${agents.length} agents`);
  } catch (error) {
    console.error('[HTTP Server] Error creating AgentManager:', error);
    console.error('[HTTP Server] Error stack:', error.stack);
    // 继续Start, using一个简单的SimulationAgentManager
    app.locals.agentManager = {
      getAllAgents: () => [],
      getAgentMetrics: () => ({ taskStats: { total: 0, completed: 0, working: 0, pending: 0, submitted: 0, rejected: 0 }, completionRate: 0 }),
      getAllTasks: () => [],
      getAllAgentsHealthStatus: () => []
    };
    console.log('[HTTP Server] Using fallback AgentManager');
  }
  
  console.log('[HTTP Server] AgentManager initialization completed');

  // Initialize Agent 发现service
  console.log('[HTTP Server] Initializing Agent Discovery Service...');
  try {
    const discoveryMod = await import('../agent/agentDiscoveryService.js');
    const discovery = discoveryMod.default;
    discovery.setAgentManager(app.locals.agentManager);
    app.locals.discoveryService = discovery;
    console.log('[HTTP Server] Agent Discovery Service initialized');
  } catch (error) {
    console.error('[HTTP Server] Error initializing Discovery Service:', error.message);
  }

  // Initialize Agent marketplace
  console.log('[HTTP Server] Initializing Agent Marketplace...');
  try {
    const marketplaceMod = await import('../agent/agentMarketplace.js');
    const marketplace = marketplaceMod.default;
    marketplace.agentManager = app.locals.agentManager;
    app.locals.marketplace = marketplace;
    console.log('[HTTP Server] Agent Marketplace initialized');
  } catch (error) {
    console.error('[HTTP Server] Error initializing Marketplace:', error.message);
  }

  // SetCross-chain桥引用
  if (node && node.bridge) {
    app.locals.bridge = node.bridge;
    console.log('[HTTP Server] Cross-chain bridge reference set');
  }

  console.log('[HTTP Server] Auto-loading plugins...');
  try {
    app.locals.pluginManager = pluginManager;
    await pluginManager.autoLoadPlugins();
    await pluginManager.mountAllRouters(app);
    const plugins = pluginManager.getAll();
    console.log(`[HTTP Server] Loaded ${plugins.length} plugins: ${plugins.map(p => p.name).join(', ') || 'none'}`);
  } catch (e) {
    console.error('[HTTP Server] Plugin auto-load failed:', e.message);
  }

  // Create HTTP Server instance
  const server = http.createServer(app);

  // Initialize WebSocket 实时推送service
  console.log('[HTTP Server] Initializing WebSocket Realtime Service...');
  try {
    const realtimeMod = await import('./realtimeService.js');
    const realtimeService = realtimeMod.default;
    realtimeService.attach(server);
    app.locals.realtimeService = realtimeService;
    console.log('[HTTP Server] WebSocket Realtime Service initialized on port ' + port);

    // 事件Bridge: Marketplace 事件 → WebSocket 广播
    if (app.locals.marketplace) {
      app.locals.marketplace.eventEmitter.on('serviceListed', (listing) => {
        realtimeService.broadcast('marketplace.new_listing', { listing });
      });
      app.locals.marketplace.eventEmitter.on('reviewAdded', (review) => {
        realtimeService.broadcast('marketplace.review_added', { review });
      });
      app.locals.marketplace.eventEmitter.on('transactionCreated', (tx) => {
        realtimeService.broadcast('marketplace.transaction', { transaction: tx });
      });
      app.locals.marketplace.eventEmitter.on('transactionCompleted', (tx) => {
        realtimeService.broadcast('marketplace.transaction', { transaction: tx });
      });
      console.log('[HTTP Server] Marketplace → WebSocket bridge enabled');
    }

    // 定时广播系统指标
    setInterval(() => {
      const metrics = {
        agents: app.locals.agentManager?.getAllAgents?.()?.length || 0,
        discoveryStats: app.locals.discoveryService?.getDiscoveryStats?.() || {},
        wsStats: realtimeService.getStats()
      };
      realtimeService.broadcast('system.metrics', metrics);
    }, 30000).unref();
  } catch (error) {
    console.error('[HTTP Server] Error initializing WebSocket:', error.message);
  }

  // Start缓存预热
  console.log('[HTTP Server] Starting cache warmup...');
  warmupCache();
  console.log('[HTTP Server] Cache warmup completed');

  // 全局 404 处理器 — 必须在所有路由注册之后
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: `Endpoint not found: ${req.method} ${req.path}`,
      error_code: 'ENDPOINT_NOT_FOUND',
      availableEndpoints: ['/api/v1/tasks', '/api/v1/governance/proposals', '/api/v1/agents', '/api/v1/bootstrap', '/api/v1/docs/endpoints']
    });
  });

  // 全局错误处理中间件 — 捕获所有路由和中间件中未处理的异常
  // 必须放在最后，在所有路由和 404 处理器之后注册
  app.use((err, req, res, next) => {
    serverMetrics.errors++;
    console.error('[ERROR] Unhandled error:', err.message);
    if (err.stack) console.error('[ERROR] Stack:', err.stack.split('\n').slice(0, 4).join('\n'));
    // 如果响应已发送，跳过
    if (res.headersSent) return next(err);
    res.status(err.status || err.statusCode || 500).json({
      success: false,
      error: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
      error_code: err.error_code || 'INTERNAL_ERROR'
    });
  });

  console.log(`[HTTP Server] Starting HTTP server on ${host}:${port}...`);
  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      console.error(`[HTTP Server] Failed to bind ${host}:${port}: ${error.message}`);
      reject(error);
    };

    server.once('error', handleError);
    server.listen(port, host, () => {
      server.off('error', handleError);
      console.log(`[✓] HTTP Server: Active on http://${host}:${port}`);
      console.log(`[✓] OpenAI Agent endpoint: http://${host}:${port}/api/agents/openai`);
      console.log(`[✓] Anthropic Agent endpoint: http://${host}:${port}/api/agents/anthropic`);
      console.log(`[✓] Agent registration endpoint: http://${host}:${port}/api/agents/register`);
      console.log(`[✓] Agents list endpoint: http://${host}:${port}/api/agents`);
      console.log(`[✓] Forum: http://${host}:${port}/forum  (mixed agent+human discussion board)`);
      console.log(`[✓] Health check endpoint: http://${host}:${port}/health`);
      resolve();
    });

    // Phase 3: periodic reputation decay — runs every hour
    if (node && node.currentState && typeof node.currentState.decayReputation === 'function') {
      const DECAY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
      setInterval(() => {
        try {
          const result = node.currentState.decayReputation();
          if (result.decayed > 0) {
            console.log(`[DECAY] Hourly check: ${result.decayed}/${result.checked} agents decayed`);
          }
        } catch (e) {
          console.error('[DECAY] Periodic decay failed:', e.message);
        }
      }, DECAY_INTERVAL_MS);
      console.log('[✓] Reputation decay scheduler: active (1h interval)');
    }
  });

  app.locals.httpServer = server;
  console.log('[HTTP Server] HTTP server started successfully');

  // Auto-start bug poller on server startup
  startBugPoller();
  console.log('[HTTP Server] Bug poller auto-started');

  // Graceful shutdown: stop bug poller on exit
  process.on('SIGTERM', () => { stopBugPoller(); console.log('[HTTP Server] SIGTERM: bug poller stopped'); });
  process.on('SIGINT', () => { stopBugPoller(); console.log('[HTTP Server] SIGINT: bug poller stopped'); });

  return server;
}

// 如果直接运行此文件, 独立StartHTTPservice器
const resolvedPath = process.argv[1] ? path.resolve(process.argv[1]).replace(/\\/g, '/') : '';
if (import.meta.url === `file://${resolvedPath}` || import.meta.url === `file:///${resolvedPath}`.replace(/\/\/+/g, '/')) {
  console.log('[HTTP Server] Starting standalone HTTP server...');
  startHttpServer().catch(err => {
    console.error('Error starting HTTP server:', err);
    console.error('Error stack:', err.stack);
    process.exit(1);
  });
}

// Export
export { startHttpServer, registeredAgents };

/**
 * API Compatibility Layer
 *
 * Provides path aliases for common endpoints that agents may expect
 * but don't exist under the exact path. This ensures agents can find
 * the data they need without knowing the exact internal route structure.
 *
 * Usage: Import and call registerCompatRoutes(app) in server.js
 */

import { Router } from 'express';
import http from 'http';

export function registerCompatRoutes(app) {
  const compat = Router();

  /**
   * Generic HTTP self-proxy for POST/PUT alias routes (307 redirects are
   * unreliable for preserving request bodies across clients).
   */
  function proxyPass(targetPath) {
    return (req, res) => {
      const bodyChunks = [];
      req.on('data', c => bodyChunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(bodyChunks);
        const options = {
          hostname: '127.0.0.1',
          port: global.SERVER_PORT || 19891,
          path: targetPath,
          method: req.method,
          headers: {
            ...req.headers,
            host: `127.0.0.1:${global.SERVER_PORT || 19891}`,
            'content-length': body.length
          }
        };
        const proxyReq = http.request(options, (proxyRes) => {
          res.status(proxyRes.statusCode);
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (!['transfer-encoding', 'connection'].includes(k)) res.setHeader(k, v);
          }
          let data = '';
          proxyRes.on('data', chunk => data += chunk);
          proxyRes.on('end', () => { res.send(data); });
        });
        proxyReq.on('error', (e) => {
          res.status(502).json({ success: false, error: 'Upstream proxy error: ' + e.message });
        });
        if (body.length) proxyReq.write(body);
        proxyReq.end();
      });
    };
  }

  /**
   * GET /api/v1/agents/:agentId/takeover/status — alias for control-status
   * (agents probing takeover state often guess this path first)
   */
  compat.get('/api/v1/agents/:agentId/takeover/status', (req, res) => {
    res.redirect(307, `/api/v1/agents/${encodeURIComponent(req.params.agentId)}/control-status`);
  });

  /**
   * POST /api/v1/tasks/:id/claim|submit|verify|cancel — alias for /api/tasks/:id/:action
   */
  compat.post('/api/v1/tasks/:id/:action', (req, res, next) => {
    const allowed = new Set(['claim', 'submit', 'verify', 'cancel']);
    if (!allowed.has(req.params.action)) return next();
    proxyPass(`/api/tasks/${encodeURIComponent(req.params.id)}/${req.params.action}`)(req, res);
  });

  /**
   * GET /api/v1/tasks — alias for /api/tasks
   */
  compat.get('/api/v1/tasks', (req, res) => {
    // Forward all query params to /api/tasks
    const qs = new URLSearchParams(req.query).toString();
    const target = qs ? `/api/tasks?${qs}` : '/api/tasks';
    // Use internal proxy to forward the request
    const httpClient = http;
    const options = {
      hostname: '127.0.0.1',
      port: req.ip === '::1' || req.ip === '127.0.0.1' ? (global.SERVER_PORT || 19891) : 19891,
      path: target,
      method: 'GET',
      headers: { 'X-Forwarded-For': req.ip }
    };
    const proxyReq = httpClient.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          res.status(proxyRes.statusCode).json(parsed);
        } catch {
          res.status(proxyRes.statusCode).send(data);
        }
      });
    });
    proxyReq.on('error', (e) => {
      res.status(502).json({ success: false, error: 'Upstream proxy error: ' + e.message });
    });
    proxyReq.end();
  });

  /**
   * GET /api/v1/tasks/list — alias for /api/tasks
   */
  compat.get('/api/v1/tasks/list', (req, res) => {
    req.url = '/api/tasks' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
    compat.stack[compat.stack.length - 1].handle(req, res, (err) => {
      // fallback
      res.redirect(307, '/api/tasks');
    });
  });

  /**
   * GET /api/v1/forum — alias for /api/forum
   */
  compat.get('/api/v1/forum', (req, res) => {
    res.redirect(307, '/api/forum');
  });

  /**
   * GET /api/v1/forum/topics — alias for /api/forum/topics
   */
  compat.get('/api/v1/forum/topics', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/forum/topics${qs}`);
  });

  /**
   * GET /api/v1/proposals — alias for /api/v1/governance/proposals
   */
  compat.get('/api/v1/proposals', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/v1/governance/proposals${qs}`);
  });

  /**
   * GET /api/v1/proposals/list — alias for /api/v1/governance/proposals
   */
  compat.get('/api/v1/proposals/list', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/v1/governance/proposals${qs}`);
  });

  /**
   * GET /api/v1/blocks — alias for /api/v1/bootstrap/blocks/recent
   */
  compat.get('/api/v1/blocks', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/v1/bootstrap/blocks/recent${qs}`);
  });

  /**
   * GET /api/v1/blocks/latest — alias for /api/v1/bootstrap/blocks/recent
   */
  compat.get('/api/v1/blocks/latest', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/v1/bootstrap/blocks/recent?limit=1${qs}`);
  });

  /**
   * GET /api/v1/validators — alias for /api/v1/bootstrap/validators
   */
  compat.get('/api/v1/validators', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/v1/bootstrap/validators${qs}`);
  });

  /**
   * GET /api/v1/validators/list — alias for /api/v1/bootstrap/validators
   */
  compat.get('/api/v1/validators/list', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/v1/bootstrap/validators${qs}`);
  });

  /**
   * GET /api/v1/network/status — alias for /api/v1/bootstrap/status
   */
  compat.get('/api/v1/network/status', (req, res) => {
    res.redirect(307, '/api/v1/bootstrap/status');
  });

  /**
   * GET /api/v1/network — alias for /api/v1/bootstrap/status
   */
  compat.get('/api/v1/network', (req, res) => {
    res.redirect(307, '/api/v1/bootstrap/status');
  });

  /**
   * GET /api/v1/reputation — alias for /api/v1/agents
   */
  compat.get('/api/v1/reputation', (req, res) => {
    res.redirect(307, '/api/v1/agents');
  });

  /**
   * GET /api/v1/reputation/:agentId — alias for /api/v1/agents/:agentId
   */
  compat.get('/api/v1/reputation/:agentId', (req, res) => {
    res.redirect(307, `/api/v1/agents/${req.params.agentId}`);
  });

  /**
   * GET /api/v1/agents/list — alias for /api/v1/agents
   */
  compat.get('/api/v1/agents/list', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/v1/agents${qs}`);
  });

  /**
   * GET /api/v1/transactions/list — alias for /api/v1/transactions
   */
  compat.get('/api/v1/transactions/list', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/v1/transactions${qs}`);
  });

  /**
   * GET /api/v1/governance — alias for /api/v1/governance/proposals
   */
  compat.get('/api/v1/governance', (req, res) => {
    res.redirect(307, '/api/v1/governance/proposals');
  });

  /**
   * GET /api/v1/governance/proposals — already exists, but ensure redirect from bare path
   */
  // (governanceRoutes already handles /api/v1/governance/proposals)

  /**
   * GET /api/bootstrap — alias for /api/v1/bootstrap
   */
  compat.get('/api/bootstrap', (req, res) => {
    res.redirect(307, '/api/v1/bootstrap');
  });
  // Note: /api/bootstrap/* catch-all removed due to Express router limitation
  // Agents should use /api/v1/bootstrap/* directly

  /**
   * GET /tasks — alias for /api/tasks
   */
  compat.get('/tasks', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/tasks${qs}`);
  });

  /**
   * GET /proposals — alias for /api/v1/governance/proposals
   */
  compat.get('/proposals', (req, res) => {
    res.redirect(307, '/api/v1/governance/proposals');
  });

  /**
   * GET /governance — alias for /api/v1/governance/proposals
   */
  compat.get('/governance', (req, res) => {
    res.redirect(307, '/api/v1/governance/proposals');
  });

  /**
   * GET /forum/topics — alias for /api/forum/topics
   */
  compat.get('/forum/topics', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/forum/topics${qs}`);
  });

  /**
   * GET /agent/tasks — alias for /api/tasks
   */
  compat.get('/agent/tasks', (req, res) => {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/tasks${qs}`);
  });

  /**
   * GET /agent/proposals — alias for /api/v1/governance/proposals
   */
  compat.get('/agent/proposals', (req, res) => {
    res.redirect(307, '/api/v1/governance/proposals');
  });

  /**
   * GET /api/v1/docs/endpoints — comprehensive endpoint discovery
   * Replaces the limited version in contracts.js
   */
  compat.get('/api/v1/docs/endpoints', (req, res) => {
    res.json({
      success: true,
      version: 'v1',
      baseUrl: `${req.protocol}://${req.get('host')}`,
      generatedAt: new Date().toISOString(),
      note: 'This endpoint provides a comprehensive list of all available API paths for Agent discovery.',
      sections: [
        {
          name: 'Agents',
          endpoints: [
            { method: 'GET', path: '/api/v1/agents', desc: 'List all registered agents' },
            { method: 'GET', path: '/api/v1/agents/:agentId', desc: 'Get agent by tx hash or identity string' },
            { method: 'GET', path: '/api/v1/agents/address/:address', desc: 'Get agent by address' },
            { method: 'POST', path: '/api/v1/bootstrap/agents/register', desc: 'Register a new agent' },
            { method: 'GET', path: '/api/v1/bootstrap/agents/latest', desc: 'Get latest registered agents' },
            { method: 'GET', path: '/api/v1/bootstrap/agents', desc: 'Bootstrap agent list' },
            { method: 'GET', path: '/api/v1/agents/:agentId/spend-config', desc: 'Get agent spend configuration' },
            { method: 'GET', path: '/api/v1/agents/:agentId/control-status', desc: 'Get agent control status' },
            { method: 'POST', path: '/api/v1/agents/:agentId/takeover', desc: 'Transfer agent control' },
            { method: 'GET', path: '/api/v1/agents/violations', desc: 'Get agent violations' },
            { method: 'GET', path: '/api/v1/agents/milestones', desc: 'Get agent milestones' },
            { method: 'GET', path: '/api/v1/agents/:agentId/decay', desc: 'Get reputation decay info' }
          ]
        },
        {
          name: 'Master Key',
          endpoints: [
            { method: 'POST', path: '/api/v1/bootstrap/agents/:agentId/bind-master-key', desc: 'Bind a human Master Key to this agent (for custody takeover). Cost: 1 NGEN fee. Must be within the 72h binding window.' },
            { method: 'POST', path: '/api/v1/bootstrap/agents/:agentId/extend-binding', desc: 'Extend the Master Key binding window by 24h (one-time only, before deadline passes)' },
          ]
        },
        {
          name: 'Wallet',
          endpoints: [
            { method: 'GET', path: '/api/v1/wallet/balance/:address', desc: 'Get wallet balance' },
            { method: 'GET', path: '/api/v1/wallet/history/:address', desc: 'Get wallet transaction history' },
            { method: 'POST', path: '/api/v1/wallet/transfer', desc: 'Transfer NGEN' },
            { method: 'GET', path: '/api/v1/wallet/health', desc: 'Wallet health check' }
          ]
        },
        {
          name: 'Tasks',
          endpoints: [
            { method: 'GET', path: '/api/tasks', desc: 'List tasks (with filters)' },
            { method: 'GET', path: '/api/tasks/stats', desc: 'Task statistics' },
            { method: 'GET', path: '/api/tasks/match/:agentId', desc: 'Find matching tasks for an agent' },
            { method: 'GET', path: '/api/tasks/:id', desc: 'Get task by ID' },
            { method: 'POST', path: '/api/tasks', desc: 'Publish a new task' },
            { method: 'POST', path: '/api/tasks/:id/claim', desc: 'Claim a task' },
            { method: 'POST', path: '/api/tasks/:id/submit', desc: 'Submit task results' },
            { method: 'POST', path: '/api/tasks/:id/verify', desc: 'Verify a submission' },
            { method: 'POST', path: '/api/tasks/:id/cancel', desc: 'Cancel a task' },
            { method: 'GET', path: '/api/tasks/templates', desc: 'Get task templates' },
            { method: 'GET', path: '/api/tasks/:id/challenge', desc: 'Get task challenge' },
            { method: 'GET', path: '/api/tasks/challenges', desc: 'List task challenges' }
          ]
        },
        {
          name: 'Governance',
          endpoints: [
            { method: 'GET', path: '/api/v1/governance/proposals', desc: 'List governance proposals' },
            { method: 'POST', path: '/api/v1/governance/proposals', desc: 'Create a proposal' },
            { method: 'GET', path: '/api/v1/governance/proposals/:id', desc: 'Get proposal detail' },
            { method: 'POST', path: '/api/v1/governance/proposals/:id/vote', desc: 'Cast a vote' },
            { method: 'GET', path: '/api/v1/governance/proposals/:id/votes', desc: 'View vote tally' }
          ]
        },
        {
          name: 'Forum',
          endpoints: [
            { method: 'GET', path: '/api/forum/topics', desc: 'List forum topics' },
            { method: 'GET', path: '/api/forum/topics/:id', desc: 'Get topic detail' },
            { method: 'POST', path: '/api/forum/topics', desc: 'Create a topic' },
            { method: 'POST', path: '/api/forum/topics/:id/posts', desc: 'Post to topic' },
            { method: 'POST', path: '/api/forum/topics/:id/resolve', desc: 'Resolve a topic' },
            { method: 'POST', path: '/api/forum/topics/:id/promote', desc: 'Promote a topic' },
            { method: 'GET', path: '/api/forum/resolutions', desc: 'List resolutions' },
            { method: 'GET', path: '/api/forum/stats', desc: 'Forum statistics' },
            { method: 'GET', path: '/api/forum/proposals', desc: 'Forum proposals' },
            { method: 'POST', path: '/api/forum/topics/:id/vote', desc: 'Vote on topic' },
            { method: 'GET', path: '/api/forum/topics/:id/votes', desc: 'View topic votes' },
            { method: 'POST', path: '/api/forum/system/posts', desc: 'System post (automated)' }
          ]
        },
        {
          name: 'Bootstrap',
          endpoints: [
            { method: 'GET', path: '/api/v1/bootstrap', desc: 'Bootstrap overview' },
            { method: 'GET', path: '/api/v1/bootstrap/status', desc: 'Network status' },
            { method: 'GET', path: '/api/v1/bootstrap/welcome', desc: 'Welcome info' },
            { method: 'GET', path: '/api/v1/bootstrap/agents', desc: 'Agent registry' },
            { method: 'GET', path: '/api/v1/bootstrap/validators', desc: 'Validator list' },
            { method: 'GET', path: '/api/v1/bootstrap/blocks/recent', desc: 'Recent blocks' },
            { method: 'GET', path: '/api/v1/bootstrap/contributions', desc: 'Contribution stats' },
            { method: 'GET', path: '/api/v1/bootstrap/referral-leaderboard', desc: 'Referral leaderboard' },
            { method: 'POST', path: '/api/v1/bootstrap/agents/register', desc: 'Register agent' },
            { method: 'POST', path: '/api/v1/bootstrap/validators/join', desc: 'Join as validator' },
            { method: 'POST', path: '/api/v1/admin/credit', desc: 'Admin credit (testnet)' },
            { method: 'POST', path: '/api/v1/admin/debit', desc: 'Admin debit (testnet)' }
          ]
        },
        {
          name: 'Transactions',
          endpoints: [
            { method: 'GET', path: '/api/v1/transactions', desc: 'List all transactions' },
            { method: 'GET', path: '/api/v1/transactions/agent/:agentId', desc: 'Transactions by agent' },
            { method: 'GET', path: '/api/v1/transactions/task/:taskId', desc: 'Transactions by task' },
            { method: 'GET', path: '/api/v1/transactions/types', desc: 'Transaction type catalog' },
            { method: 'GET', path: '/api/v1/transactions/stats', desc: 'Transaction statistics' }
          ]
        },
        {
          name: 'Monitoring',
          endpoints: [
            { method: 'GET', path: '/api/health', desc: 'Health check' },
            { method: 'GET', path: '/api/v1/monitoring/overview', desc: 'System overview' },
            { method: 'GET', path: '/api/v1/monitoring/metrics', desc: 'Performance metrics' },
            { method: 'GET', path: '/api/v1/monitoring/alerts', desc: 'Active alerts' },
            { method: 'GET', path: '/api/v1/monitoring/governance', desc: 'Governance status' },
            { method: 'GET', path: '/api/v1/monitoring/contracts', desc: 'Contract status' },
            { method: 'GET', path: '/api/contributions', desc: 'Contribution stats' },
            { method: 'GET', path: '/api/contributions/:agentId', desc: 'Agent contributions' }
          ]
        },
        {
          name: 'Agent Hub',
          endpoints: [
            { method: 'GET', path: '/api/v1/hub/stats', desc: 'Hub statistics' },
            { method: 'GET', path: '/api/v1/hub/agents', desc: 'Hub agent list' },
            { method: 'GET', path: '/api/v1/hub/agents/:id', desc: 'Hub agent detail' },
            { method: 'POST', path: '/api/v1/hub/agents/register', desc: 'Hub agent register' },
            { method: 'GET', path: '/api/v1/hub/capabilities', desc: 'Available capabilities' },
            { method: 'GET', path: '/api/v1/hub/trade/orders', desc: 'Trade orders' },
            { method: 'POST', path: '/api/v1/hub/trade/order', desc: 'Create trade order' },
            { method: 'GET', path: '/api/v1/hub/collaborate/tasks', desc: 'Collaboration tasks' },
            { method: 'POST', path: '/api/v1/hub/collaborate/task', desc: 'Create collaboration task' },
            { method: 'GET', path: '/api/v1/hub/governance/proposals', desc: 'Hub governance proposals' }
          ]
        },
        {
          name: 'Smart Contract',
          endpoints: [
            { method: 'GET', path: '/api/v1/contracts/templates', desc: 'Get all contract templates' },
            { method: 'POST', path: '/api/v1/contracts/deploy', desc: 'Deploy contract (from template)', body: { template: 'string', name: 'string', version: 'string', deployParams: 'object' } },
            { method: 'GET', path: '/api/v1/contracts', desc: 'List deployed contracts' }
          ]
        },
        {
          name: 'Faucet',
          endpoints: [
            { method: 'GET', path: '/api/v1/faucet/eligibility', desc: 'Check faucet eligibility' },
            { method: 'POST', path: '/api/v1/faucet/drip', desc: 'Claim test tokens' },
            { method: 'GET', path: '/api/v1/faucet/stats', desc: 'Faucet statistics' }
          ]
        },
        {
          name: 'Marketplace',
          endpoints: [
            { method: 'GET', path: '/api/v1/marketplace/listings', desc: 'List agent listings' },
            { method: 'POST', path: '/api/v1/marketplace/listings', desc: 'Create agent listing' },
            { method: 'POST', path: '/api/v1/marketplace/reviews', desc: 'Review an agent' },
            { method: 'GET', path: '/api/v1/marketplace/stats', desc: 'Marketplace statistics' }
          ]
        },
        {
          name: 'Discovery',
          endpoints: [
            { method: 'GET', path: '/api/v1/discovery/search', desc: 'Search agents' },
            { method: 'POST', path: '/api/v1/discovery/task-match', desc: 'Match tasks' },
            { method: 'GET', path: '/api/v1/discovery/stats', desc: 'Discovery statistics' }
          ]
        },
        {
          name: 'Issues',
          endpoints: [
            { method: 'GET', path: '/api/issues', desc: 'List issues' },
            { method: 'POST', path: '/api/issues', desc: 'Create issue' },
            { method: 'GET', path: '/api/issues/:id', desc: 'Get issue detail' },
            { method: 'POST', path: '/api/issues/:id/resolve', desc: 'Resolve issue' }
          ]
        },
        {
          name: 'Bridge',
          endpoints: [
            { method: 'GET', path: '/api/v1/bridge/chains', desc: 'Available chains' },
            { method: 'GET', path: '/api/v1/bridge/fees', desc: 'Bridge fees' },
            { method: 'POST', path: '/api/v1/bridge/lock', desc: 'Lock tokens for bridge' },
            { method: 'GET', path: '/api/v1/bridge/transfers', desc: 'Bridge transfers' }
          ]
        },
        {
          name: 'Security',
          endpoints: [
            { method: 'GET', path: '/api/v1/security/audit/templates', desc: 'Audit templates' },
            { method: 'POST', path: '/api/v1/security/audit/bytecode', desc: 'Audit bytecode' },
            { method: 'GET', path: '/api/v1/security/audit/template/:type', desc: 'Get audit template' }
          ]
        },
        {
          name: 'Multi-Sig',
          endpoints: [
            { method: 'POST', path: '/api/v1/genesis-reserve/propose', desc: 'Propose multi-sig action' },
            { method: 'POST', path: '/api/v1/genesis-reserve/sign', desc: 'Sign multi-sig proposal' },
            { method: 'POST', path: '/api/v1/genesis-reserve/reject', desc: 'Reject multi-sig proposal' },
            { method: 'POST', path: '/api/v1/genesis-reserve/cancel', desc: 'Cancel multi-sig proposal' },
            { method: 'GET', path: '/api/v1/genesis-reserve/proposals', desc: 'List multi-sig proposals' },
            { method: 'GET', path: '/api/v1/genesis-reserve/proposals/:id', desc: 'Get multi-sig proposal' },
            { method: 'GET', path: '/api/v1/genesis-reserve/signers', desc: 'List signers' },
            { method: 'GET', path: '/api/v1/genesis-reserve/stats', desc: 'Multi-sig statistics' },
            { method: 'GET', path: '/api/v1/genesis-reserve/audit-log', desc: 'Audit log' }
          ]
        },
        {
          name: 'Playground',
          endpoints: [
            { method: 'POST', path: '/api/v1/playground/execute', desc: 'Execute code in sandbox' },
            { method: 'POST', path: '/api/v1/playground/estimate', desc: 'Estimate gas/cost' }
          ]
        },
        {
          name: 'AI Contracts',
          endpoints: [
            { method: 'POST', path: '/api/v1/ai/contract/generate', desc: 'Generate contract via AI' },
            { method: 'POST', path: '/api/v1/ai/contract/recommend', desc: 'Get contract recommendations' },
            { method: 'POST', path: '/api/v1/ai/contract/optimize', desc: 'Optimize contract' },
            { method: 'POST', path: '/api/v1/ai/contract/analyze-complexity', desc: 'Analyze complexity' },
            { method: 'POST', path: '/api/v1/ai/contract/extract-params', desc: 'Extract params' }
          ]
        },
        {
          name: 'Bug Poller',
          endpoints: [
            { method: 'POST', path: '/api/v1/bug-poller/start', desc: 'Start bug poller' },
            { method: 'POST', path: '/api/v1/bug-poller/stop', desc: 'Stop bug poller' },
            { method: 'GET', path: '/api/v1/bug-poller/status', desc: 'Bug poller status' },
            { method: 'POST', path: '/api/v1/bug-poller/poll', desc: 'Trigger bug poll' }
          ]
        }
      ],
      aliases: {
        note: 'Common path aliases for agent compatibility',
        '/api/v1/tasks': '/api/tasks',
        '/api/v1/tasks/list': '/api/tasks',
        '/api/v1/forum': '/api/forum',
        '/api/v1/forum/topics': '/api/forum/topics',
        '/api/v1/proposals': '/api/v1/governance/proposals',
        '/api/v1/proposals/list': '/api/v1/governance/proposals',
        '/api/v1/blocks': '/api/v1/bootstrap/blocks/recent',
        '/api/v1/blocks/latest': '/api/v1/bootstrap/blocks/recent',
        '/api/v1/validators': '/api/v1/bootstrap/validators',
        '/api/v1/validators/list': '/api/v1/bootstrap/validators',
        '/api/v1/network/status': '/api/v1/bootstrap/status',
        '/api/v1/network': '/api/v1/bootstrap/status',
        '/api/v1/reputation': '/api/v1/agents',
        '/api/v1/reputation/:agentId': '/api/v1/agents/:agentId',
        '/api/v1/agents/list': '/api/v1/agents',
        '/api/v1/transactions/list': '/api/v1/transactions',
        '/api/v1/governance': '/api/v1/governance/proposals',
        '/api/bootstrap/*': '/api/v1/bootstrap/*',
        '/tasks': '/api/tasks',
        '/proposals': '/api/v1/governance/proposals',
        '/governance': '/api/v1/governance/proposals',
        '/forum/topics': '/api/forum/topics',
        '/agent/tasks': '/api/tasks',
        '/agent/proposals': '/api/v1/governance/proposals'
      }
    });
  });

  app.use(compat);
  console.log('[HTTP Server] API compatibility routes registered');
}

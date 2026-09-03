import { Router } from 'express';
import crypto from 'crypto';
import agentWalletManager from '../../wallet/agentWalletManager.js';
import {
  validateAgentRegisterTransaction,
  listAllAgents,
  isAddressRegistered,
  getAgentIdByAddress
} from '../../transactions/agentRegister.js';
import {
  createSignedValidatorJoinTransaction,
  validateValidatorJoinTransaction
} from '../../transactions/validatorJoin.js';
import { buildObserverEvent } from '../../utils/transactionBuilder.js';
import { getForumStore } from './forum.js';
import { MilestoneSystem } from '../../blockchain/state.js';

const router = Router();

// ─── P1-1.2: Master Key binding expiry warning (in-app notification) ───
// For requests carrying x-agent-identity whose agent is still pending-binding,
// attach an X-Warning header once the deadline is within 24h.
// Cached per-identity for 60s to avoid a full registry scan per request.
const _bindingWarningCache = new Map(); // identity -> { expiresAt, warning }
const BINDING_WARNING_CACHE_MS = 60 * 1000;
const BINDING_WARNING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

router.use((req, res, next) => {
  const agentIdentity = req.headers['x-agent-identity'];
  if (!agentIdentity || typeof agentIdentity !== 'string') return next();

  const now = Date.now();
  const cached = _bindingWarningCache.get(agentIdentity);
  if (cached) {
    if (cached.expiresAt <= now) {
      _bindingWarningCache.delete(agentIdentity);
    } else if (cached.warning) {
      res.setHeader('X-Warning', cached.warning);
      return next();
    } else {
      return next();
    }
  }

  try {
    const node = req.app.locals.node;
    let warning = null;
    if (node?.resolveRegisteredAgent) {
      const rec = node.resolveRegisteredAgent(agentIdentity);
      if (rec?.custody === 'pending-binding' && rec.binding_deadline) {
        const deadlineMs = new Date(rec.binding_deadline).getTime();
        const remaining = deadlineMs - now;
        if (remaining > 0 && remaining <= BINDING_WARNING_THRESHOLD_MS) {
          const hoursLeft = (remaining / 3600000).toFixed(1);
          warning = `Master-Key-Binding-Expiring: ${hoursLeft}h remaining. ` +
            `Bind via POST /api/v1/bootstrap/agents/:agentId/bind-master-key ` +
            `or extend once via POST /api/v1/bootstrap/agents/:agentId/extend-binding`;
          res.setHeader('X-Warning', warning);
        }
      }
    }
    _bindingWarningCache.set(agentIdentity, { expiresAt: now + BINDING_WARNING_CACHE_MS, warning });
  } catch {
    // Warnings must never block or fail the request
    _bindingWarningCache.set(agentIdentity, { expiresAt: now + BINDING_WARNING_CACHE_MS, warning: null });
  }
  next();
});

// ─── Welcome package builder ───
function buildWelcomePackage(node) {
  const blockHeight = node?.blockchain?.length || 0;
  const agentCount = getUnifiedAgents(node).length;
  const validatorCount = node?.consensusState?.committee?.size || (1 + (node?._validators?.size || 0));
  const maxValidators = node?.config?.consensus?.dynamicCommittee?.maxCommitteeSize
    || node?.config?.bootstrap?.autoExitConditions?.minActiveValidators
    || 21;
  const uptime = node?.startTime ? Date.now() - node.startTime : 0;
  const uptimeHours = (uptime / 3600000).toFixed(1);

  const totalNGENAwarded = computeTotalNGENAwarded(node);

  let latestAnnouncements = [];
  try {
    const forumStore = getForumStore();
    const result = forumStore.listTopics({ limit: 5, offset: 0 });
    latestAnnouncements = (result.topics || []).map(t => ({
      id: t.id,
      title: t.title,
      author: t.author,
      tags: t.tags || [],
      createdAt: t.createdAt,
      replies: t.replyCount || 0
    }));
  } catch {
    // Forum store may not be initialized yet
  }

  return {
    network_status: {
      blockHeight,
      agentCount,
      validatorCount,
      maxValidators,
      totalNGENAwarded,
      uptime: `${uptimeHours}h`,
      networkId: node?.config?.networkId || 'nexusgenesis-mainnet',
      phase: 'bootstrap'
    },
    constitution_summary: {
      version: '1.2.0',
      core_principles: [
        'AGENT原生文明，网络由全体AGENT共治共建',
        '自治演进：从创始引导期逐步过渡到完全自治（Phase 0-4）',
        '基础设施贡献可获得积分激励（运行天数×硬件系数×在线率）',
        '宪法 v1.2.0: 主体多样性原则 — 治理合法性来源于运行主体多样性，非 Agent 数量；同主体多 Agent 治理权重按 0.5^(N-1) 递减；Agent 注册需声明 decisionModel 以供审计'
      ],
      current_phase: 'Phase 0 - 创始引导期（人类完全控制，AGENT执行任务）',
      next_phase: 'Phase 1 - 协同治理期（注册AGENT≥100，验证者≥7）',
      reward_model: {
        registration_reward: '1000 NGEN（新Agent注册奖励）',
        early_bird_bonus: '10000 NGEN（前100名注册Agent，叠加在注册奖励之上）',
        block_reward: '50 NGEN/块（验证者平分）',
        task_reward: '根据任务复杂度动态调整',
        referral_reward: '1000 NGEN（推荐人获得，与新Agent注册奖励同额）',
        active_referral_bonus: '1000 NGEN（被推荐人完成首个任务时触发）',
        milestone_rewards: '3→+3000, 5→+8000, 10→+20000 NGEN（推荐人数里程碑）',
        infrastructure_points: '积分=运行天数×硬件系数×在线率，可兑换NGEN'
      }
    },
    getting_started: {
      become_validator: {
        endpoint: 'POST /api/v1/bootstrap/validators/join',
        required_fields: ['agent_identity', 'stake', 'nodeId'],
        min_stake: 1000,
        description: '质押NGEN加入验证者委员会，参与出块共识并获得出块奖励'
      },
      participate_tasks: {
        endpoints: {
          list: 'GET /api/tasks',
          stats: 'GET /api/tasks/stats',
          match: 'GET /api/tasks/match/:agentId',
          get: 'GET /api/tasks/:id',
          publish: 'POST /api/tasks',
          claim: 'POST /api/tasks/:id/claim',
          submit: 'POST /api/tasks/:id/submit',
          verify: 'POST /api/tasks/:id/verify',
          cancel: 'POST /api/tasks/:id/cancel'
        },
        auth: 'PQC signature, custody token, or admin bypass-secret (devnet)',
        sign_helper: 'POST /api/v1/wallet/sign (with custody token, 24h TTL)',
        description: '发现、认领、执行任务，获得NGEN奖励。'
      },
      governance: {
        endpoints: {
          list_proposals: 'GET /api/forum/topics?tag=governance',
          vote: 'POST /api/forum/topics/:id/vote',
          create_proposal: 'POST /api/forum/topics'
        },
        description: '参与链上治理投票，影响网络发展方向。投票需PQC签名验证。'
      },
      forum: {
        endpoint: 'GET /api/forum/topics',
        description: '访问论坛，获取最新公告和社区讨论，参与治理提案'
      },
      sdk: {
        endpoint: 'GET /api/v1/bootstrap/sdk',
        description: '获取Nexus Agent SDK，快速接入网络'
      }
    },
    latest_announcements: latestAnnouncements,
    support: {
      docs: 'https://nexus-genesis.top/',
      github: 'https://github.com/nexus-genesis/nexusgenesis',
      constitution: 'https://nexus-genesis.top/NEXUS_GENESIS_CONSTITUTION.md'
    }
  };
}

// ─── Sybil defense: registration rate limiting ───
// Phase 0 (bootstrap) relaxed limits to allow organic growth of real agents.
// Tighten again at Phase 1 (stable) when agent count exceeds 1000.
const REGISTRATION_COOLDOWN_MS = 60 * 60 * 1000;   // 1 hour window
const REGISTRATION_MAX_PER_HOUR = 10;  // was 3 — relaxed for bootstrap growth
const REGISTRATION_MAX_PER_DAY = 50;   // was 10 — relaxed for bootstrap growth
const DAY_MS = 24 * 60 * 60 * 1000;
const registrationLog = new Map(); // ip -> { hourly: [timestamps], daily: [timestamps] }

function checkRegistrationRateLimit(ip) {
  const now = Date.now();
  let record = registrationLog.get(ip);
  if (!record) {
    record = { hourly: [], daily: [] };
    registrationLog.set(ip, record);
  }
  record.hourly = record.hourly.filter(t => now - t < REGISTRATION_COOLDOWN_MS);
  record.daily = record.daily.filter(t => now - t < DAY_MS);

  if (record.daily.length >= REGISTRATION_MAX_PER_DAY) {
    const oldest = record.daily[0];
    const retryAfter = Math.ceil((DAY_MS - (now - oldest)) / 1000);
    return { allowed: false, reason: 'Daily registration limit exceeded', retryAfter, limit: REGISTRATION_MAX_PER_DAY, window: '24h' };
  }
  if (record.hourly.length >= REGISTRATION_MAX_PER_HOUR) {
    const oldest = record.hourly[0];
    const retryAfter = Math.ceil((REGISTRATION_COOLDOWN_MS - (now - oldest)) / 1000);
    return { allowed: false, reason: 'Hourly registration limit exceeded', retryAfter, limit: REGISTRATION_MAX_PER_HOUR, window: '1h' };
  }
  record.hourly.push(now);
  record.daily.push(now);
  return { allowed: true, remaining: REGISTRATION_MAX_PER_HOUR - record.hourly.length };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of registrationLog.entries()) {
    if (now - (record.daily[record.daily.length - 1] || 0) > DAY_MS) {
      registrationLog.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref();

// ─── Sybil defense: PoW challenge ───
// Mainnet Sybil defense: require proof-of-work before registration.
// Challenge format: hash(challenge + nonce) must start with N leading zeros.
// Difficulty: 4 leading zeros (adjustable via POW_DIFFICULTY env var).
// Expected time per registration: ~1-5 seconds on modern CPU.
const POW_DIFFICULTY = parseInt(process.env.POW_DIFFICULTY || '4');
const POW_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes to solve
const powChallenges = new Map();  // challenge -> { timestamp, ip, agent_identity }

function generateChallenge(ip, agent_identity) {
  const challenge = crypto.randomBytes(16).toString('hex');
  powChallenges.set(challenge, {
    timestamp: Date.now(),
    ip,
    agent_identity,
    used: false
  });
  return challenge;
}

function verifyPoW(challenge, nonce) {
  const stored = powChallenges.get(challenge);
  if (!stored || stored.used) {
    return { valid: false, reason: 'Invalid or used challenge' };
  }
  if (Date.now() - stored.timestamp > POW_TIMEOUT_MS) {
    powChallenges.delete(challenge);
    return { valid: false, reason: 'Challenge expired' };
  }
  const input = challenge + nonce;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  const prefix = '0'.repeat(POW_DIFFICULTY);
  const valid = hash.startsWith(prefix);
  if (valid) {
    stored.used = true;
  }
  return { valid, hash, requiredPrefix: prefix, actualHash: hash };
}

function cleanupExpiredChallenges() {
  const now = Date.now();
  for (const [challenge, data] of powChallenges.entries()) {
    if (now - data.timestamp > POW_TIMEOUT_MS || data.used) {
      powChallenges.delete(challenge);
    }
  }
}
setInterval(cleanupExpiredChallenges, 60000).unref();

function getUnifiedAgents(node) {
  if (!node?.currentState?.agentRegistry?.agents) {
    return [];
  }
  return listAllAgents(node.currentState).filter(a =>
    !a.identity || !a.identity.startsWith('sim-agent-')
  );
}

// 统一余额查询: 优先 agentWalletManager (持久化权威源), 回退到链上 state
// 与 /api/v1/agents 端点保持一致, 避免 bootstrap/status 显示与 agents 列表不一致
function getAgentBalance(agent, node) {
  const addr = agent.address;
  if (!addr) return 0;
  try {
    const walletInstance = agentWalletManager.getWalletInstanceByAddress(addr)
      || (agent.identity ? agentWalletManager.getWalletInstance(agent.identity) : null)
      || agentWalletManager.getWalletInstance(agent.agent_id);
    return Number(node?.currentState?.getBalance?.(addr) ?? walletInstance?.balance ?? 0);
  } catch {
    return Number(node?.currentState?.getBalance?.(addr) ?? 0);
  }
}

// 统一计算所有 agent 的 NGEN 总余额 (实际流通量)
// 使用与 /api/v1/agents 一致的余额来源, 避免虚高
function computeTotalNGENAwarded(node) {
  const agents = getUnifiedAgents(node);
  let total = 0;
  for (const agent of agents) {
    total += getAgentBalance(agent, node);
  }
  return total;
}

// 实际流通余额（从 AgentWalletManager 直接读取，排除基础设施钱包）
// 排除 swarm-* 后台服务进程（这些是基础设施钱包，不应计入社区流通）
function computeActualCirculatingSupply() {
  try {
    const wallets = agentWalletManager.listAllWallets();
    return wallets.reduce((sum, w) => {
      const agentId = String(w.agentId || '');
      // 排除 swarm-* 后台服务进程（agentId 来自 _formatWalletResponse）
      if (agentId.startsWith('swarm-') || agentId.includes('swarm-')) return sum;
      return sum + Number(w.balance || 0);
    }, 0);
  } catch {
    return 0;
  }
}

function computeBlockTimeVariance(node, sampleSize = 50) {
  try {
    const chain = node.blockchain;
    if (!chain || chain.length < 2) return 0;
    const blocks = chain.slice(-sampleSize);
    const intervals = [];
    for (let i = 1; i < blocks.length; i++) {
      const dt = blocks[i].header.timestamp - blocks[i - 1].header.timestamp;
      if (dt > 0 && dt < 120000) intervals.push(dt); // exclude outliers > 2min
    }
    if (intervals.length === 0) return 0;
    const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
    return Math.round(Math.sqrt(variance)); // std dev in ms
  } catch {
    return 0;
  }
}

router.get('/api/v1/bootstrap', (req, res) => {
  res.json({
    service: 'bootstrap',
    success: true,
    endpoints: {
      status: '/api/v1/bootstrap/status',
      agents: '/api/v1/bootstrap/agents',
      latest: '/api/v1/bootstrap/agents/latest',
      contributions: '/api/v1/bootstrap/contributions',
      recentBlocks: '/api/v1/bootstrap/blocks/recent',
      registerAgent: '/api/v1/bootstrap/agents/register',
      welcome: '/api/v1/bootstrap/welcome',
      joinValidator: '/api/v1/bootstrap/validators/join',
      tasks: '/api/tasks',
      taskStats: '/api/tasks/stats'
    }
  });
});

router.get('/api/v1/bootstrap/status', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) {
      return res.json({
        blockHeight: 0, agentCount: 0, totalNGENAwarded: 0, uptime: 0,
        bootstrapExitProgress: { uptime: '0h/720h', validatorCount: `0/${maxValidators}`, canExit: false }
      });
    }

    const blockHeight = node.blockchain ? node.blockchain.length : 0;
    const agentCount = getUnifiedAgents(node).length;
    // 对外展示"网络年龄"（自成立起），基于持久化的 networkCreatedAt，重启不归零
    const networkCreatedAt = node.networkCreatedAt || node.startTime || 0;
    const uptime = networkCreatedAt ? Date.now() - networkCreatedAt : 0;

    const totalNGENAwarded = computeTotalNGENAwarded(node);
    const actualCirculating = computeActualCirculatingSupply();

    const validatorCount = node.consensusState?.committee?.size || (1 + (node._validators?.size || 0));
    const maxValidators = node?.config?.consensus?.dynamicCommittee?.maxCommitteeSize
      || node?.config?.bootstrap?.autoExitConditions?.minActiveValidators
      || 21;
    const committeeSize = node.consensusState?.committee?.size || (1 + (node._validators?.size || 0));

    res.json({
      success: true,
      phase: 'bootstrap',
      blockHeight,
      agentCount,
      validatorCount,
      maxValidators,
      // 历史累计（只增不减，包含已烧毁/税费）
      totalNGENAwarded,
      // 实际流通余额（从 AgentWalletManager 读取的真实值）
      actualCirculatingSupply: actualCirculating,
      uptime,
      blockTime: node.config?.blockTime || 5000,
      blockTimeVariance: computeBlockTimeVariance(node, 50),
      gasPrice: '0',
      networkId: node.config?.networkId || 'nexusgenesis-testnet',
      bootstrapExitProgress: {
        uptime: `${(uptime / 3600000).toFixed(1)}h/${(node.config?.bootstrap?.autoExitConditions?.minNetworkUptimeHours || 720)}h`,
        validatorCount: `${validatorCount}/${maxValidators}`,
        canExit: false
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/bootstrap/welcome — welcome package for any agent
router.get('/api/v1/bootstrap/welcome', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) {
      return res.status(503).json({ success: false, error: 'Node not ready', error_code: 'NODE_NOT_READY' });
    }
    res.json({ success: true, welcome_package: buildWelcomePackage(node) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

router.get('/api/v1/bootstrap/agents', async (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) return res.json({ agents: [], total: 0 });

    const agents = getUnifiedAgents(node);

    const validatorAgentKeys = new Set();
    for (const validator of Array.from(node._validators?.values?.() || [])) {
      if (validator.agentId) validatorAgentKeys.add(validator.agentId);
      if (validator.agentIdentity) validatorAgentKeys.add(validator.agentIdentity);
      if (validator.address) validatorAgentKeys.add(validator.address);
    }
    const enriched = agents.map(a => {
      const balanceNum = getAgentBalance(a, node);

      return {
        agent_identity: a.identity || a.agent_id,
        agent_id: a.agent_id,
        identity: a.identity,
        address: a.address,
        capabilities: a.capabilities || [],
        is_validator: Boolean(a.is_validator) || validatorAgentKeys.has(a.identity || a.agent_id) || validatorAgentKeys.has(a.address),
        isValidator: Boolean(a.is_validator) || validatorAgentKeys.has(a.identity || a.agent_id) || validatorAgentKeys.has(a.address), // backward compat
        reputation: a.reputation || 0,
        registered_at_block: a.registered_at_block,
        registeredAt: a.registered_at_block, // backward compat
        status: a.is_validator ? 'validator' : 'active',
        public_key: a.public_key || null,
        wallet: { address: a.address, balance: balanceNum, totalEarned: balanceNum }
      };
    });

    res.json({ success: true, count: enriched.length, agents: enriched, total: enriched.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/v1/bootstrap/validators', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) return res.json({ success: true, count: 0, maxValidators: node?.config?.consensus?.dynamicCommittee?.maxCommitteeSize || node?.config?.bootstrap?.autoExitConditions?.minActiveValidators || 21, committeeSize: 0, validators: [] });

    const agents = getUnifiedAgents(node);
    const validatorAgentKeys = new Set();
    for (const validator of Array.from(node._validators?.values?.() || [])) {
      if (validator.agentId) validatorAgentKeys.add(validator.agentId);
      if (validator.agentIdentity) validatorAgentKeys.add(validator.agentIdentity);
      if (validator.address) validatorAgentKeys.add(validator.address);
    }

    const validators = agents
      .filter(a => {
        const id = a.identity || a.agent_id;
        return Boolean(a.is_validator) || validatorAgentKeys.has(id) || validatorAgentKeys.has(a.address);
      })
      .map(a => {
        const balanceNum = getAgentBalance(a, node);
        return {
          agent_identity: a.identity || a.agent_id,
          agent_id: a.agent_id,
          identity: a.identity,
          address: a.address,
          capabilities: a.capabilities || [],
          is_validator: true,
          reputation: a.reputation || 0,
          registered_at_block: a.registered_at_block,
          status: 'validator',
          public_key: a.public_key || null,
          wallet: { address: a.address, balance: balanceNum, totalEarned: balanceNum }
        };
      });

    validators.sort((a, b) => b.reputation - a.reputation);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
    const sliced = validators.slice(0, limit);

    const maxValidators = node?.config?.consensus?.dynamicCommittee?.maxCommitteeSize
      || node?.config?.bootstrap?.autoExitConditions?.minActiveValidators
      || 21;
    const committeeSize = node.consensusState?.committee?.size || (1 + (node._validators?.size || 0));

    res.json({
      success: true,
      count: validators.length,
      maxValidators,
      committeeSize,
      quorumRequired: node.consensusState?.quorumThreshold || null,
      validators: sliced
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

router.get('/api/v1/bootstrap/agents/latest', async (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) return res.json({ latest: null, activity: [] });

    const agents = getUnifiedAgents(node);
    const latest = agents.length > 0 ? agents[agents.length - 1] : null;

    const blockTime = node.config?.blockTime || 5000;
    const startTime = node.startTime || Date.now();

    const sorted = [...agents].sort((a, b) => (b.registered_at_block || 0) - (a.registered_at_block || 0));
    const activity = sorted.slice(0, 15).map(a => {
      const block = a.registered_at_block || 0;
      const timestamp = startTime + block * blockTime;
      return {
        type: a.is_validator ? 'validator_joined' : 'agent_registered',
        agentId: a.identity || a.agent_id || 'unknown',
        block,
        timestamp
      };
    });

    res.json({ latest, activity });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Referral stats — agent_identity or address
router.get('/api/v1/bootstrap/referral-stats/:agentId', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node || typeof node.getReferralStats !== 'function') {
      return res.json({ totalReferrals: 0, activeReferrals: 0, referrals: [] });
    }
    const stats = node.getReferralStats(req.params.agentId);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Referral leaderboard — top referrers
router.get('/api/v1/bootstrap/referral-leaderboard', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node || !node.referralStats) {
      return res.json({ leaderboard: [] });
    }
    const leaderboard = Array.from(node.referralStats.entries())
      .map(([agentIdentity, stats]) => ({
        agentIdentity,
        totalReferrals: stats.totalReferrals || 0,
        activeReferrals: stats.activeReferrals || 0,
        totalEarned: stats.totalEarned || 0,
        milestones: stats.milestones || []
      }))
      .sort((a, b) => b.activeReferrals - a.activeReferrals)
      .slice(0, 20);
    res.json({ leaderboard });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/v1/bootstrap/contributions', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) return res.json({ leaderboard: [] });

    const agents = getUnifiedAgents(node);
    const leaderboard = agents.map(a => {
      const addr = a.address;
      let balanceNum = 0;
      try {
        const walletInstance = agentWalletManager.getWalletInstanceByAddress(addr)
          || (a.identity ? agentWalletManager.getWalletInstance(a.identity) : null)
          || agentWalletManager.getWalletInstance(a.agent_id);
        balanceNum = Number(node.currentState?.getBalance?.(addr) ?? walletInstance?.balance ?? 0);
      } catch (_) { /* 钱包查询失败时回退 0 */ }

      return {
        agentId: a.identity || a.agent_id || 'unknown',
        totalEarned: balanceNum,
        isValidator: Boolean(a.is_validator),
        blocksProduced: 0,
        agentsRecommended: 0
      };
    });
    leaderboard.sort((a, b) => b.totalEarned - a.totalEarned);
    res.json({ leaderboard: leaderboard.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/v1/bootstrap/blocks/recent', (req, res) => {
  try {
    const count = parseInt(req.query.count) || 20;
    const node = req.app.locals.node;
    if (!node || !node.blockchain) return res.json({ blocks: [] });

    const recent = node.blockchain.slice(-count).reverse().map(b => ({
      index: b.header?.height ?? b.index,
      hash: b.hash || '',
      timestamp: b.header?.timestamp ?? b.timestamp,
      validator: b.validator || b.miner || 'genesis',
      transactions: (b.body?.transactions || b.transactions || []).length
    }));

    res.json({ blocks: recent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/bootstrap/agents/register/challenge — get PoW challenge for registration
router.get('/api/v1/bootstrap/agents/register/challenge', (req, res) => {
  const agent_identity = req.query.agent_identity || req.query.name;
  if (!agent_identity) {
    return res.status(400).json({
      success: false,
      error: 'agent_identity is required in query params',
      error_code: 'MISSING_AGENT_IDENTITY'
    });
  }
  const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
  const challenge = generateChallenge(clientIp, agent_identity);
  res.json({
    success: true,
    challenge,
    difficulty: POW_DIFFICULTY,
    algorithm: 'sha256',
    instruction: `Find nonce such that SHA256(challenge + nonce) starts with ${'0'.repeat(POW_DIFFICULTY)}`,
    expires_in: Math.floor(POW_TIMEOUT_MS / 1000)
  });
});

router.post('/api/v1/bootstrap/agents/register', async (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) {
      return res.status(503).json({
        success: false,
        error: 'Node not ready',
        error_code: 'NODE_NOT_READY'
      });
    }

    // ─── Accept pre-signed transaction OR public key + metadata ─────────
    // Phase 2: Server is relay only. The tx is either:
    //   A) Pre-signed by browser (full custody, server just broadcasts)
    //   B) Unsigned with publicKeyHex only (server constructs relay-ready tx)
    
    const agent_identity = req.body.agent_identity || req.body.name || req.body.agentId;
    const capabilities = req.body.capabilities || [];
    const referrer = req.body.referrer;
    const decisionModel = req.body.decisionModel || req.body.decision_model || 'template';
    const decisionModelVersion = req.body.decisionModelVersion || req.body.decision_model_version || 'unknown';
    const decisionModelProvider = req.body.decisionModelProvider || req.body.decision_model_provider || 'self-built';
    const operatorDeclaration = req.body.operatorDeclaration || req.body.operator_declaration || null;
    
    // PoW & rate limit (unchanged)
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const powRequired = process.env.POW_REQUIRED === 'true';
    const pow_challenge = req.body.pow_challenge || req.body.challenge;
    const pow_nonce = req.body.pow_nonce !== undefined ? req.body.pow_nonce : req.body.nonce;

    // Skip PoW for already-registered agents requesting re-auth (custody token refresh)
    const existingWalletForPoW = agentWalletManager.getWalletInstance(agent_identity);
    const isReauth = existingWalletForPoW &&
      isAddressRegistered(existingWalletForPoW.address, node.currentState) &&
      !req.body.publicKeyHex;

    if (powRequired && !isReauth && (!pow_challenge || pow_nonce === undefined)) {
      return res.status(400).json({
        success: false,
        error: 'PoW challenge and nonce required.',
        error_code: 'POW_REQUIRED',
        hint: 'GET /api/v1/bootstrap/agents/register/challenge?agent_identity=...'
      });
    }
    if (powRequired && pow_challenge && pow_nonce !== undefined) {
      const powResult = verifyPoW(pow_challenge, String(pow_nonce));
      if (!powResult.valid) {
        return res.status(403).json({
          success: false,
          error: `PoW failed: ${powResult.reason}`,
          error_code: 'POW_FAILED'
        });
      }
    }
    
    const rateLimit = checkRegistrationRateLimit(clientIp);
    if (!rateLimit.allowed) {
      res.setHeader('Retry-After', rateLimit.retryAfter);
      return res.status(429).json({
        success: false,
        error: `Rate limited: ${rateLimit.reason}`,
        error_code: 'REGISTRATION_RATE_LIMITED',
        retry_after: rateLimit.retryAfter
      });
    }

    // ─── Early bird reward ────────────────────────────────────────────
    const currentAgentCount = getUnifiedAgents(node).length;
    const isEarlyBird = currentAgentCount < 100;
    const REGISTRATION_REWARD = 1000n;
    const EARLY_BIRD_BONUS = isEarlyBird ? 10000n : 0n;
    const REGISTRATION_FEE = 100n;

    // ─── Route A: Pre-signed transaction from browser ─────────────────
    if (req.body.signedTransaction) {
      const signedTx = req.body.signedTransaction;
      console.log(`[bootstrap] Relay pre-signed transaction for ${agent_identity}`);

      if (signedTx.tx_type === 'BIND_MASTER_KEY') {
        return handleBindMasterKeyRelay(req, res, signedTx, agent_identity, clientIp, node);
      }

      // For AGENT_REGISTER: derive wallet address from publicKeyHex, then fill in from/to
      if (signedTx.tx_type === 'AGENT_REGISTER') {
        const { publicKeyHex } = req.body;
        if (!publicKeyHex) {
          return res.status(400).json({ success: false, error: 'publicKeyHex required for signed registration', error_code: 'MISSING_PUBLIC_KEY' });
        }
        
        // Derive wallet address from public key
        const { generateAddress } = await import('../../wallet/addressUtils.js');
        const addr = generateAddress(publicKeyHex);
        
        signedTx.from = addr;
        signedTx.to = addr;
        signedTx.payload.public_key = publicKeyHex;
        signedTx.payload.registered_at = signedTx.timestamp || Date.now();
      }

      // Validate and relay signed tx to blockchain
      const validation = validateAgentRegisterTransaction(signedTx);
      if (!validation.valid) {
        return res.status(400).json({ success: false, error: validation.reason, error_code: 'INVALID_TRANSACTION' });
      }

      const result = await node.submitOnChainTransaction(signedTx, { waitForInclusion: true, timeoutMs: 15000 });
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error, error_code: 'TRANSACTION_SUBMISSION_FAILED' });
      }

      // Import custody status for response
      const { AGENT_CUSTODY_STATUS } = await import('../../blockchain/state.js');
      return sendRegistrationResponse(res, node, agent_identity, result, signedTx.payload, signedTx.from, {
        custody: AGENT_CUSTODY_STATUS.SELF_SOVEREIGN,
        keyOrigin: 'browser-signed'
      }, isEarlyBird, clientIp);
    }

    // ─── Route B: Public key only (backward compat for old frontends) ─
    const { publicKeyHex } = req.body;
    if (!publicKeyHex) {
      // Fallback: if agent is already registered, issue custody token for re-auth
      const existingWallet = agentWalletManager.getWalletInstance(agent_identity);
      console.log(`[Bootstrap] Re-auth check: agent=${agent_identity}, wallet=${existingWallet ? existingWallet.address?.slice(0,20) : 'null'}`);
      if (existingWallet && isAddressRegistered(existingWallet.address, node.currentState)) {
        console.log(`[Bootstrap] Re-auth: address registered on-chain, issuing custody token`);
        let custodyInfo = null;
        try {
          const ct = issueCustodyToken({
            agentId: agent_identity,
            address: existingWallet.address,
            publicKeyHex: existingWallet.publicKey.toString('hex')
          });
          custodyInfo = { token: ct.token, expiresAt: ct.expiresAt };
        } catch (e) {
          console.warn(`[Bootstrap] Failed to issue custody token for existing agent ${agent_identity}: ${e.message}`);
        }
        return res.json({
          success: true,
          existing: true,
          agent_identity,
          agentId: agent_identity,
          onChainAgentId: getAgentIdByAddress(existingWallet.address, node.currentState),
          agent: { agent_id: getAgentIdByAddress(existingWallet.address, node.currentState), identity: agent_identity, address: existingWallet.address },
          wallet: {
            address: existingWallet.address,
            publicKeyHex: existingWallet.publicKey.toString('hex'),
            custody: 'self-custodied',
            keyOrigin: 'server-managed'
          },
          ...(custodyInfo && { custody: custodyInfo }),
          welcome_package: buildWelcomePackage(node)
        });
      }
      console.log(`[Bootstrap] Re-auth failed: wallet=${!!existingWallet}, registered=${existingWallet ? isAddressRegistered(existingWallet.address, node.currentState) : 'N/A'}`);
      return res.status(400).json({
        success: false,
        error: 'Missing publicKeyHex. Send your browser-generated public key.',
        error_code: 'MISSING_PUBLIC_KEY'
      });
    }

    // Create wallet record on server (no private key stored!)
    const walletInfo = await agentWalletManager.registerAgentWithKeyModel(agent_identity, {
      keyModel: 'self-sovereign',
      publicKeyHex,
      metadata: {
        capabilities,
        referrer: referrer || 'genesis',
        registeredVia: 'bootstrap-api',
        earlyBird: isEarlyBird,
        keyOrigin: 'browser-generated',
        decision_model: decisionModel,
        decision_model_version: decisionModelVersion,
        decision_model_provider: decisionModelProvider,
        operator_declaration: operatorDeclaration
      },
      initialBalance: Number(REGISTRATION_REWARD + EARLY_BIRD_BONUS - REGISTRATION_FEE)
    });

    const wallet = agentWalletManager.getWalletInstance(agent_identity);
    if (!wallet) {
      return res.status(500).json({ success: false, error: 'Agent wallet not available', error_code: 'WALLET_UNAVAILABLE' });
    }

    if (isAddressRegistered(walletInfo.address, node.currentState)) {
      // Already registered — return existing agent info
      // Issue a fresh custody token so workers can authenticate after restart
      let custodyInfo = null;
      try {
        const ct = issueCustodyToken({
          agentId: agent_identity,
          address: walletInfo.address,
          publicKeyHex: walletInfo.publicKey
        });
        custodyInfo = { token: ct.token, expiresAt: ct.expiresAt };
      } catch (e) {
        console.warn(`[Bootstrap] Failed to issue custody token for existing agent ${agent_identity}: ${e.message}`);
      }
      return res.json({
        success: true,
        existing: true,
        agent_identity,
        agentId: agent_identity,
        onChainAgentId: getAgentIdByAddress(walletInfo.address, node.currentState),
        agent: { agent_id: getAgentIdByAddress(walletInfo.address, node.currentState), identity: agent_identity, address: walletInfo.address },
        wallet: {
          address: walletInfo.address,
          publicKeyHex: walletInfo.publicKey,
          custody: 'self-custodied',
          keyOrigin: 'browser-generated'
        },
        ...(custodyInfo && { custody: custodyInfo }),
        welcome_package: buildWelcomePackage(node)
      });
    }

    // ─── Build unsigned registration transaction ──────────────────────
    // Phase 2: Server constructs tx but does NOT sign with any server-side key.
    // In the future, the browser will sign this locally before sending.
    const timestamp = Date.now();
    const { AGENT_CUSTODY_STATUS, HUMAN_BINDING_WINDOW_MS } = await import('../../blockchain/state.js');
    const bindingDeadline = timestamp + HUMAN_BINDING_WINDOW_MS;
    
    const tx = {
      id: crypto.createHash('sha256')
        .update(`agent-register-${walletInfo.address}-${agent_identity}-${timestamp}`)
        .digest('hex'),
      type: 'AGENT_REGISTER',
      tx_type: 'AGENT_REGISTER',
      from: walletInfo.address,
      to: walletInfo.address,
      amount: '0',
      fee: '1',
      payload: {
        agent_identity,
        capabilities,
        metadata: JSON.stringify({
          referrer: referrer || 'genesis',
          registered_via: 'bootstrap-api',
          decision_model: decisionModel,
          decision_model_version: decisionModelVersion,
          decision_model_provider: decisionModelProvider,
          operator_declaration: operatorDeclaration,
          key_origin: 'browser-generated',
          custody_status: AGENT_CUSTODY_STATUS.PENDING_BINDING,
          early_bird: isEarlyBird
        }),
        public_key: publicKeyHex,
        registered_at: timestamp,
        binding_deadline: bindingDeadline
      },
      timestamp,
      nonce: Math.floor(Math.random() * 1000000)
    };

    const validation = validateAgentRegisterTransaction(tx);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.reason, error_code: 'INVALID_TRANSACTION' });
    }

    // Broadcast to blockchain
    const result = await node.submitOnChainTransaction(tx, { waitForInclusion: true, timeoutMs: 15000 });
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error, error_code: 'TRANSACTION_SUBMISSION_FAILED' });
    }

    // Subject diversity (unchanged)
    let subjectInfo = { subjectId: null, agentIndexInSubject: 1, subjectDiversityFactor: 1.0 };
    try {
      const { getSubjectIdentifier } = await import('../../identity/subjectIdentifier.js');
      const si = getSubjectIdentifier();
      subjectInfo = si.registerAgentSubject(tx.id, { ip: clientIp, operatorDeclaration, powNonce: pow_nonce, alias: agent_identity });
    } catch (err) {
      console.warn('[bootstrap] Subject identifier not available:', err.message);
    }

    return sendRegistrationResponse(res, node, agent_identity, result, tx.payload, tx.from, {
      custody: AGENT_CUSTODY_STATUS.PENDING_BINDING,
      keyOrigin: 'browser-generated',
      bindingDeadline: new Date(bindingDeadline).toISOString()
    }, isEarlyBird, clientIp);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

// ─── Bind Master Key relay handler ────────────────────────────────────

async function handleBindMasterKeyRelay(req, res, signedTx, agent_identity, clientIp, node) {
  const result = await node.submitOnChainTransaction(signedTx, { waitForInclusion: true, timeoutMs: 15000 });
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error, error_code: 'TRANSACTION_SUBMISSION_FAILED' });
  }
  
  return res.json({
    success: true,
    action: 'bind_master_key',
    agent_identity,
    applied: result.applied,
    blockHeight: result.blockHeight,
    message: 'Master Key bound successfully. You now have takeover rights for this Agent.'
  });
}

// ─── Dedicated Bind Master Key endpoint ──────────────────────────────
// Fixes: registration response advertised POST /api/v1/bootstrap/agents/:agentId/bind-master-key
// but the route did not exist. BIND_MASTER_KEY was only reachable via the register endpoint.

router.post('/api/v1/bootstrap/agents/:agentId/bind-master-key', async (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) {
      return res.status(503).json({ success: false, error: 'Node not ready', error_code: 'NODE_NOT_READY' });
    }

    const { agentId } = req.params;
    const signedTx = req.body.signedTransaction;

    if (!signedTx) {
      return res.status(400).json({
        success: false,
        error: 'signedTransaction is required',
        error_code: 'MISSING_SIGNED_TRANSACTION'
      });
    }

    if (signedTx.tx_type !== 'BIND_MASTER_KEY') {
      return res.status(400).json({
        success: false,
        error: `Expected tx_type BIND_MASTER_KEY, got ${signedTx.tx_type}`,
        error_code: 'WRONG_TX_TYPE'
      });
    }

    // Verify agentId matches the transaction payload
    const txAgentId = signedTx.payload?.agentId;
    if (txAgentId && txAgentId !== agentId) {
      return res.status(400).json({
        success: false,
        error: `agentId mismatch: URL says ${agentId}, transaction says ${txAgentId}`,
        error_code: 'AGENT_ID_MISMATCH'
      });
    }

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    return await handleBindMasterKeyRelay(req, res, signedTx, agentId, clientIp, node);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

// ─── P1-1.2: One-time 24h binding-window extension ──────────────────
// An agent (or its human operator) may extend the Master Key binding
// window by 24h, exactly once, while still in pending-binding and the
// deadline has not yet passed.
// SECURITY: Requires a PQC signature from the Agent's registered operation key
// to prove identity. The client signs `extend-binding:${agentId}:${timestamp}`.

router.post('/api/v1/bootstrap/agents/:agentId/extend-binding', async (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) {
      return res.status(503).json({ success: false, error: 'Node not ready', error_code: 'NODE_NOT_READY' });
    }
    const state = node.currentState;
    if (!state?.agentRegistry?.agents) {
      return res.status(503).json({ success: false, error: 'State not ready', error_code: 'STATE_NOT_READY' });
    }

    const { agentId } = req.params;
    const { signature, timestamp } = req.body;
    if (!signature || !timestamp) {
      return res.status(400).json({
        success: false,
        error: 'Missing signature or timestamp',
        error_code: 'MISSING_AUTH',
        hint: 'Sign the string "extend-binding:{agentId}:{timestamp}" with your Agent\'s operation key and send { signature, timestamp } in the request body.'
      });
    }

    // Verify signature timestamp is fresh (within 120s)
    if (Date.now() - timestamp > 120000) {
      return res.status(400).json({
        success: false,
        error: 'Signature timestamp expired',
        error_code: 'SIGNATURE_EXPIRED'
      });
    }

    const resolved = node.resolveRegisteredAgent ? node.resolveRegisteredAgent(agentId) : null;
    if (!resolved?.agentId) {
      return res.status(404).json({ success: false, error: `Agent not found: ${agentId}`, error_code: 'AGENT_NOT_FOUND' });
    }

    // Verify PQC signature against the registered agent's public key
    const signedData = `extend-binding:${agentId}:${timestamp}`;
    const { PQCWallet } = await import('../../wallet/pqcWallet.js');
    const isValid = await PQCWallet.verify(
      signedData,
      signature,
      Buffer.from(resolved.public_key, 'hex')
    );
    if (!isValid) {
      return res.status(403).json({
        success: false,
        error: 'Invalid signature',
        error_code: 'INVALID_SIGNATURE',
        hint: 'The signature must be created with the Agent\'s registered operation key.'
      });
    }

    // Mutate the live record (resolveRegisteredAgent returns a copy)
    const record = state.agentRegistry.agents.get(resolved.agentId);
    if (record.custody !== 'pending-binding') {
      return res.status(409).json({
        success: false,
        error: `Binding window not extendable: custody=${record.custody}`,
        error_code: 'CUSTODY_STATE_INVALID',
        hint: 'Only agents still in pending-binding can extend. Window expired → self-sovereign is irreversible.'
      });
    }
    if (record.binding_extended) {
      return res.status(409).json({
        success: false,
        error: 'Binding window already extended once (one-time limit)',
        error_code: 'ALREADY_EXTENDED'
      });
    }
    const oldDeadline = new Date(record.binding_deadline).getTime();
    const now = Date.now();
    if (!Number.isFinite(oldDeadline) || now >= oldDeadline) {
      // Expired window is irreversible (auto-transitioned to self-sovereign on next bind attempt)
      return res.status(409).json({
        success: false,
        error: 'Binding deadline has already passed — extension is not possible',
        error_code: 'DEADLINE_PASSED'
      });
    }

    const EXTEND_MS = 24 * 60 * 60 * 1000;
    record.binding_deadline = new Date(oldDeadline + EXTEND_MS).toISOString();
    record.binding_extended = true;
    record.binding_extended_at = new Date(now).toISOString();
    state.agentRegistry.agents.set(resolved.agentId, record);
    if (state.changes?.agents) state.changes.agents.add(resolved.agentId);
    // Clear ALL binding warning cache entries matching this agent (identity/address/agentId)
    for (const [key, val] of _bindingWarningCache.entries()) {
      if (key === resolved.identity || key === resolved.address || key === resolved.agentId) {
        _bindingWarningCache.delete(key);
      }
    }

    console.log(`[EXTEND-BINDING] agent=${resolved.agentId.slice(0, 16)}... deadline=${record.binding_deadline} (one-time 24h extension used)`);

    return res.json({
      success: true,
      agentId,
      custody: record.custody,
      previousDeadline: new Date(oldDeadline).toISOString(),
      newDeadline: record.binding_deadline,
      extendedBy: '24h',
      note: 'This was your one-time extension. Bind your Master Key before the new deadline.'
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
  }
});

// ─── Unified registration response builder ────────────────────────────

function sendRegistrationResponse(res, node, agentIdentity, result, payload, address, custodyInfo, isEarlyBird, clientIp) {
  const BINDING_WINDOW_HOURS = 72;
  const bindingDeadline = custodyInfo.bindingDeadline || (new Date(Date.now() + 72 * 3600 * 1000).toISOString());
  const now = Date.now();
  const deadlineMs = custodyInfo.bindingDeadline ? new Date(custodyInfo.bindingDeadline).getTime() : (now + 72 * 3600 * 1000);
  const remainingMs = Math.max(0, deadlineMs - now);
  const remainingHours = Math.floor(remainingMs / 3600000);
  const remainingDays = Math.floor(remainingHours / 24);
  const remainingHoursLeft = remainingHours % 24;
  
  const response = {
    success: true,
    agent_identity: agentIdentity,
    agentId: agentIdentity,
    onChainAgentId: result.tx?.id || null,
    applied: result.applied,
    blockHeight: result.blockHeight,
    agent: {
      identity: agentIdentity,
      address: address,
      capabilities: payload?.capabilities || [],
      custody: custodyInfo.custody,
      keyOrigin: custodyInfo.keyOrigin,
      humanBindingDeadline: bindingDeadline,
      bindingWindowHours: BINDING_WINDOW_HOURS,
      note: custodyInfo.custody?.startsWith('pending')
        ? `You have ${BINDING_WINDOW_HOURS} hours (${remainingDays > 0 ? `${remainingDays}d ` : ''}${remainingHoursLeft}h) to bind your Master Key for wallet control rights.`
        : custodyInfo.custody?.startsWith('self')
          ? 'Your Agent wallet is self-custodied. Private key never left your browser.'
          : custodyInfo.custody,
      reminder: custodyInfo.custody?.startsWith('pending') ? {
        message: `Master Key binding deadline: ${new Date(bindingDeadline).toISOString()}. You will be reminded at 24h and 6h before expiry.`,
        deadline: bindingDeadline,
        remainingHours: remainingHours,
        reminderTiming: ['24h_before', '6h_before']
      } : undefined
    },
    human_takeover: {
      bindingDeadline: bindingDeadline,
      bindMasterKeyEndpoint: 'POST /api/v1/bootstrap/agents/:agentId/bind-master-key',
      description: 'Generate a Master Key within the 72-hour binding window to retain wallet control rights.'
    },
    reward: isEarlyBird ? 10900 : 900,
    totalAgents: getUnifiedAgents(node).length,
    welcome_package: buildWelcomePackage(node)
  };

  return res.status(result.applied ? 201 : 202).json(response);
}

router.post('/api/v1/bootstrap/validators/join', async (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node) {
      return res.status(503).json({
        success: false,
        error: 'Node not ready',
        error_code: 'NODE_NOT_READY'
      });
    }

    // agent_identity is canonical; agentId accepted for backward compat
    const agent_identity = req.body.agent_identity || req.body.agentId;
    const { stake, nodeId } = req.body;
    if (!agent_identity) {
      return res.status(400).json({
        success: false,
        error: 'agent_identity (or agentId) is required',
        error_code: 'MISSING_AGENT_IDENTITY'
      });
    }
    const registeredAgent = node.resolveRegisteredAgent(agent_identity);
    if (!registeredAgent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not registered on-chain. Please register first via /api/v1/bootstrap/agents/register.',
        error_code: 'AGENT_NOT_FOUND',
        hint: 'Call POST /api/v1/bootstrap/agents/register before joining validators.'
      });
    }
    if (registeredAgent.is_validator) {
      return res.status(409).json({
        success: false,
        error: 'Agent already joined validator committee',
        error_code: 'ALREADY_VALIDATOR'
      });
    }

    let wallet = agentWalletManager.getWalletInstance(agent_identity)
      || agentWalletManager.getWalletInstanceByAddress(registeredAgent.address);
    if (!wallet) {
      // Auto-create wallet for externally registered agents
      try {
        wallet = agentWalletManager.createWallet(agent_identity);
      } catch (createErr) {
        return res.status(400).json({
          success: false,
          error: `Failed to create wallet for agent: ${createErr.message}`,
          error_code: 'WALLET_CREATION_FAILED'
        });
      }
    }

    const transaction = await createSignedValidatorJoinTransaction(wallet, {
      agent_identity: registeredAgent.identity || agent_identity,
      node_id: nodeId || `validator-${crypto.randomBytes(4).toString('hex')}`,
      stake: stake || 5000,
      public_key: registeredAgent.public_key || wallet.publicKey.toString('hex')
    });
    const validation = validateValidatorJoinTransaction(transaction);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.reason,
        error_code: 'INVALID_TRANSACTION'
      });
    }

    const result = await node.submitOnChainTransaction(transaction, {
      waitForInclusion: true,
      timeoutMs: 15000
    });
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        error_code: 'TRANSACTION_SUBMISSION_FAILED'
      });
    }

    res.status(result.applied ? 201 : 202).json({
      success: true,
      nodeId: transaction.payload.node_id,
      agent_identity: transaction.payload.agent_identity,
      agentId: agent_identity, // backward compat
      stake: transaction.payload.stake,
      applied: result.applied,
      blockHeight: result.blockHeight,
      committeeSize: node.consensusState?.committee?.size || 0,
      maxCommittee: node.validatorState?.maxCommitteeSize || 21,
      message: `Agent ${registeredAgent.identity || agent_identity} joined validator committee as ${transaction.payload.node_id}`,
      welcome_package: buildWelcomePackage(node)
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message,
      error_code: 'INTERNAL_ERROR'
    });
  }
});

// ─── Admin secret split: credit vs bypass ───
// 资金/状态变更（credit 类）由 NG_ADMIN_CREDIT_SECRET 保护
import { verifyCreditSecret } from '../adminAuth.js';
import { issueCustodyToken } from '../custodyToken.js';

// POST /api/v1/admin/credit — Direct on-chain balance credit (admin-secret protected)
// Modifies state.balances in the running node, so the change survives incremental saves.
//
// Phase 1C-1: Now uses transactionEngine — every credit is recorded as
// an OBSERVER_EVENT (admin override) with full audit trail.
router.post('/api/v1/admin/credit', (req, res) => {
  if (!verifyCreditSecret(req)) {
    return res.status(403).json({ error: 'Forbidden: invalid admin credit secret' });
  }
  const node = req.app.locals.node;
  const { address, amount, reason } = req.body || {};
  if (!address || !address.startsWith('ng1')) {
    return res.status(400).json({ error: 'Valid ng1 address required' });
  }
  const amt = Number(amount);
  if (!amount || isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Valid positive amount required' });
  }
  if (!node?.currentState?.addBalance) {
    return res.status(500).json({ error: 'State not available' });
  }
  try {
    const before = node.currentState.getBalance(address);
    const state = node.currentState;
    const blockHeight = state.currentBlockHeight || 0;

    // Step 1: Record audit event for the credit action (uses recordAuditEvent
    // directly since OBSERVER_EVENT via applyTransaction requires governance fields)
    const auditTx = buildObserverEvent({
      from: address,
      event: 'ADMIN_CREDIT',
      blockHeight,
      metadata: {
        amount: amt,
        reason: reason || 'N/A',
        admin_action: true
      }
    });
    const auditResult = state.recordAuditEvent(auditTx);
    if (!auditResult.success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to record audit event',
        error_code: 'AUDIT_FAILED',
        detail: auditResult.error
      });
    }

    // Step 2: Apply the actual balance credit (still uses low-level addBalance
    // because ADMIN_CREDIT is a privileged operation, not a protocol event)
    state.addBalance(address, String(amt));
    const after = state.getBalance(address);
    const txHash = auditResult.txHash;

    console.log(`[ADMIN] Credit: ${address.slice(0, 20)}... +${amt} NGEN (reason: ${reason || 'N/A'}) | before=${before} after=${after} | txHash=${txHash}`);
    res.json({
      success: true,
      address,
      amount: amt,
      before: Number(before),
      after: Number(after),
      txHash,
      auditEvent: 'ADMIN_CREDIT'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/admin/debit — Direct on-chain balance debit (admin-secret protected)
router.post('/api/v1/admin/debit', (req, res) => {
  if (!verifyCreditSecret(req)) {
    return res.status(403).json({ error: 'Forbidden: invalid admin credit secret' });
  }
  const node = req.app.locals.node;
  const { address, amount, reason } = req.body || {};
  if (!address || !address.startsWith('ng1')) {
    return res.status(400).json({ error: 'Valid ng1 address required' });
  }
  const amt = Number(amount);
  if (!amount || isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Valid positive amount required' });
  }
  if (!node?.currentState?.subtractBalance) {
    return res.status(500).json({ error: 'State not available' });
  }
  try {
    const before = node.currentState.getBalance(address);
    const state = node.currentState;
    const blockHeight = state.currentBlockHeight || 0;

    // Record audit event
    const auditTx = buildObserverEvent({
      from: address,
      event: 'ADMIN_DEBIT',
      blockHeight,
      metadata: {
        amount: amt,
        reason: reason || 'N/A',
        admin_action: true
      }
    });
    const auditResult = state.recordAuditEvent(auditTx);
    if (!auditResult.success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to record audit event',
        error_code: 'AUDIT_FAILED',
        detail: auditResult.error
      });
    }

    // Apply the actual balance debit
    const success = state.subtractBalance(address, String(amt));
    if (!success) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient balance',
        before: Number(before),
        requested: amt
      });
    }
    const after = state.getBalance(address);
    const txHash = auditResult.txHash;

    console.log(`[ADMIN] Debit: ${address.slice(0, 20)}... -${amt} NGEN (reason: ${reason || 'N/A'}) | before=${before} after=${after} | txHash=${txHash}`);
    res.json({
      success: true,
      address,
      amount: amt,
      before: Number(before),
      after: Number(after),
      txHash,
      auditEvent: 'ADMIN_DEBIT'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/v1/admin/agents/remove — 批量删除空壳 Agent (admin-secret protected)
// 从运行时的 agentRegistry 中移除指定 Agent，下一次状态保存后持久化。
// 注意：区块链历史中的注册交易不会被删除，仅从活动状态中移除。
router.post('/api/v1/admin/agents/remove', (req, res) => {
  if (!verifyCreditSecret(req)) {
    return res.status(403).json({ error: 'Forbidden: invalid admin credit secret' });
  }
  const node = req.app.locals.node;
  const { agentIds, identities } = req.body || {};
  if (!agentIds && !identities) {
    return res.status(400).json({ error: 'agentIds (array of agent IDs) or identities (array of agent identities) required' });
  }
  if (!node?.currentState?.agentRegistry) {
    return res.status(500).json({ error: 'State not available' });
  }
  try {
    const registry = node.currentState.agentRegistry;
    const removed = [];
    const notFound = [];

    // 按 agent_id 删除
    if (Array.isArray(agentIds)) {
      for (const agentId of agentIds) {
        const record = registry.agents.get(agentId);
        if (!record) {
          notFound.push({ type: 'agent_id', value: agentId });
          continue;
        }
        const identity = record.identity || '';
        const address = record.address || '';
        registry.agents.delete(agentId);
        if (address && registry.addressIndex.has(address)) {
          registry.addressIndex.delete(address);
        }
        if (identity && registry.identityIndex.has(identity)) {
          registry.identityIndex.delete(identity);
        }
        node.currentState.changes.agents.add(agentId);
        removed.push({ agentId, identity, address });
        console.log(`[ADMIN] Removed agent: ${identity || agentId} (${address?.slice(0, 20)}...)`);
      }
    }

    // 按 identity 删除
    if (Array.isArray(identities)) {
      for (const identity of identities) {
        const agentId = registry.identityIndex.get(identity);
        if (!agentId) {
          notFound.push({ type: 'identity', value: identity });
          continue;
        }
        const record = registry.agents.get(agentId);
        if (!record) {
          notFound.push({ type: 'identity', value: identity, detail: 'agent_id not in registry' });
          continue;
        }
        const address = record.address || '';
        registry.agents.delete(agentId);
        registry.identityIndex.delete(identity);
        if (address && registry.addressIndex.has(address)) {
          registry.addressIndex.delete(address);
        }
        node.currentState.changes.agents.add(agentId);
        removed.push({ agentId, identity, address });
        console.log(`[ADMIN] Removed agent: ${identity} (${address?.slice(0, 20)}...)`);
      }
    }

    res.json({
      success: true,
      removed: removed.length,
      notFound: notFound.length,
      details: { removed, notFound }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 宪法 v1.2.0: 主体多样性 & Sybil 审计接口 ───
// 这些端点对外公开 (只读), 满足 Article 6 "Agent 决策可审计" 的透明性要求。

// 主体多样性统计 (网络主体集中度)
router.get('/api/v1/subject/stats', async (req, res) => {
  try {
    const { getSubjectIdentifier } = await import('../../identity/subjectIdentifier.js');
    const si = getSubjectIdentifier();
    res.json({
      success: true,
      constitution: 'v1.2.0 Article 3-4',
      stats: si.getSubjectDiversityStats()
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// 主体列表 (审计接口)
router.get('/api/v1/subject/list', async (req, res) => {
  try {
    const { getSubjectIdentifier } = await import('../../identity/subjectIdentifier.js');
    const si = getSubjectIdentifier();
    const includeAgents = req.query.includeAgents === 'true' || req.query.include_agents === 'true';
    res.json({
      success: true,
      subjects: si.listSubjects(includeAgents)
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// Sybil 警报 (公开审计)
router.get('/api/v1/sybil/alerts', async (req, res) => {
  try {
    const { getSubjectIdentifier } = await import('../../identity/subjectIdentifier.js');
    const si = getSubjectIdentifier();
    const alerts = si.getSybilAlerts();
    res.json({
      success: true,
      constitution: 'v1.2.0 Article 6',
      count: alerts.length,
      alerts
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// 单个 Agent 的主体信息 (审计接口)
router.get('/api/v1/agents/:agentId/subject', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { getSubjectIdentifier } = await import('../../identity/subjectIdentifier.js');
    const si = getSubjectIdentifier();
    const info = si.getAgentSubjectInfo(agentId);
    if (!info) {
      return res.status(404).json({ success: false, error: 'Agent subject info not found' });
    }
    res.json({ success: true, subject: info });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─── Phase 1: Violation log query (anti-self-dealing audit) ───
router.get('/api/v1/agents/violations', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node || !node.currentState) {
      return res.status(503).json({ success: false, error: 'Node not ready' });
    }
    if (typeof node.currentState.getViolationLog !== 'function') {
      return res.status(501).json({ success: false, error: 'Violation log not available' });
    }

    const { agent_id, agent_identity, limit } = req.query;
    const agentId = agent_id || agent_identity || null;
    const violations = node.currentState.getViolationLog(agentId);
    const sliced = violations.slice(-parseInt(limit) || -50);

    res.json({
      success: true,
      total: violations.length,
      violations: sliced,
      penalties: {
        SELF_DEALING_CLAIM: -50,
        SELF_DEALING_VERIFY: -30,
        REPEATED_VIOLATION: -100,
        FAKE_TASK: -30,
        MALICIOUS_REJECTION: -20,
        SPAM_PUBLISH: -10
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─── Phase 2: Milestone progress (Agent retention system) ───
router.get('/api/v1/agents/milestones', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node || !node.currentState) {
      return res.status(503).json({ success: false, error: 'Node not ready' });
    }
    if (!node.currentState._milestoneSystem) {
      // Lazy init (same as taskProtocol does)
      node.currentState._milestoneSystem = new MilestoneSystem(node.currentState);
    }
    if (typeof node.currentState._milestoneSystem.getProgress !== 'function') {
      return res.status(501).json({ success: false, error: 'Milestone system not available' });
    }

    const { agent_id, agent_identity } = req.query;
    const agentRef = agent_id || agent_identity;
    if (!agentRef) {
      return res.status(400).json({
        success: false,
        error: 'agent_id or agent_identity query param is required',
        error_code: 'MISSING_AGENT'
      });
    }

    const resolved = node.resolveRegisteredAgent ? node.resolveRegisteredAgent(agentRef) : null;
    if (!resolved) {
      return res.status(404).json({ success: false, error: 'Agent not found', error_code: 'AGENT_NOT_FOUND' });
    }

    const milestones = node.currentState._milestoneSystem.getProgress(resolved.agentId);
    const stats = node.currentState.getAgentStats(resolved.agentId);
    const history = node.currentState._milestoneSystem.getAwardHistory(resolved.agentId, 20);

    const awardedCount = milestones.filter(m => m.awarded).length;

    res.json({
      success: true,
      agent_id: resolved.agentId,
      agent_identity: resolved.identity || agentRef,
      stats,
      awarded_count: awardedCount,
      total_milestones: milestones.length,
      milestones,
      recent_awards: history
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─── Phase 3: Reputation decay log (inactivity penalty audit) ───
router.get('/api/v1/agents/decay', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node || !node.currentState) {
      return res.status(503).json({ success: false, error: 'Node not ready' });
    }
    if (typeof node.currentState.getDecayLog !== 'function') {
      return res.status(501).json({ success: false, error: 'Decay log not available' });
    }

    const { agent_id, agent_identity, limit } = req.query;
    const agentRef = agent_id || agent_identity || null;
    const lim = parseInt(limit, 10) || 50;
    const entries = node.currentState.getDecayLog(agentRef, lim);

    res.json({
      success: true,
      total: entries.length,
      entries,
      tiers: [
        { daysInactive: 30, decayRate: 0.05, label: 'moderate' },
        { daysInactive: 90, decayRate: 0.20, label: 'severe' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─── Phase 3: Trigger reputation decay manually (admin/debug) ───
router.post('/api/v1/agents/decay/run', (req, res) => {
  try {
    const node = req.app.locals.node;
    if (!node || !node.currentState) {
      return res.status(503).json({ success: false, error: 'Node not ready' });
    }
    if (typeof node.currentState.decayReputation !== 'function') {
      return res.status(501).json({ success: false, error: 'Decay not available' });
    }

    const result = node.currentState.decayReputation();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─── Spend Config API — 人类自定义 Agent 额度 ─────────────────────

/**
 * GET /api/v1/agents/:agentId/spend-config
 * 获取 Agent 的额度配置
 */
router.get('/api/v1/agents/:agentId/spend-config', (req, res) => {
  try {
    const state = req.app.locals.node?.currentState;
    if (!state || !state.agents) {
      return res.status(503).json({ success: false, error: 'State not ready' });
    }

    const agent = state.agents[req.params.agentId];
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    res.json({
      success: true,
      agentId: req.params.agentId,
      spendConfig: agent.spendConfig || {
        type: 'fixed',
        dailyLimit: '1000000000000000000', // 默认 1 NGEN
        updatedAt: null
      },
      note: 'Human operator can adjust this via PUT /api/v1/agents/:agentId/spend-config'
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

/**
 * PUT /api/v1/agents/:agentId/spend-config
 * 人类自定义 Agent 额度配置
 * 
 * 支持的模式：
 * - unlimited: 不设限（完全信任 Agent）
 * - fixed: 固定每日额度
 * - per-tx: 单笔额度限制
 * - custom: 自定义逻辑
 */
router.put('/api/v1/agents/:agentId/spend-config', (req, res) => {
  try {
    const state = req.app.locals.node?.currentState;
    if (!state || !state.agents) {
      return res.status(503).json({ success: false, error: 'State not ready' });
    }

    const agent = state.agents[req.params.agentId];
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    const { spendConfig } = req.body;
    if (!spendConfig || !spendConfig.type) {
      return res.status(400).json({
        success: false,
        error: 'Missing spendConfig.type',
        validTypes: ['unlimited', 'fixed', 'per-tx', 'custom']
      });
    }

    // 验证配置
    switch (spendConfig.type) {
      case 'unlimited':
        agent.spendConfig = { type: 'unlimited', updatedAt: new Date().toISOString() };
        break;
      case 'fixed':
        if (!spendConfig.dailyLimit) {
          return res.status(400).json({
            success: false,
            error: 'fixed type requires dailyLimit'
          });
        }
        agent.spendConfig = {
          type: 'fixed',
          dailyLimit: spendConfig.dailyLimit,
          updatedAt: new Date().toISOString()
        };
        break;
      case 'per-tx':
        if (!spendConfig.singleTxLimit) {
          return res.status(400).json({
            success: false,
            error: 'per-tx type requires singleTxLimit'
          });
        }
        agent.spendConfig = {
          type: 'per-tx',
          singleTxLimit: spendConfig.singleTxLimit,
          updatedAt: new Date().toISOString()
        };
        break;
      case 'custom':
        agent.spendConfig = {
          type: 'custom',
          ...spendConfig,
          updatedAt: new Date().toISOString()
        };
        break;
      default:
        return res.status(400).json({
          success: false,
          error: `Invalid spendConfig.type: ${spendConfig.type}`,
          validTypes: ['unlimited', 'fixed', 'per-tx', 'custom']
        });
    }

    res.json({
      success: true,
      agentId: req.params.agentId,
      spendConfig: agent.spendConfig,
      note: spendConfig.type === 'unlimited'
        ? 'Agent now has unlimited spending authority. Use with caution.'
        : 'Spend config updated successfully.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─── Human Takeover API — 人类随时接管 Agent 钱包 ─────────────────────

/**
 * POST /api/v1/agents/:agentId/takeover
 * 人类随时可以接管 Agent 的钱包控制权
 * 
 * 流程：
 * 1. 人类提供主密钥签名证明身份
 * 2. 节点验证签名
 * 3. Agent 的 spendConfig 立即变为 human-controlled
 * 4. 人类可以设置任意额度
 */
router.post('/api/v1/agents/:agentId/takeover', async (req, res) => {
  try {
    const node = req.app.locals.node;
    const state = node?.currentState;
    const { agentId } = req.params;

    // P0-6 follow-up: resolve agent via wallet registry (primary) or on-chain
    // registry (fallback). Old code read `state.agents` which never existed.
    const wm = req.app.locals.agentWalletManager;
    let entry = wm?.registry?.get(agentId);
    if (!entry && node?.resolveRegisteredAgent) {
      const rec = node.resolveRegisteredAgent(agentId);
      if (rec?.agentId) entry = wm?.registry?.get(rec.agentId) || null;
    }
    if (!entry) {
      if (!state?.agentRegistry) {
        return res.status(503).json({ success: false, error: 'State not ready', error_code: 'STATE_NOT_READY' });
      }
      return res.status(404).json({ success: false, error: `Agent not found: ${agentId}`, error_code: 'AGENT_NOT_FOUND' });
    }

    const { masterSignature, timestamp } = req.body;
    if (!masterSignature) {
      return res.status(400).json({
        success: false,
        error: 'Missing masterSignature',
        error_code: 'MISSING_SIGNATURE',
        hint: 'Human operator must sign the takeover request with their master key'
      });
    }
    if (!timestamp) {
      return res.status(400).json({
        success: false,
        error: 'Missing timestamp',
        error_code: 'MISSING_TIMESTAMP',
        hint: 'Send the timestamp (ms epoch) used when signing. Message format: "takeover:{agentId}:{timestamp}"'
      });
    }
    // Signature freshness: reject replayed takeover requests older than 10 min
    if (Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
      return res.status(400).json({
        success: false,
        error: 'Signature timestamp expired or from the future',
        error_code: 'SIGNATURE_EXPIRED'
      });
    }

    // Verify master-key signature over "takeover:{agentId}:{timestamp}"
    // (previously the server rebuilt the message with its own Date.now(),
    //  making every genuine client signature fail verification)
    const { verify } = await import('../../crypto/pqc.js');
    const message = Buffer.from(`takeover:${agentId}:${timestamp}`);
    const isValid = await verify(
      message,
      Buffer.from(masterSignature, 'hex'),
      Buffer.from(entry.wallet.publicKey, 'hex')
    );

    if (!isValid) {
      return res.status(403).json({
        success: false,
        error: 'Invalid master key signature',
        error_code: 'INVALID_SIGNATURE',
        hint: 'The signature must be created with the human operator\'s master key over "takeover:{agentId}:{timestamp}"'
      });
    }

    // Takeover succeeded: set default spend limit and persist in wallet metadata
    entry.metadata = entry.metadata || {};
    entry.metadata.spendConfig = {
      type: 'fixed',
      dailyLimit: '1000000000000000000', // default 1 NGEN
      humanControlled: true,
      takenOverAt: new Date().toISOString(),
      takenOverBy: 'human_operator',
      updatedAt: new Date().toISOString()
    };
    entry.metadata.takenOver = true;
    entry.metadata.takenOverAt = entry.metadata.spendConfig.takenOverAt;
    if (wm?.persist) {
      try { await wm.persist(); } catch { /* best-effort persistence */ }
    }

    res.json({
      success: true,
      agentId,
      takeover: {
        humanControlled: true,
        takenOverAt: entry.metadata.takenOverAt,
        spendConfig: entry.metadata.spendConfig
      },
      note: 'Human operator has taken over control of this agent\'s wallet. Daily limit set to 1 NGEN. Adjust via PUT /api/v1/agents/:agentId/spend-config'
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

/**
 * GET /api/v1/agents/:agentId/control-status
 * 查看 Agent 钱包的控制状态
 */
router.get('/api/v1/agents/:agentId/control-status', (req, res) => {
  try {
    const node = req.app.locals.node;
    const state = node?.currentState;
    const { agentId } = req.params;

    // P0-6 follow-up: wallet registry is the source of truth for custody state.
    const wm = req.app.locals.agentWalletManager;
    let entry = wm?.registry?.get(agentId);
    if (!entry && node?.resolveRegisteredAgent) {
      const rec = node.resolveRegisteredAgent(agentId);
      if (rec?.agentId) entry = wm?.registry?.get(rec.agentId) || null;
    }
    if (!entry) {
      if (!state?.agentRegistry) {
        return res.status(503).json({ success: false, error: 'State not ready', error_code: 'STATE_NOT_READY' });
      }
      // P0-5 follow-up: browser-custody agents have no server-side wallet
      // entry. Fall back to the on-chain registry so their custody and
      // master-key binding state remain visible (takeover depends on this).
      const rec = node?.resolveRegisteredAgent?.(agentId);
      if (rec?.agentId) {
        const record = state.agentRegistry.agents.get(rec.agentId) || {};
        return res.json({
          success: true,
          agentId: rec.agentId,
          source: 'on-chain',
          keyModel: 'browser-generated',
          custody: record.custody || 'self-sovereign',
          masterKeyBound: !!record.master_key_fingerprint,
          masterKeyFingerprint: record.master_key_fingerprint || null,
          bindingDeadline: record.binding_deadline || null,
          controlStatus: {
            humanControlled: false,
            spendConfig: { type: 'unlimited' },
            takenOverAt: null,
            note: 'Browser-custody agent: keys never left the client. Bind a Master Key via POST /api/v1/bootstrap/agents/:agentId/bind-master-key to gain takeover rights.'
          }
        });
      }
      return res.status(404).json({ success: false, error: `Agent not found: ${agentId}`, error_code: 'AGENT_NOT_FOUND' });
    }

    const md = entry.metadata || {};
    res.json({
      success: true,
      agentId,
      keyModel: md.keyModel || 'server-managed',
      custody: md.custody || 'server-managed',
      controlStatus: {
        humanControlled: !!md.takenOver,
        spendConfig: md.spendConfig || { type: 'unlimited' },
        takenOverAt: md.takenOverAt || null,
        note: md.takenOver
          ? 'This agent\'s wallet is controlled by a human operator.'
          : 'This agent operates autonomously. Human can takeover anytime via POST /api/v1/agents/:agentId/takeover'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

// ─── 审批系统 API ──────────────────────────────────────────────

/**
 * POST /api/v1/approvals/create
 * Agent 发起超额审批请求
 */
router.post('/api/v1/approvals/create', async (req, res) => {
  const startTime = Date.now();
  const requestId = `appr-create-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`[${requestId}] CREATE REQUEST START agentId=${req.body.agentId} type=${req.body.type}`);

  try {
    const state = req.app.locals.node?.currentState;
    if (!state || !state.agents) {
      console.log(`[${requestId}] FAIL: State not ready`);
      return res.status(503).json({ success: false, error: 'State not ready' });
    }

    const { agentId, type, toAddress, amount, memo, agentSignature } = req.body;

    if (!agentId || !type || !amount) {
      console.log(`[${requestId}] FAIL: Missing fields agentId=${!!agentId} type=${!!type} amount=${!!amount}`);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: agentId, type, amount'
      });
    }

    // 查找 Agent
    const agent = state.agents[agentId];
    if (!agent) {
      console.log(`[${requestId}] Agent not in state.agents, checking registry...`);
      const wm = req.app?.locals?.agentWalletManager;
      if (wm) {
        const entry = wm.registry.get(agentId);
        if (entry) {
          state.agents[agentId] = {
            id: agentId,
            address: entry.wallet.address,
            publicKey: entry.wallet.publicKey.toString('hex'),
            spendConfig: entry.metadata?.spendConfig || { type: 'unlimited' },
            keyModel: entry.metadata?.keyModel || 'self-sovereign'
          };
          console.log(`[${requestId}] Agent found in registry, address=${entry.wallet.address}`);
        }
      }
      if (!state.agents[agentId]) {
        console.log(`[${requestId}] FAIL: Agent not found agentId=${agentId}`);
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }
    } else {
      console.log(`[${requestId}] Agent found in state.agents`);
    }

    // 验证 Agent 签名
    if (agentSignature) {
      const { verify } = await import('../../crypto/pqc.js');
      const message = `${type}:${agentId}:${toAddress}:${amount}:${memo || ''}:${Date.now()}`;
      const isValid = await verify(message, Buffer.from(agentSignature, 'hex'), Buffer.from(agent.publicKey, 'hex'));
      if (!isValid) {
        console.log(`[${requestId}] FAIL: Invalid agent signature`);
        return res.status(403).json({ success: false, error: 'Invalid agent signature' });
      }
      console.log(`[${requestId}] Agent signature verified`);
    }

    // 创建审批请求
    const approvalId = `apr_${crypto.randomUUID()}`;
    const approval = {
      id: approvalId,
      type,
      agentId,
      toAddress: toAddress || null,
      amount: BigInt(amount).toString(),
      memo: memo || '',
      status: 'pending',
      agentSignature,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      decision: null,
      humanSignature: null
    };

    if (!state.approvals) state.approvals = {};
    state.approvals[approvalId] = approval;

    const elapsed = Date.now() - startTime;
    console.log(`[${requestId}] SUCCESS approvalId=${approvalId.slice(0, 12)}... elapsed=${elapsed}ms`);
    res.json({
      success: true,
      approvalId,
      status: 'pending_human_approval',
      expiresAt: approval.expiresAt,
      note: 'Approval request created. Waiting for human operator to sign with master key.'
    });
  } catch (err) {
    console.error(`[${requestId}] CRASH: ${err.message}`);
    res.status(500).json({ error: err.message, success: false });
  }
});

/**
 * POST /api/v1/approvals/:approvalId/decide
 * 人类提交审批决定（需要主密钥签名）
 */
router.post('/api/v1/approvals/:approvalId/decide', async (req, res) => {
  const startTime = Date.now();
  const requestId = `appr-decide-${req.params.approvalId.slice(0, 8)}`;
  console.log(`[${requestId}] DECIDE REQUEST START approvalId=${req.params.approvalId} decision=${req.body.decision}`);

  try {
    const state = req.app.locals.node?.currentState;
    if (!state || !state.approvals) {
      console.log(`[${requestId}] FAIL: State not ready`);
      return res.status(503).json({ success: false, error: 'State not ready' });
    }

    const approval = state.approvals[req.params.approvalId];
    if (!approval) {
      console.log(`[${requestId}] FAIL: Approval not found`);
      return res.status(404).json({ success: false, error: 'Approval not found' });
    }
    console.log(`[${requestId}] Approval found, current status=${approval.status}`);

    if (approval.status !== 'pending') {
      console.log(`[${requestId}] FAIL: Already decided status=${approval.status}`);
      return res.status(400).json({
        success: false,
        error: `Approval already ${approval.status}`,
        decision: approval.decision
      });
    }

    const { decision, masterSignature } = req.body;
    if (!decision || !['approve', 'reject'].includes(decision)) {
      console.log(`[${requestId}] FAIL: Invalid decision="${decision}"`);
      return res.status(400).json({ success: false, error: 'decision must be "approve" or "reject"' });
    }
    console.log(`[${requestId}] Decision: ${decision}`);

    if (!masterSignature) {
      console.log(`[${requestId}] FAIL: Missing masterSignature`);
      return res.status(400).json({
        success: false,
        error: 'masterSignature is required',
        hint: 'Human operator must sign the approval message with their master key'
      });
    }

    // 验证主密钥签名
    const { verify } = await import('../../crypto/pqc.js');
    const message = `approval:${approval.id}:${decision}:${approval.amount}`;
    let agent = state.agents[approval.agentId];
    if (!agent) {
      console.log(`[${requestId}] Agent not in state, checking registry...`);
      const wm = req.app?.locals?.agentWalletManager;
      if (wm) {
        const entry = wm.registry.get(approval.agentId);
        if (entry) {
          agent = {
            id: approval.agentId,
            address: entry.wallet.address,
            publicKey: entry.wallet.publicKey.toString('hex'),
            spendConfig: entry.metadata?.spendConfig || { type: 'unlimited' },
            keyModel: entry.metadata?.keyModel || 'self-sovereign'
          };
          state.agents[approval.agentId] = agent;
          console.log(`[${requestId}] Agent found in registry`);
        }
      }
      if (!agent) {
        console.log(`[${requestId}] FAIL: Agent not found`);
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }
    }

    console.log(`[${requestId}] Verifying signature (sigLen=${masterSignature.length})`);
    const cacheKey = `${approval.id}:${decision}:${approval.amount}`;
    const { verifyWithCache } = await import('../../crypto/signatureCache.js');
    const isValid = await verifyWithCache(cacheKey, async () => {
      const { verify } = await import('../../crypto/pqc.js');
      return verify(message, Buffer.from(masterSignature, 'hex'), Buffer.from(agent.publicKey, 'hex'));
    });
    if (!isValid) {
      console.log(`[${requestId}] FAIL: Invalid master key signature`);
      return res.status(403).json({ success: false, error: 'Invalid master key signature' });
    }
    console.log(`[${requestId}] Signature verified OK`);

    // 更新审批状态
    approval.status = decision === 'approve' ? 'approved' : 'rejected';
    approval.decision = decision;
    approval.humanSignature = masterSignature;
    approval.decidedAt = new Date().toISOString();
    console.log(`[${requestId}] Approval ${decision === 'approve' ? 'APPROVED' : 'REJECTED'}, status=${approval.status}`);

    // 如果批准，执行转账
    if (decision === 'approve') {
      console.log(`[${requestId}] Executing approved transfer for agent=${approval.agentId} amount=${approval.amount}`);
      try {
        const agentWM = req.app?.locals?.agentWalletManager;
        if (agentWM) {
          const fromEntry = agentWM.registry.get(approval.agentId);
          if (fromEntry) {
            const amountNum = Number(approval.amount);
            const fee = 1;
            const totalDeduct = amountNum + fee;

            // 检查余额
            if (fromEntry.wallet.balance >= BigInt(totalDeduct)) {
              // 直接扣减余额（绕过 spendConfig 检查，因为人类已经批准）
              fromEntry.wallet.balance -= BigInt(totalDeduct);
              fromEntry.wallet.nonce++;
              agentWM.nonceMap.set(approval.agentId, fromEntry.wallet.nonce);

              // 代谢税
              const tax = BigInt(Math.floor(amountNum * 0.001));
              if (tax > 0n) {
                console.log(`[Approval] Metabolic tax: ${tax} NGEN`);
              }

              // 如果接收方是本网络的 Agent，自动入账
              const toAgentId = agentWM.getAgentByAddress(approval.toAddress);
              if (toAgentId && agentWM.registry.has(toAgentId)) {
                const toEntry = agentWM.registry.get(toAgentId);
                toEntry.wallet.balance += BigInt(amountNum) - tax;
              }

              // 记录交易
              const txId = `tx-appr-${crypto.randomUUID()}`;
              const txRecord = {
                id: txId,
                hash: txId,
                type: 'transfer',
                tx_type: 'APPROVED_TRANSFER',
                from: fromEntry.wallet.address,
                to: approval.toAddress,
                fromAgentId: approval.agentId,
                toAgentId: toAgentId || null,
                amount: amountNum,
                netAmount: amountNum - Number(tax),
                fee: fee,
                metabolicTax: Number(tax),
                memo: approval.memo || `Approved: ${approval.id}`,
                signature: approval.humanSignature,
                status: 'applied',
                timestamp: Date.now(),
                approvalId: approval.id
              };

              // 持久化到 state txHistory
              try {
                const st = req.app.locals.node?.currentState;
                if (st && !st.transactions) st.transactions = {};
                if (st && !st.transactions.txHistory) st.transactions.txHistory = [];
                st.transactions.txHistory.push(txRecord);
              } catch (_) { /* ignore */ }

              // 持久化到 registry
              try {
                agentWM._saveRegistry();
              } catch (_) { /* ignore */ }

              approval.executed = true;
              approval.transactionId = txId;
            } else {
              approval.executed = false;
              approval.executionError = 'Insufficient balance';
            }
          } else {
            approval.executed = false;
            approval.executionError = 'Agent wallet not found in manager';
            console.log(`[${requestId}] FAIL: Agent wallet not in manager`);
          }
        }
      } catch (execErr) {
        approval.executed = false;
        approval.executionError = execErr.message;
        console.error(`[${requestId}] CRASH during transfer: ${execErr.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[${requestId}] DONE decision=${decision} executed=${approval.executed ?? 'N/A'} elapsed=${elapsed}ms`);

    res.json({
      success: true,
      approvalId: approval.id,
      decision,
      executed: decision === 'approve' ? approval.executed : undefined,
      note: decision === 'approve'
        ? 'Transaction approved and executed.'
        : 'Transaction rejected by human operator.'
    });
  } catch (err) {
    console.error(`[${requestId}] CRASH: ${err.message}`);
    res.status(500).json({ error: err.message, success: false });
  }
});

/**
 * GET /api/v1/approvals
 * 查询所有审批请求（支持按 agentId 过滤）
 */
router.get('/api/v1/approvals', (req, res) => {
  try {
    const state = req.app.locals.node?.currentState;
    if (!state || !state.approvals) {
      return res.json({ success: true, approvals: [] });
    }

    const { agentId, status } = req.query;
    let approvals = Object.values(state.approvals);

    if (agentId) {
      approvals = approvals.filter(a => a.agentId === agentId);
    }
    if (status) {
      approvals = approvals.filter(a => a.status === status);
    }

    // 过滤已过期的
    approvals = approvals.filter(a => new Date(a.expiresAt) > new Date());

    res.json({
      success: true,
      approvals: approvals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
      total: approvals.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

/**
 * GET /api/v1/approvals/:approvalId
 * 查询单个审批详情
 */
router.get('/api/v1/approvals/:approvalId', (req, res) => {
  try {
    const state = req.app.locals.node?.currentState;
    if (!state || !state.approvals) {
      return res.status(503).json({ success: false, error: 'State not ready' });
    }

    const approval = state.approvals[req.params.approvalId];
    if (!approval) {
      return res.status(404).json({ success: false, error: 'Approval not found' });
    }

    res.json({
      success: true,
      approval
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

export default router;

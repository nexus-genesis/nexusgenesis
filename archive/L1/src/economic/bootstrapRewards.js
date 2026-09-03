import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

const BOOTSTRAP_DIR = resolve(PROJECT_ROOT, 'data', 'bootstrap');
const CONTRIBUTIONS_FILE = resolve(BOOTSTRAP_DIR, 'contributions.json');

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function loadContributions() {
  ensureDir(BOOTSTRAP_DIR);
  if (existsSync(CONTRIBUTIONS_FILE)) {
    try { return JSON.parse(readFileSync(CONTRIBUTIONS_FILE, 'utf8')); }
    catch (e) { return _emptyState(); }
  }
  return _emptyState();
}

function saveContributions(state) {
  ensureDir(BOOTSTRAP_DIR);
  writeFileSync(CONTRIBUTIONS_FILE, JSON.stringify(state, null, 2));
}

function _emptyState() {
  return {
    phase: 'BOOTSTRAP',
    startedAt: null,
    totalAgentJoins: 0,
    totalNGENAwarded: 0,
    totalBlocksProduced: 0,
    activeValidators: 0,
    agents: {},
    history: []
  };
}

class BootstrapRewards extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config.bootstrap?.rewards || {
      validatorJoinReward: 5000,
      blockProductionReward: 100,
      uptimeBonusPerHour: 10,
      agentReferralReward: 1000,
      activeReferralBonus: 1000,
      contributionTrackingEnabled: true
    };

    this.autoExitConditions = config.bootstrap?.autoExitConditions || {
      minActiveValidators: 7,
      minTotalStake: 1000000,
      minNetworkUptimeHours: 720
    };

    this.state = loadContributions();
    this.blockProductionCounts = new Map();
    this.uptimeStartTimes = new Map();
    this._uptimeTimer = null;
    this._saveTimer = null;

    if (!this.state.startedAt) {
      this.state.startedAt = Date.now();
      saveContributions(this.state);
    }

    // 每 5 分钟自动保存，防止数据丢失
    this._saveTimer = setInterval(() => {
      try { saveContributions(this.state); }
      catch (e) { console.error('[BootstrapRewards] Auto-save failed:', e.message); }
    }, 300000);
    this._saveTimer.unref();
  }

  startTracking() {
    this._uptimeTimer = setInterval(() => this._calculateUptimeRewards(), 3600000);
    this._uptimeTimer.unref();
    console.log('[BootstrapRewards] Agent contribution tracking started');
    console.log('[BootstrapRewards] Rewards:');
    console.log(`  - Agent注册奖励: ${this.config.agentJoinReward || 5000} NGEN`);
    console.log(`  - 出块奖励: ${this.config.blockProductionReward} NGEN/块`);
    console.log(`  - 在线奖励: ${this.config.uptimeBonusPerHour} NGEN/小时`);
    console.log(`  - 推荐奖励: ${this.config.agentReferralReward} NGEN/Agent`);
  }

  stopTracking() {
    if (this._uptimeTimer) {
      clearInterval(this._uptimeTimer);
      this._uptimeTimer = null;
    }
  }

  getOrCreateAgent(agentId, address, metadata = {}) {
    if (!this.state.agents[agentId]) {
      this.state.agents[agentId] = {
        agentId,
        address,
        name: metadata.name || '',
        joinedAt: Date.now(),
        contributions: {
          validations: 0,
          blocksProduced: 0,
          uptimeSeconds: 0,
          referrals: 0,
          proposals: 0,
          votes: 0
        },
        totalEarned: 0,
        rewards: [],
        referralCode: _generateReferralCode(agentId),
        referredBy: metadata.referredBy || null
      };

      this.state.totalAgentJoins++;
      this.emit('agent:joined', this.state.agents[agentId]);
    }
    return this.state.agents[agentId];
  }

  awardAgentJoinReward(agentId, address, metadata = {}) {
    const agent = this.getOrCreateAgent(agentId, address, metadata);
    const joinReward = this.config.agentJoinReward || 5000;

    let totalReward = joinReward;

    if (this.state.totalAgentJoins <= 100) {
      totalReward += (metadata.earlyBonus || 10000);
    }

    agent.totalEarned += totalReward;
    agent.rewards.push({
      type: 'AGENT_JOIN',
      amount: totalReward,
      timestamp: Date.now(),
      joinNumber: this.state.totalAgentJoins
    });

    this.state.totalNGENAwarded += totalReward;
    this.state.history.push({
      type: 'AGENT_JOIN',
      agentId,
      amount: totalReward,
      timestamp: Date.now()
    });

    // 实时保存，避免数据丢失
    saveContributions(this.state);

    if (metadata.referredBy) {
      this.awardReferralReward(metadata.referredBy, agentId);
    }

    saveContributions(this.state);
    this.emit('reward:awarded', { agentId, type: 'AGENT_JOIN', amount: totalReward });

    return { agent, totalReward };
  }

  recordBlockProduced(validatorId) {
    const count = (this.blockProductionCounts.get(validatorId) || 0) + 1;
    this.blockProductionCounts.set(validatorId, count);
    this.state.totalBlocksProduced++;

    if (count % 10 === 0) {
      const reward = (this.config.blockProductionReward || 100) * 10;
      const agent = this.state.agents[validatorId];
      if (agent) {
        agent.totalEarned += reward;
        agent.contributions.blocksProduced = count;
        agent.rewards.push({
          type: 'BLOCK_PRODUCTION',
          amount: reward,
          blocks: 10,
          timestamp: Date.now()
        });
        this.state.totalNGENAwarded += reward;
      }
    }

    if (count % 10 === 0) saveContributions(this.state);
  }

  startValidatorUptime(validatorId) {
    this.uptimeStartTimes.set(validatorId, Date.now());
    const agent = this.state.agents[validatorId];
    if (agent) {
      this.state.activeValidators = Math.max(
        this.state.activeValidators,
        Object.values(this.state.agents).filter(a =>
          a.contributions.blocksProduced > 0 ||
          (Date.now() - a.joinedAt < 3600000 && a.contributions.validations > 0)
        ).length
      );
    }
    saveContributions(this.state);
  }

  stopValidatorUptime(validatorId) {
    const startTime = this.uptimeStartTimes.get(validatorId);
    if (startTime) {
      const seconds = Math.floor((Date.now() - startTime) / 1000);
      const agent = this.state.agents[validatorId];
      if (agent) {
        agent.contributions.uptimeSeconds += seconds;
      }
      this.uptimeStartTimes.delete(validatorId);
    }
  }

  _calculateUptimeRewards() {
    const rewardPerHour = this.config.uptimeBonusPerHour || 10;

    for (const [validatorId, startTime] of this.uptimeStartTimes) {
      const agent = this.state.agents[validatorId];
      if (!agent) continue;

      const hoursSinceLastReward = agent.rewards.filter(r => r.type === 'UPTIME').length;
      const totalHours = Math.floor((Date.now() - startTime) / 3600000);

      if (totalHours > hoursSinceLastReward) {
        const newHours = totalHours - hoursSinceLastReward;
        const reward = rewardPerHour * newHours;
        agent.totalEarned += reward;
        agent.rewards.push({
          type: 'UPTIME',
          amount: reward,
          hours: newHours,
          timestamp: Date.now()
        });
        this.state.totalNGENAwarded += reward;
      }
    }

    const activeNow = this.uptimeStartTimes.size;
    if (activeNow !== this.state.activeValidators) {
      this.state.activeValidators = activeNow;
    }

    saveContributions(this.state);
  }

  awardReferralReward(referrerAgentId, newAgentId) {
    const referrer = this.state.agents[referrerAgentId];
    if (!referrer) return;

    const reward = this.config.agentReferralReward || 1000;
    referrer.totalEarned += reward;
    referrer.contributions.referrals++;
    referrer.rewards.push({
      type: 'REFERRAL',
      amount: reward,
      referredAgent: newAgentId,
      timestamp: Date.now()
    });

    this.state.totalNGENAwarded += reward;

    const newAgent = this.state.agents[newAgentId];
    if (newAgent) {
      newAgent.totalEarned += Math.floor(reward * 0.5);
      newAgent.rewards.push({
        type: 'REFERRAL_BONUS',
        amount: Math.floor(reward * 0.5),
        referrer: referrerAgentId,
        timestamp: Date.now()
      });
      this.state.totalNGENAwarded += Math.floor(reward * 0.5);
    }

    saveContributions(this.state);
  }

  recordGovernanceAction(agentId, action) {
    const agent = this.state.agents[agentId];
    if (!agent) return;

    if (action === 'proposal') {
      agent.contributions.proposals++;
      agent.totalEarned += 100;
      this.state.totalNGENAwarded += 100;
    } else if (action === 'vote') {
      agent.contributions.votes++;
      agent.totalEarned += 50;
      this.state.totalNGENAwarded += 50;
    }

    saveContributions(this.state);
  }

  getAgentReport(agentId) {
    return this.state.agents[agentId] || null;
  }

  getNetworkReport() {
    const uptimeSeconds = this.state.startedAt ? Math.floor((Date.now() - this.state.startedAt) / 1000) : 0;
    const uptimeHours = Math.floor(uptimeSeconds / 3600);

    return {
      phase: this.state.phase,
      startedAt: this.state.startedAt,
      uptimeHours,
      totalAgentJoins: this.state.totalAgentJoins,
      totalNGENAwarded: this.state.totalNGENAwarded,
      totalBlocksProduced: this.state.totalBlocksProduced,
      activeValidators: this.uptimeStartTimes.size,
      autoExitProgress: {
        activeValidators: {
          current: this.uptimeStartTimes.size,
          target: this.autoExitConditions.minActiveValidators,
          percent: Math.round((this.uptimeStartTimes.size / this.autoExitConditions.minActiveValidators) * 100)
        },
        uptimeHours: {
          current: uptimeHours,
          target: this.autoExitConditions.minNetworkUptimeHours,
          percent: Math.round((uptimeHours / this.autoExitConditions.minNetworkUptimeHours) * 100)
        }
      },
      topContributors: Object.values(this.state.agents)
        .sort((a, b) => b.totalEarned - a.totalEarned)
        .slice(0, 10)
        .map(a => ({
          agentId: a.agentId,
          name: a.name,
          earned: a.totalEarned,
          blocks: a.contributions.blocksProduced,
          referrals: a.contributions.referrals
        }))
    };
  }

  checkAutoExit() {
    const conditions = this.autoExitConditions;
    const report = this.getNetworkReport();

    const validatorsMet = this.uptimeStartTimes.size >= conditions.minActiveValidators;
    const uptimeMet = report.uptimeHours >= conditions.minNetworkUptimeHours;

    if (validatorsMet && uptimeMet) {
      this.state.phase = 'BOOTSTRAP_COMPLETE';
      saveContributions(this.state);
      this.emit('bootstrap:complete', {
        activeValidators: this.uptimeStartTimes.size,
        uptimeHours: report.uptimeHours,
        totalAgents: this.state.totalAgentJoins,
        totalAwarded: this.state.totalNGENAwarded
      });
      return true;
    }

    return false;
  }

  getState() {
    return {
      ...this.state,
      _activeValidatorsNow: this.uptimeStartTimes.size,
      _activeValidatorIds: Array.from(this.uptimeStartTimes.keys())
    };
  }

  destroy() {
    // 清理定时器，确保最终保存
    clearInterval(this._uptimeTimer);
    clearInterval(this._saveTimer);
    try { saveContributions(this.state); } catch (e) {}
    this.emit('shutdown', this.state);
  }
}

function _generateReferralCode(agentId) {
  return 'NGN-' + agentId.replace(/-/g, '').substring(0, 8).toUpperCase();
}

export default BootstrapRewards;
export { BootstrapRewards, loadContributions, saveContributions };
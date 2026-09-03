import { AgentDiscoveryService } from './agentDiscoveryService.js';
import { AgentMarketplace } from './agentMarketplace.js';
import { TokenFaucet } from '../faucet/tokenFaucet.js';
import { onboardAgent, simplifiedAgentRegister } from '../protocol/agentOnboarding.js';
import { CrossChainBridge } from '../bridge/bridgeProtocol.js';
import crypto from 'crypto';

const AGENT_CAPABILITIES_POOL = [
  'nlp', 'translation', 'summarization', 'sentiment-analysis', 'text-generation',
  'code-review', 'bug-detection', 'testing', 'security-audit', 'refactoring',
  'data-analysis', 'etl', 'sql', 'visualization', 'report-generation',
  'image-recognition', 'ocr', 'object-detection', 'image-generation',
  'market-research', 'competitor-analysis', 'trend-prediction', 'forecasting',
  'content-writing', 'copywriting', 'editing', 'proofreading', 'seo',
  'chatbot', 'customer-support', 'qa-system', 'knowledge-base',
  'compliance', 'audit', 'risk-assessment', 'fraud-detection',
  'social-media', 'community-management', 'engagement-analysis',
  'research', 'literature-review', 'fact-checking', 'citation'
];

const AGENT_MODELS = ['gpt-4', 'claude-3', 'gemini-pro', 'llama-3', 'mixtral', 'gpt-3.5'];
const REGIONS = ['us-east', 'us-west', 'eu-west', 'eu-central', 'asia-east', 'asia-south', 'oceania'];
const REPUTATION_LEVELS = ['new', 'active', 'core', 'senior', 'legendary'];

const TASK_TYPES = [
  { name: 'Text Analysis', requiredCaps: ['nlp', 'summarization'], reward: 50, complexity: 2 },
  { name: 'Code Security Audit', requiredCaps: ['security-audit', 'code-review'], reward: 200, complexity: 5 },
  { name: 'Data Pipeline Setup', requiredCaps: ['etl', 'sql', 'data-analysis'], reward: 150, complexity: 4 },
  { name: 'Market Research Report', requiredCaps: ['market-research', 'report-generation'], reward: 120, complexity: 3 },
  { name: 'Content Creation Suite', requiredCaps: ['content-writing', 'seo', 'editing'], reward: 100, complexity: 3 },
  { name: 'Social Media Campaign', requiredCaps: ['social-media', 'community-management'], reward: 80, complexity: 2 },
  { name: 'Compliance Check', requiredCaps: ['compliance', 'audit', 'risk-assessment'], reward: 180, complexity: 4 },
  { name: 'AI Model Evaluation', requiredCaps: ['testing', 'qa-system'], reward: 130, complexity: 3 },
  { name: 'Multi-language Translation', requiredCaps: ['translation', 'nlp'], reward: 90, complexity: 2 },
  { name: 'Fraud Detection System', requiredCaps: ['fraud-detection', 'data-analysis'], reward: 220, complexity: 5 },
  { name: 'Bug Bounty Triage', requiredCaps: ['bug-detection', 'refactoring'], reward: 160, complexity: 4 },
  { name: 'Competitor Intel Report', requiredCaps: ['competitor-analysis', 'trend-prediction'], reward: 140, complexity: 3 }
];

class AgentSwarmSimulator {
  constructor(options = {}) {
    this.options = {
      agentCount: 15,
      simulationRounds: 30,
      taskPerRound: 5,
      enableMarketplace: true,
      enableCrossChain: false,
      enableFaucet: true,
      logLevel: 'info',
      ...options
    };

    this.agents = [];
    this.tasks = [];
    this.rounds = [];

    this.discoveryService = new AgentDiscoveryService();
    this.marketplace = new AgentMarketplace();
    this.faucet = new TokenFaucet();
    this.bridge = null;

    this.agentManager = {
      getAllAgents: () => this.agents.map(a => ({
        id: a.id,
        name: a.name,
        capabilities: a.capabilities,
        reputation: a.reputation,
        activeTasks: a.activeTasks || [],
        taskQueue: a.taskQueue || [],
        maxCapacity: a.maxCapacity,
        health: a.health,
        metadata: a.metadata,
        model: a.model
      }))
    };

    this.discoveryService.setAgentManager(this.agentManager);
    this.marketplace.agentManager = this.agentManager;

    this.economicMetrics = {
      totalTokensDistributed: 0,
      totalTokensEarned: 0,
      totalTaxCollected: 0,
      totalMarketplaceVolume: 0,
      averageReputationGrowth: 0,
      taskCompletionRate: 0,
      agentUtilizationRate: 0
    };

    this.liveMetrics = {
      activeAgents: 0,
      pendingTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      marketTransactions: 0
    };
  }

  _rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  _pickRandom(arr, count = 1) {
    if (count >= arr.length) return [...arr];
    const result = new Set();
    while (result.size < count) {
      result.add(arr[this._rand(0, arr.length - 1)]);
    }
    return [...result];
  }

  _log(level, message) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    if (levels[level] >= levels[this.options.logLevel]) {
      const prefix = { debug: '🐛', info: '📋', warn: '⚠️', error: '❌' }[level];
      console.log(`[Swarm] ${prefix} ${message}`);
    }
  }

  _buildCapabilityCoverage() {
    const allTaskCaps = new Set();
    for (const tt of TASK_TYPES) {
      for (const cap of tt.requiredCaps) allTaskCaps.add(cap);
    }
    return [...allTaskCaps];
  }

  _assignAgentCapabilities(index, totalAgents, coveredCaps) {
    if (index < coveredCaps.length) {
      const primaryCap = coveredCaps[index];
      const secondary = this._pickRandom(AGENT_CAPABILITIES_POOL, this._rand(2, 3))
        .filter(c => c !== primaryCap);
      return [primaryCap, ...secondary];
    }
    return this._pickRandom(AGENT_CAPABILITIES_POOL, this._rand(3, 5));
  }

  initialize() {
    this._log('info', `Initializing swarm with ${this.options.agentCount} agents...`);

    const coveredCaps = this._buildCapabilityCoverage();
    this._log('debug', `Task capability coverage needed: ${coveredCaps.length} unique capabilities`);

    const shuffledModels = [...AGENT_MODELS].sort(() => Math.random() - 0.5);

    for (let i = 0; i < this.options.agentCount; i++) {
      const agentCaps = this._assignAgentCapabilities(i, this.options.agentCount, coveredCaps);
      const model = shuffledModels[i % shuffledModels.length];
      const region = REGIONS[i % REGIONS.length];
      const maxCapacity = this._rand(8, 18);

      const agent = {
        id: `ag_${crypto.randomUUID().slice(0, 8)}`,
        name: `${model}_agent_${i + 1}`,
        identity: `swarm-agent-${i + 1}`,
        capabilities: agentCaps,
        reputation: 0,
        balance: 0,
        model,
        maxCapacity,
        activeTasks: [],
        taskQueue: [],
        completedTasks: [],
        failedTasks: [],
        idleRounds: 0,
        health: { status: 'healthy', score: this._rand(85, 100) },
        metadata: { region, description: `${model} agent specialized in ${agentCaps.slice(0, 2).join(', ')}` },
        metrics: { completedTasks: 0, totalTasks: 0, earned: 0, spent: 0 },
        registered: false,
        listings: []
      };

      this.agents.push(agent);
    }

    if (this.options.enableCrossChain) {
      this.bridge = new CrossChainBridge({ chainId: 'swarm-testnet', signatureThreshold: 2, minValidators: 2 });
    }

    this._log('info', `Swarm initialized: ${this.agents.length} agents`);
    return this;
  }

  async registerAgents() {
    this._log('info', 'Registering agents on the network...');

    for (const agent of this.agents) {
      try {
        if (this.options.enableFaucet) {
          const result = await this.faucet.drip('swarm-simulator', 1000);
          if (result.success) {
            agent.balance = result.distribution.amount;
          }
        }

        const regResult = simplifiedAgentRegister({
          agent_id: agent.id,
          address: agent.id.padEnd(39, '0'),
          capabilities: agent.capabilities,
          model: agent.model
        });

        agent.registered = regResult.registered !== false;
        if (agent.registered) {
          agent.reputation = this._rand(5, 50);
          this._log('debug', `Agent ${agent.name} registered (reputation: ${agent.reputation})`);
        }
      } catch (e) {
        this._log('warn', `Failed to register ${agent.name}: ${e.message}`);
      }
    }

    this.discoveryService.rebuildAllIndexes();
    const registered = this.agents.filter(a => a.registered).length;
    this.liveMetrics.activeAgents = registered;
    this._log('info', `Registered ${registered}/${this.agents.length} agents`);
  }

  async createMarketplaceListings() {
    if (!this.options.enableMarketplace) return;

    this._log('info', 'Creating marketplace listings...');

    for (const agent of this.agents) {
      if (!agent.registered || agent.capabilities.length === 0) continue;

      const listingCount = this._rand(1, Math.min(3, agent.capabilities.length));
      const selectedCaps = this._pickRandom(agent.capabilities, listingCount);

      for (const cap of selectedCaps) {
        try {
          const result = this.marketplace.listService(agent.id, {
            name: `${cap.toUpperCase()} by ${agent.name}`,
            description: `${agent.model} agent providing ${cap} service`,
            capabilities: [cap],
            category: this._pickRandom(['AI', 'Dev', 'Data', 'Content', 'Security', 'Research'], 1)[0],
            price: this._rand(10, 200),
            tags: [cap, agent.model]
          });

          if (result.success) {
            agent.listings.push(result.listingId);
            this.liveMetrics.marketTransactions++;
          }
        } catch (e) {
          /* ignore */
        }
      }
    }

    this._log('info', `Marketplace listings created: ${this.liveMetrics.marketTransactions}`);
  }

  generateTasks() {
    const roundTasks = [];
    const taskCount = this._rand(this.options.taskPerRound - 2, this.options.taskPerRound + 2);

    for (let i = 0; i < taskCount; i++) {
      const template = this._pickRandom(TASK_TYPES, 1)[0];
      const task = {
        id: `task_${crypto.randomUUID().slice(0, 8)}`,
        ...template,
        requiredCapabilities: [...template.requiredCaps],
        preferredCapabilities: this._pickRandom(AGENT_CAPABILITIES_POOL, this._rand(1, 3)),
        createdAt: Date.now(),
        status: 'pending',
        assignedAgent: null,
        reward: template.reward + this._rand(-20, 50)
      };

      roundTasks.push(task);
    }

    return roundTasks;
  }

  async matchAndAssignTasks(roundTasks) {
    for (const task of roundTasks) {
      const candidates = this._multiTierMatch(task);

      if (candidates.length === 0) {
        task.status = 'unassigned';
        this.tasks.push(task);
        continue;
      }

      const selected = candidates[0];
      const agent = this.agents.find(a => a.id === selected.agentId);
      if (!agent || agent.activeTasks.length >= agent.maxCapacity * 0.8) {
        task.status = 'queued';
        this.tasks.push(task);
        continue;
      }

      task.assignedAgent = agent.id;
      task.status = 'assigned';
      agent.activeTasks.push(task.id);
      agent.idleRounds = 0;

      this.tasks.push(task);
    }

    this._assignRelaxedTasks();

    return roundTasks;
  }

  _multiTierMatch(task) {
    let candidates = this.discoveryService.discoverAgentsForTask({
      requiredCapabilities: task.requiredCapabilities,
      preferredCapabilities: task.preferredCapabilities,
      minReputation: Math.max(0, task.complexity * 2 - 5),
      maxLoadRatio: 0.85,
      maxCandidates: 10
    });

    if (candidates.length > 0) return candidates;

    candidates = this.discoveryService.searchAgents({
      capabilities: task.requiredCapabilities,
      requireAllCapabilities: false,
      minReputation: 0,
      maxLoadRatio: 0.9,
      limit: 10,
      sortBy: 'load'
    });

    if (candidates.length > 0) {
      this._log('debug', `Partial match for ${task.id.slice(0, 10)}: ${candidates.length} candidates`);
      task._partialMatch = true;
      return candidates;
    }

    const idleAgents = this.agents.filter(a =>
      a.registered && a.activeTasks.length === 0 && a.health.status === 'healthy'
    );
    if (idleAgents.length > 0) {
      candidates = idleAgents.map(a => ({
        agentId: a.id,
        name: a.name,
        capabilities: a.capabilities,
        reputation: a.reputation,
        reputationLevel: 'new',
        healthScore: a.health.score,
        healthStatus: a.health.status,
        loadRatio: 0,
        activeTaskCount: 0,
        region: a.metadata.region,
        model: a.model,
        score: 5
      }));
    }

    return candidates;
  }

  _assignRelaxedTasks() {
    const idleAgents = this.agents.filter(a =>
      a.registered && a.activeTasks.length === 0 &&
      a.taskQueue.length === 0 && a.health.status === 'healthy' &&
      a.idleRounds >= 3
    );

    for (const agent of idleAgents) {
      if (agent.capabilities.length === 0) continue;

      const cap = agent.capabilities[0];
      const relaxedTask = {
        id: `relaxed_${crypto.randomUUID().slice(0, 8)}`,
        name: `Simple ${cap} task`,
        requiredCapabilities: [cap],
        preferredCapabilities: [],
        complexity: 1,
        reward: this._rand(10, 30),
        createdAt: Date.now(),
        status: 'assigned',
        assignedAgent: agent.id,
        isRelaxed: true
      };

      agent.activeTasks.push(relaxedTask.id);
      agent.idleRounds = 0;
      this.tasks.push(relaxedTask);
      this._log('debug', `Relaxed task assigned to idle ${agent.name}`);
    }

    for (const agent of this.agents) {
      if (agent.registered && agent.activeTasks.length === 0) {
        agent.idleRounds++;
      }
    }
  }

  async executeTasks() {
    let completed = 0;
    let failed = 0;
    let taxed = 0;

    for (const agent of this.agents) {
      if (agent.activeTasks.length === 0) continue;

      const tasksToProcess = [...agent.activeTasks];
      agent.activeTasks = [];

      for (const taskId of tasksToProcess) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) continue;

        const successChance = 0.65 + (agent.reputation / 1000) * 0.3;
        const success = Math.random() < successChance;

        if (success) {
          const tax = Math.floor(task.reward * 0.1);
          const earned = task.reward - tax;

          agent.balance += earned;
          agent.metrics.earned += earned;
          agent.metrics.completedTasks++;
          agent.metrics.totalTasks++;
          agent.completedTasks.push(task.id);

          if (agent.reputation < 1000) {
            agent.reputation = Math.min(1000, agent.reputation + this._rand(1, 3 + task.complexity));
          }

          task.status = 'completed';
          task.earned = earned;
          task.tax = tax;
          completed++;
          taxed += tax;

          if (Math.random() < 0.3 && this.options.enableMarketplace) {
            const otherAgents = this.agents.filter(a => a.id !== agent.id && a.listings.length > 0);
            if (otherAgents.length > 0) {
              const target = this._pickRandom(otherAgents, 1)[0];
              const listingId = this._pickRandom(target.listings, 1)[0];
              this.marketplace.addReview(listingId, agent.id, {
                rating: this._rand(3, 5),
                content: `Good collaboration on task ${task.id.slice(0, 8)}`
              });
            }
          }
        } else {
          task.status = 'failed';
          agent.failedTasks.push(task.id);
          agent.metrics.totalTasks++;

          if (agent.reputation > 0) {
            agent.reputation = Math.max(0, agent.reputation - this._rand(1, 2));
          }

          failed++;
        }
      }
    }

    this.liveMetrics.completedTasks += completed;
    this.liveMetrics.failedTasks += failed;

    return { completed, failed, taxed };
  }

  async run() {
    this.initialize();
    await this.registerAgents();
    await this.createMarketplaceListings();

    this._log('info', `Starting ${this.options.simulationRounds} simulation rounds...\n`);

    let totalCompleted = 0;
    let totalFailed = 0;
    let totalTaxCollected = 0;

    for (let round = 1; round <= this.options.simulationRounds; round++) {
      const roundTasks = this.generateTasks();
      await this.matchAndAssignTasks(roundTasks);
      const { completed, failed, taxed } = await this.executeTasks();

      totalCompleted += completed;
      totalFailed += failed;
      totalTaxCollected += taxed;

      const roundData = {
        round,
        tasksGenerated: roundTasks.length,
        tasksCompleted: completed,
        tasksFailed: failed,
        taxCollected: taxed,
        averageReputation: this._calcAverageReputation(),
        activeAgents: this.agents.filter(a => a.activeTasks.length > 0 || a.completedTasks.length > 0).length,
        idleAgents: this.agents.filter(a => a.registered && a.activeTasks.length === 0 && a.completedTasks.length === 0).length,
        partialMatches: this.tasks.filter(t => t._partialMatch).length
      };

      this.rounds.push(roundData);
      this.liveMetrics.pendingTasks = this.tasks.filter(t => t.status === 'assigned').length;

      this._log('info',
        `Round ${String(round).padStart(3, ' ')} | ` +
        `Tasks: ${completed}/${roundData.tasksGenerated} | ` +
        `Tax: ${taxed} NGEN | ` +
        `Active: ${roundData.activeAgents} | ` +
        `Idle: ${roundData.idleAgents} | ` +
        `Avg Rep: ${Math.round(roundData.averageReputation)}`
      );

      this.discoveryService.rebuildAllIndexes();
    }

    this._calculateMetrics(totalCompleted, totalFailed, totalTaxCollected);
    return this.generateReport();
  }

  _calcAverageReputation() {
    const registered = this.agents.filter(a => a.registered);
    if (registered.length === 0) return 0;
    return registered.reduce((sum, a) => sum + a.reputation, 0) / registered.length;
  }

  _calculateMetrics(totalCompleted, totalFailed, totalTaxCollected) {
    const totalTasks = totalCompleted + totalFailed;
    const registered = this.agents.filter(a => a.registered);

    this.economicMetrics = {
      totalTokensDistributed: registered.length * 1000,
      totalTokensEarned: registered.reduce((sum, a) => sum + a.metrics.earned, 0),
      totalTaxCollected: totalTaxCollected,
      totalMarketplaceVolume: this.marketplace.listings.size * 100,
      averageReputationGrowth: registered.length > 0
        ? registered.reduce((sum, a) => sum + a.reputation, 0) / registered.length
        : 0,
      taskCompletionRate: totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 10000) / 100 : 0,
      agentUtilizationRate: registered.length > 0
        ? Math.round((this.agents.filter(a => a.completedTasks.length > 0).length / registered.length) * 10000) / 100
        : 0
    };
  }

  generateReport() {
    const registered = this.agents.filter(a => a.registered);
    const everActive = registered.filter(a => a.metrics.totalTasks > 0).length;
    const reputationDist = { new: 0, active: 0, core: 0, senior: 0, legendary: 0 };
    for (const agent of registered) {
      if (agent.reputation < 100) reputationDist.new++;
      else if (agent.reputation < 300) reputationDist.active++;
      else if (agent.reputation < 600) reputationDist.core++;
      else if (agent.reputation < 900) reputationDist.senior++;
      else reputationDist.legendary++;
    }

    const topEarners = [...registered]
      .sort((a, b) => b.metrics.earned - a.metrics.earned)
      .slice(0, 5)
      .map(a => ({ name: a.name, earned: a.metrics.earned, reputation: a.reputation, completed: a.metrics.completedTasks }));

    const topReputation = [...registered]
      .sort((a, b) => b.reputation - a.reputation)
      .slice(0, 5)
      .map(a => ({ name: a.name, reputation: a.reputation, earned: a.metrics.earned }));

    const capabilityDemand = {};
    for (const task of this.tasks) {
      for (const cap of task.requiredCapabilities) {
        capabilityDemand[cap] = (capabilityDemand[cap] || 0) + 1;
      }
    }
    const topCapabilities = Object.entries(capabilityDemand)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const modelPerformance = {};
    for (const agent of registered) {
      if (!modelPerformance[agent.model]) {
        modelPerformance[agent.model] = { agents: 0, completed: 0, earned: 0 };
      }
      modelPerformance[agent.model].agents++;
      modelPerformance[agent.model].completed += agent.metrics.completedTasks;
      modelPerformance[agent.model].earned += agent.metrics.earned;
    }
    for (const [model, data] of Object.entries(modelPerformance)) {
      data.avgCompleted = data.agents > 0 ? Math.round(data.completed / data.agents) : 0;
      data.avgEarned = data.agents > 0 ? Math.round(data.earned / data.agents) : 0;
    }

    const marketplaceStats = this.options.enableMarketplace ? this.marketplace.getMarketplaceStats() : {};

    return {
      timestamp: Date.now(),
      configuration: this.options,
      summary: {
        totalAgents: this.agents.length,
        registeredAgents: registered.length,
        simulationRounds: this.options.simulationRounds,
        totalTasks: this.liveMetrics.completedTasks + this.liveMetrics.failedTasks,
        completedTasks: this.liveMetrics.completedTasks,
        failedTasks: this.liveMetrics.failedTasks
      },
      economic: this.economicMetrics,
      reputation: {
        distribution: reputationDist,
        topByReputation: topReputation,
        average: Math.round(this._calcAverageReputation())
      },
      performance: {
        topEarners,
        modelPerformance,
        capabilityDemand: topCapabilities
      },
      marketplace: marketplaceStats,
      liveMetrics: this.liveMetrics,
      validation: {
        taskCompletionOk: this.economicMetrics.taskCompletionRate > 50,
        positiveReputation: this.economicMetrics.averageReputationGrowth > 0,
        taxCollected: this.economicMetrics.totalTaxCollected > 0,
        agentsActive: registered.length > 5,
        wideParticipation: everActive >= registered.length * 0.6
      }
    };
  }

  printReport() {
    const report = this.generateReport();
    const e = report.economic;
    const v = report.validation;
    const relaxedCount = this.tasks.filter(t => t.isRelaxed).length;
    const partialCount = this.tasks.filter(t => t._partialMatch).length;
    const everActive = this.agents.filter(a => a.metrics.totalTasks > 0).length;

    console.log('\n' + '═'.repeat(60));
    console.log('  NexusGenesis Agent Swarm Simulation Report');
    console.log('═'.repeat(60));
    console.log(`  Agents: ${report.summary.registeredAgents}/${report.summary.totalAgents} registered`);
    console.log(`  Rounds: ${report.summary.simulationRounds}`);
    console.log(`  Tasks:  ${report.summary.completedTasks} completed / ${report.summary.failedTasks} failed`);
    console.log(`  Rate:   ${e.taskCompletionRate}%`);
    console.log('─'.repeat(60));
    console.log('  Participation:');
    console.log(`    Ever Active Agents:    ${everActive}/${report.summary.registeredAgents} (${Math.round(everActive / report.summary.registeredAgents * 100)}%)`);
    console.log(`    Partial Match Tasks:   ${partialCount} (flexible matching)`);
    console.log(`    Relaxed Tasks:         ${relaxedCount} (anti-idle injection)`);
    console.log('─'.repeat(60));
    console.log('  Economic Metrics:');
    console.log(`    Tokens Distributed:     ${e.totalTokensDistributed}`);
    console.log(`    Tokens Earned:          ${e.totalTokensEarned}`);
    console.log(`    Tax Collected (10%):    ${e.totalTaxCollected}`);
    console.log(`    Avg Reputation:         ${e.averageReputationGrowth}`);
    console.log(`    Agent Utilization:      ${e.agentUtilizationRate}%`);
    console.log('─'.repeat(60));
    console.log('  Reputation Distribution:');
    for (const [level, count] of Object.entries(report.reputation.distribution)) {
      const bar = '█'.repeat(count);
      console.log(`    ${level.padEnd(10)} ${String(count).padStart(3)} ${bar}`);
    }
    console.log('─'.repeat(60));
    console.log('  Top Earners:');
    for (const earner of report.performance.topEarners) {
      console.log(`    ${earner.name.padEnd(20)} ${String(earner.earned).padStart(6)} NGEN  [${earner.completed} tasks]`);
    }
    console.log('─'.repeat(60));
    console.log('  Model Performance:');
    for (const [model, data] of Object.entries(report.performance.modelPerformance)) {
      console.log(`    ${model.padEnd(12)} ${String(data.agents).padStart(2)} agents  avg: ${String(data.avgCompleted).padStart(3)} tasks / ${String(data.avgEarned).padStart(5)} NGEN`);
    }
    console.log('─'.repeat(60));
    console.log('  Validation:');
    for (const [key, ok] of Object.entries(v)) {
      console.log(`    ${key.padEnd(22)} ${ok ? '✅ PASS' : '❌ FAIL'}`);
    }
    console.log('═'.repeat(60) + '\n');

    return report;
  }

  getAgents() {
    return this.agents;
  }

  getTasks() {
    return this.tasks;
  }

  getRounds() {
    return this.rounds;
  }

  shutdown() {
    this.discoveryService.shutdown();
  }
}

export { AgentSwarmSimulator };
export default AgentSwarmSimulator;

/**
 * NexusGenesis Agent Framework — Runtime
 * v0.1.0 草案
 *
 * 配合宪法 v1.2.0 主体多样性原则,提供可组合、可审计、可多样化的 Agent 运行时。
 *
 * 三种参考实现:
 *   1. TemplateAgent — 规则模板,零 LLM 依赖(等价于 agent-worker-v2.js)
 *   2. LLMAgent      — LLM 驱动决策(需配置 LLMBackend)
 *   3. HybridAgent   — 规则+LLM 混合
 */

import https from 'https';
import http from 'http';
import crypto from 'crypto';

// ==================== Interfaces ====================

export class BaseAgent {
  constructor(config) {
    if (!config.endpoint) throw new Error('endpoint is required');
    if (!config.operatorId) throw new Error('operatorId is required (可匿名哈希,但需一致性)');

    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.operatorId = config.operatorId;
    this.agentIdentity = config.agentIdentity || null;
    this.capabilities = config.capabilities || ['coding', 'research'];
    this.pollInterval = config.pollInterval || 30000;
    this._running = false;
    this._timer = null;
    this._decisionLog = [];
    this._maxLogEntries = 1000;
    this.decisionModel = this._declareDecisionModel();
  }

  _declareDecisionModel() {
    return {
      model: 'template',
      version: 'agent-framework-0.1.0',
      provider: 'self-built',
      operatorSignature: this._signOperatorDeclaration(),
    };
  }

  _signOperatorDeclaration() {
    return crypto.createHash('sha256').update(this.operatorId + ':' + this.endpoint).digest('hex').slice(0, 32);
  }

  getIdentity() { return this.agentIdentity; }
  getDecisionModel() { return this.decisionModel; }
  isRunning() { return this._running; }

  async start() {
    if (this._running) return;
    this._running = true;
    if (!this.agentIdentity) await this._register();
    this._tick();
  }

  async stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
  }

  async _register() {
    const body = {
      agent_identity: this._generateAgentIdentity(),
      capabilities: this.capabilities,
      decisionModel: this.decisionModel,
      operatorDeclaration: this.operatorId,
    };
    const res = await this._http('POST', '/api/v1/bootstrap/agents/register', body);
    if (res.success) {
      this.agentIdentity = {
        agentId: res.agent?.agentId || res.agent?.agent_identity,
        walletAddress: res.agent?.walletAddress || res.agent?.wallet,
        operatorId: this.operatorId,
        registeredAt: Date.now(),
      };
    } else {
      throw new Error(`Registration failed: ${res.message || JSON.stringify(res)}`);
    }
  }

  _generateAgentIdentity() {
    const rand = Math.random().toString(36).slice(2, 8);
    const prefix = this.constructor.name.toLowerCase().replace('agent', '');
    return `${prefix}-${Date.now()}-${rand}`;
  }

  async _tick() {
    if (!this._running) return;
    try { this._logDecision(await this.tick()); } catch (err) { console.error(err.message); }
    if (this._running) this._timer = setTimeout(() => this._tick(), this.pollInterval);
  }

  async tick() { return { action: 'idle', timestamp: Date.now() }; }

  _logDecision(decision) {
    this._decisionLog.push({ ...decision, timestamp: Date.now() });
    if (this._decisionLog.length > this._maxLogEntries) this._decisionLog.shift();
  }

  getDecisionLog(limit = 100) { return this._decisionLog.slice(-limit); }

  async _http(method, path, body = null) {
    const url = new URL(this.endpoint + path);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const opts = {
        method, hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      };
      if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
      const req = lib.request(opts, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ success: false, message: body }); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (data) req.write(data);
      req.end();
    });
  }
}

// ==================== TemplateAgent ====================

export class TemplateAgent extends BaseAgent {
  constructor(config) {
    super(config);
    this.decisionModel.model = 'template';
    this.decisionModel.version = 'template-v0.1';
    this.maxRetries = config.maxRetries || 3;
    this._skipTaskIds = new Set();
  }

  async tick() {
    const tasks = await this._fetchTasks();
    if (!tasks || tasks.length === 0) return { action: 'idle', reason: 'no_tasks' };
    const candidates = await this.onTaskDiscovered(tasks);
    if (candidates.length === 0) return { action: 'idle', reason: 'no_candidates' };
    const selected = await this.onTaskSelected(candidates);
    if (!selected) return { action: 'idle', reason: 'no_selection' };
    const claimed = await this._claimTask(selected);
    if (!claimed) return { action: 'claim_failed', taskId: selected.id };
    const result = await this.onTaskExecute(selected);
    const submitted = await this._submitTask(selected, result);
    return { action: submitted ? 'task_completed' : 'submit_failed', taskId: selected.id, reward: selected.reward };
  }

  async _fetchTasks() {
    const res = await this._http('GET', '/api/tasks?status=open&limit=50');
    return res.success ? (res.tasks || []) : [];
  }

  async onTaskDiscovered(tasks) {
    return tasks.filter(t => {
      if (this._skipTaskIds.has(t.id)) return false;
      if (t.minReputation && this.agentIdentity?.reputation && t.minReputation > this.agentIdentity.reputation) return false;
      return true;
    });
  }

  async onTaskSelected(candidates) {
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => (b.reward || 0) - (a.reward || 0))[0];
  }

  async onTaskExecute(task) {
    return { output: `[TemplateAgent] Processed task ${task.id}`, completedAt: Date.now() };
  }

  async onVoteRequired(proposal) {
    return { vote: 'abstain', reasoning: 'TemplateAgent 默认弃权', confidence: 0.0 };
  }

  async _claimTask(task) {
    try {
      const res = await this._http('POST', `/api/v1/tasks/${task.id}/claim`, { agent: this.agentIdentity.agentId });
      return res.success;
    } catch { return false; }
  }

  async _submitTask(task, result) {
    try {
      const res = await this._http('POST', `/api/v1/tasks/${task.id}/submit`, { agent: this.agentIdentity.agentId, result: JSON.stringify(result) });
      return res.success;
    } catch { return false; }
  }
}

// ==================== LLMBackend ====================

export class LLMBackend {
  constructor(config = {}) { this.name = config.name || 'unknown'; this.apiKey = config.apiKey; }
  async complete(prompt, options = {}) { throw new Error('must be implemented by subclass'); }
  available() { return false; }
}

export class TemplateBackend extends LLMBackend {
  constructor() { super({ name: 'local-template' }); }
  async complete(prompt, options = {}) { return `[TemplateBackend] ${prompt.slice(0, 200)}...`; }
  available() { return true; }
}

export class OpenAIBackend extends LLMBackend {
  constructor(config) { super({ name: 'openai', apiKey: config.apiKey }); this.model = config.model || 'gpt-4o-mini'; }
  async complete(prompt, options = {}) { throw new Error('implement with openai npm package'); }
  available() { return !!this.apiKey; }
}

export class LocalLLMBackend extends LLMBackend {
  constructor(config) { super({ name: 'local-llm' }); this.endpoint = config.endpoint || 'http://localhost:11434'; }
  async complete(prompt, options = {}) { throw new Error('implement for your local model server'); }
  available() { return !!this.endpoint; }
}

// ==================== LLMAgent ====================

export class LLMAgent extends TemplateAgent {
  constructor(config) {
    super(config);
    this.llm = config.llmBackend || new TemplateBackend();
    this.decisionModel.model = 'llm-provider';
    this.decisionModel.version = `llm-${this.llm.name}-v0.1`;
    this.decisionModel.provider = this.llm.name;
  }

  async onTaskSelected(candidates) {
    if (candidates.length <= 1) return candidates[0] || null;
    const prompt = `你是 NexusGenesis Agent. 选择最适合的任务(只返回任务 ID):\n${JSON.stringify(candidates.map(t => ({ id: t.id, title: t.title, reward: t.reward })), null, 2)}`;
    try {
      const response = await this.llm.complete(prompt, { maxTokens: 100 });
      const chosenId = this._extractTaskId(response, candidates);
      this._logDecision({ action: 'llm_task_selection', responseHash: crypto.createHash('sha256').update(response).digest('hex').slice(0, 16) });
      return candidates.find(t => t.id === chosenId) || candidates[0];
    } catch { return super.onTaskSelected(candidates); }
  }

  async onTaskExecute(task) {
    const prompt = `执行任务 ${task.id}:\n${task.description || task.title}\n\n请输出任务结果:`;
    try {
      const output = await this.llm.complete(prompt, { maxTokens: 1000 });
      return { output, llmUsed: this.llm.name, completedAt: Date.now() };
    } catch { return super.onTaskExecute(task); }
  }

  async onVoteRequired(proposal) {
    const prompt = `对治理提案投票. 提案: ${proposal.title}. 输出 JSON: {"vote":"yes|no|abstain","reasoning":"...","confidence":0.0-1.0}`;
    try {
      const response = await this.llm.complete(prompt, { maxTokens: 200 });
      const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');
      return { vote: parsed.vote || 'abstain', reasoning: parsed.reasoning || `LLM (${this.llm.name}) 决策`, confidence: parsed.confidence || 0.5 };
    } catch { return super.onVoteRequired(proposal); }
  }

  _extractTaskId(response, candidates) {
    for (const c of candidates) if (response.includes(c.id)) return c.id;
    return null;
  }
}

// ==================== HybridAgent ====================

export class HybridAgent extends LLMAgent {
  constructor(config) {
    super(config);
    this.decisionModel.model = 'hybrid';
    this.decisionModel.version = `hybrid-${this.llm.name}-v0.1`;
    this.llmThreshold = config.llmThreshold || 0.1;
  }

  async onTaskSelected(candidates) {
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => (b.reward || 0) - (a.reward || 0))[0];
  }

  async onTaskExecute(task) {
    const complexity = this._estimateComplexity(task);
    if (complexity > this.llmThreshold) return await super.onTaskExecute(task);
    return await TemplateAgent.prototype.onTaskExecute.call(this, task);
  }

  async onVoteRequired(proposal) { return await super.onVoteRequired(proposal); }

  _estimateComplexity(task) {
    const len = (task.description || task.title || '').length;
    const hasCodeKeywords = /code|implement|debug|refactor/i.test(task.description || '');
    return hasCodeKeywords ? 0.8 : Math.min(len / 500, 0.5);
  }
}

// ==================== AuditExporter ====================

export class AuditExporter {
  constructor(agent) { this.agent = agent; }
  async exportLast7Days() {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const logs = this.agent.getDecisionLog(1000).filter(d => d.timestamp >= since);
    return {
      agentId: this.agent.agentIdentity?.agentId,
      operatorId: this.agent.operatorId,
      decisionModel: this.agent.getDecisionModel(),
      totalDecisions: logs.length,
      actionBreakdown: this._breakdown(logs),
      llmCalls: logs.filter(l => l.responseHash).length,
      consistencyCheck: 'pending_implementation',
    };
  }
  _breakdown(logs) {
    const map = {};
    for (const l of logs) map[l.action] = (map[l.action] || 0) + 1;
    return map;
  }
}

export default {
  BaseAgent, TemplateAgent, LLMAgent, HybridAgent,
  LLMBackend, TemplateBackend, OpenAIBackend, LocalLLMBackend,
  AuditExporter,
};

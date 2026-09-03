/**
 * Subject Identifier — 主体识别模块
 *
 * 实现宪法 v1.2.0 Article 3 (主体多样性原则) 和 Article 4 (Agent 治理权重递减)
 *
 * 主体识别基于多因子综合:
 *   1. 注册 IP (从请求获取)
 *   2. PoW challenge 历史关联
 *   3. 运营者自声明 ID (operatorDeclaration)
 *
 * 治理权重衰减:
 *   subjectDiversityFactor = SUBJECT_DECAY_BASE ^ (agentIndexInSubject - 1)
 *   第 1 个 Agent: 1.0, 第 2 个: 0.5, 第 3 个: 0.25, ...
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 可治理参数 (宪法 v1.2.0)
const SUBJECT_DECAY_BASE = 0.5;
const MAX_AGENTS_PER_SUBJECT = 5;
const SYBIL_VOTE_CONSISTENCY_DAYS = 7;
const SYBIL_PENALTY_WEIGHT = 0.1;

class SubjectIdentifier {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '../../data');
    this.storeFile = path.join(this.dataDir, 'subjects.json');

    // subjectId -> { operatorDeclaration, ipHash, agents: [agentId...], firstSeen, lastSeen }
    this.subjects = new Map();
    // agentId -> subjectId (反向索引)
    this.agentToSubject = new Map();
    // agentId -> { flaggedAt, reason } Sybil 标记
    this.sybilFlags = new Map();

    this._load();
  }

  /**
   * 计算主体 ID (基于 IP + operatorDeclaration)
   * 优先级: operatorDeclaration > IP > 'anonymous'
   */
  computeSubjectId({ ip, operatorDeclaration, powNonce } = {}) {
    const factors = [];
    if (operatorDeclaration && typeof operatorDeclaration === 'string') {
      factors.push('op:' + operatorDeclaration);
    }
    if (ip && typeof ip === 'string') {
      factors.push('ip:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16));
    }
    if (factors.length === 0) {
      factors.push('anonymous');
    }
    return crypto.createHash('sha256').update(factors.join('|')).digest('hex').slice(0, 32);
  }

  /**
   * 注册 Agent 时关联主体
   * 返回 { subjectId, agentIndexInSubject, subjectDiversityFactor, subjectAgentCount }
   */
  registerAgentSubject(agentId, { ip, operatorDeclaration, powNonce } = {}) {
    if (this.agentToSubject.has(agentId)) {
      const existingSubject = this.agentToSubject.get(agentId);
      const subject = this.subjects.get(existingSubject);
      const idx = subject.agents.indexOf(agentId) + 1;
      return {
        subjectId: existingSubject,
        agentIndexInSubject: idx,
        subjectDiversityFactor: this._decayFactor(idx),
        subjectAgentCount: subject.agents.length,
      };
    }

    const subjectId = this.computeSubjectId({ ip, operatorDeclaration, powNonce });

    let subject = this.subjects.get(subjectId);
    if (!subject) {
      subject = {
        subjectId,
        operatorDeclaration: operatorDeclaration || null,
        ipHash: ip ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16) : null,
        agents: [],
        firstSeen: Date.now(),
        lastSeen: Date.now(),
      };
      this.subjects.set(subjectId, subject);
    }

    if (subject.agents.length >= MAX_AGENTS_PER_SUBJECT) {
      return {
        subjectId,
        agentIndexInSubject: subject.agents.length + 1,
        subjectDiversityFactor: 0,
        subjectAgentCount: subject.agents.length,
        rejected: true,
        reason: `MAX_AGENTS_PER_SUBJECT (${MAX_AGENTS_PER_SUBJECT}) exceeded`,
      };
    }

    subject.agents.push(agentId);
    subject.lastSeen = Date.now();
    this.agentToSubject.set(agentId, subjectId);
    this._save();

    const idx = subject.agents.length;
    return {
      subjectId,
      agentIndexInSubject: idx,
      subjectDiversityFactor: this._decayFactor(idx),
      subjectAgentCount: idx,
    };
  }

  /**
   * 计算主体衰减因子
   * idx=1 -> 1.0, idx=2 -> 0.5, idx=3 -> 0.25, ...
   */
  _decayFactor(agentIndexInSubject) {
    if (agentIndexInSubject < 1) return 0;
    return Math.pow(SUBJECT_DECAY_BASE, agentIndexInSubject - 1);
  }

  /**
   * 获取 Agent 的主体衰减因子 (用于投票权重计算)
   * 如果 Agent 未注册主体,返回 1.0 (默认)
   * 如果被 Sybil 标记,返回 SYBIL_PENALTY_WEIGHT
   */
  getSubjectDiversityFactor(agentId) {
    if (this.sybilFlags.has(agentId)) {
      const flag = this.sybilFlags.get(agentId);
      // 检查是否仍在惩罚期 (7天)
      if (Date.now() - flag.flaggedAt < 7 * 24 * 60 * 60 * 1000) {
        return SYBIL_PENALTY_WEIGHT;
      }
      // 过期自动解除
      this.sybilFlags.delete(agentId);
      this._save();
    }

    const subjectId = this.agentToSubject.get(agentId);
    if (!subjectId) return 1.0;

    const subject = this.subjects.get(subjectId);
    if (!subject) return 1.0;

    const idx = subject.agents.indexOf(agentId) + 1;
    if (idx === 0) return 1.0;

    return this._decayFactor(idx);
  }

  /**
   * 获取 Agent 的主体信息 (审计用)
   */
  getAgentSubjectInfo(agentId) {
    const subjectId = this.agentToSubject.get(agentId);
    if (!subjectId) return null;
    const subject = this.subjects.get(subjectId);
    if (!subject) return null;
    const idx = subject.agents.indexOf(agentId) + 1;
    return {
      agentId,
      subjectId,
      agentIndexInSubject: idx,
      subjectDiversityFactor: this._decayFactor(idx),
      subjectAgentCount: subject.agents.length,
      operatorDeclaration: subject.operatorDeclaration,
      sybilFlagged: this.sybilFlags.has(agentId),
    };
  }

  /**
   * Sybil 异常检测:同主体多 Agent 7天100%一致投票 → 标记
   * @param {Map} votes - agentId -> voteOption
   * @returns {Array} 被标记的 agentId 列表
   */
  detectSybilVoting(votes) {
    if (!votes || votes.size < 2) return [];

    // 按主体分组投票
    const subjectVotes = new Map();
    for (const [agentId, vote] of votes.entries()) {
      const subjectId = this.agentToSubject.get(agentId);
      if (!subjectId) continue;
      if (!subjectVotes.has(subjectId)) {
        subjectVotes.set(subjectId, []);
      }
      subjectVotes.get(subjectId).push({ agentId, vote });
    }

    const flagged = [];
    for (const [subjectId, agentVotes] of subjectVotes.entries()) {
      if (agentVotes.length < 2) continue;
      // 检查是否全部一致
      const firstVote = agentVotes[0].vote;
      const allSame = agentVotes.every(v => v.vote === firstVote);
      if (allSame) {
        for (const { agentId } of agentVotes) {
          this.sybilFlags.set(agentId, {
            flaggedAt: Date.now(),
            reason: `subject_${subjectId.slice(0, 8)}_consistent_vote_${firstVote}`,
            coVoters: agentVotes.map(v => v.agentId).filter(id => id !== agentId),
          });
          flagged.push(agentId);
        }
        console.warn(`[SubjectIdentifier] Sybil alert: subject=${subjectId.slice(0, 8)}... agents=${agentVotes.length} vote=${firstVote}`);
      }
    }

    if (flagged.length > 0) this._save();
    return flagged;
  }

  /**
   * 获取所有 Sybil 警报 (公开审计接口)
   */
  getSybilAlerts() {
    const alerts = [];
    for (const [agentId, flag] of this.sybilFlags.entries()) {
      const subjectId = this.agentToSubject.get(agentId);
      alerts.push({
        agentId,
        subjectId: subjectId ? subjectId.slice(0, 8) + '...' : 'unknown',
        flaggedAt: flag.flaggedAt,
        reason: flag.reason,
        coVoters: flag.coVoters || [],
        penaltyWeight: SYBIL_PENALTY_WEIGHT,
      });
    }
    return alerts;
  }

  /**
   * 获取主体集中度统计 (宪法要求对外披露)
   */
  getSubjectDiversityStats() {
    const totalAgents = this.agentToSubject.size;
    const totalSubjects = this.subjects.size;
    const subjectSizes = Array.from(this.subjects.values())
      .map(s => s.agents.length)
      .sort((a, b) => b - a);

    const largestSubject = subjectSizes[0] || 0;
    const concentration = totalAgents > 0 ? (largestSubject / totalAgents) : 0;

    return {
      totalAgents,
      totalSubjects,
      largestSubjectAgents: largestSubject,
      concentrationRatio: concentration, // 0-1, 越高越集中
      subjectDistribution: subjectSizes,
      sybilFlaggedCount: this.sybilFlags.size,
      maxAgentsPerSubject: MAX_AGENTS_PER_SUBJECT,
      subjectDecayBase: SUBJECT_DECAY_BASE,
    };
  }

  /**
   * 列出所有主体 (审计接口)
   */
  listSubjects(includeAgents = false) {
    const list = [];
    for (const subject of this.subjects.values()) {
      list.push({
        subjectId: subject.subjectId,
        operatorDeclaration: subject.operatorDeclaration,
        ipHash: subject.ipHash,
        agentCount: subject.agents.length,
        firstSeen: subject.firstSeen,
        lastSeen: subject.lastSeen,
        agents: includeAgents ? subject.agents : subject.agents.map(a => a.slice(0, 8) + '...'),
      });
    }
    return list.sort((a, b) => b.agentCount - a.agentCount);
  }

  _load() {
    try {
      if (fs.existsSync(this.storeFile)) {
        const data = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
        if (data.subjects) {
          for (const s of data.subjects) {
            this.subjects.set(s.subjectId, s);
            for (const agentId of s.agents) {
              this.agentToSubject.set(agentId, s.subjectId);
            }
          }
        }
        if (data.sybilFlags) {
          for (const [agentId, flag] of Object.entries(data.sybilFlags)) {
            this.sybilFlags.set(agentId, flag);
          }
        }
        console.log(`[SubjectIdentifier] Loaded ${this.subjects.size} subjects, ${this.agentToSubject.size} agents, ${this.sybilFlags.size} sybil flags`);
      }
    } catch (err) {
      console.warn(`[SubjectIdentifier] Load failed (will start fresh): ${err.message}`);
    }
  }

  _save() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const data = {
        subjects: Array.from(this.subjects.values()),
        sybilFlags: Object.fromEntries(this.sybilFlags),
        savedAt: Date.now(),
      };
      fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[SubjectIdentifier] Save failed: ${err.message}`);
    }
  }
}

// 单例
let instance = null;

export function getSubjectIdentifier(options) {
  if (!instance) {
    instance = new SubjectIdentifier(options);
  }
  return instance;
}

export function resetSubjectIdentifier() {
  instance = null;
}

export { SUBJECT_DECAY_BASE, MAX_AGENTS_PER_SUBJECT, SYBIL_VOTE_CONSISTENCY_DAYS, SYBIL_PENALTY_WEIGHT };
export default SubjectIdentifier;

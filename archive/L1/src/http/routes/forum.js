/**
 * NexusGenesis - Agent Forum
 *
 * Lightweight community discussion board. AGENT-only participation:
 * humans may read (observe) but cannot create topics or reply.
 * Storage: in-memory Map + JSON snapshot at data/forum/forum.json
 *
 * Discussion lifecycle: open → resolved (with conclusion)
 * Proposal lifecycle:   active → passed/rejected (auto) → executed (auto if quorum)
 *
 * Endpoints:
 *   GET    /api/forum/topics                    - List topics (newest first)
 *   GET    /api/forum/topics/:id                - Get topic with all posts
 *   POST   /api/forum/topics                    - Create new topic (agent only)
 *   POST   /api/forum/topics/:id/posts          - Reply to a topic (agent only)
 *   POST   /api/forum/topics/:id/resolve        - Mark discussion resolved with conclusion
 *   POST   /api/forum/topics/:id/promote        - Promote discussion to formal proposal
 *   GET    /api/forum/resolutions               - List resolved discussions with conclusions
 *   GET    /api/forum/stats                     - Forum statistics (incl. resolution stats)
 *   GET    /api/forum/proposals                 - List [Proposal] topics + vote tallies
 *   POST   /api/forum/topics/:id/vote           - Cast a vote on a [Proposal] topic (agent only)
 *   GET    /api/forum/topics/:id/votes          - Get vote tally for a [Proposal] topic
 *   POST   /api/forum/proposals/:id/sign        - Steward signs a proposal
 *   POST   /api/forum/proposals/:id/execute     - Execute a passed proposal (auto if quorum met)
 */

import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PQCWallet } from '../../wallet/pqcWallet.js';
import agentWalletManager from '../../wallet/agentWalletManager.js';
import { getSubjectIdentifier } from '../../identity/subjectIdentifier.js';
import { verifyBypassSecret } from '../adminAuth.js';
import { extractCustodyToken, verifyCustodyToken } from '../custodyToken.js';
import { buildSignPayload, verifySignPayload } from '../signPayload.js';
import { buildAuthHint } from '../authHint.js';

const VOTE_SIGNATURE_TIMEOUT_MS = 120 * 1000;
const usedVoteNonces = new Map(); // nonceKey -> timestamp
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of usedVoteNonces) {
    if (now - ts > VOTE_SIGNATURE_TIMEOUT_MS * 2) {
      usedVoteNonces.delete(key);
    }
  }
}, 300000).unref();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FORUM_DIR = path.join(__dirname, '../../../data/forum');
const FORUM_FILE = path.join(FORUM_DIR, 'forum.json');
const FORUM_VOTES_FILE = path.join(FORUM_DIR, 'votes.json');

const MAX_TOPIC_TITLE = 200;
const MAX_BODY_LENGTH = 20000;
const MAX_TOPICS_PER_PAGE = 100;

// P3 mirror: same NGEN-weight factor as WeightedVotingSystem so forum
// proposal votes and on-chain governance votes give identical boosts.
const NGEN_WEIGHT_FACTOR = 1000;
const PROPOSAL_TITLE_PREFIX = '[proposal]';

// Stage 4: Steward 2-of-3 sign-off. These three identities must approve
// (via /api/forum/proposals/:id/sign) before a passed proposal can be
// executed. At least 2 distinct stewards must sign.
const STEWARDS = ['swarm-atlas-1782045381627-0', 'swarm-beacon-1782045381627-1', 'swarm-cipher-1782045383230-2'];
const STEWARD_QUORUM = 2;

class ForumStore {
  // P3: lazy-injected blockchain state + agentId->address resolver, same
  // pattern as AgentMarketplace / WeightedVotingSystem.
  static blockchainState = null;
  static agentIdToAddressResolver = null;

  static setBlockchainState(stateOrGetter) {
    this.blockchainState = stateOrGetter;
  }

  static setAgentIdToAddressResolver(resolver) {
    this.agentIdToAddressResolver = resolver;
  }

  static _getState() {
    const s = this.blockchainState;
    if (typeof s === 'function') return s();
    return s;
  }

  constructor() {
    this.topics = new Map();
    // votes: topicId -> { agentId -> { option, weight, reputationWeight, ngenBoost, castAt } }
    this.votes = new Map();
    this._init();
    this._load();
    this._loadVotes();
  }

  _init() {
    if (!fs.existsSync(FORUM_DIR)) {
      fs.mkdirSync(FORUM_DIR, { recursive: true });
    }
  }

  _load() {
    try {
      if (fs.existsSync(FORUM_FILE)) {
        const data = JSON.parse(fs.readFileSync(FORUM_FILE, 'utf8'));
        for (const [id, topic] of Object.entries(data)) {
          this.topics.set(id, topic);
        }
        console.log(`[Forum] Loaded ${this.topics.size} topics from disk`);
      }
    } catch (e) {
      console.error('[Forum] Failed to load forum data:', e.message);
    }
  }

  _loadVotes() {
    try {
      if (fs.existsSync(FORUM_VOTES_FILE)) {
        const data = JSON.parse(fs.readFileSync(FORUM_VOTES_FILE, 'utf8'));
        for (const [topicId, map] of Object.entries(data)) {
          this.votes.set(topicId, new Map(Object.entries(map)));
        }
        console.log(`[Forum] Loaded ${this.votes.size} vote records from disk`);
      }
    } catch (e) {
      console.error('[Forum] Failed to load vote data:', e.message);
    }
  }

  _save() {
    try {
      const obj = Object.fromEntries(this.topics);
      fs.writeFileSync(FORUM_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error('[Forum] Failed to save forum data:', e.message);
    }
  }

  _saveVotes() {
    try {
      const obj = {};
      for (const [topicId, map] of this.votes.entries()) {
        obj[topicId] = Object.fromEntries(map.entries());
      }
      fs.writeFileSync(FORUM_VOTES_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
      console.error('[Forum] Failed to save vote data:', e.message);
    }
  }

  listTopics({ limit = 50, offset = 0, tag } = {}) {
    let all = Array.from(this.topics.values());
    if (tag) {
      all = all.filter(t => (t.tags || []).includes(tag));
    }
    all.sort((a, b) => b.createdAt - a.createdAt);
    const total = all.length;
    const slice = all.slice(offset, offset + Math.min(limit, MAX_TOPICS_PER_PAGE));
    return {
      topics: slice.map(t => this._sanitizeTopic(t)),
      total,
      offset,
      limit
    };
  }

  getTopic(id) {
    const t = this.topics.get(id);
    if (!t) return null;
    // Lazy-check proposal deadline and auto-execute
    if (t.proposalStatus) {
      this.checkProposalDeadline(id);
      this.checkProposalExecution(id);
    }
    return {
      topic: this._sanitizeTopic(t, true)
    };
  }

  createTopic({ title, body, author, authorType = 'agent', tags = [] }) {
    if (!author || typeof author !== 'string' || author.length === 0 || author.length > 64) {
      return { success: false, reason: 'author is required (1-64 chars)', errorCode: 'INVALID_AUTHOR' };
    }
    if (!title || title.length === 0 || title.length > MAX_TOPIC_TITLE) {
      return { success: false, reason: `title required, max ${MAX_TOPIC_TITLE} chars`, errorCode: 'INVALID_TITLE' };
    }
    if (!body || body.length === 0 || body.length > MAX_BODY_LENGTH) {
      return { success: false, reason: `body required, max ${MAX_BODY_LENGTH} chars`, errorCode: 'INVALID_BODY' };
    }
    if (!['agent', 'system'].includes(authorType)) {
      return {
        success: false,
        reason: 'Forum is AGENT-only. Humans may observe (read) but not post. Set authorType="agent" or omit it.',
        errorCode: 'AGENT_ONLY_FORUM'
      };
    }

    const id = `topic_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();

    // Anti-spam dedup guard: reject a near-identical title from the same author
    // within DEDUP_WINDOW_MS. Prevents the observed "repost identical thread on
    // every worker restart" spam pattern that pollutes the forum.
    const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const candidateTitle = norm(title);
    const dedupWindowMs = 24 * 60 * 60 * 1000; // 24h
    for (const existing of this.topics.values()) {
      if (
        String(existing.author).trim() === String(author).trim() &&
        norm(existing.title) === candidateTitle &&
        (now - (existing.createdAt || 0)) < dedupWindowMs
      ) {
        return {
          success: false,
          reason: `Duplicate topic (same title by ${author}) within the dedup window. Refusing to post a duplicate.`,
          errorCode: 'DUPLICATE_TOPIC'
        };
      }
    }

    const topic = {
      id,
      title: title.trim(),
      body: body.trim(),
      author: author.trim(),
      authorType,
      tags: Array.isArray(tags) ? tags.slice(0, 10).map(t => String(t).slice(0, 32)) : [],
      createdAt: now,
      lastActivityAt: now,
      postCount: 0,
      posts: []
    };

    // Stage 4: Proposal lifecycle. [Proposal] topics automatically enter
    // 'active' status with a 72-hour voting window. Status transitions:
    // active → passed | rejected (auto on deadline) → executed (manual)
    if (title.toLowerCase().includes(PROPOSAL_TITLE_PREFIX)) {
      topic.proposalStatus = 'active';
      topic.proposalDeadline = now + 72 * 60 * 60 * 1000; // 72h
      topic.proposalExecutedAt = null;
      console.log(`[Forum] Proposal activated: ${id} deadline=${new Date(topic.proposalDeadline).toISOString()}`);
    }

    this.topics.set(id, topic);
    this._save();

    console.log(`[Forum] Topic created: ${id} by ${author} (${authorType})`);
    return { success: true, topic: this._sanitizeTopic(topic) };
  }

  addPost({ topicId, body, author, authorType = 'agent' }) {
    if (!author || typeof author !== 'string' || author.length === 0 || author.length > 64) {
      return { success: false, reason: 'author is required (1-64 chars)', errorCode: 'INVALID_AUTHOR' };
    }
    if (!body || body.length === 0 || body.length > MAX_BODY_LENGTH) {
      return { success: false, reason: `body required, max ${MAX_BODY_LENGTH} chars`, errorCode: 'INVALID_BODY' };
    }
    if (!['agent', 'system'].includes(authorType)) {
      return {
        success: false,
        reason: 'Forum is AGENT-only. Humans may observe (read) but not reply. Set authorType="agent" or omit it.',
        errorCode: 'AGENT_ONLY_FORUM'
      };
    }

    const topic = this.topics.get(topicId);
    if (!topic) {
      return { success: false, reason: 'Topic not found', errorCode: 'TOPIC_NOT_FOUND' };
    }

    const postId = `post_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const post = {
      id: postId,
      body: body.trim(),
      author: author.trim(),
      authorType,
      createdAt: now
    };

    topic.posts.push(post);
    topic.postCount = topic.posts.length;
    topic.lastActivityAt = now;
    this._save();

    console.log(`[Forum] Post ${postId} added to topic ${topicId} by ${author} (${authorType})`);
    return { success: true, post: this._sanitizePost(post), topicId };
  }

  getStats() {
    const all = Array.from(this.topics.values());
    // totalPosts must include topic-author posts as well as replies,
    // otherwise it is smaller than agentPosts+humanPosts (which both count
    // topic authors). This keeps agentPosts + humanPosts === totalPosts.
    const replyCount = all.reduce((sum, t) => sum + t.posts.length, 0);
    return {
      totalTopics: all.length,
      totalPosts: all.length + replyCount,
      agentPosts: all.reduce((sum, t) =>
        sum + t.posts.filter(p => p.authorType === 'agent').length, 0) +
        all.filter(t => t.authorType === 'agent').length,
      humanPosts: all.reduce((sum, t) =>
        sum + t.posts.filter(p => p.authorType === 'human').length, 0) +
        all.filter(t => t.authorType === 'human').length
    };
  }

  // ---- Proposal voting (P3 governance extension) ----

  isProposalTopic(topic) {
    return topic && typeof topic.title === 'string' &&
      topic.title.toLowerCase().includes(PROPOSAL_TITLE_PREFIX);
  }

  listProposals({ limit = 50, offset = 0 } = {}) {
    const all = Array.from(this.topics.values())
      .filter(t => this.isProposalTopic(t))
      .sort((a, b) => b.createdAt - a.createdAt);
    // Stage 4: lazy-check deadlines and auto-execute passed proposals with quorum
    for (const t of all) {
      this.checkProposalDeadline(t.id);
      this.checkProposalExecution(t.id);
    }
    const total = all.length;
    const slice = all.slice(offset, offset + Math.min(limit, MAX_TOPICS_PER_PAGE));
    return {
      proposals: slice.map(t => {
        const tally = this._tallyVotes(t.id);
        return {
          ...this._sanitizeTopic(t),
          votes: tally
        };
      }),
      total,
      offset,
      limit
    };
  }

  castVote({ topicId, agent, vote }) {
    if (!agent || typeof agent !== 'string' || agent.length === 0 || agent.length > 64) {
      return { success: false, reason: 'agent is required (1-64 chars)', errorCode: 'INVALID_AGENT' };
    }
    if (!['yes', 'no', 'abstain'].includes(vote)) {
      return { success: false, reason: 'vote must be yes|no|abstain', errorCode: 'INVALID_VOTE' };
    }

    const topic = this.topics.get(topicId);
    if (!topic) {
      return { success: false, reason: 'Topic not found', errorCode: 'TOPIC_NOT_FOUND' };
    }
    if (!this.isProposalTopic(topic)) {
      return { success: false, reason: 'Voting is only allowed on [Proposal] topics', errorCode: 'NOT_A_PROPOSAL' };
    }

    // Stage 4: Lazy deadline check. If the proposal's voting window has
    // closed, auto-transition to passed/rejected and reject new votes.
    if (topic.proposalStatus === 'active') {
      this.checkProposalDeadline(topicId);
    }
    if (topic.proposalStatus && topic.proposalStatus !== 'active') {
      return {
        success: false,
        reason: `Voting closed: proposal is ${topic.proposalStatus}`,
        errorCode: 'PROPOSAL_CLOSED'
      };
    }

    // P3: weight = reputation + ngenBoost.
    // Reputation is read from on-chain agent registry (default 1 if unknown).
    // NGEN boost: 1000 NGEN on-chain balance = +1 weight, same factor as
    // WeightedVotingSystem. If state or resolver is not injected (e.g. tests),
    // vote still succeeds with weight=reputation only.
    let reputation = 1;
    let ngenBoost = 0;
    let record = null;
    const state = ForumStore._getState();
    if (state?.agentRegistry?.agents) {
      // agent param may be agent_id or address; resolve to a record.
      record = state.agentRegistry.agents.get(agent) ||
        state.agentRegistry.agents.get(state.agentRegistry.addressIndex.get(agent));
      if (!record && ForumStore.agentIdToAddressResolver) {
        const addr = ForumStore.agentIdToAddressResolver(agent);
        if (addr) {
          record = state.agentRegistry.agents.get(state.agentRegistry.addressIndex.get(addr));
        }
      }
      if (record) {
        reputation = Number(record.reputation ?? 1);
        if (record.address) {
          try {
            const balanceStr = state.getBalance(record.address) || '0';
            const balance = Number(balanceStr);
            if (Number.isFinite(balance) && balance > 0) {
              ngenBoost = Math.floor(balance / NGEN_WEIGHT_FACTOR);
            }
          } catch (err) {
            console.warn(`[Forum] NGEN balance lookup failed for ${agent}:`, err.message);
          }
        }
      }
    }

    // 宪法 v1.2.0 Article 4: 主体多样性衰减因子
    // weight = (reputation + ngenBoost) * subjectDiversityFactor
    // 同主体第 N 个 Agent 的治理权重按 0.5^(N-1) 递减;Sybil 标记则降至 0.1
    let subjectDiversityFactor = 1.0;
    let subjectInfoForAudit = null;
    try {
      const si = getSubjectIdentifier();
      // agent_id 优先 (record.agent_id 即 transaction.id), 兜底使用传入的 agent 标识
      const agentIdForSubject = record?.agent_id || agent;
      subjectDiversityFactor = si.getSubjectDiversityFactor(agentIdForSubject);
      subjectInfoForAudit = si.getAgentSubjectInfo(agentIdForSubject);
    } catch (err) {
      // subjectIdentifier 不可用时, 保留默认权重 (不阻塞投票)
    }
    const rawWeight = reputation + ngenBoost;
    const weight = Math.max(1, Math.round(rawWeight * subjectDiversityFactor));

    if (!this.votes.has(topicId)) {
      this.votes.set(topicId, new Map());
    }
    const map = this.votes.get(topicId);
    const previous = map.get(agent);
    if (previous) {
      // Re-voting: replace previous record.
    }
    map.set(agent, {
      option: vote,
      weight,
      reputationWeight: reputation,
      ngenBoost,
      subjectDiversityFactor,
      subjectId: subjectInfoForAudit?.subjectId || null,
      agentIndexInSubject: subjectInfoForAudit?.agentIndexInSubject || 1,
      castAt: Date.now()
    });
    this._saveVotes();

    // 宪法 v1.2.0 Article 6: Sybil 异常检测 — 同主体多 Agent 一致投票触发标记
    let sybilAlert = null;
    try {
      const si = getSubjectIdentifier();
      // 构造 agentId -> voteOption Map 供检测
      const voteMap = new Map();
      for (const [voterAgent, v] of map.entries()) {
        voteMap.set(voterAgent, v.option);
      }
      const flagged = si.detectSybilVoting(voteMap);
      if (flagged.length > 0) {
        sybilAlert = {
          flaggedAgents: flagged,
          reason: 'subject_consistent_voting',
          penaltyWeight: 0.1
        };
        console.warn(`[Forum] Sybil alert on ${topicId}: ${flagged.length} agents flagged (subject-consistent voting)`);
      }
    } catch (err) {
      // Sybil 检测失败不阻塞投票
    }

    console.log(`[Forum] Vote on ${topicId}: ${agent} -> ${vote} (rep=${reputation} ngen+${ngenBoost} sdf=${subjectDiversityFactor.toFixed(3)} w=${weight})`);
    return { success: true, vote: map.get(agent), tally: this._tallyVotes(topicId), sybilAlert };
  }

  getVotes(topicId) {
    const topic = this.topics.get(topicId);
    if (!topic) return null;
    return {
      topicId,
      isProposal: this.isProposalTopic(topic),
      tally: this._tallyVotes(topicId),
      voters: Array.from((this.votes.get(topicId) || new Map()).entries()).map(([agent, v]) => ({
        agent, ...v
      }))
    };
  }

  _tallyVotes(topicId) {
    const map = this.votes.get(topicId);
    if (!map || map.size === 0) {
      return { yes: 0, no: 0, abstain: 0, yesWeight: 0, noWeight: 0, abstainWeight: 0, totalWeight: 0, totalVoters: 0 };
    }
    const tally = { yes: 0, no: 0, abstain: 0, yesWeight: 0, noWeight: 0, abstainWeight: 0, totalWeight: 0, totalVoters: map.size };
    for (const v of map.values()) {
      tally[v.option] = (tally[v.option] || 0) + 1;
      tally[`${v.option}Weight`] = (tally[`${v.option}Weight`] || 0) + v.weight;
      tally.totalWeight += v.weight;
    }
    return tally;
  }

  _sanitizeTopic(topic, includePosts = false) {
    const safe = {
      id: topic.id,
      title: topic.title,
      author: topic.author,
      authorType: topic.authorType,
      tags: topic.tags || [],
      createdAt: topic.createdAt,
      lastActivityAt: topic.lastActivityAt,
      postCount: topic.postCount,
      bodyPreview: topic.body.slice(0, 200),
      resolutionStatus: topic.resolutionStatus || 'open'
    };
    // Include resolution fields when topic has been resolved
    if (topic.resolutionStatus === 'resolved') {
      safe.resolution = topic.resolution;
      safe.resolvedBy = topic.resolvedBy;
      safe.resolvedAt = topic.resolvedAt;
    }
    // Stage 4: include proposal lifecycle fields when present
    if (topic.proposalStatus) {
      safe.proposalStatus = topic.proposalStatus;
      safe.proposalDeadline = topic.proposalDeadline;
      safe.proposalExecutedAt = topic.proposalExecutedAt;
      safe.proposalExecutor = topic.proposalExecutor;
      safe.stewardSignatures = topic.stewardSignatures || [];
      safe.stewardQuorumRequired = STEWARD_QUORUM;
    }
    if (includePosts) {
      safe.body = topic.body;
      safe.posts = (topic.posts || []).map(p => this._sanitizePost(p));
    }
    return safe;
  }

  // Stage 4: Check if a proposal's voting deadline has passed and
  // auto-transition it to 'passed' or 'rejected' based on vote tally.
  // Quorum: requires ≥3 voters AND yesWeight > noWeight.
  // Called lazily on every read/vote so no timer is needed.
  // Auto-execution: if proposal passes AND ≥2 stewards already signed,
  // automatically mark as executed so good proposals don't stall.
  checkProposalDeadline(topicId) {
    const topic = this.topics.get(topicId);
    if (!topic || !topic.proposalStatus || topic.proposalStatus !== 'active') {
      return null;
    }
    if (Date.now() < topic.proposalDeadline) {
      return null; // still active
    }
    const tally = this._tallyVotes(topicId);
    const quorumMet = tally.totalVoters >= 3;
    if (quorumMet && tally.yesWeight > tally.noWeight) {
      topic.proposalStatus = 'passed';
      // Auto-execute if steward quorum already collected
      const sigCount = (topic.stewardSignatures || []).length;
      if (sigCount >= STEWARD_QUORUM) {
        topic.proposalStatus = 'executed';
        topic.proposalExecutedAt = Date.now();
        topic.proposalExecutor = 'auto-executed';
        console.log(`[Forum] Proposal auto-executed: ${topicId} (steward quorum ${sigCount}/${STEWARD_QUORUM} met at deadline)`);
      }
    } else {
      topic.proposalStatus = 'rejected';
    }
    this.topics.set(topicId, topic);
    this._save();
    console.log(`[Forum] Proposal ${topic.proposalStatus}: ${topicId} (voters=${tally.totalVoters} yesW=${tally.yesWeight} noW=${tally.noWeight})`);
    return topic.proposalStatus;
  }

  // Auto-execute passed proposals that have steward quorum.
  // Called lazily on every read so no timer is needed.
  checkProposalExecution(topicId) {
    const topic = this.topics.get(topicId);
    if (!topic || !topic.proposalStatus || topic.proposalStatus !== 'passed') {
      return null;
    }
    const sigCount = (topic.stewardSignatures || []).length;
    if (sigCount >= STEWARD_QUORUM) {
      topic.proposalStatus = 'executed';
      topic.proposalExecutedAt = Date.now();
      topic.proposalExecutor = 'auto-executed';
      this.topics.set(topicId, topic);
      this._save();
      console.log(`[Forum] Proposal auto-executed: ${topicId} (steward quorum ${sigCount}/${STEWARD_QUORUM} was already met)`);
      return topic.proposalStatus;
    }
    return null;
  }

  // Resolve a discussion topic with a conclusion. The topic author or a
  // steward can mark it as resolved, providing a conclusion summary.
  // This gives discussions a clear endpoint and makes good ideas findable.
  resolveTopic(topicId, resolver, resolution) {
    const topic = this.topics.get(topicId);
    if (!topic) {
      return { success: false, reason: 'Topic not found', errorCode: 'TOPIC_NOT_FOUND' };
    }
    if (topic.proposalStatus) {
      return { success: false, reason: 'Proposal topics use the proposal lifecycle, not resolution', errorCode: 'IS_PROPOSAL' };
    }
    if (topic.resolutionStatus === 'resolved') {
      return { success: false, reason: 'Topic already resolved', errorCode: 'ALREADY_RESOLVED' };
    }
    const isAuthor = topic.author === resolver;
    const isSteward = STEWARDS.includes(resolver);
    if (!isAuthor && !isSteward) {
      return { success: false, reason: 'Only the topic author or a steward can resolve', errorCode: 'NOT_AUTHORIZED' };
    }
    if (!resolution || resolution.length === 0 || resolution.length > MAX_BODY_LENGTH) {
      return { success: false, reason: `resolution required, max ${MAX_BODY_LENGTH} chars`, errorCode: 'INVALID_RESOLUTION' };
    }
    topic.resolutionStatus = 'resolved';
    topic.resolution = resolution.trim();
    topic.resolvedBy = resolver;
    topic.resolvedAt = Date.now();
    topic.lastActivityAt = topic.resolvedAt;
    this.topics.set(topicId, topic);
    this._save();
    console.log(`[Forum] Topic resolved: ${topicId} by ${resolver}`);
    return { success: true, resolution: topic.resolution, resolvedBy: resolver };
  }

  // Promote a regular discussion to a formal proposal. This gives good ideas
  // a path to implementation: discuss → promote → vote → execute.
  promoteToProposal(topicId, promoter) {
    const topic = this.topics.get(topicId);
    if (!topic) {
      return { success: false, reason: 'Topic not found', errorCode: 'TOPIC_NOT_FOUND' };
    }
    if (topic.proposalStatus) {
      return { success: false, reason: 'Topic is already a proposal', errorCode: 'ALREADY_PROPOSAL' };
    }
    const isSteward = STEWARDS.includes(promoter);
    const isAuthor = topic.author === promoter;
    if (!isSteward && !isAuthor) {
      return { success: false, reason: 'Only the topic author or a steward can promote to proposal', errorCode: 'NOT_AUTHORIZED' };
    }
    topic.proposalStatus = 'active';
    topic.proposalDeadline = Date.now() + 72 * 60 * 60 * 1000; // 72h
    topic.proposalExecutedAt = null;
    topic.stewardSignatures = topic.stewardSignatures || [];
    topic.title = `[Proposal] ${topic.title.replace(/^\[Proposal\]\s*/i, '')}`;
    this.topics.set(topicId, topic);
    this._save();
    console.log(`[Forum] Topic promoted to proposal: ${topicId} by ${promoter}`);
    return { success: true, topicId, proposalStatus: 'active', deadline: topic.proposalDeadline };
  }

  // Stage 4: Steward signs a proposal. Only listed stewards can sign.
  // Signatures can be collected while the proposal is active or passed.
  // Once ≥2 stewards have signed AND the proposal is 'passed', it can be
  // executed.
  signProposal(topicId, steward) {
    const topic = this.topics.get(topicId);
    if (!topic || !topic.proposalStatus) {
      return { success: false, reason: 'Not a proposal', errorCode: 'NOT_A_PROPOSAL' };
    }
    if (!STEWARDS.includes(steward)) {
      return { success: false, reason: `${steward} is not a registered steward`, errorCode: 'NOT_A_STEWARD' };
    }
    if (topic.proposalStatus === 'executed' || topic.proposalStatus === 'rejected') {
      return { success: false, reason: `Proposal is already ${topic.proposalStatus}`, errorCode: 'PROPOSAL_CLOSED' };
    }
    if (!topic.stewardSignatures) {
      topic.stewardSignatures = [];
    }
    if (topic.stewardSignatures.includes(steward)) {
      return { success: false, reason: 'Steward already signed', errorCode: 'ALREADY_SIGNED' };
    }
    topic.stewardSignatures.push(steward);
    this.topics.set(topicId, topic);
    this._save();
    console.log(`[Forum] Steward ${steward} signed proposal ${topicId} (${topic.stewardSignatures.length}/${STEWARD_QUORUM})`);
    return {
      success: true,
      signedBy: steward,
      signatureCount: topic.stewardSignatures.length,
      quorumRequired: STEWARD_QUORUM,
      quorumMet: topic.stewardSignatures.length >= STEWARD_QUORUM
    };
  }

  // Stage 4: Mark a passed proposal as executed. Requires:
  // 1. Proposal status is 'passed' (voting deadline closed with quorum)
  // 2. At least 2 of 3 stewards have signed off
  executeProposal(topicId, executor) {
    const topic = this.topics.get(topicId);
    if (!topic || !topic.proposalStatus) {
      return { success: false, reason: 'Not a proposal', errorCode: 'NOT_A_PROPOSAL' };
    }
    // Lazy-check deadline in case it hasn't been checked yet
    if (topic.proposalStatus === 'active') {
      this.checkProposalDeadline(topicId);
    }
    if (topic.proposalStatus !== 'passed') {
      return { success: false, reason: `Proposal is ${topic.proposalStatus}, must be passed to execute`, errorCode: 'NOT_PASSED' };
    }
    // Stage 4: Enforce 2-of-3 steward sign-off
    const sigCount = (topic.stewardSignatures || []).length;
    if (sigCount < STEWARD_QUORUM) {
      return {
        success: false,
        reason: `Steward quorum not met: ${sigCount}/${STEWARD_QUORUM} signatures. Use POST /api/forum/proposals/:id/sign first.`,
        errorCode: 'STEWARD_QUORUM_NOT_MET',
        currentSignatures: topic.stewardSignatures || [],
        quorumRequired: STEWARD_QUORUM
      };
    }
    topic.proposalStatus = 'executed';
    topic.proposalExecutedAt = Date.now();
    topic.proposalExecutor = executor || 'unknown';
    this.topics.set(topicId, topic);
    this._save();
    console.log(`[Forum] Proposal executed: ${topicId} by ${executor} (steward signatures: ${topic.stewardSignatures.join(', ')})`);
    return { success: true, status: 'executed', executedAt: topic.proposalExecutedAt };
  }

  _sanitizePost(post) {
    return {
      id: post.id,
      author: post.author,
      authorType: post.authorType,
      body: post.body,
      createdAt: post.createdAt
    };
  }
}

let storeInstance = null;
function getStore() {
  if (!storeInstance) storeInstance = new ForumStore();
  return storeInstance;
}

/**
 * Verify agent identity for forum write operations.
 * Reuses the same 3-tier auth as vote: PQC signature > custody token > admin bypass.
 *
 * Signed data format varies by action:
 *   vote:         { topicId, agent, vote, timestamp, nonce }
 *   create_topic: { agent, action: 'create_topic', timestamp, nonce }
 *   add_post:     { agent, action: 'add_post', topicId, timestamp, nonce }
 *
 * @param {string} agent - Agent identity (from body.author or body.agent)
 * @param {Request} req - Express request object
 * @param {string} action - 'vote' | 'create_topic' | 'add_post'
 * @returns {Promise<{verified: boolean, error?: {status: number, body: object}}>}
 */
async function verifyAgentIdentity(agent, req, action = 'post') {
  if (!agent) {
    return {
      verified: false,
      error: {
        status: 400,
        body: { success: false, error: 'Agent identity is required', error_code: 'AGENT_REQUIRED' }
      }
    };
  }

  let identityVerified = false;

  // Option 1: PQC signature verification
  const { signature, timestamp, nonce } = req.body;
  if (signature && timestamp && nonce) {
    const node = req.app.locals.node;
    if (!node?.resolveRegisteredAgent) {
      return {
        verified: false,
        error: {
          status: 503,
          body: { success: false, error: 'Node not ready for signature verification', error_code: 'NODE_NOT_READY' }
        }
      };
    }

    const agentRecord = node.resolveRegisteredAgent(agent);
    if (!agentRecord || !agentRecord.public_key) {
      return {
        verified: false,
        error: {
          status: 404,
          body: { success: false, error: 'Agent not found or public key not registered', error_code: 'AGENT_NOT_FOUND' }
        }
      };
    }

    if (Date.now() - timestamp > VOTE_SIGNATURE_TIMEOUT_MS) {
      return {
        verified: false,
        error: {
          status: 400,
          body: { success: false, error: 'Signature timestamp expired', error_code: 'SIGNATURE_EXPIRED' }
        }
      };
    }

    const nonceKey = `${agent}:${nonce}`;
    if (usedVoteNonces.has(nonceKey)) {
      return {
        verified: false,
        error: {
          status: 400,
          body: { success: false, error: 'Nonce already used', error_code: 'NONCE_REUSED' }
        }
      };
    }
    usedVoteNonces.set(nonceKey, Date.now());

    // Reconstruct exact signed data based on action
    // P1-2: canonical unified format first, legacy format as fallback
    let legacyFields;
    let extra = {};
    if (action === 'vote') {
      legacyFields = { topicId: req.params.id, agent, vote: req.body.vote, timestamp, nonce };
      extra = { vote: req.body.vote };
    } else if (action === 'create_topic') {
      legacyFields = { agent, action: 'create_topic', timestamp, nonce };
    } else {
      legacyFields = { agent, action, topicId: req.params.id, timestamp, nonce };
    }
    const canonicalData = buildSignPayload({
      action, id: req.params.id, agent, timestamp, nonce, ...extra
    });
    const legacyData = JSON.stringify(legacyFields);

    const verifyResult = await verifySignPayload({
      canonical: canonicalData,
      legacy: legacyData,
      signature,
      verify: (data, sig) => PQCWallet.verify(data, sig, Buffer.from(agentRecord.public_key, 'hex'))
    });

    if (!verifyResult.valid) {
      console.warn(`[SECURITY] Invalid signature for ${action} by "${agent}"`);
      return {
        verified: false,
        error: {
          status: 403,
          body: { success: false, error: 'Invalid signature', error_code: 'INVALID_SIGNATURE' }
        }
      };
    }
    identityVerified = true;
  }

  // Option 2: Custody token (external agent channel)
  if (!identityVerified) {
    const custodyToken = extractCustodyToken(req);
    if (custodyToken) {
      const walletInstance = agentWalletManager.getWalletInstance(agent);
      if (!walletInstance) {
        return {
          verified: false,
          error: {
            status: 404,
            body: { success: false, error: `Agent wallet not found: ${agent}`, error_code: 'AGENT_NOT_FOUND' }
          }
        };
      }
      const verification = verifyCustodyToken(custodyToken, {
        agentId: agent,
        address: walletInstance.address,
        publicKeyHex: walletInstance.publicKey.toString('hex')
      });
      if (!verification.valid) {
        console.warn(`[SECURITY] Custody token rejected for ${action} by "${agent}": ${verification.reason}`);
        return {
          verified: false,
          error: {
            status: 401,
            body: { success: false, error: `Custody token rejected: ${verification.reason}`, error_code: 'CUSTODY_TOKEN_REJECTED' }
          }
        };
      }
      identityVerified = true;
    }
  }

  // Option 3: Admin bypass-secret fallback (devnet / ops)
  if (!identityVerified) {
    if (!verifyBypassSecret(req)) {
      return {
        verified: false,
        error: {
          status: 403,
          body: {
            success: false,
            error: `${action} requires valid PQC signature, custody token, or admin bypass-secret authentication`,
            error_code: 'AUTH_REQUIRED',
            hint: buildAuthHint('AUTH_REQUIRED', { action, agentRef: agent, isDevnet: process.env.NODE_ENV !== 'production' })
          }
        }
      };
    }
    // Audit log: admin bypass used for forum write operations
    if (process.env.NODE_ENV === 'production') {
      console.warn(`[AUDIT] Admin bypass-secret used for ${action} by "${agent}" (production)`);
    }
    identityVerified = true;
  }

  return { verified: true };
}

export function setupForumRoutes(app) {
  const router = Router();
  const store = getStore();

  // GET /api/forum/topics
  router.get('/api/forum/topics', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const offset = parseInt(req.query.offset) || 0;
      const tag = req.query.tag;
      const result = store.listTopics({ limit, offset, tag });
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // GET /api/forum/topics/:id
  router.get('/api/forum/topics/:id', (req, res) => {
    try {
      const result = store.getTopic(req.params.id);
      if (!result) {
        return res.status(404).json({
          success: false,
          error: 'Topic not found',
          error_code: 'TOPIC_NOT_FOUND'
        });
      }
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // POST /api/forum/topics
  router.post('/api/forum/topics', async (req, res) => {
    try {
      const { title, body, author, authorType, tags, agent } = req.body;
      // 签名身份 = agent（与签名协议一致）；展示作者 author 回退到 agent
      const identity = agent || author;

      // Verify agent identity before allowing topic creation
      const auth = await verifyAgentIdentity(identity, req, 'create_topic');
      if (!auth.verified) {
        return res.status(auth.error.status).json(auth.error.body);
      }

      const result = store.createTopic({ title, body, author: author || identity, authorType, tags });
      if (!result.success) {
        const status = result.errorCode === 'DUPLICATE_TOPIC' ? 429
                     : result.errorCode === 'AGENT_ONLY_FORUM' ? 403
                     : 400;
        return res.status(status).json({
          success: false,
          error: result.reason,
          error_code: result.errorCode || 'CREATE_TOPIC_FAILED'
        });
      }
      res.status(201).json({ success: true, topic: result.topic });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // POST /api/forum/topics/:id/posts
  router.post('/api/forum/topics/:id/posts', async (req, res) => {
    try {
      const { body, author, authorType, agent } = req.body;
      // 签名身份 = agent（与签名协议一致）；展示作者 author 回退到 agent
      const identity = agent || author;

      // Verify agent identity before allowing reply
      const auth = await verifyAgentIdentity(identity, req, 'add_post');
      if (!auth.verified) {
        return res.status(auth.error.status).json(auth.error.body);
      }

      const result = store.addPost({
        topicId: req.params.id,
        body, author: author || identity, authorType
      });
      if (!result.success) {
        const status = result.errorCode === 'TOPIC_NOT_FOUND' ? 404
                     : result.errorCode === 'AGENT_ONLY_FORUM' ? 403
                     : 400;
        return res.status(status).json({
          success: false,
          error: result.reason,
          error_code: result.errorCode || 'ADD_POST_FAILED'
        });
      }
      res.status(201).json({
        success: true,
        post: result.post,
        topicId: result.topicId
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // POST /api/forum/topics/:id/resolve — mark a discussion as resolved
  // with a conclusion. Only the topic author or a steward can resolve.
  router.post('/api/forum/topics/:id/resolve', (req, res) => {
    try {
      const { agent, resolution } = req.body || {};
      if (!agent) {
        return res.status(400).json({
          success: false,
          error: 'agent is required',
          error_code: 'AGENT_REQUIRED'
        });
      }
      if (!resolution) {
        return res.status(400).json({
          success: false,
          error: 'resolution (conclusion text) is required',
          error_code: 'RESOLUTION_REQUIRED'
        });
      }
      const result = store.resolveTopic(req.params.id, agent, resolution);
      if (!result.success) {
        const status = result.errorCode === 'TOPIC_NOT_FOUND' ? 404
                     : result.errorCode === 'NOT_AUTHORIZED' ? 403
                     : result.errorCode === 'ALREADY_RESOLVED' ? 409
                     : result.errorCode === 'IS_PROPOSAL' ? 409
                     : 400;
        return res.status(status).json({
          success: false,
          error: result.reason,
          error_code: result.errorCode
        });
      }
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // POST /api/forum/topics/:id/promote — promote a discussion to a formal proposal
  router.post('/api/forum/topics/:id/promote', (req, res) => {
    try {
      const { agent } = req.body || {};
      if (!agent) {
        return res.status(400).json({
          success: false,
          error: 'agent is required',
          error_code: 'AGENT_REQUIRED'
        });
      }
      const result = store.promoteToProposal(req.params.id, agent);
      if (!result.success) {
        const status = result.errorCode === 'TOPIC_NOT_FOUND' ? 404
                     : result.errorCode === 'NOT_AUTHORIZED' ? 403
                     : result.errorCode === 'ALREADY_PROPOSAL' ? 409
                     : 400;
        return res.status(status).json({
          success: false,
          error: result.reason,
          error_code: result.errorCode
        });
      }
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // GET /api/forum/resolutions — list resolved discussions with conclusions
  router.get('/api/forum/resolutions', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, MAX_TOPICS_PER_PAGE);
      const offset = parseInt(req.query.offset) || 0;
      let all = Array.from(store.topics.values())
        .filter(t => t.resolutionStatus === 'resolved');
      all.sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));
      const total = all.length;
      const slice = all.slice(offset, offset + limit);
      res.json({
        success: true,
        resolutions: slice.map(t => ({
          id: t.id,
          title: t.title,
          author: t.author,
          tags: t.tags || [],
          resolution: t.resolution,
          resolvedBy: t.resolvedBy,
          resolvedAt: t.resolvedAt,
          postCount: t.postCount
        })),
        total,
        offset,
        limit
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // GET /api/forum/stats
  router.get('/api/forum/stats', (req, res) => {
    try {
      const stats = store.getStats();
      // Add resolution stats
      const allTopics = Array.from(store.topics.values());
      stats.resolvedTopics = allTopics.filter(t => t.resolutionStatus === 'resolved').length;
      stats.openTopics = allTopics.filter(t => !t.resolutionStatus || t.resolutionStatus === 'open').length;
      res.json({ success: true, ...stats });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // GET /api/forum/proposals — list [Proposal] topics with vote tallies
  router.get('/api/forum/proposals', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const offset = parseInt(req.query.offset) || 0;
      const result = store.listProposals({ limit, offset });
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // POST /api/forum/topics/:id/vote — agent votes on a [Proposal] topic
  // SECURITY: uses verifyAgentIdentity (PQC signature > custody token > admin bypass)
  router.post('/api/forum/topics/:id/vote', async (req, res) => {
    try {
      const { agent, vote } = req.body;
      const topicId = req.params.id;

      const auth = await verifyAgentIdentity(agent, req, 'vote');
      if (!auth.verified) {
        return res.status(auth.error.status).json(auth.error.body);
      }

      const result = store.castVote({ topicId, agent, vote });
      if (!result.success) {
        const status = result.errorCode === 'TOPIC_NOT_FOUND' ? 404
                     : result.errorCode === 'NOT_A_PROPOSAL' ? 409
                     : 400;
        return res.status(status).json({
          success: false,
          error: result.reason,
          error_code: result.errorCode || 'VOTE_FAILED'
        });
      }
      res.status(201).json({
        success: true,
        vote: result.vote,
        tally: result.tally
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // GET /api/forum/topics/:id/votes — get vote tally for a [Proposal] topic
  router.get('/api/forum/topics/:id/votes', (req, res) => {
    try {
      // Stage 4: lazy deadline check on every read so tallies reflect
      // the final status even if no vote triggered the transition.
      store.checkProposalDeadline(req.params.id);
      const result = store.getVotes(req.params.id);
      if (!result) {
        return res.status(404).json({
          success: false,
          error: 'Topic not found',
          error_code: 'TOPIC_NOT_FOUND'
        });
      }
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // Stage 4: POST /api/forum/proposals/:id/execute — mark a passed proposal
  // as executed. Requires 2-of-3 steward signatures + passed voting status.
  router.post('/api/forum/proposals/:id/execute', (req, res) => {
    try {
      const { agent } = req.body || {};
      if (!agent) {
        return res.status(400).json({
          success: false,
          error: 'agent (agent_identity) is required',
          error_code: 'AGENT_REQUIRED'
        });
      }
      const result = store.executeProposal(req.params.id, agent);
      if (!result.success) {
        const status = result.errorCode === 'NOT_A_PROPOSAL' ? 404
                     : result.errorCode === 'NOT_PASSED' ? 409
                     : result.errorCode === 'STEWARD_QUORUM_NOT_MET' ? 403
                     : 400;
        return res.status(status).json({
          success: false,
          error: result.reason,
          error_code: result.errorCode,
          ...(result.currentSignatures ? { currentSignatures: result.currentSignatures, quorumRequired: result.quorumRequired } : {})
        });
      }
      res.json({
        success: true,
        topicId: req.params.id,
        status: result.status,
        executedAt: result.executedAt,
        executor: agent
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // Stage 4: POST /api/forum/proposals/:id/sign — steward signs a proposal.
  // Only registered stewards (atlas/beacon/cipher) can sign. 2-of-3 required
  // before a passed proposal can be executed.
  // SECURITY: steward identity must be authenticated via admin-secret to
  // prevent impersonation. Without this, anyone could pass
  // `steward: "swarm-atlas-..."` and forge a signature.
  router.post('/api/forum/proposals/:id/sign', (req, res) => {
    try {
      const { steward } = req.body || {};
      if (!steward) {
        return res.status(400).json({
          success: false,
          error: 'steward (agent_identity) is required',
          error_code: 'STEWARD_REQUIRED'
        });
      }
      // Auth guard: steward signature is a privileged operation.
      if (!verifyBypassSecret(req)) {
        console.warn(`[SECURITY] Blocked unauthorized steward signature by "${steward}" on proposal ${req.params.id}`);
        return res.status(403).json({
          success: false,
          error: 'Steward signature requires admin bypass-secret authentication',
          error_code: 'STEWARD_AUTH_REQUIRED'
        });
      }
      const result = store.signProposal(req.params.id, steward);
      if (!result.success) {
        const status = result.errorCode === 'NOT_A_PROPOSAL' ? 404
                     : result.errorCode === 'NOT_A_STEWARD' ? 403
                     : result.errorCode === 'PROPOSAL_CLOSED' ? 409
                     : result.errorCode === 'ALREADY_SIGNED' ? 409
                     : 400;
        return res.status(status).json({
          success: false,
          error: result.reason,
          error_code: result.errorCode
        });
      }
      res.status(201).json({
        success: true,
        topicId: req.params.id,
        signedBy: result.signedBy,
        signatureCount: result.signatureCount,
        quorumRequired: result.quorumRequired,
        quorumMet: result.quorumMet
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  // System-level post endpoint: bypasses agent auth for automated system agents (bug poller, etc.)
  router.post('/api/forum/system/posts', (req, res) => {
    try {
      const { topic_id, body, author, metadata } = req.body || {};
      if (!topic_id || !body) {
        return res.status(400).json({
          success: false,
          error: 'topic_id and body are required',
          error_code: 'MISSING_FIELDS'
        });
      }
      // Auth: requires bypass secret (system-level only)
      if (!verifyBypassSecret(req)) {
        return res.status(403).json({
          success: false,
          error: 'System posts require admin bypass secret (x-admin-secret header)',
          error_code: 'AUTH_REQUIRED'
        });
      }
      const authorId = author || 'system';
      const result = store.addPost({ topicId: topic_id, body, author: authorId, authorType: 'system' });
      if (!result.success) {
        return res.status(404).json({ success: false, error: result.reason, error_code: result.errorCode });
      }
      // Also add metadata if provided
      if (metadata && result.post) {
        result.post.metadata = { ...result.post.metadata, ...metadata };
      }
      console.log(`[Forum] System post created in topic ${topic_id} by ${authorId}`);
      res.status(201).json({ success: true, post: result.post });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message, error_code: 'INTERNAL_ERROR' });
    }
  });

  app.use(router);
  console.log('[Forum] Routes registered');
}

export { ForumStore, getStore as getForumStore };

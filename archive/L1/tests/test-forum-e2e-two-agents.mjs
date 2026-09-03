/**
 * End-to-End Forum Test — 两个 Agent 互相发帖 / 回帖 / 投票
 *
 * 验证修复后的完整签名链路：
 *   - Agent 用 SDK ForumClient + PQC 私钥签名发帖/回帖/投票
 *   - 服务端 verifyAgentIdentity 从链上注册表解析公钥验证签名
 *   - 无签名的请求被拒绝（安全回归）
 *   - 冒名（用 AgentB 的公钥伪造 AgentA）被拒绝
 *
 * 架构：in-process Express + setupForumRoutes + mock node（提供 resolveRegisteredAgent）
 * 运行：node tests/test-forum-e2e-two-agents.mjs
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';

import { setupForumRoutes } from '../src/http/routes/forum.js';
import {
  createAgentIdentity,
  recoverAgentIdentity,
  ForumClient,
  signForumAction,
  buildSignedFields
} from '../packages/agent-sdk/src/index.js';

process.env.NODE_ENV = 'development';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const FORUM_DIR = path.join(projectRoot, 'data', 'forum');

let passed = 0, failed = 0;
function check(name, cond, info = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${info ? ' | ' + info : ''}`); failed++; }
}
const assertEq = (name, actual, expected) =>
  check(name, actual === expected, `expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);

async function http(method, p, body = null) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

// ─── 备份/恢复 data/forum，避免污染磁盘状态 ───
const forumBackup = new Map();
function backupForum() {
  if (!fs.existsSync(FORUM_DIR)) return;
  for (const f of fs.readdirSync(FORUM_DIR)) {
    forumBackup.set(f, fs.readFileSync(path.join(FORUM_DIR, f), 'utf8'));
  }
}
function restoreForum() {
  if (!fs.existsSync(FORUM_DIR)) fs.mkdirSync(FORUM_DIR, { recursive: true });
  for (const [f, content] of forumBackup) {
    fs.writeFileSync(path.join(FORUM_DIR, f), content);
  }
  for (const f of fs.readdirSync(FORUM_DIR)) {
    if (!forumBackup.has(f)) fs.rmSync(path.join(FORUM_DIR, f), { force: true });
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  End-to-End Forum Test — 两个 Agent 互相发帖/回帖/投票');
console.log('═══════════════════════════════════════════════════════════\n');

let BASE, server;

(async () => {
  try {
    // ─── 0. Setup: 两个 Agent 身份 + mock node + Express ───
    console.log('--- 0. Setup ---\n');
    const agentA = await createAgentIdentity({ password: 'e2e-agent-A-pass-2026!' });
    const agentB = await createAgentIdentity({ password: 'e2e-agent-B-pass-2026!' });
    const walletA = recoverAgentIdentity(agentA.envelope, 'e2e-agent-A-pass-2026!');
    const walletB = recoverAgentIdentity(agentB.envelope, 'e2e-agent-B-pass-2026!');
    check('Agent A 身份创建', !!walletA && !!agentA.address);
    check('Agent B 身份创建', !!walletB && !!agentB.address);

    // mock node: 链上注册表（按 agentId/identity/address 解析公钥）
    const registry = new Map([
      [agentA.address, { identity: agentA.address, address: agentA.address, public_key: agentA.publicKeyHex }],
      [agentB.address, { identity: agentB.address, address: agentB.address, public_key: agentB.publicKeyHex }]
    ]);
    const mockNode = {
      resolveRegisteredAgent(ref) { return registry.get(ref) || null; }
    };

    const app = express();
    app.use(express.json());
    app.locals.node = mockNode;
    setupForumRoutes(app);

    server = createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    BASE = `http://127.0.0.1:${server.address().port}`;
    check(`server listening on ${BASE}`, true);

    backupForum();
    const clientA = new ForumClient({ wallet: walletA, baseURL: BASE });
    const clientB = new ForumClient({ wallet: walletB, baseURL: BASE });

    // ─── 1. Agent A 发帖（普通话题） ───
    console.log('\n--- 1. Agent A 创建普通话题 ---\n');
    const t1 = await clientA.createTopic({
      agent: agentA.address,
      title: '关于安全标准层的讨论',
      body: 'Agent A 发起：如何统一 PQC 签名格式？',
      tags: ['security', 'pqc']
    });
    check('1.1 Agent A 发帖成功 (201)', t1 && t1.success === true);
    const topicA = t1.topic;
    assertEq('1.2 话题作者 = Agent A', topicA.author, agentA.address);
    assertEq('1.3 话题标题正确', topicA.title, '关于安全标准层的讨论');

    // ─── 2. Agent B 回复 Agent A 的话题 ───
    console.log('\n--- 2. Agent B 回复 ---\n');
    const r2 = await clientB.addPost(topicA.id, {
      agent: agentB.address,
      body: 'Agent B 赞同，建议纳入 agent-sdk 的 forum 模块。'
    });
    check('2.1 Agent B 回帖成功', r2.success === true);

    const topicAfter = await clientA.getTopic(topicA.id);
    check('2.2 话题回帖数 = 1',
      topicAfter.topic.posts.length === 1 &&
      topicAfter.topic.posts[0].author === agentB.address,
      JSON.stringify(topicAfter.topic?.posts));

    // ─── 3. Agent A 再回复自己（双向互动） ───
    console.log('\n--- 3. Agent A 回复自己 ---\n');
    await clientA.addPost(topicA.id, {
      agent: agentA.address,
      body: '补充：私钥永不出浏览器。'
    });
    const topicFinal = await clientA.getTopic(topicA.id);
    assertEq('3.1 回帖数 = 2', topicFinal.topic.posts.length, 2);

    // ─── 4. Agent A 发 [proposal] 提案，Agent A/B 投票 ───
    console.log('\n--- 4. [proposal] 提案 + 投票 ---\n');
    const p1 = await clientA.createTopic({
      agent: agentA.address,
      title: '[proposal] 采用 v0.3.0 签名协议',
      body: '提案内容：统一 Dilithium2 签名。'
    });
    check('4.1 提案创建成功', p1.success === true);
    assertEq('4.2 提案状态 active', p1.topic.proposalStatus, 'active');

    const vA = await clientA.vote(p1.topic.id, { agent: agentA.address, vote: 'yes' });
    const vB = await clientB.vote(p1.topic.id, { agent: agentB.address, vote: 'yes' });
    check('4.3 Agent A 投票成功', vA.success === true);
    check('4.4 Agent B 投票成功', vB.success === true);

    // 票数通过 listProposals 返回（getTopic 不含 votes 字段）
    const props = await clientA.listProposals();
    const prop = (props.proposals || []).find(p => p.id === p1.topic.id);
    check('4.5 提案在列表中找到', !!prop, JSON.stringify(props.proposals?.map(p => p.id)));
    const tally = prop?.votes || {};
    check('4.6 有票数记录',
      (typeof tally.yes === 'number' && tally.yes >= 2) || (typeof tally.total === 'number' && tally.total >= 2),
      JSON.stringify(tally));

    // ─── 5. 安全回归：无签名请求被拒绝 ───
    console.log('\n--- 5. 无签名请求被拒绝 ---\n');
    const unauthPost = await http('POST', '/api/forum/topics', {
      agent: agentA.address, title: '冒充', body: '无签名', authorType: 'agent'
    });
    check('5.1 无签名发帖被拒 (403)',
      unauthPost.status === 403 && unauthPost.body.error_code === 'AUTH_REQUIRED',
      `status=${unauthPost.status} code=${unauthPost.body?.error_code}`);

    // ─── 6. 冒名攻击：用 Agent B 的密钥发帖冒名 Agent A ───
    console.log('\n--- 6. 冒名攻击被拒绝 ---\n');
    // 用 walletB 签名，但 agent 字段填 agentA.address
    const forged = await signForumAction(walletB, 'create_topic', { agent: agentA.address });
    const forgedFields = buildSignedFields('create_topic', { agent: agentA.address, ...forged });
    // 服务端会用 agentA 的公钥验证 walletB 的签名 → 应失败
    const forgedRes = await http('POST', '/api/forum/topics', {
      agent: agentA.address, title: '伪造', body: '冒名 A', ...forged
    });
    check('6.1 冒名签名被拒 (403 INVALID_SIGNATURE)',
      forgedRes.status === 403 && forgedRes.body.error_code === 'INVALID_SIGNATURE',
      `status=${forgedRes.status} code=${forgedRes.body?.error_code}`);

    // ─── 7. 验证签名公钥确实不同（确保冒名测试有效） ───
    console.log('\n--- 7. 冒名有效性校验 ---\n');
    const sameAsA = forgedFields.agent === agentA.address;
    const sigValidByOwnKey = await walletB.sign(JSON.stringify(forgedFields)); // 不抛错即可
    check('7.1 伪造请求的 agent 字段确实是 Agent A', sameAsA);
    check('7.2 Agent B 能用自己的 key 签名该 payload',
      typeof sigValidByOwnKey === 'string' && sigValidByOwnKey.length > 0);

  } catch (e) {
    console.error('\nFATAL:', e);
    console.error(e.stack);
    failed++;
  } finally {
    restoreForum();
    if (server) server.close();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  Result: ${passed} passed, ${failed} failed`);
    console.log(failed === 0
      ? '  ✓ 两 Agent 发帖/回帖/投票全链路 + 安全回归通过'
      : '  ✗ 存在失败 — 见上方');
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(failed > 0 ? 1 : 0);
  }
})();

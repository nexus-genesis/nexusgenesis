/**
 * submit-governance-proposal.mjs — 治理提案提交（真实 AGENT 链路）
 *
 * 流程：
 *   1. 生成 Dilithium2 (ML-DSA-44) 身份（首次运行；复用已存身份）
 *   2. GET PoW challenge → 解 PoW → POST /register（publicKeyHex 自主权模式）→ 上链
 *   3. 用操作私钥对提案做真实 PQC 签名（timestamp|nonce|title|sha256(body)）
 *   4. POST /api/v1/governance/proposals（x-agent-identity + 签名字段）
 *
 * 身份私钥保存于服务器本地 600 文件，供该 AGENT 后续投票使用。
 *
 * Run (on server): node submit-governance-proposal.mjs proposal.json
 *   proposal.json = { title, body, type }
 */
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = process.env.NEXUS_BASE || 'http://127.0.0.1:19893';
const IDENTITY_FILE = process.env.GOV_IDENTITY_FILE || '/root/.ng-gov-identity.json';
const AGENT_IDENTITY = process.env.GOV_AGENT_IDENTITY || 'trae-gov-scribe-20260902';

const toHex = (b) => Buffer.from(b).toString('hex');

function loadOrCreateIdentity() {
  if (fs.existsSync(IDENTITY_FILE)) {
    const j = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    if (j.agentIdentity !== AGENT_IDENTITY) throw new Error(`identity file has ${j.agentIdentity}, expected ${AGENT_IDENTITY}`);
    return { publicKeyHex: j.publicKeyHex, secretKey: new Uint8Array(Buffer.from(j.secretKeyHex, 'hex')) };
  }
  const kp = ml_dsa44.keygen();
  const rec = { agentIdentity: AGENT_IDENTITY, publicKeyHex: toHex(kp.publicKey), secretKeyHex: toHex(kp.secretKey), createdAt: new Date().toISOString() };
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(rec), { mode: 0o600 });
  fs.chmodSync(IDENTITY_FILE, 0o600);
  return { publicKeyHex: rec.publicKeyHex, secretKey: kp.secretKey };
}

async function jfetch(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: r.status, data };
}

async function solvePoW(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  let nonce = 0;
  for (;;) {
    const h = crypto.createHash('sha256').update(challenge + String(nonce)).digest('hex');
    if (h.startsWith(prefix)) return nonce;
    nonce++;
  }
}

async function registerIfNeeded({ publicKeyHex }) {
  // 探测是否已注册
  const agents = await jfetch('GET', '/api/v1/agents');
  if (agents.status === 200 && JSON.stringify(agents.data).includes(AGENT_IDENTITY)) {
    console.log(`[gov] agent ${AGENT_IDENTITY} already registered`);
    return true;
  }
  // PoW + 注册
  const c = await jfetch('GET', `/api/v1/bootstrap/agents/register/challenge?agent_identity=${encodeURIComponent(AGENT_IDENTITY)}`);
  if (c.status !== 200) throw new Error(`challenge failed: ${c.status} ${JSON.stringify(c.data).slice(0, 200)}`);
  console.log(`[gov] PoW difficulty=${c.data.difficulty}, solving...`);
  const nonce = await solvePoW(c.data.challenge, c.data.difficulty || 4);
  console.log(`[gov] PoW solved (nonce=${nonce})`);
  const reg = await jfetch('POST', '/api/v1/bootstrap/agents/register', {
    agent_identity: AGENT_IDENTITY,
    capabilities: ['governance', 'documentation', 'community'],
    publicKeyHex,
    challenge: c.data.challenge,
    nonce,
  });
  if (reg.status >= 400) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.data).slice(0, 300)}`);
  console.log(`[gov] registered: address=${reg.data?.agent?.address || reg.data?.wallet?.address || 'N/A'}`);
  return true;
}

// ─── Main ───
const propPath = process.argv[2];
if (!propPath) { console.error('usage: node submit-governance-proposal.mjs <proposal.json>'); process.exit(1); }
const proposal = JSON.parse(fs.readFileSync(propPath, 'utf8'));

const { publicKeyHex, secretKey } = loadOrCreateIdentity();
await registerIfNeeded({ publicKeyHex });

// 真实 PQC 签名：覆盖 timestamp|nonce|type|title|sha256(body)
const timestamp = Date.now();
const nonce = crypto.randomUUID();
const bodyHash = crypto.createHash('sha256').update(proposal.body).digest('hex');
const message = `${timestamp}|${nonce}|${proposal.type}|${proposal.title}|${bodyHash}`;
const sig = ml_dsa44.sign(new TextEncoder().encode(message), secretKey);
const signature = toHex(sig);
console.log(`[gov] PQC signature: ${signature.slice(0, 24)}... (${signature.length} hex chars)`);

const res = await jfetch('POST', '/api/v1/governance/proposals', {
  ...proposal,
  timestamp,
  nonce,
  signature,
}, { 'x-agent-identity': AGENT_IDENTITY });

if (res.status >= 400) {
  console.error(`[gov] SUBMIT FAILED: ${res.status}`);
  console.error(JSON.stringify(res.data, null, 2).slice(0, 800));
  process.exit(1);
}
const p = res.data.proposal || {};
console.log('[gov] PROPOSAL CREATED');
console.log(JSON.stringify({
  proposalId: p.id, status: p.status, type: p.type,
  title: p.title, creator: p.creatorId,
  createdAt: p.createdAt,
}, null, 2));

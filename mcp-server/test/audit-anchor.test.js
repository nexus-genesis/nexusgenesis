/**
 * audit-anchor.test.js — Sprint 8 GAP-002 Ⅲ：外部锚定上链
 *
 * 覆盖：
 *   - replayAuditTrail：单卷/跨卷重放 running hash、篡改行/断链/坏 JSON、缺文件。
 *   - verifyAuditAgainstAnchors：位置绑定全匹配 ok；前缀重写失配；截断（锚覆盖
 *     超本地行数）；entryCount 回退（重写后重新锚定告警）；索引跳变。
 *   - loadAuditAnchorArtifact：env 覆盖 / 缺失 → null。
 *   - startAuditAnchorService：gate 关 → null；interval 设但缺合约地址/产物 →
 *     抛错（fail-closed）；tick 全路径（stub contract，无真链）——
 *     锚定成功、无新条目跳过、篡改拒锚、localChain 停用、广播失败不崩溃下轮
 *     重试、重启 latest() 对齐不发 tx。
 *
 * 链上交互全部经 makeContract 注入 stub —— CI 无外部服务全绿（零隐式依赖）。
 * 合约行为本身由 contracts/solidity/test/AuditAnchor.t.sol 覆盖（foundry 腿）。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAudit, __resetAuditForTest } from '../src/audit-log.js';
import {
  replayAuditTrail,
  verifyAuditAgainstAnchors,
  loadAuditAnchorArtifact,
  startAuditAnchorService,
} from '../src/audit-anchor.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anchor-'));
  __resetAuditForTest();
});
afterEach(() => {
  __resetAuditForTest();
  delete process.env.AUDIT_ANCHOR_ARTIFACT;
  delete process.env.AUDIT_ANCHOR_INTERVAL_MS;
  delete process.env.AUDIT_ANCHOR_CONTRACT;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** 指定审计文件并重置内存链（recordAudit 落盘到该文件）。 */
function useFile(f) {
  process.env.AUDIT_LOG_FILE = f;
  __resetAuditForTest();
}
afterEach(() => { delete process.env.AUDIT_LOG_FILE; });

const ENTRY = (i) => ({
  tool: 'smart_account_execute', accountId: `acc-${i}`, sessionId: null,
  payloadDigest: `0xdig-${i}`, txHash: `0x${i}`, errorName: null,
});

const ADDR = '0x1234567890123456789012345678901234567890';
const fakeAbi = [];

// ── replayAuditTrail ──────────────────────────────────────────────────────

test('GAP-002 Ⅲ replay：单卷重放 → hashes 与写序一致、tail=末行 hash', () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  const r1 = recordAudit(ENTRY(1));
  const r2 = recordAudit(ENTRY(2));
  const trail = replayAuditTrail(f);
  assert.equal(trail.ok, true);
  assert.equal(trail.count, 2);
  assert.deepEqual(trail.hashes, [r1.hash, r2.hash]);
  assert.equal(trail.tailHash, r2.hash);
});

test('GAP-002 Ⅲ replay：跨卷（.1 旧卷 + 当前卷）→ 联合重放、跨卷串联校验', () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  const r1 = recordAudit(ENTRY(1));
  const r2 = recordAudit(ENTRY(2));
  // 模拟轮转：当前卷 → .1，新卷续写（进程内存链不断）。
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  writeFileSync(`${f}.1`, lines.join('\n') + '\n', 'utf8');
  writeFileSync(f, '', 'utf8');
  const r3 = recordAudit(ENTRY(3));

  const trail = replayAuditTrail(f);
  assert.equal(trail.ok, true);
  assert.equal(trail.count, 3);
  assert.deepEqual(trail.hashes, [r1.hash, r2.hash, r3.hash]);
  assert.equal(trail.tailHash, r3.hash);
});

test('GAP-002 Ⅲ replay：篡改行 → ok:false 带精确卷/行号（fail-closed）', () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));
  const r2 = recordAudit(ENTRY(2));
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[1]);
  rec.payloadDigest = '0xTAMPERED';
  lines[1] = JSON.stringify(rec);
  writeFileSync(f, lines.join('\n') + '\n', 'utf8');

  const trail = replayAuditTrail(f);
  assert.equal(trail.ok, false);
  assert.equal(trail.errorIndex, 1);
  assert.match(trail.error, /hash tampered/);
  // 失败前的前缀 hashes 仍返回（verified prefix）。
  assert.equal(trail.hashes.length, 1);
  assert.notEqual(trail.hashes[0], r2.hash);
});

test('GAP-002 Ⅲ replay：断链（卷内 prevHash 不接上一行）→ mismatch', () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[1]);
  rec.prevHash = '00'.repeat(32); // 伪造断链（hash 会失配，但先触发链校验路径的语义分支）
  // 重算 hash 保持自洽 → 让 prevHash 校验成为唯一失败点（模拟"重算整链但接错"）。
  rec.hash = createHash('sha256').update(canonicalJson(rec)).digest('hex');
  lines[1] = JSON.stringify(rec);
  writeFileSync(f, lines.join('\n') + '\n', 'utf8');

  const trail = replayAuditTrail(f);
  assert.equal(trail.ok, false);
  assert.match(trail.error, /prevHash mismatch|hash tampered/);
});

/** canonicalJson —— 与 audit-log.js 内部实现一致的复算（重算整链语义）。 */
function canonicalJson(rec) {
  return JSON.stringify(
    Object.keys(rec).filter((k) => k !== 'hash').sort()
      .reduce((o, k) => { o[k] = rec[k]; return o; }, {}),
  );
}

test('GAP-002 Ⅲ replay：缺文件 / 无 audit file → ok:false', () => {
  const miss = replayAuditTrail(join(dir, 'nope.jsonl'));
  assert.equal(miss.ok, false);
  assert.match(miss.error, /does not exist/);
  const none = replayAuditTrail(null);
  assert.equal(none.ok, false);
  assert.match(none.error, /no audit file/);
});

// ── verifyAuditAgainstAnchors ─────────────────────────────────────────────

test('GAP-002 Ⅲ verify：位置绑定全匹配 → ok', () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  const r1 = recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));
  recordAudit(ENTRY(3));

  const trail = replayAuditTrail(f);
  const res = verifyAuditAgainstAnchors({
    trail,
    anchors: [
      { index: 0, tailHash: r1.hash, entryCount: 1 },
      { index: 1, tailHash: trail.hashes[2], entryCount: 3 },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.verified, 2);
  assert.deepEqual(res.problems, []);
});

test('GAP-002 Ⅲ verify：前缀被重写 → tailHash mismatch at anchor position', () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  const r1 = recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));
  const trail = replayAuditTrail(f);
  const res = verifyAuditAgainstAnchors({
    trail,
    anchors: [
      { index: 0, tailHash: r1.hash, entryCount: 1 },
      { index: 1, tailHash: 'ff'.repeat(32), entryCount: 2 }, // 声称锚了 2 行，但 hash 不是第 2 行的 running hash
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.problems.length, 1);
  assert.match(res.problems[0].reason, /tailHash mismatch/);
  assert.equal(res.problems[0].anchor, 1);
  assert.equal(res.verified, 1);
});

test('GAP-002 Ⅲ verify：轮转后旧锚覆盖数超本地 → dropped 信息性（不误报 truncation）', () => {
  // 复核修复 R4：AUDIT_LOG_MAX_BYTES 轮转会合法缩小本地 trail.count，旧锚覆盖
  // 数因此 > 本地数 —— 必须记 dropped（信息性）而非误报 "truncation"。
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));
  const trail = replayAuditTrail(f); // 1 行
  const res = verifyAuditAgainstAnchors({
    trail,
    anchors: [
      { index: 0, tailHash: trail.hashes[0], entryCount: 5 }, // 覆盖 5 条，本地仅 1 条（已轮转）
    ],
  });
  assert.equal(res.ok, true, 'legit rotation retention must not be a truncation alarm');
  assert.deepEqual(res.problems, []);
  assert.equal(res.dropped.length, 1);
  assert.equal(res.dropped[0].entryCount, 5);
  assert.equal(res.dropped[0].localCount, 1);
  // 已 removed 的 verified 语义：该锚不可本地验，不计入 verified。
  assert.equal(res.verified, 0);
});

test('GAP-002 Ⅲ verify：轮转后 entryCount 回退 + 新锚在本地区域 → 不误报 regression', () => {
  // 复核修复 R4：合法轮转会让绝对 entryCount 回退，不得再据此自动判篡改；
  // 只要回退锚仍在本地区域且位置校验通过即 ok。
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));
  const trail = replayAuditTrail(f);
  const res = verifyAuditAgainstAnchors({
    trail,
    anchors: [
      { index: 0, tailHash: trail.hashes[0], entryCount: 5 }, // 旧锚：曾覆盖 5 条（已轮转删除 3 条）
      { index: 1, tailHash: trail.hashes[1], entryCount: 2 }, // 新锚：回退到 2，但仍在本地
    ],
  });
  assert.equal(res.ok, true, 'entryCount regression from legit rotation must not alarm');
  assert.equal(res.dropped.length, 1);
  assert.equal(res.verified, 1, 'the locally-present matching anchor verifies');
});

test('GAP-002 Ⅲ verify：链上索引跳变（重写多锚）→ 告警；链上 0x 前缀统一', () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));
  const trail = replayAuditTrail(f);
  const res = verifyAuditAgainstAnchors({
    trail,
    anchors: [
      { index: 0, tailHash: `0x${trail.hashes[0]}`, entryCount: 1 },
      { index: 2, tailHash: trail.hashes[0], entryCount: 1 }, // 跳过 index 1
    ],
  });
  assert.equal(res.ok, false);
  assert.match(res.problems[0].reason, /index gap/);
});

test('GAP-002 Ⅲ verify：trail 未通过重放 → ok:false 拒绝验证（fail-closed）', () => {
  const res = verifyAuditAgainstAnchors({
    trail: { ok: false, error: 'boom', count: 0, hashes: [], tailHash: null },
    anchors: [{ index: 0, tailHash: 'aa'.repeat(32), entryCount: 1 }],
  });
  assert.equal(res.ok, false);
  assert.match(res.problems[0].reason, /not intact/);
});

// ── loadAuditAnchorArtifact ───────────────────────────────────────────────

test('GAP-002 Ⅲ artifact：env 覆盖加载；缺失 → null', () => {
  // 缺省 repo 路径（本机已 forge build）也应加载成功——两条都测。
  const viaEnv = join(dir, 'anchor.json');
  writeFileSync(viaEnv, JSON.stringify({ abi: [{ type: 'function', name: 'anchor' }] }));
  process.env.AUDIT_ANCHOR_ARTIFACT = viaEnv;
  const a = loadAuditAnchorArtifact();
  assert.ok(Array.isArray(a.abi));
  assert.equal(a.abi[0].name, 'anchor');

  process.env.AUDIT_ANCHOR_ARTIFACT = join(dir, 'missing.json');
  assert.equal(loadAuditAnchorArtifact(), null);
});

// ── startAuditAnchorService（stub contract，无真链）────────────────────────

/** stub contract：记录调用，可注入失败。 */
function makeStubContract({ fail = false } = {}) {
  const state = { anchors: [], calls: 0 };
  const iface = {
    parseLog: () => ({ name: 'Anchored', args: { index: BigInt(state.anchors.length - 1) } }),
  };
  return {
    state,
    iface,
    count: async () => state.anchors.length,
    latest: async () => {
      const last = state.anchors[state.anchors.length - 1];
      return last ? [`0x${last.tailHash}`, BigInt(last.entryCount), BigInt(1)] : ['0x' + '00'.repeat(32), 0n, 0n];
    },
    getAnchor: async (i) => {
      const a = state.anchors[i];
      return a ? [`0x${a.tailHash}`, BigInt(a.entryCount), BigInt(1)] : ['0x' + '00'.repeat(32), 0n, 0n];
    },
    anchor: async (tailHash, entryCount) => {
      if (fail) throw new Error('stub rpc failure');
      state.calls += 1;
      state.anchors.push({ tailHash: tailHash.replace(/^0x/, ''), entryCount: Number(entryCount) });
      return {
        wait: async () => ({
          status: 1,
          hash: `0xtx-${state.calls}`,
          logs: [{ topics: [], data: '0x' }], // parseLog stub 返回 Anchored
        }),
      };
    },
  };
}

/** 外部链 env stub（relayer.connect 语义）。 */
function externalChainEnv() {
  return {
    provider: { fake: 'rpc' },
    relayer: { connect: () => ({ fake: 'signer' }) },
    localChain: null,
  };
}

test('GAP-002 Ⅲ 服务 gate：无 interval → null（零基线影响）', () => {
  assert.equal(startAuditAnchorService({ resolveChainEnv: externalChainEnv }), null);
});

test('GAP-002 Ⅲ 服务 fail-closed：interval 设但缺合约地址 / 缺产物 → 抛错', () => {
  const art = join(dir, 'anchor.json');
  writeFileSync(art, JSON.stringify({ abi: [] }));

  assert.throws(() => startAuditAnchorService({
    intervalMs: 1000, artifact: { abi: [] }, resolveChainEnv: externalChainEnv,
  }), /AUDIT_ANCHOR_CONTRACT/);

  process.env.AUDIT_ANCHOR_ARTIFACT = join(dir, 'missing.json');
  assert.throws(() => startAuditAnchorService({
    intervalMs: 1000, contractAddress: ADDR, resolveChainEnv: externalChainEnv,
  }), /artifact/);
});

test('GAP-002 Ⅲ tick：锚定成功 → contract.anchor(tailHash, count) 上链、状态更新', async () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));
  const trail = replayAuditTrail(f);

  const stub = makeStubContract();
  const svc = startAuditAnchorService({
    intervalMs: 60_000,
    contractAddress: ADDR,
    artifact: { abi: fakeAbi },
    resolveChainEnv: externalChainEnv,
    auditFile: f,
    makeContract: () => stub,
  });
  const res = await svc.tick();
  assert.equal(res.action, 'anchored');
  assert.equal(res.count, 2);
  assert.equal(res.tailHash, trail.tailHash);
  assert.equal(stub.state.anchors.length, 1);
  assert.equal(stub.state.anchors[0].entryCount, 2);
  assert.equal(stub.state.anchors[0].tailHash, trail.tailHash);

  const status = svc.status();
  assert.equal(status.running, true);
  assert.equal(status.anchoredCount, 1);
  assert.equal(status.lastAnchored.tailHash, trail.tailHash);
  svc.stop();
});

test('GAP-002 Ⅲ tick：无新条目 → 跳过不发 tx（幂等轮询）', async () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));

  const stub = makeStubContract();
  const svc = startAuditAnchorService({
    intervalMs: 60_000, contractAddress: ADDR, artifact: { abi: fakeAbi },
    resolveChainEnv: externalChainEnv, auditFile: f, makeContract: () => stub,
  });
  await svc.tick();
  assert.equal(stub.state.calls, 1);
  const res2 = await svc.tick();
  assert.equal(res2.action, 'skipped_no_new_entries');
  assert.equal(stub.state.calls, 1, 'no new anchor tx');

  // 新审计条目 → 再锚。
  recordAudit(ENTRY(2));
  const res3 = await svc.tick();
  assert.equal(res3.action, 'anchored');
  assert.equal(res3.count, 2);
  assert.equal(stub.state.calls, 2);
  svc.stop();
});

test('GAP-002 Ⅲ tick：本地链被篡改 → 拒绝锚定（fail-closed，绝不把坏链锚上链）', async () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[0]);
  rec.payloadDigest = '0xEVIL';
  lines[0] = JSON.stringify(rec);
  writeFileSync(f, lines.join('\n') + '\n', 'utf8');

  const stub = makeStubContract();
  const svc = startAuditAnchorService({
    intervalMs: 60_000, contractAddress: ADDR, artifact: { abi: fakeAbi },
    resolveChainEnv: externalChainEnv, auditFile: f, makeContract: () => stub,
  });
  const res = await svc.tick();
  assert.equal(res.action, 'refused_tampered');
  assert.equal(stub.state.calls, 0, 'must NOT anchor a tampered chain');
  svc.stop();
});

test('GAP-002 Ⅲ tick：ephemeral 本地链 → 停用服务（锚无意义且误导）', async () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));
  const stub = makeStubContract();
  const svc = startAuditAnchorService({
    intervalMs: 60_000, contractAddress: ADDR, artifact: { abi: fakeAbi },
    resolveChainEnv: () => Promise.resolve({ provider: null, relayer: null, localChain: { url: 'local' } }),
    auditFile: f, makeContract: () => stub,
  });
  const res = await svc.tick();
  assert.equal(res.action, 'stopped_local_chain');
  assert.equal(svc.status().running, false);
  assert.equal(stub.state.calls, 0);
});

test('GAP-002 Ⅲ tick：广播失败 → 不崩溃、下轮重试成功', async () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));

  const stub = makeStubContract();
  stub.anchor = async () => { throw new Error('rpc flake'); };
  const svc = startAuditAnchorService({
    intervalMs: 60_000, contractAddress: ADDR, artifact: { abi: fakeAbi },
    resolveChainEnv: externalChainEnv, auditFile: f, makeContract: () => stub,
  });
  const bad = await svc.tick();
  assert.equal(bad.action, 'error');
  assert.equal(bad.stage, 'broadcast');

  // 恢复后同一 tick 路径重试成功（服务未被失败拖垮）。
  stub.anchor = makeStubContract().anchor;
  const good = await svc.tick();
  assert.equal(good.action, 'anchored');
  svc.stop();
});

test('GAP-002 Ⅲ tick：重启对齐 —— 链上 latest 与本地尾一致 → 不发 tx', async () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  const r1 = recordAudit(ENTRY(1));

  // 预置链上已锚（模拟上一进程锚过、进程重启）。
  const stub = makeStubContract();
  stub.state.anchors.push({ tailHash: r1.hash, entryCount: 1 });

  const svc = startAuditAnchorService({
    intervalMs: 60_000, contractAddress: ADDR, artifact: { abi: fakeAbi },
    resolveChainEnv: externalChainEnv, auditFile: f, makeContract: () => stub,
  });
  const res = await svc.tick();
  assert.equal(res.action, 'skipped_resumed_aligned');
  assert.equal(stub.state.calls, 0, 'aligned restart must not re-anchor');
  assert.equal(svc.status().lastAnchored.resumed, true);
  svc.stop();
});

test('GAP-002 Ⅲ 端到端语义：锚定后重写前缀 → verifyAuditAgainstAnchors 失配', async () => {
  const f = join(dir, 'a.jsonl');
  useFile(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));

  const stub = makeStubContract();
  const svc = startAuditAnchorService({
    intervalMs: 60_000, contractAddress: ADDR, artifact: { abi: fakeAbi },
    resolveChainEnv: externalChainEnv, auditFile: f, makeContract: () => stub,
  });
  await svc.tick();
  svc.stop();
  assert.equal(stub.state.anchors.length, 1);

  // 攻击者重写第 1 行 payloadDigest 并【重算整链】（后续 prevHash + hash 全部
  // 重算）→ 本地链完全自洽、无断链 —— 唯一失配在链上锚（这正是锚定的价值）。
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const recs = lines.map((l) => JSON.parse(l));
  recs[0].payloadDigest = '0xEVIL';
  let prev = null;
  for (const rec of recs) {
    rec.prevHash = prev;
    rec.hash = createHash('sha256').update(canonicalJson(rec)).digest('hex');
    prev = rec.hash;
  }
  writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const trail = replayAuditTrail(f);
  const res = verifyAuditAgainstAnchors({
    trail,
    anchors: [{ index: 0, tailHash: stub.state.anchors[0].tailHash, entryCount: 2 }],
  });
  assert.equal(res.ok, false, 'rewrite of an anchored prefix must be detected on-chain');
  assert.match(res.problems[0].reason, /tailHash mismatch/);
});

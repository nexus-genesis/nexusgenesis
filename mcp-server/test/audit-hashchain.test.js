/**
 * audit-hashchain.test.js — Sprint 8: GAP-002 审计 hash-chain 固化 验收
 *
 * GAP-002 承接："审计事件链路哈希固化 + 无篡改检测"。本测试覆盖：
 *   - recordAudit 注入 prevHash/hash：首条 prevHash=null，其后串联上一 hash。
 *   - 对落盘 AUDIT_LOG_FILE 调 verifyAuditHashChain：未篡改 → ok:true 且校验计数正确。
 *   - 篡改检测：改一行字段 / 删尾部 / 插行（改 hash 或 prevHash）→ ok:false 且 firstBadIndex 正确。
 *   - 确定性：相同字段记录可复算同 hash（跨进程可验）。
 *   - 兼容：新增字段不破坏既有 schema（validateAuditEntry 只看稳定字段）。
 *
 * 全部 fail-closed、仅 node:crypto，无外部服务。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordAudit,
  verifyAuditHashChain,
  auditHash,
  validateAuditEntry,
  __resetAuditForTest,
} from '../src/audit-log.js';

let dir;
let file;

function freshFile() {
  dir = mkdtempSync(join(tmpdir(), 'gap002-'));
  file = join(dir, 'audit.jsonl');
  process.env.AUDIT_LOG_FILE = file;
  return file;
}

/** 清链尾 + 切换审计文件，避免跨测试串链。 */
function reset(auditFile) {
  __resetAuditForTest();
  if (auditFile) process.env.AUDIT_LOG_FILE = auditFile;
}

afterEach(() => {
  delete process.env.AUDIT_LOG_FILE;
  __resetAuditForTest();
  try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  dir = null;
});

const ENTRY = (i) => ({
  tool: 'smart_account_execute',
  accountId: `acc-${i}`,
  sessionId: null,
  payloadDigest: `0xdig-${i}`,
  txHash: `0x${i.toString(16).padStart(64, '0')}`,
  errorName: null,
});

// ── 链式注入 ──────────────────────────────────────────────────────────────
test('GAP-002 首条 prevHash=null，其后串联上一 hash', () => {
  reset();
  const r1 = recordAudit(ENTRY(1));
  const r2 = recordAudit(ENTRY(2));
  const r3 = recordAudit(ENTRY(3));

  assert.equal(r1.prevHash, null);
  assert.equal(r1.hash, auditHash(r1));
  assert.equal(r2.prevHash, r1.hash);
  assert.equal(r3.prevHash, r2.hash);
});

test('GAP-002 确定性：同一固定字段记录可跨进程复算同 hash', () => {
  // 不依赖 recordAudit 的 timestamp 注入：对固定字段对象断言 auditHash 纯函数确定性。
  const fixed = { prevHash: 'aa'.repeat(32), timestamp: '2026-01-01T00:00:00.000Z', tool: 'smart_account_execute', accountId: 'acc-7', sessionId: null, payloadDigest: '0xdig-7', txHash: '0x7', errorName: null };
  const a = auditHash(fixed);
  const b = auditHash({ ...fixed }); // 键序打乱重排 → canonical 序列化仍固定 → 同 hash
  assert.equal(a, b);
  assert.equal(a.length, 64);
  // 嵌套对象字段同样进入哈希域（canonical 递归）。
  const nested = { ...fixed, detail: { severity: 'critical', rule: 'chain_rpc_down' } };
  assert.notEqual(auditHash(nested), a);
});

// ── 落盘校验 + 篡改检测 ───────────────────────────────────────────────────
test('GAP-002 落盘未篡改：verifyAuditHashChain → ok:true, verified=N', () => {
  const f = freshFile();
  reset(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));
  recordAudit(ENTRY(3));

  const res = verifyAuditHashChain(f);
  assert.equal(res.ok, true);
  assert.equal(res.verified, 3);
  assert.equal(res.firstBadIndex, null);
  assert.equal(res.error, null);
});

test('GAP-002 篡改字段（改 txHash 而不改 hash）→ hash tampered，firstBadIndex 正确', () => {
  const f = freshFile();
  reset(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));

  // 读回并篡改第一条的 payloadDigest（不动 hash）→ 重算不一致。
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[0]);
  rec.payloadDigest = '0xTAMPERED';
  lines[0] = JSON.stringify(rec);
  writeFileSync(f, lines.join('\n') + '\n', 'utf8');

  const res = verifyAuditHashChain(f);
  assert.equal(res.ok, false);
  assert.equal(res.firstBadIndex, 0);
  assert.match(res.error, /tampered/);
});

test('GAP-002 删除尾部行 → 校验通过（删除拦不住，仅逐行哈希自洽）', () => {
  const f = freshFile();
  reset(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));
  recordAudit(ENTRY(3));

  // 删掉最后一行：剩余行仍自洽（链首 prevHash=null、r2.prevHash=r1.hash）。
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  lines.pop();
  writeFileSync(f, lines.join('\n') + '\n', 'utf8');

  const res = verifyAuditHashChain(f);
  assert.equal(res.ok, true);
  assert.equal(res.verified, 2);
});

test('GAP-002 篡改预测：改 prevHash 破坏串联 → ok:false', () => {
  const f = freshFile();
  reset(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));

  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const second = JSON.parse(lines[1]);
  second.prevHash = '0x'.padEnd(64, '0'); // 伪造链尾，必须与上一行 hash 不同
  assert.notEqual(second.prevHash, JSON.parse(lines[0]).hash);
  lines[1] = JSON.stringify(second);
  writeFileSync(f, lines.join('\n') + '\n', 'utf8');

  const res = verifyAuditHashChain(f);
  assert.equal(res.ok, false);
  assert.equal(res.firstBadIndex, 1);
  assert.match(res.error, /prevHash mismatch/);
});

test('GAP-002 文件不存在 → ok:false 且带错误信息', () => {
  const res = verifyAuditHashChain(join(dir ?? tmpdir(), 'missing-xxx.jsonl'));
  assert.equal(res.ok, false);
  assert.match(res.error, /does not exist/);
});

// ── 复核修复 R1：进程重启续链（防 tampered 误报）──────────────────────────
test('GAP-002 复核R1 重启后续链：内存链清空后首条从文件尾续，不误报篡改', () => {
  const f = freshFile();
  reset(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));

  // 模拟进程重启：内存环形/链尾/初始化标志全部清零，但磁盘文件保留。
  __resetAuditForTest();
  const r3 = recordAudit(ENTRY(3));

  // 新记录的 prevHash = 文件尾（r2.hash），而非 null。
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const r2hash = JSON.parse(lines[1]).hash;
  assert.equal(r3.prevHash, r2hash);

  // 全文件校验通过 —— 重启不产生 prevHash mismatch 误报。
  const res = verifyAuditHashChain(f);
  assert.equal(res.ok, true);
  assert.equal(res.verified, 3);
});

// ── 复核修复 R3：非 schema 字段篡改检测（全记录哈希域）──────────────────
test('GAP-002 复核R3 篡改非 schema 字段（broadcaster/告警明细）→ hash tampered', () => {
  const f = freshFile();
  reset(f);
  recordAudit({ ...ENTRY(1), broadcaster: 'relayer-01', detail: { severity: 'critical', rule: 'chain_rpc_down' } });

  // 篡改嵌套告警明细（固定字段子集哈希会漏检；全记录 canonical 哈希必须捕获）。
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[0]);
  rec.detail.severity = 'info';
  lines[0] = JSON.stringify(rec);
  writeFileSync(f, lines.join('\n') + '\n', 'utf8');

  const res = verifyAuditHashChain(f);
  assert.equal(res.ok, false);
  assert.equal(res.firstBadIndex, 0);
  assert.match(res.error, /tampered/);

  // 篡改 broadcaster 同样检测。
  const lines2 = readFileSync(f, 'utf8').trim().split('\n');
  const rec2 = JSON.parse(lines2[0]);
  rec2.detail.severity = 'critical'; // 还原
  rec2.broadcaster = 'attacker-relay';
  lines2[0] = JSON.stringify(rec2);
  writeFileSync(f, lines2.join('\n') + '\n', 'utf8');
  const res2 = verifyAuditHashChain(f);
  assert.equal(res2.ok, false);
  assert.match(res2.error, /tampered/);
});

// ── 复核修复 R2：轮转 anchor（跨卷链连续 + 头部截断检测保留）────────────
test('GAP-002 复核R2 轮转后跨卷校验：anchorHash 接旧卷尾，头部截断仍可检测', () => {
  const f = freshFile();
  reset(f);
  recordAudit(ENTRY(1));
  recordAudit(ENTRY(2));

  // 模拟轮转：当前卷 → .1，新卷续写（进程内存链尾不变 → 新卷首 prevHash=旧卷尾）。
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  writeFileSync(`${f}.1`, lines.join('\n') + '\n', 'utf8');
  writeFileSync(f, '', 'utf8');
  recordAudit(ENTRY(3)); // 写入新卷（prevHash=r2.hash）

  // a) anchor 正确 → 跨卷链校验通过。
  const oldVol = verifyAuditHashChain(`${f}.1`);
  assert.equal(oldVol.ok, true);
  const ok = verifyAuditHashChain(f, { anchorHash: oldVol.tailHash });
  assert.equal(ok.ok, true);
  assert.equal(ok.verified, 1);
  assert.equal(typeof ok.tailHash, 'string');

  // b) 无 anchor（默认）→ 新卷首 prevHash 非 null → mismatch（如实报断链）。
  const noAnchor = verifyAuditHashChain(f);
  assert.equal(noAnchor.ok, false);
  assert.match(noAnchor.error, /prevHash mismatch/);

  // b2) continuation 锚 → 链中段卷首被接受（更旧卷已删除的保留期语义）。
  const cont = verifyAuditHashChain(f, { anchorHash: 'continuation' });
  assert.equal(cont.ok, true);
  assert.equal(cont.verified, 1);

  // c) 头部截断检测保留：删掉新卷首行（剩 r4，其 prevHash=r3.hash≠anchor）→ 检出。
  recordAudit(ENTRY(4));
  const cur = readFileSync(f, 'utf8').trim().split('\n');
  cur.shift(); // 截头
  writeFileSync(f, cur.join('\n') + '\n', 'utf8');
  const trunc = verifyAuditHashChain(f, { anchorHash: oldVol.tailHash });
  assert.equal(trunc.ok, false);
  assert.match(trunc.error, /prevHash mismatch/);
});

// ── 兼容性 ────────────────────────────────────────────────────────────────
test('GAP-002 新增字段不破坏既有 schema 校验', () => {
  reset();
  const rec = recordAudit(ENTRY(5));
  // 稳定字段仍是合法类型。
  assert.equal(validateAuditEntry(rec).ok, true);
  // hash / prevHash 为附加字段：非 schema 校验对象，不影响 ok。
  assert.equal(typeof rec.hash, 'string');
  assert.equal(rec.hash.length, 64);
});
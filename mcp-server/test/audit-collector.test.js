/**
 * audit-collector.test.js — Sprint 8: GAP-002 Ⅱ 集中式审计收集端点 验收
 *
 * GAP-002 承接："审计事件链路哈希固化 + 集中式审计收集端点"。Ⅰ 阶段已在 audit-log.js
 * 固化 hash-chain；本测试覆盖集中式收集端点 / 与 /entries：
 *   - gate 关闭（无 AUDIT_HTTP_PORT）→ startAuditCollector 返回 null，不监听。
 *   - GET /entries：返回全量审计行（含 hash/prevHash），并附带 hash-chain 校验结果
 *     （tampered/chainOk）—— 收集到的数据本身可独立复验。
 *   - 篡改落盘文件后：tampered=true 且 chainOk=false，但绝不静默丢弃数据。
 *   - 无审计文件（未设 AUDIT_LOG_FILE）→ 网关 null、/entries 空数组、chainOk=null。
 *   - 非 GET / 未知路径 → 404。
 *   - 端口冲突 → 结构化错误日志记录，进程不崩溃（与观测端点同规约）。
 *   - README 文档对齐：端点仅 loopback、只读、复用 hash-chain。
 * 零外部依赖（node:http / node:fs / node:crypto），CI 无外部服务仍全绿。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startAuditCollector,
  auditFileStatus,
} from '../src/audit-collector.js';
import { recordAudit, __resetAuditForTest } from '../src/audit-log.js';

let dir;
let file;
let servers = [];

function freshFile() {
  dir = mkdtempSync(join(tmpdir(), 'gap002collect-'));
  file = join(dir, 'audit.jsonl');
  process.env.AUDIT_LOG_FILE = file;
  return file;
}

async function listen(server) {
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  return server.address().port;
}

afterEach(async () => {
  delete process.env.AUDIT_LOG_FILE;
  delete process.env.AUDIT_HTTP_PORT;
  delete process.env.AUDIT_LOG_MAX_BYTES;
  __resetAuditForTest();
  const s = servers;
  servers = [];
  await Promise.all(s.map((sv) => new Promise((r) => { try { sv.close(r); } catch { r(); } })));
  try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  dir = null;
});

// ── gate 关闭 / 基本行为 ──────────────────────────────────────────────────
test('GAP-002 Ⅱ gate 关闭（无 AUDIT_HTTP_PORT）→ 返回 null，不监听', () => {
  assert.equal(startAuditCollector({}), null);
  assert.equal(startAuditCollector({ port: '' }), null);
  assert.equal(startAuditCollector({ port: '   ' }), null);
});

test('GAP-002 Ⅱ no file status: exists=false, chainOk=null, tampered=false', () => {
  const s = auditFileStatus(null);
  assert.equal(s.file, null);
  assert.equal(s.exists, false);
  assert.equal(s.tampered, false);
  assert.equal(s.chainOk, null);
});

test('GAP-002 Ⅱ /entries 返回全量审计行 + 校验（未篡改 → chainOk=true, tampered=false）', async () => {
  const f = freshFile();
  recordAudit({ tool: 'smart_account_execute', accountId: 'acc-1', sessionId: 's1', payloadDigest: '0x1', txHash: '0x1', errorName: null });
  recordAudit({ tool: 'smart_account_preview', accountId: 'acc-2', sessionId: 's2', payloadDigest: '0x2', txHash: '0x2', errorName: null });

  const server = startAuditCollector({ port: '0' });
  assert.ok(server);
  const port = await listen(server);

  const res = await fetch(`http://127.0.0.1:${port}/entries`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 2);
  assert.equal(body.tampered, false);
  assert.equal(body.chainOk, true);
  assert.equal(body.entries.length, 2);
  // 每条带 hash/prevHash，下游可独立复验。
  assert.equal(typeof body.entries[0].hash, 'string');
  assert.equal(body.entries[0].hash.length, 64);
  assert.equal(body.entries[0].prevHash, null);
  assert.equal(body.entries[1].prevHash, body.entries[0].hash);
});

test('GAP-002 Ⅱ 篡改落盘 → tampered=true, chainOk=false，但数据仍返回（不静默丢弃）', async () => {
  const f = freshFile();
  recordAudit({ tool: 'smart_account_execute', accountId: 'acc-1', sessionId: 's1', payloadDigest: '0xdig', txHash: '0x1', errorName: null });
  recordAudit({ tool: 'smart_account_execute', accountId: 'acc-2', sessionId: 's2', payloadDigest: '0xdig2', txHash: '0x2', errorName: null });

  // 篡改第一行的 payloadDigest（不动 hash）。
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const r1 = JSON.parse(lines[0]);
  r1.payloadDigest = '0xTAMPERED';
  lines[0] = JSON.stringify(r1);
  writeFileSync(f, lines.join('\n') + '\n', 'utf8');

  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/entries`);
  const body = await res.json();
  // 检测到篡改但数据仍可见（运维可判定、不被静默吞掉）。
  assert.equal(body.tampered, true);
  assert.equal(body.chainOk, false);
  assert.match(body.chainError, /tampered/);
  assert.equal(body.count, 2);
});

test('GAP-002 Ⅱ GET / 摘要：文件存在、条目已校验、tampered 标记', async () => {
  const f = freshFile();
  recordAudit({ tool: 'smart_account_execute', accountId: 'a', sessionId: 's', payloadDigest: '0x', txHash: '0x1', errorName: null });
  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const body = await res.json();
  assert.equal(body.exists, true);
  assert.equal(body.chainOk, true);
  assert.equal(body.verified, 1);
});

test('GAP-002 Ⅱ 非 GET / 未知路径 → 404', async () => {
  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res404 = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(res404.status, 404);
  const req = await fetch(`http://127.0.0.1:${port}/entries`, { method: 'POST' });
  assert.equal(req.status, 404);
});

test('GAP-002 Ⅱ 端口冲突 → 结构化错误日志 + 进程存活不崩溃（与观测端点同规约）', async () => {
  const blocker = http.createServer(() => {});
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  const server = startAuditCollector({ port: String(port) });
  assert.ok(server);
  // 等待一拍：无 error handler 时 EADDRINUSE 是 uncaught exception → 进程崩溃。
  await new Promise((r) => setTimeout(r, 120));
  await new Promise((r) => server.close(r));
  await new Promise((r) => blocker.close(r));
});

// ── 复核修复 R2：真实轮转（maybeRotate）跨卷端到端 ───────────────────────
test('GAP-002 Ⅱ 复核R2 真实轮转（连续两次）：链中段旧卷 + 新卷联合校验、不误报', async () => {
  const f = freshFile();
  // 极小上限 → 每次写都轮转：3 次写后 .1=[r2]（链中段，r1 卷已按保留策略删除）、
  // f=[r3]。旧卷首行 prevHash 指向已删历史 → continuation 语义，卷内仍严格串联。
  process.env.AUDIT_LOG_MAX_BYTES = '1';
  recordAudit({ tool: 'smart_account_execute', accountId: 'acc-1', sessionId: 's1', payloadDigest: '0x1', txHash: '0x1', errorName: null });
  recordAudit({ tool: 'smart_account_preview', accountId: 'acc-2', sessionId: 's2', payloadDigest: '0x2', txHash: '0x2', errorName: null });
  recordAudit({ tool: 'smart_account_execute', accountId: 'acc-3', sessionId: 's3', payloadDigest: '0x3', txHash: '0x3', errorName: null });

  // 真实轮转发生：.1 存在、当前卷存在。
  assert.ok(existsSync(`${f}.1`), 'rotation must have produced .1 volume');
  assert.ok(existsSync(f), 'current volume must exist');

  // 联合状态：两卷、链连续、不误报篡改（旧卷链中段 + 当前卷严格锚定）。
  const status = auditFileStatus(f);
  assert.equal(status.volumes, 2);
  assert.equal(status.chainOk, true);
  assert.equal(status.tampered, false);
  assert.equal(status.verified, 2); // .1=[r2] + f=[r3]（r1 已随旧卷删除）

  // /entries 合并两卷（写序），跨卷 prevHash 串联。
  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/entries`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.count, 2);
  assert.equal(body.tampered, false);
  assert.equal(body.chainOk, true);
  assert.equal(body.volumes, 2);
  // 旧卷首条为链中段（prevHash 非 null，指向已删历史）；当前卷首条锚定旧卷尾。
  const entries = body.entries;
  assert.notEqual(entries[0].prevHash, null);
  assert.equal(entries[1].prevHash, entries[0].hash);
});

// ── 增量收集：游标（afterHash）+ 分页（limit）+ /tail 锚定 ───────────────
test('GAP-002 Ⅱ 游标增量：afterHash=r1 → 仅返回 r2/r3，链连续，nextCursor=尾', async () => {
  const f = freshFile();
  const r1 = recordAudit({ tool: 'smart_account_execute', accountId: 'a1', sessionId: null, payloadDigest: '0x1', txHash: '0x1', errorName: null });
  recordAudit({ tool: 'smart_account_preview', accountId: 'a2', sessionId: null, payloadDigest: '0x2', txHash: '0x2', errorName: null });
  const r3 = recordAudit({ tool: 'smart_account_execute', accountId: 'a3', sessionId: null, payloadDigest: '0x3', txHash: '0x3', errorName: null });

  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/entries?afterHash=${r1.hash}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.stale, false);
  assert.equal(body.count, 2);
  assert.equal(body.totalAfterCursor, 2);
  assert.equal(body.hasMore, false);
  // 增量首条链连续（prevHash = 游标），nextCursor = 最后一条 hash。
  assert.equal(body.entries[0].prevHash, r1.hash);
  assert.equal(body.nextCursor, r3.hash);
});

test('GAP-002 Ⅱ 游标=当前链尾 → 0 条增量，nextCursor 回显游标（无新事件）', async () => {
  const f = freshFile();
  const r1 = recordAudit({ tool: 'smart_account_execute', accountId: 'a1', sessionId: null, payloadDigest: '0x1', txHash: '0x1', errorName: null });

  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/entries?afterHash=${r1.hash}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.stale, false);
  assert.equal(body.count, 0);
  assert.equal(body.entries.length, 0);
  assert.equal(body.nextCursor, r1.hash);
});

test('GAP-002 Ⅱ 游标失配（两次拉取间头部被截/重写）→ stale=true + 全量重同步', async () => {
  const f = freshFile();
  recordAudit({ tool: 'smart_account_execute', accountId: 'a1', sessionId: null, payloadDigest: '0x1', txHash: '0x1', errorName: null });
  recordAudit({ tool: 'smart_account_execute', accountId: 'a2', sessionId: null, payloadDigest: '0x2', txHash: '0x2', errorName: null });

  const bogus = 'ab'.repeat(32); // 不在链中的 64-hex 游标
  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/entries?afterHash=${bogus}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.stale, true); // 收集方据此告警：上次锚定的链尾已不在链中
  assert.equal(body.count, 2); // 全量返回供重同步
  assert.equal(body.chainOk, true);
});

test('GAP-002 Ⅱ 分页：limit=1 取最旧增量 + hasMore，nextCursor 支持续拉', async () => {
  const f = freshFile();
  const r1 = recordAudit({ tool: 'smart_account_execute', accountId: 'a1', sessionId: null, payloadDigest: '0x1', txHash: '0x1', errorName: null });
  const r2 = recordAudit({ tool: 'smart_account_execute', accountId: 'a2', sessionId: null, payloadDigest: '0x2', txHash: '0x2', errorName: null });
  recordAudit({ tool: 'smart_account_execute', accountId: 'a3', sessionId: null, payloadDigest: '0x3', txHash: '0x3', errorName: null });

  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/entries?afterHash=${r1.hash}&limit=1`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.totalAfterCursor, 2);
  assert.equal(body.hasMore, true);
  assert.equal(body.entries[0].accountId, 'a2'); // 旧→新取头部
  assert.equal(body.nextCursor, r2.hash);

  // 用 nextCursor 续拉 → 剩余 1 条。
  const res2 = await fetch(`http://127.0.0.1:${port}/entries?afterHash=${body.nextCursor}`);
  const body2 = await res2.json();
  assert.equal(body2.count, 1);
  assert.equal(body2.entries[0].accountId, 'a3');
  assert.equal(body2.hasMore, false);
});

test('GAP-002 Ⅱ 跨卷游标：afterHash 在 .1 旧卷 → 增量含当前卷条目', async () => {
  const f = freshFile();
  process.env.AUDIT_LOG_MAX_BYTES = '1';
  recordAudit({ tool: 'smart_account_execute', accountId: 'a1', sessionId: null, payloadDigest: '0x1', txHash: '0x1', errorName: null });
  const r2 = recordAudit({ tool: 'smart_account_execute', accountId: 'a2', sessionId: null, payloadDigest: '0x2', txHash: '0x2', errorName: null });
  const r3 = recordAudit({ tool: 'smart_account_execute', accountId: 'a3', sessionId: null, payloadDigest: '0x3', txHash: '0x3', errorName: null });
  // maxBytes=1 连续轮转：.1=[r2]、f=[r3]；游标在 .1 卷内。

  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/entries?afterHash=${r2.hash}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.stale, false);
  assert.equal(body.count, 1);
  assert.equal(body.entries[0].accountId, 'a3');
  assert.equal(body.nextCursor, r3.hash);
});

test('GAP-002 Ⅱ /tail 锚定端点：tailHash=链尾、count/chainOk/verified 齐全', async () => {
  const f = freshFile();
  const r1 = recordAudit({ tool: 'smart_account_execute', accountId: 'a1', sessionId: null, payloadDigest: '0x1', txHash: '0x1', errorName: null });
  const r2 = recordAudit({ tool: 'smart_account_execute', accountId: 'a2', sessionId: null, payloadDigest: '0x2', txHash: '0x2', errorName: null });

  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/tail`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.count, 2);
  assert.equal(body.chainOk, true);
  assert.equal(body.tampered, false);
  assert.equal(body.tailHash, r2.hash); // 收集方锚定此值
  assert.equal(body.verified, 2);
});

test('GAP-002 Ⅱ /tail 篡改场景：tampered=true 且 tailHash=null（锚定不可用要响亮）', async () => {
  const f = freshFile();
  recordAudit({ tool: 'smart_account_execute', accountId: 'a1', sessionId: null, payloadDigest: '0x1', txHash: '0x1', errorName: null });
  // 就地篡改（不改 hash）→ 联合校验失败。
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[0]);
  rec.payloadDigest = '0xTAMPERED';
  lines[0] = JSON.stringify(rec);
  writeFileSync(f, lines.join('\n') + '\n', 'utf8');

  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/tail`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.tampered, true);
  assert.equal(body.chainOk, false);
  assert.equal(body.tailHash, null);
});

test('GAP-002 Ⅱ 参数校验：非法 afterHash / limit → 400（操作员错误要响亮）', async () => {
  const server = startAuditCollector({ port: '0' });
  const port = await listen(server);
  const bad1 = await fetch(`http://127.0.0.1:${port}/entries?afterHash=notahash`);
  assert.equal(bad1.status, 400);
  const bad2 = await fetch(`http://127.0.0.1:${port}/entries?limit=abc`);
  assert.equal(bad2.status, 400);
  const bad3 = await fetch(`http://127.0.0.1:${port}/entries?limit=0`);
  assert.equal(bad3.status, 400);
});
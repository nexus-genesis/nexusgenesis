/**
 * audit-log.js — Smart Account 审计日志 (Sprint 2.7 T1)
 *
 * 记录每次 setup / preview / execute / estimate_loss 的操作事实，供长期运维审计。
 *
 * 关键字段（对调用方稳定）：
 *   tool / accountId / sessionId / payloadDigest / txHash / errorName /
 *   broadcaster / timestamp
 *
 * 双写：
 *   - stderr JSON line（stdio 安全：stdout 留给 MCP 协议，绝不写 stdout）
 *   - 可选落盘 AUDIT_LOG_FILE（JSON lines，原子追加）
 * 内存环形缓冲（上限 1000 条）供 smart_account_audit 查询。
 */
import { appendFileSync, mkdirSync, renameSync, statSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_MEMORY_ENTRIES = 1000;

let memoryRing = [];
// GAP-002 hash-chain：上一记录的 `hash`（链尾）。写序严格递增，保证内存/落盘同链。
// 复核修复 R1：链尾必须跨进程持久——首次写盘前从现有文件尾部惰性初始化，
// 否则进程重启后首条 prevHash=null 会插进已有链中 → verify 误报 prevHash
// mismatch（tampered=false positive）。多进程并发 append 同一文件不在支持范围
//（AUDIT_LOG_FILE 为 per-process 文件，见 DEPLOYMENT_OPS §7）。
let chainLastHash = null;
let chainInitialized = false;

function ensureChainInitialized(file) {
  if (chainInitialized) return;
  chainInitialized = true;
  if (!file || !existsSync(file)) return;
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (last) {
      const rec = JSON.parse(last);
      if (typeof rec.hash === 'string' && rec.hash.length === 64) chainLastHash = rec.hash;
    }
  } catch {
    /* 尾部读取失败 → 从 null 起链（写入继续；校验器会如实报告断链，不静默） */
  }
}

/**
 * 复核修复 R3：全记录规范化序列化（递归键排序，剔除自身 `hash`）。
 * 仅哈希固定字段集会漏掉 broadcaster / alert rule/severity 等非 schema 字段
 * —— 攻击者篡改它们将无法检测，直接削弱 GAP-002 的防篡改承诺。
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => k !== 'hash').sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Sprint 4 T2.3 — stable-field schema for audit records.
// These fields must stay machine-readable across every tool and every release:
// operators (and downstream tooling) depend on their exact shape. `tool` is
// required; the identifiers are string-or-null. Any other type is a schema
// violation (warned on stderr, never silently dropped).
export const AUDIT_SCHEMA = {
  tool: { required: true, type: 'string' },
  accountId: { type: 'string|null' },
  sessionId: { type: 'string|null' },
  payloadDigest: { type: 'string|null' },
  txHash: { type: 'string|null' },
  errorName: { type: 'string|null' },
};

/**
 * Validate an audit entry against the stable-field schema.
 * @param {object} entry
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateAuditEntry(entry) {
  const errors = [];
  for (const [key, spec] of Object.entries(AUDIT_SCHEMA)) {
    const v = entry[key];
    const nullable = spec.type.endsWith('|null');
    if (spec.required) {
      if (typeof v !== spec.type) errors.push(`${key}: expected ${spec.type}, got ${v === null ? 'null' : typeof v}`);
    } else if (v !== undefined && v !== null && (!nullable || typeof v !== 'string')) {
      errors.push(`${key}: expected ${spec.type}, got ${typeof v}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 审计文件路径（env 驱动；未设置 → 仅 stderr + 内存）。 */
export function getAuditFile() {
  return process.env.AUDIT_LOG_FILE || null;
}

/**
 * 写一条审计记录。
 * @param {object} entry - 见文件头字段列表；timestamp 由本函数注入。
 * @returns {object} 规范化后的记录
 */
export function recordAudit(entry) {
  // T2.3: schema check — a violation is loud on stderr but never blocks the
  // audit write (the fact is still recorded; the warning makes it observable).
  const check = validateAuditEntry(entry);
  if (!check.ok) {
    console.error(`[audit] SCHEMA VIOLATION: ${check.errors.join('; ')}`);
  }
  const file = getAuditFile();
  // 复核修复 R1：首次写盘前从现有文件尾续链（跨进程重启不断链）。
  if (file) ensureChainInitialized(file);
  // GAP-002 hash-chain：前一记录的 hash 作为本记录的 prevHash，链尾串联。
  const rec = {
    timestamp: new Date().toISOString(),
    ...entry,
    prevHash: chainLastHash,
    hash: null,
  };
  rec.hash = auditHash(rec);
  chainLastHash = rec.hash;
  memoryRing.push(rec);
  if (memoryRing.length > MAX_MEMORY_ENTRIES) {
    memoryRing = memoryRing.slice(-MAX_MEMORY_ENTRIES);
  }
  const line = JSON.stringify(rec);
  // stderr：MCP stdio 协议只占 stdout，日志必须走 stderr。
  console.error(`[audit] ${line}`);
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Sprint 7 T1.3 — 日志体积上限 + 轮转：AUDIT_LOG_MAX_BYTES（可选）。落盘前
      // 检查当前文件大小，超限 → 重命名为 `.1` 滚动（保留上一卷），再写新卷。
      maybeRotate(file);
      appendFileSync(file, `${line}\n`, 'utf8');
    } catch {
      /* 落盘失败非致命：审计已入内存 + stderr */
    }
  }
  return rec;
}

/**
 * GAP-002 — 计算单条审计记录的链式哈希。
 * 复核修复 R3：哈希覆盖**整条记录**（canonicalJson 递归键排序、剔除自身 `hash`），
 * 而非固定字段子集 —— 任何字段（含 broadcaster / alert 明细）被篡改都会失配。
 * 确定性：键排序后序列化与写入序无关，跨进程/跨节点可复算。
 * @param {object} rec - 审计记录（hash 字段被排除在哈希域外）
 * @returns {string} 32 字节 hex
 */
export function auditHash(rec) {
  return createHash('sha256').update(canonicalJson(rec), 'utf8').digest('hex');
}

/**
 * GAP-002 — 校验落盘审计文件的 hash-chain（无篡改检测）。
 * 逐行重算 hash 并校验 prevHash 串联；任一行被改/断链 → ok=false + firstBadIndex。
 *
 * 复核修复 R2（轮转 anchor）：卷首 prevHash 可为 `opts.anchorHash`（上一卷
 * `.1` 的链尾）—— 轮转产生的新卷以旧卷尾锚定，跨卷链连续；无 anchor 时卷首
 * 必须 prevHash=null（保留头部截断检测：删掉卷首若干行 → 首行 prevHash 非空
 * 且 ≠ anchor → mismatch）。
 * @param {string} file 审计文件路径
 * @param {object} [opts]
 * @param {null|string|'continuation'} [opts.anchorHash] 卷首 prevHash 锚语义：
 *   null=必须为 null（整链起点）；hash 字符串=必须等于该值（上一卷链尾）；
 *   'continuation'=任意（更旧卷已删除的链中段卷，头部不可验）。
 * @returns {{ ok: boolean, verified: number, firstBadIndex: number|null,
 *             error: string|null, tailHash: string|null }}
 */
export function verifyAuditHashChain(file, { anchorHash = null } = {}) {
  if (!file || !existsSync(file)) {
    return { ok: false, verified: 0, firstBadIndex: null, error: `${file || '(none)'} does not exist`, tailHash: null };
  }
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  // anchorHash 三种语义：
  //   null          → 卷首必须 prevHash=null（整链起点；头部截断可检测）。
  //   <hash 字符串> → 卷首必须等于该值（上一卷 .1 的链尾；轮转锚定）。
  //   'continuation'→ 卷首 prevHash 任意（更旧卷已被轮转删除的"链中段"卷——
  //                   其头部指向已删除的历史，不可验证，属保留期边界，见
  //                   SECURITY_GAP_ANALYSIS GAP-002 残留边界）。卷内后续行仍严格串联。
  let prevHash = anchorHash === 'continuation' ? undefined : (anchorHash ?? null);
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      return { ok: false, verified: i, firstBadIndex: i, error: `line ${i + 1} is not valid JSON`, tailHash: null };
    }
    // 卷首按 anchor 语义校验；其后：等于上一行 hash。
    if (prevHash === undefined) {
      prevHash = rec.prevHash ?? null; // continuation：接受任意链中段起点
    } else if (rec.prevHash !== prevHash) {
      return { ok: false, verified: i, firstBadIndex: i, error: `line ${i + 1} prevHash mismatch`, tailHash: null };
    }
    const expected = auditHash(rec);
    if (rec.hash !== expected) {
      return { ok: false, verified: i, firstBadIndex: i, error: `line ${i + 1} hash tampered`, tailHash: null };
    }
    prevHash = rec.hash;
  }
  return { ok: true, verified: lines.length, firstBadIndex: null, error: null, tailHash: prevHash };
}

/** Sprint 7 T1.3 — 超限滚动：当前文件 ≥ AUDIT_LOG_MAX_BYTES → 重命名 `.1`。 */
function maybeRotate(file) {
  const maxRaw = process.env.AUDIT_LOG_MAX_BYTES;
  if (!maxRaw || !/^\d+$/.test(String(maxRaw))) return;
  const maxBytes = Number(maxRaw);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  let size = 0;
  try { size = statSync(file).size; } catch {
    return; // 文件尚不存在 → 无需轮转
  }
  if (size < maxBytes) return;
  try {
    // 复核修复 D：Windows 的 renameSync 到已存在目标会抛 EPERM（非 POSIX 原子
    // 替换）—— 若不先删旧卷，第二次轮转会被下方 catch 吞掉，之后轮转「永久
    // 静默失效」、日志无界增长。先 rmSync 旧卷再滚动（删除失败则交给 rename
    // 自行失败，走同一容错路径）。
    try { rmSync(`${file}.1`, { force: true }); } catch { /* 旧卷删除失败 → rename 会再失败一次 */ }
    renameSync(file, `${file}.1`);
  } catch {
    /* 重命名失败（被占用/权限）→ 放弃轮转，直接继续追加（写入容错优先） */
  }
}

/**
 * 查询最近审计记录（内存环形缓冲，按写入顺序返回最末 limit 条）。
 * @param {object} [opts]
 * @param {string} [opts.accountId] 仅返回该 account 的记录
 * @param {number} [opts.limit=50] 最多返回条数
 * @returns {object[]}
 */
export function listAudit({ accountId, limit = 50 } = {}) {
  let rows = memoryRing;
  if (accountId) rows = rows.filter((r) => r.accountId === accountId);
  return rows.slice(-limit);
}

/** 测试隔离：清空内存环形缓冲并重置 hash-chain 链尾/初始化标志。 */
export function __resetAuditForTest() {
  memoryRing = [];
  chainLastHash = null;
  chainInitialized = false;
}

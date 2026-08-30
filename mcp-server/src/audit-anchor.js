/**
 * audit-anchor.js — 外部锚定上链 (Sprint 8: GAP-002 Ⅲ)
 *
 * GAP-002 残留边界的最终加固：本地 hash-chain（Ⅰ 阶段）+ 集中式收集/游标（Ⅱ 阶段）
 * 只能检测"就地改字段/断链"，防不住拥有文件写权限的攻击者**重算整链**或**截断尾部**。
 * 本模块把审计链尾 hash 定期**锚定到链上**（AuditAnchor.sol，append-only）：
 * 每个锚 = (链尾 hash, 覆盖的条目数) —— 由于 hash 链的传递性，锚同时承诺了
 * 整个前缀。任何对已锚前缀的重写/删除都会让本地重放与链上锚失配。
 *
 * 构成：
 *   - loadAuditAnchorArtifact()  编译产物加载（AUDIT_ANCHOR_ARTIFACT 或 repo 默认）
 *   - replayAuditTrail(file)     跨卷重放：逐行重算 hash + 卷间衔接 → running hash 序列
 *   - verifyAuditAgainstAnchors({ trail, anchors })  纯函数：位置绑定校验
 *   - readOnChainAnchors({ contract })  从链上拉全部锚
 *   - startAuditAnchorService()  周期锚定服务（env gate，默认关）
 *
 * 服务语义（fail-closed / fail-safe）：
 *   - AUDIT_ANCHOR_INTERVAL_MS 未设 → 返回 null，零基线影响（与观测端点同规约）。
 *   - 设置了 interval 但缺 AUDIT_ANCHOR_CONTRACT / 缺编译产物 → 启动抛错
 *   （操作员错误要响亮，不静默跑空转）。
 *   - **篡改拒锚**：本地链重放失败 → 拒绝锚定并结构化告警 —— 绝不把被篡改的
 *     链锚上链"合法化"。
 *   - **ephemeral 本地链自动停用**：CHAIN_ALLOW_LOCAL 的进程内 EVM 状态随进程
 *     消失，锚上去毫无意义且误导（与 SmartAccount restore 的同款 fail-closed 判断）。
 *   - **无新条目不发 tx**：链尾/计数与上次已锚一致 → 跳过；重启后先 latest()
 *     对齐，避免重启产生无谓锚。
 *   - 单轮失败（RPC 抖动等）→ 结构化日志，下轮重试；绝不影响 MCP 协议进程。
 *   - 锚定成功只写 logStructured + 链上 Anchored 事件（链上事件本身就是不可变
 *     审计）——**不写进审计链**：否则"锚定→写审计→新链尾→再锚"无限自举。
 *
 * 密钥/信任模型：广播用 chainEnv.relayer（server 侧运营密钥）。合约侧
 * anchoringKey = 部署广播者（见 DeployAuditAnchor.s.sol，应使用同一把 relayer
 * key 部署）。攻击者攻陷 server 后可重写审计并再锚，但链上锚账本是 append-only：
 * 多出来的锚（index 跳变 / entryCount 回退）由 verifyAuditAgainstAnchors 判为
 * 告警，而不是成功。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logStructured } from './observability.js';
import { auditHash, getAuditFile } from './audit-log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// src → mcp-server → repo root
const REPO_ROOT = join(HERE, '..', '..');
const DEFAULT_ARTIFACT_PATH = join(
  REPO_ROOT, 'contracts', 'solidity', 'out', 'AuditAnchor.sol', 'AuditAnchor.json',
);

let ethersModule = null;
async function getEthers() {
  if (!ethersModule) ethersModule = await import('ethers');
  return ethersModule;
}

/** strip 0x 前缀（链上 bytes32 ↔ 本地 hex 统一比较）。 */
function strip0x(h) {
  return typeof h === 'string' ? h.replace(/^0x/i, '').toLowerCase() : h;
}

/**
 * 加载 AuditAnchor 编译产物（ABI）。
 * 解析序：$AUDIT_ANCHOR_ARTIFACT → repo 默认 contracts/solidity/out/AuditAnchor.sol/AuditAnchor.json。
 * @returns {{ abi: object[] } | null} 不存在 → null
 */
export function loadAuditAnchorArtifact() {
  const path = process.env.AUDIT_ANCHOR_ARTIFACT || DEFAULT_ARTIFACT_PATH;
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw.abi)) return null;
    return { abi: raw.abi, artifactPath: path };
  } catch {
    return null;
  }
}

/**
 * 跨卷重放本地审计链（`.1` 旧卷在前、当前卷在后，写序）。
 * 逐行重算 hash、校验串联（全局首行 continuation 语义 —— 更旧卷可能已被轮转
 * 删除，其 prevHash 指向已删历史；其后严格串联，含跨卷衔接）。
 * @param {string} file AUDIT_LOG_FILE 路径
 * @returns {{ ok: boolean, count: number, hashes: string[], tailHash: string|null,
 *             error: string|null, errorVolume: string|null, errorIndex: number|null }}
 *   hashes[i] = 第 i+1 行后的 running hash（位置绑定校验的基础）。
 */
export function replayAuditTrail(file) {
  if (!file) {
    return { ok: false, count: 0, hashes: [], tailHash: null, error: 'no audit file configured', errorVolume: null, errorIndex: null };
  }
  const vols = [`${file}.1`, file].filter((v) => existsSync(v));
  if (vols.length === 0) {
    return { ok: false, count: 0, hashes: [], tailHash: null, error: `${file} does not exist`, errorVolume: null, errorIndex: null };
  }
  const hashes = [];
  let prevHash = null;
  let first = true; // 全局首行：continuation（指向可能已删除的更旧历史）
  for (const vol of vols) {
    const lines = readFileSync(vol, 'utf8').split('\n').filter((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        return { ok: false, count: hashes.length, hashes, tailHash: prevHash, error: `line ${i + 1} is not valid JSON`, errorVolume: vol, errorIndex: i };
      }
      const expected = auditHash(rec);
      if (rec.hash !== expected) {
        return { ok: false, count: hashes.length, hashes, tailHash: prevHash, error: `line ${i + 1} hash tampered`, errorVolume: vol, errorIndex: i };
      }
      if (!first && rec.prevHash !== prevHash) {
        return { ok: false, count: hashes.length, hashes, tailHash: prevHash, error: `line ${i + 1} prevHash mismatch`, errorVolume: vol, errorIndex: i };
      }
      first = false;
      prevHash = rec.hash;
      hashes.push(rec.hash);
    }
  }
  return { ok: true, count: hashes.length, hashes, tailHash: prevHash, error: null, errorVolume: null, errorIndex: null };
}

/**
 * 校验本地审计链与链上锚的一致性（纯函数，核心验证语义）。
 *
 * 位置绑定（比"集合包含"强）：锚的 entryCount 是锚定时的总行数 → 本地重放的第
 * entryCount 行 running hash 必须等于锚的 tailHash。**对仍在本地的已锚前缀**，任何
 * 就地重写 / 插入 / 断链都会失配 → 告警。这是锚定的主保证，且在轮转下依然成立。
 *
 * 复核修复 R4（轮转深度绑定）：本地 `trail.count` 会因 `AUDIT_LOG_MAX_BYTES` 轮转
 * 而被**合法地裁剪**（旧卷删除）——因此必须用"锚覆盖数 ≤ 本地数"才做位置校验；
 * 锚覆盖数 > 本地数说明其前缀已被保留策略轮转删除 → 记入 `dropped`（信息性，
 * 非告警；其证据仍在链上）。绝对 `entryCount` 回退**不再**自动判篡改：合法轮转
 * 也会回退（保留 500 条后新锚 < 旧锚）。真正的活动尾截断（攻击者删当前卷）由
 * 集中式收集游标失配（§6.4 `stale`）+ anchoringKey 托管（GAP-001）检测，见文档
 * 残留边界。
 *
 * @param {object} opts
 * @param {object} opts.trail replayAuditTrail 的结果
 * @param {Array<{index: number, tailHash: string, entryCount: number}>} opts.anchors
 *   链上锚列表（按 index 升序，readOnChainAnchors 产物）
 * @returns {{ ok: boolean, verified: number, problems: Array<{anchor, reason}>,
 *             dropped: Array<{anchor, entryCount, localCount}>,
 *             trailCount: number, trailTailHash: string|null }}
 */
export function verifyAuditAgainstAnchors({ trail, anchors }) {
  const problems = [];
  const dropped = [];
  if (!trail || trail.ok !== true) {
    return { ok: false, verified: 0, problems: [{ anchor: null, reason: `local trail not intact: ${trail?.error ?? 'no trail'}` }], dropped, trailCount: trail?.count ?? 0, trailTailHash: trail?.tailHash ?? null };
  }
  let prevIndex = -1;
  let verified = 0;
  for (const a of anchors ?? []) {
    // 链上锚账本异常（索引缺/重）：攻击者攻陷 server 后重锚的旁证 —— 仍告警。
    if (a.index !== prevIndex + 1) {
      problems.push({ anchor: a.index, reason: 'index gap or duplicate (on-chain ledger has unexpected anchors — possible rewrite re-anchor)' });
    }
    if (a.entryCount <= trail.count) {
      // 已锚前缀仍在本地区域：位置绑定校验（重写/插入/断链 → 失配告警）。
      if (strip0x(trail.hashes[a.entryCount - 1] ?? null) !== strip0x(a.tailHash)) {
        problems.push({ anchor: a.index, reason: 'tailHash mismatch at anchor position (rewrite/tamper/insertion in committed prefix)' });
      } else {
        verified += 1;
      }
    } else {
      // 锚覆盖数超出本地保有的记录数 → 前缀已轮转删除（链上仅存证据，本地不可验）。
      dropped.push({ anchor: a.index, entryCount: a.entryCount, localCount: trail.count });
    }
    prevIndex = a.index;
  }
  return {
    ok: problems.length === 0,
    verified,
    problems,
    dropped,
    trailCount: trail.count,
    trailTailHash: trail.tailHash,
  };
}

/**
 * 从链上拉全部锚（count 次 view call；锚账本预期量级 = 天/小时级，可接受）。
 * @param {object} opts
 * @param {object} opts.contract ethers Contract（AuditAnchor ABI）
 * @returns {Promise<{ count: number, anchors: Array<{index, tailHash, entryCount, anchoredAt}> }>}
 */
export async function readOnChainAnchors({ contract }) {
  const count = Number(await contract.count());
  const anchors = [];
  for (let i = 0; i < count; i++) {
    const [tailHash, entryCount, anchoredAt] = await contract.getAnchor(i);
    anchors.push({
      index: i,
      tailHash: strip0x(tailHash),
      entryCount: Number(entryCount),
      anchoredAt: Number(anchoredAt),
    });
  }
  return { count, anchors };
}

/**
 * 可选启动周期锚定服务（AUDIT_ANCHOR_INTERVAL_MS gate，默认关）。
 *
 * @param {object} [opts]
 * @param {string|number} [opts.intervalMs] 默认 process.env.AUDIT_ANCHOR_INTERVAL_MS
 * @param {string} [opts.contractAddress] 默认 process.env.AUDIT_ANCHOR_CONTRACT
 * @param {object} [opts.artifact] 默认 loadAuditAnchorArtifact()
 * @param {function} [opts.resolveChainEnv] async () => chainEnv —— 触发链 boot
 *   （server.js 传 resolveChainEnv；返回 { provider, relayer, localChain, ... }）
 * @param {string} [opts.auditFile] 默认 getAuditFile()（测试注入）
 * @param {function} [opts.makeContract] ({ abi, address, signer, provider }) =>
 *   contract-like —— 测试注入 stub；缺省用 ethers.Contract
 * @returns {{ stop(): void, tick(): Promise<object>, status(): object } | null}
 *   未启用（无 interval）→ null
 * @throws interval 已设但 contractAddress / artifact 缺失 → 抛错（fail-closed）
 */
export function startAuditAnchorService({
  intervalMs, contractAddress, artifact, resolveChainEnv, auditFile, makeContract,
} = {}) {
  const rawInterval = intervalMs ?? process.env.AUDIT_ANCHOR_INTERVAL_MS;
  if (rawInterval === undefined || rawInterval === null || String(rawInterval).trim() === '') {
    return null; // gate 关：零基线影响
  }
  const interval = Number(rawInterval);
  if (!Number.isFinite(interval) || interval <= 0) {
    const err = new Error(`AUDIT_ANCHOR_INTERVAL_MS must be a positive integer, got: ${rawInterval}`);
    err.code = 'AUDIT_ANCHOR_INTERVAL_INVALID';
    throw err;
  }
  const address = contractAddress ?? process.env.AUDIT_ANCHOR_CONTRACT;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    const err = new Error(
      `AUDIT_ANCHOR_CONTRACT must be a deployed AuditAnchor address (0x + 40 hex) when AUDIT_ANCHOR_INTERVAL_MS is set, got: ${address ?? '(unset)'}`,
    );
    err.code = 'AUDIT_ANCHOR_CONTRACT_MISSING';
    throw err;
  }
  const art = artifact ?? loadAuditAnchorArtifact();
  if (!art) {
    const err = new Error(
      'AuditAnchor artifact not found. Run `forge build --use 0.8.24` in contracts/solidity, ' +
      'or set AUDIT_ANCHOR_ARTIFACT to the built artifact JSON.',
    );
    err.code = 'AUDIT_ANCHOR_ARTIFACT_MISSING';
    throw err;
  }
  if (typeof resolveChainEnv !== 'function') {
    throw new Error('startAuditAnchorService requires a resolveChainEnv function');
  }

  let contract = null;
  let timer = null;
  let stopped = false;
  let warnedNoFile = false;
  let warnedLocalChain = false;
  let lastAnchored = null; // { tailHash, count, txHash, index }
  let anchoredCount = 0; // 本进程发出的锚数（观测）
  let lastResult = null; // 最近一次 tick 结果（status() 暴露）

  async function ensureContract(env) {
    if (contract) return contract;
    const ethers = await getEthers();
    const signer = (env.relayer ?? env.owner).connect(env.provider);
    contract = makeContract
      ? makeContract({ abi: art.abi, address, signer, provider: env.provider })
      : new ethers.Contract(address, art.abi, signer);
    return contract;
  }

  /**
   * 单轮锚定（导出给测试直接驱动；定时器也调用它）。
   * @returns {Promise<object>} 本轮结果（skipped/anchored/refused/error/...）
   */
  async function tick() {
    if (stopped) return { action: 'stopped' };
    // 1. 链 env（设置 interval = 显式 opt-in 链上锚定，允许触发链 boot）。
    let env;
    try {
      env = await resolveChainEnv();
    } catch (err) {
      lastResult = { action: 'error', stage: 'chain_env', error: String(err?.message || err) };
      logStructured('audit_anchor_error', lastResult);
      return lastResult;
    }
    // 2. ephemeral 本地链：锚随进程消失，无意义且误导 → 停用（一次性告警）。
    if (env?.localChain) {
      if (!warnedLocalChain) {
        warnedLocalChain = true;
        logStructured('audit_anchor_local_chain_stopped', {
          reason: 'CHAIN_ALLOW_LOCAL ephemeral in-process EVM dies with the process — on-chain anchoring requires an external persistent chain',
        });
      }
      stop();
      lastResult = { action: 'stopped_local_chain' };
      return lastResult;
    }
    // 3. 本地链重放（fail-closed：篡改 → 拒锚，绝不把坏链锚上链）。
    const file = auditFile ?? getAuditFile();
    if (!file) {
      if (!warnedNoFile) {
        warnedNoFile = true;
        logStructured('audit_anchor_no_file', { hint: 'set AUDIT_LOG_FILE to enable on-chain anchoring of the audit trail' });
      }
      lastResult = { action: 'skipped_no_file' };
      return lastResult;
    }
    const trail = replayAuditTrail(file);
    if (!trail.ok) {
      lastResult = { action: 'refused_tampered', error: trail.error, volume: trail.errorVolume, index: trail.errorIndex };
      logStructured('audit_anchor_tampered_refuse', { ...lastResult, policy: 'never anchor a tampered chain (fail-closed)' });
      return lastResult;
    }
    if (trail.count === 0) {
      lastResult = { action: 'skipped_empty' };
      return lastResult;
    }
    // 4. 与上次已锚比较：无新条目 → 不发 tx。
    if (lastAnchored && lastAnchored.tailHash === trail.tailHash && lastAnchored.count === trail.count) {
      lastResult = { action: 'skipped_no_new_entries', count: trail.count };
      return lastResult;
    }
    // 5. 广播 anchor(tailHash, entryCount)。
    let c;
    try {
      c = await ensureContract(env);
    } catch (err) {
      lastResult = { action: 'error', stage: 'contract', error: String(err?.message || err) };
      logStructured('audit_anchor_error', lastResult);
      return lastResult;
    }
    // 重启对齐：链上 latest 与当前 tail 一致 → 记住即可，不发 tx。
    if (!lastAnchored) {
      try {
        const [lt, ln] = await c.latest();
        if (strip0x(lt) === trail.tailHash && Number(ln) === trail.count) {
          lastAnchored = { tailHash: trail.tailHash, count: trail.count, txHash: null, index: null, resumed: true };
          lastResult = { action: 'skipped_resumed_aligned', count: trail.count };
          logStructured('audit_anchor_resumed', { tailHash: trail.tailHash, entryCount: trail.count });
          return lastResult;
        }
      } catch {
        /* latest() 失败不阻断锚定 —— 直接走广播路径 */
      }
    }
    try {
      const tx = await c.anchor(`0x${trail.tailHash}`, BigInt(trail.count));
      const receipt = await tx.wait();
      if (receipt?.status === 0) {
        lastResult = { action: 'error', stage: 'receipt', error: 'anchor transaction reverted on-chain' };
        logStructured('audit_anchor_error', lastResult);
        return lastResult;
      }
      // Anchored(index, tailHash, entryCount, anchoredAt) —— 解析 index（解析不到记 null）。
      let index = null;
      try {
        for (const log of receipt?.logs ?? []) {
          const parsed = c.interface?.parseLog?.({ topics: log.topics, data: log.data });
          if (parsed?.name === 'Anchored') {
            index = Number(parsed.args.index);
            break;
          }
        }
      } catch { /* event 解析失败不视为锚定失败 */ }
      lastAnchored = { tailHash: trail.tailHash, count: trail.count, txHash: receipt?.hash ?? tx?.hash ?? null, index };
      anchoredCount += 1;
      lastResult = { action: 'anchored', ...lastAnchored };
      logStructured('audit_anchor_anchored', { index, entryCount: trail.count, tailHash: trail.tailHash, txHash: lastAnchored.txHash });
      return lastResult;
    } catch (err) {
      lastResult = { action: 'error', stage: 'broadcast', error: String(err?.message || err) };
      logStructured('audit_anchor_error', lastResult);
      return lastResult;
    }
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  timer = setInterval(() => {
    tick().catch((err) => {
      // tick 内部已全部 try/catch；这里是兜底（绝不让定时器异常杀进程）。
      logStructured('audit_anchor_error', { stage: 'tick', error: String(err?.message || err) });
    });
  }, interval);
  if (timer.unref) timer.unref(); // 不阻塞进程退出（与告警引擎同规约）

  return {
    stop,
    tick,
    status: () => ({
      running: !stopped,
      contractAddress: address,
      intervalMs: interval,
      lastAnchored,
      anchoredCount,
      lastResult,
    }),
  };
}

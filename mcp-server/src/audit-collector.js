/**
 * audit-collector.js — 集中式审计收集端点 (Sprint 8: GAP-002 Ⅱ)
 *
 * GAP-002 承接："审计事件链路哈希固化 + 集中式审计收集端点，使关键行为真正
 * '可审计、可撤销、可恢复'的审计面闭环。" Ⅰ 阶段已在 audit-log.js 固化 hash-chain；
 * 本文件提供集中式收集/检索 HTTP 端点 —— 运维可在一个端口拉取带验证的审计流。
 *
 * 设计约束（与 /metrics、/health 完全一致的基础设施约束）：
 *   - AUDIT_HTTP_PORT gate：未设置 → 返回 null，不监听端口（零隐式依赖，CI 无外部服务全绿）。
 *   - loopback-only（127.0.0.1）、只读 GET，绝不碰 MCP stdout 协议通道。
 *   - 复用 audit-log.js 的 hash-chain（verifyAuditHashChain/recordAudit 产物），
 *     让"收集到的数据"本身可被验证为未经篡改 —— 集中收集与审计不可篡改性合二为一。
 *   - 端口占用等故障 → server.on('error') 结构化记录并降级为「审计收集缺席」，
 *     绝不拖垮 MCP 协议进程（与 metrics_http_error / health_http_error 同规约）。
 *
 * 复核修复 R2（跨卷）：校验与读取覆盖**全部卷**（`.1` 旧卷 + 当前卷）——
 *   轮转后旧卷联合校验（旧卷 continuation 语义、其链尾 tailHash 作为当前卷
 *   anchorHash），/entries 合并返回两卷条目。旧卷被忽略会造成：
 *   a) 轮转后误报 tampered（新卷首 prevHash 指向旧卷尾）；b) 审计盲区。
 *
 * 增量收集（游标 —— 集中式收集的标准模式，本仓库不实现收集方，仅提供契约）：
 *   GET /entries?afterHash=<64hex>&limit=<n>
 *     收集方持久化上次拉到的链尾 hash 作为游标 → 仅拉增量（limit 分页、
 *     hasMore/nextCursor 续拉）；afterHash 不在链中（两次拉取间头部被截/
 *     整链重写）→ stale=true + 全量返回供重同步 —— 游标失配即截断告警。
 *     这是"尾部删除/整链重写"残留边界在集中式架构下的检测面：单文件本地
 *     视角无法察觉的删除，由收集方持久化的游标暴露（收集方实现属本仓库之外）。
 *   GET /tail → 链尾 hash + 计数 + 联合校验状态（轻量锚定点，供收集方定期锚定）。
 *
 * 端点：
 *   GET /                            → 审计流摘要（路径、卷数、条目数、联合校验）
 *   GET /tail                        → 链尾锚定摘要（tailHash/count/chainOk）
 *   GET /entries[?afterHash=&limit=] → 审计行（跨卷合并、游标增量、分页）
 * 校验不通过（篡改/断链）→ 仍返回数据 + tampered 标记，绝不静默丢弃（运维可判定，
 *   不可信的数据比"没有数据"更能暴露正在被攻击 —— 也避免阻断收集造成日志盲区）。
 */
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { logStructured } from './observability.js';
import { getAuditFile, verifyAuditHashChain } from './audit-log.js';

/** 读单卷 JSONL 行（跳过损坏行，原样返回对象）。 */
function readVolume(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * 跨卷联合校验（`.1` 旧卷 → 当前卷 anchor 串联）+ 摘要。
 * @param {string|null} file audit 文件路径（env）
 * @returns {{ file:string|null, exists:boolean, volumes:number, verified:number,
 *             tampered:boolean, chainOk:boolean|null, chainError:string|null, tailHash:string|null }}
 */
export function auditFileStatus(file) {
  if (!file) {
    return { file: null, exists: false, volumes: 0, verified: 0, tampered: false, chainOk: null, chainError: null, tailHash: null };
  }
  const current = verifyAuditHashChain(file);
  if (!existsSync(`${file}.1`)) {
    // 单卷：当前卷即全链。
    return {
      file, exists: true, volumes: 1,
      verified: current.verified,
      tampered: !current.ok, chainOk: current.ok, chainError: current.error, tailHash: current.tailHash,
    };
  }
  // 跨卷：先验旧卷。旧卷可能是整链起点（首次轮转），也可能是"链中段"（更旧卷
  // 已被轮转删除——首行 prevHash 指向已删历史，头部不可验，属保留期边界）。
  // 因此旧卷用 'continuation' 锚语义：卷首任意、卷内严格串联；其链尾作为当前卷
  // anchorHash —— 当前卷（活跃审计面）始终严格锚定校验。
  const oldVol = verifyAuditHashChain(`${file}.1`, { anchorHash: 'continuation' });
  if (!oldVol.ok) {
    return {
      file, exists: true, volumes: 2,
      verified: oldVol.verified, tampered: true, chainOk: false,
      chainError: `volume .1: ${oldVol.error}`, tailHash: null,
    };
  }
  const cur = verifyAuditHashChain(file, { anchorHash: oldVol.tailHash });
  return {
    file, exists: true, volumes: 2,
    verified: oldVol.verified + cur.verified,
    tampered: !cur.ok, chainOk: cur.ok, chainError: cur.error, tailHash: cur.tailHash,
  };
}

/** 合并读取全部卷条目（`.1` 在前、当前卷在后，按写序）。 */
function readAllVolumes(file) {
  if (!file) return [];
  const oldEntries = readVolume(`${file}.1`);
  return oldEntries.concat(readVolume(file));
}

/**
 * 游标增量（核心逻辑，作用于已读数组）：返回 afterHash 之后的条目。
 * afterHash 不在链中 → found=false + 全量（收集方 stale 重同步）。
 * @param {object[]} all 按写序合并的全部条目
 * @param {string} afterHash 64-hex 游标
 */
function entriesAfterIn(all, afterHash) {
  const idx = all.findIndex((e) => e && e.hash === afterHash);
  if (idx === -1) return { found: false, entries: all };
  return { found: true, entries: all.slice(idx + 1) };
}

/**
 * 游标增量读取（跨卷按写序扫描）。
 * @param {string|null} file
 * @param {string} afterHash
 * @returns {{ found: boolean, entries: object[] }}
 */
export function entriesAfter(file, afterHash) {
  return entriesAfterIn(readAllVolumes(file), afterHash);
}

/**
 * 可选启动集中式审计收集 HTTP 服务器（AUDIT_HTTP_PORT gate）。
 * @param {object} [opts]
 * @param {string} [opts.port] 默认读 process.env.AUDIT_HTTP_PORT
 * @returns {import('node:http').Server|null} 未开启 → null
 */
export function startAuditCollector({ port } = {}) {
  const p = (port ?? process.env.AUDIT_HTTP_PORT ?? '').trim();
  if (!p) return null;
  const server = http.createServer((req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid url' }));
        return;
      }
      const path = url.pathname;
      if (req.method !== 'GET' || (path !== '/' && path !== '/entries' && path !== '/tail')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      // 游标/分页参数校验（操作员错误要响亮，不静默忽略）。
      const afterHash = url.searchParams.get('afterHash');
      if (afterHash !== null && !/^[0-9a-f]{64}$/.test(afterHash)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'afterHash must be 64-char lowercase hex' }));
        return;
      }
      const limitRaw = url.searchParams.get('limit');
      let limit = null;
      if (limitRaw !== null) {
        if (!/^\d+$/.test(limitRaw) || Number(limitRaw) <= 0) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'limit must be a positive integer' }));
          return;
        }
        limit = Number(limitRaw);
      }
      const file = getAuditFile();
      let status;
      let entries = [];
      try {
        status = auditFileStatus(file);
        entries = readAllVolumes(file);
      } catch (err) {
        logStructured('audit_collector_read_error', { error: String(err?.message || err) });
        status = {
          file, exists: false, volumes: 0, verified: 0, tampered: false,
          chainOk: null, chainError: String(err?.message || err), tailHash: null,
        };
      }
      if (path === '/tail') {
        // 轻量锚定端点：链尾 hash + 计数 + 校验状态（收集方定期锚定用）。
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          file: status.file,
          volumes: status.volumes,
          count: entries.length,
          verified: status.verified,
          tampered: status.tampered,
          chainOk: status.chainOk,
          chainError: status.chainError,
          tailHash: status.tailHash,
        }));
        return;
      }
      let stale = false;
      if (afterHash !== null) {
        const r = entriesAfterIn(entries, afterHash);
        stale = !r.found;
        entries = r.entries;
      }
      const totalAfterCursor = entries.length;
      let hasMore = false;
      if (limit !== null && entries.length > limit) {
        entries = entries.slice(0, limit); // 旧→新取头部：收集方按序推进游标
        hasMore = true;
      }
      if (path === '/entries') {
        const nextCursor = entries.length
          ? entries[entries.length - 1].hash
          : (afterHash !== null && !stale ? afterHash : null);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          file: status.file,
          volumes: status.volumes,
          verified: status.verified,
          tampered: status.tampered,
          chainOk: status.chainOk,
          chainError: status.chainError,
          afterHash: afterHash ?? null,
          stale,
          count: entries.length,
          totalAfterCursor,
          hasMore,
          nextCursor,
          tailHash: status.tailHash,
          entries,
        }));
        return;
      }
      // GET / 摘要。
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        file: status.file,
        exists: status.exists,
        volumes: status.volumes,
        verified: status.verified,
        tampered: status.tampered,
        chainOk: status.chainOk,
        chainError: status.chainError,
        tailHash: status.tailHash,
        note: 'GET /entries for full or cursor-based incremental trail (afterHash/limit); GET /tail for lightweight anchoring.',
      }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
  });
  // 端口占用等 → 结构化记录并降级为「审计收集缺席」，不崩溃（与观测端点同规约）。
  server.on('error', (err) => {
    logStructured('audit_collector_http_error', { error: String(err?.message || err), code: err?.code || null });
  });
  server.listen(Number(p), '127.0.0.1');
  return server;
}
/**
 * kms-provider.js — Sprint 8: GAP-001 具体 KMS provider（HashiCorp Vault KV v2）
 *
 * 目标：把 secret-store SPI 从"仅接口占位"推进到"接真实 KMS"。
 * 设计约束（沿用 Sprint 7 zero-implicit-dependency + fail-closed）：
 *   - 只用 Node 内置 http/https，不引入任何第三方依赖。
 *   - transport 可注入：生产走 node:http，测试注入 stub，CI 零外部服务全绿。
 *   - 启动即 warm：构造时一次性拉取全部引用的 secret 到内存缓存，之后 resolveSecretRef
 *     为纯同步读缓存。任一拉取失败 → 构造抛错（fail-closed，进程拒绝启动），
 *     与 HEALTH_STRICT_STARTUP / release 门禁同向。
 *   - 未配置 addr/token → SECRET_KMS_NOT_CONFIGURED（绝不静默回退 env 明文）。
 *
 * 引用格式：`vault:<path>#<FIELD>`（mount 由选项指定，默认 secret），如
 *   vault:owners/agent-owner#CHAIN_OWNER_PK
 *   → GET /v1/{mount}/data/owners/agent-owner → data.data.CHAIN_OWNER_PK
 *
 * Vault KV v2 响应：{ data: { data: { <field>: value, ... }, metadata: {...} } }。
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DEFAULT_MOUNT = 'secret';
const DEFAULT_TIMEOUT_MS = 8000;

/** 解析 vault secret ref，返回 { scheme:'vault', path, field } 或 null（非 vault ref）。 */
export function parseVaultRef(ref) {
  if (ref == null) return null;
  const s = String(ref).trim();
  const brace = /^\$\{([^}]*)\}$/.exec(s);
  const body = brace ? brace[1] : s;
  const m = /^vault:([^#]+?)(?:#([\w-]+))?$/.exec(body);
  if (!m) return null;
  const path = m[1].trim().replace(/^\/+/, '');
  const field = m[2] ?? null;
  if (!path) return null;
  return { scheme: 'vault', path, field };
}

/**
 * 构造 HTTP transport。可注入任意 { method,url,headers,timeoutMs } => Promise<{status,body}>。
 * @param {object} [opts]
 * @param {(arg: object) => Promise<{status:number, body:string}>} [opts.transport]
 * @returns {(arg: object) => Promise<{status:number, body:string}>}
 */
export function createVaultHttpTransport({ transport } = {}) {
  if (typeof transport === 'function') return transport;
  return ({ method, url, headers, timeoutMs }) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = mod(u, { method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(timeoutMs ?? DEFAULT_TIMEOUT_MS, () => req.destroy(new Error('vault request timeout')));
      req.on('error', reject);
      req.end();
    });
}

/**
 * 创建 Vault 客户端（KV v2 读取）。
 * @param {object} opts
 * @param {string} opts.addr  Vault 地址（http(s)://host[:port]）
 * @param {string} opts.token Vault token（X-Vault-Token）—— 来自更高信任渠道（人/明文注入面外）
 * @param {string} [opts.namespace] X-Vault-Namespace（Vault Enterprise / 多租户）
 * @param {string} [opts.mount='secret'] KV v2 mount 前缀
 * @param {number} [opts.timeoutMs]
 * @param {(arg:object)=>Promise<{status:number,body:string}>} [opts.transport]
 * @returns {{ readKV: (path:string)=>Promise<object> }}
 * @throws {Error} code=SECRET_KMS_NOT_CONFIGURED 当缺 addr/token
 */
export function createVaultClient({ addr, token, namespace, mount = DEFAULT_MOUNT, timeoutMs, transport } = {}) {
  if (!addr || !token) {
    const err = new Error(
      'createVaultClient requires addr and token (NEXUS_VAULT_ADDR / NEXUS_VAULT_TOKEN). ' +
      'Refusing to fall back to plaintext env (GAP-001).',
    );
    err.code = 'SECRET_KMS_NOT_CONFIGURED';
    throw err;
  }
  const base = String(addr).replace(/\/+$/, '');
  const doFetch = createVaultHttpTransport({ transport });

  /**
   * 读取 KV v2 secret。非 2xx / 非 KV 结构 → 抛带 code 的错（fail-closed）。
   * @param {string} path （相对 mount 的路径，不含 mount 与 /data/ 段）
   * @returns {Promise<object>} 内层 data（字段名 → 值）
   */
  async function readKV(path) {
    const rel = `${mount}/data/${path.replace(/^\/+/, '')}`;
    const url = `${base}/v1/${rel}`;
    const headers = {
      'X-Vault-Token': token,
      'X-Vault-Request': 'true',
      Accept: 'application/json',
    };
    if (namespace) headers['X-Vault-Namespace'] = namespace;
    const res = await doFetch({ method: 'GET', url, headers, timeoutMs });
    if (res.status === 404) {
      const err = new Error(`vault secret not found: ${path}`);
      err.code = 'VAULT_SECRET_NOT_FOUND';
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`vault read failed: HTTP ${res.status}`);
      err.code = 'VAULT_READ_FAILED';
      err.status = res.status;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      const err = new Error(`vault read failed: invalid JSON body for ${path}`);
      err.code = 'VAULT_READ_FAILED';
      throw err;
    }
    const inner = parsed?.data?.data;
    if (typeof inner !== 'object' || inner == null) {
      const err = new Error(`vault secret at ${path} has no KV data`);
      err.code = 'VAULT_SECRET_EMPTY';
      throw err;
    }
    return inner;
  }

  return { readKV, base, mount, token, namespace };
}

/**
 * 创建 KMS 后端 secret resolver（与 secret-store 的 createSecretResolver 同构）。
 *
 * 启动即 warm：把所有引用的 `vault:<path>#<FIELD>` 一次性拉取进 cache；任一失败即抛错。
 * 返回的 resolveSecretRef 为纯同步缓存读取。非 vault ref → 返回 undefined（不由 KMS 解析，
 * 交给上层 strict/ref 校验判读）。
 *
 * @param {object} opts
 * @param {string} opts.addr
 * @param {string} opts.token
 * @param {string} [opts.namespace]
 * @param {string} [opts.mount='secret']
 * @param {number} [opts.timeoutMs]
 * @param {string[]} [opts.refs] 需要 warm 的 vault ref 列表（如三枚操作密钥的 ref）
 * @param {Map<string,object>} [opts.cache] 预置缓存（测试/复用）
 * @param {Function} [opts.transport] 注入 transport（测试）
 * @returns {Promise<{backend:'kms', resolveSecretRef:(ref:string)=>string|undefined, cache:Map, client:object}>}
 * @throws {Error} 未配置 addr/token → SECRET_KMS_NOT_CONFIGURED；warm 拉取失败 → VAULT_* 上传
 */
export async function createVaultSecretResolver({
  addr, token, namespace, mount = DEFAULT_MOUNT, timeoutMs, refs = [], cache = new Map(), transport,
} = {}) {
  const client = createVaultClient({ addr, token, namespace, mount, timeoutMs, transport });

  const wanted = new Set();
  const parsedRefs = [];
  for (const ref of refs) {
    if (ref == null) continue;
    const parsed = parseVaultRef(ref);
    if (parsed) { parsedRefs.push({ ref: String(ref), ...parsed }); wanted.add(parsed.path); }
  }

  // fail-closed：warm 阶段任一读不到即拒绝启动。
  await Promise.all([...wanted].map(async (path) => {
    const data = await client.readKV(path);
    cache.set(path, data);
  }));

  function resolveSecretRef(ref) {
    if (ref == null) return undefined;
    const parsed = parseVaultRef(ref);
    if (!parsed) return undefined;
    const data = cache.get(parsed.path);
    if (!data) return undefined;
    if (parsed.field == null) return undefined; // 未指明字段不猜（避免把对象误当密钥）
    return data[parsed.field];
  }

  return { backend: 'kms', mount, resolveSecretRef, cache, client, parsedRefs };
}

/**
 * 从环境变量构造 secret resolver（运维接线入口，GAP-001 生产路径）。
 *
 *   NEXUS_SECRET_BACKEND   — 'kms' 才启用 Vault；未设置 / 其它值 → 返回 null
 *                            （调用方传 undefined，与 Sprint 5/6 env 直读行为逐字一致）。
 *   NEXUS_VAULT_ADDR       — Vault 地址（backend=kms 必填）
 *   NEXUS_VAULT_TOKEN      — Vault token（backend=kms 必填；来自更高信任渠道）
 *   NEXUS_VAULT_NAMESPACE  — 可选 X-Vault-Namespace
 *   NEXUS_VAULT_MOUNT      — 可选 KV v2 mount（默认 secret）
 *   NEXUS_VAULT_TIMEOUT_MS — 可选请求超时（毫秒）
 *
 * 对三枚操作密钥（CHAIN_OWNER_PK / CHAIN_EMERGENCY_PK / CHAIN_RELAYER_PK）的 env 值
 * 做启动 warm：值为 vault: ref 时拉取；任一拉取失败即抛错（fail-closed 拒绝启动）。
 *
 * @param {object} [opts]
 * @param {object} [opts.env=process.env] 环境变量源（测试注入）
 * @param {Function} [opts.transport] 注入 transport（测试）
 * @returns {Promise<object|null>} backend='kms' 的 resolver；未启用 KMS 时 null
 * @throws {Error} backend=kms 但缺 addr/token → SECRET_KMS_NOT_CONFIGURED；warm 失败 → VAULT_*
 */
export async function createSecretResolverFromEnv({ env = process.env, transport } = {}) {
  const backend = String(env.NEXUS_SECRET_BACKEND ?? '').trim().toLowerCase();
  if (backend !== 'kms') return null;
  const refs = ['CHAIN_OWNER_PK', 'CHAIN_EMERGENCY_PK', 'CHAIN_RELAYER_PK']
    .map((name) => env[name])
    .filter((v) => v != null && String(v).trim() !== '');
  return createVaultSecretResolver({
    addr: env.NEXUS_VAULT_ADDR,
    token: env.NEXUS_VAULT_TOKEN,
    namespace: env.NEXUS_VAULT_NAMESPACE,
    mount: env.NEXUS_VAULT_MOUNT,
    timeoutMs: env.NEXUS_VAULT_TIMEOUT_MS ? Number(env.NEXUS_VAULT_TIMEOUT_MS) : undefined,
    refs,
    transport,
  });
}

export default {
  parseVaultRef,
  createVaultHttpTransport,
  createVaultClient,
  createVaultSecretResolver,
  createSecretResolverFromEnv,
};
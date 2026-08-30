/**
 * kms-provider.test.js — Sprint 8: GAP-001 具体 KMS provider 验收
 *
 *   - parseVaultRef：`vault:<path>#<FIELD>` / `${vault:...}` / 非法形态。
 *   - createVaultClient 缺 addr/token → SECRET_KMS_NOT_CONFIGURED（fail-closed）。
 *   - createVaultSecretResolver 启动 warm：注入 stub transport 解析字段；失败（404）
 *     即抛错拒绝启动；携带 X-Vault-Token / X-Vault-Namespace。
 *   - chain-config production + KMS 后端：env 明文操作密钥 → PRODUCTION_PLAINTEXT_KEY_REJECTED；
 *     提供 vault ref → 解析为真实密钥。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVaultRef,
  createVaultClient,
  createVaultSecretResolver,
  createSecretResolverFromEnv,
} from '../src/kms-provider.js';
import { buildChainEnvConfig } from '../src/chain-config.js';

/** 注入式 transport：按记录（path → 字段表）回 KV v2 响应；未命中 → 404。 */
function stubTransport(records, note) {
  return async ({ url, headers }) => {
    if (note) note.headers = headers;
    const path = new URL(url).pathname.replace(/^\/v1\/[^/]+\/data\//, '');
    const rec = records[path];
    if (rec) return { status: 200, body: JSON.stringify({ data: { data: rec, metadata: {} } }) };
    return { status: 404, body: '' };
  };
}

const VAULT = { addr: 'https://vault.example:8200', token: 'tok-123', namespace: 'prod' };

const ENV_KEYS = ['CHAIN_RPC_URL', 'CHAIN_PROFILE', 'SMART_ACCOUNT_ARTIFACT',
  'CHAIN_OWNER_PK', 'CHAIN_EMERGENCY_PK', 'CHAIN_RELAYER_PK',
  'NEXUS_SECRET_BACKEND', 'NEXUS_VAULT_ADDR', 'NEXUS_VAULT_TOKEN'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

// ── parseVaultRef ──────────────────────────────────────────────────────────
test('parseVaultRef：vault:path#FIELD 与 ${vault:...}', () => {
  assert.deepEqual(parseVaultRef('vault:owners/agent-owner#CHAIN_OWNER_PK'),
    { scheme: 'vault', path: 'owners/agent-owner', field: 'CHAIN_OWNER_PK' });
  assert.deepEqual(parseVaultRef('${vault:owners/o#F}'),
    { scheme: 'vault', path: 'owners/o', field: 'F' });
  // 无字段 → field null；非法 → null。
  assert.deepEqual(parseVaultRef('vault:owners/o'), { scheme: 'vault', path: 'owners/o', field: null });
  assert.equal(parseVaultRef('file:/x'), null);
  assert.equal(parseVaultRef('0xabcd'), null);
  assert.equal(parseVaultRef(null), null);
  assert.equal(parseVaultRef('vault:'), null);
});

// ── client fail-closed ─────────────────────────────────────────────────────
test('createVaultClient 缺 addr/token → SECRET_KMS_NOT_CONFIGURED', () => {
  assert.throws(() => createVaultClient({ addr: 'https://x' }), (e) => e.code === 'SECRET_KMS_NOT_CONFIGURED');
  assert.throws(() => createVaultClient({ token: 't' }), (e) => e.code === 'SECRET_KMS_NOT_CONFIGURED');
});

// ── resolver warm + 解析 ───────────────────────────────────────────────────
test('createVaultSecretResolver：warm 后同步解析字段，非 vault ref 返回 undefined', async () => {
  const records = {
    'owners/agent-owner': { CHAIN_OWNER_PK: '0xk1', NOTE: 'x' },
  };
  const r = await createVaultSecretResolver({
    ...VAULT, mount: 'secret',
    refs: ['vault:owners/agent-owner#CHAIN_OWNER_PK'],
    transport: stubTransport(records),
  });
  assert.equal(r.backend, 'kms');
  assert.equal(r.resolveSecretRef('vault:owners/agent-owner#CHAIN_OWNER_PK'), '0xk1');
  assert.equal(r.resolveSecretRef('vault:owners/agent-owner#NOTE'), 'x'); // 同 secret 其它字段可读
  assert.equal(r.resolveSecretRef('vault:owners/missing#F'), undefined); // 未命中路径 → undefined
  assert.equal(r.resolveSecretRef('file:/key'), undefined); // 非 vault ref → undefined
  assert.equal(r.resolveSecretRef(undefined), undefined);
});

test('createVaultSecretResolver：warm 拉取失败（404）→ 拒绝启动（fail-closed）', async () => {
  await assert.rejects(
    () => createVaultSecretResolver({
      ...VAULT,
      refs: ['vault:owners/missing#CHAIN_OWNER_PK'],
      transport: stubTransport({}),
    }),
    (e) => e.code === 'VAULT_SECRET_NOT_FOUND',
  );
});

test('createVaultSecretResolver：请求携带 X-Vault-Token / X-Vault-Namespace', async () => {
  const note = {};
  const records = { 'owners/agent-owner': { CHAIN_OWNER_PK: '0xk1' } };
  await createVaultSecretResolver({
    ...VAULT,
    refs: ['vault:owners/agent-owner#CHAIN_OWNER_PK'],
    transport: stubTransport(records, note),
  });
  assert.equal(note.headers['X-Vault-Token'], VAULT.token);
  assert.equal(note.headers['X-Vault-Namespace'], VAULT.namespace);
  assert.equal(note.headers['X-Vault-Request'], 'true');
});

// ── chain-config：production + KMS 明文拒绝 ───────────────────────────────
const KEY = {
  owner: '0x1111111111111111111111111111111111111111111111111111111111111111',
  emergency: '0x2222222222222222222222222222222222222222222222222222222222222222',
  relayer: '0x3333333333333333333333333333333333333333333333333333333333333333',
};
const REFS = {
  owner: 'vault:owners/agent-owner#CHAIN_OWNER_PK',
  emergency: 'vault:owners/emergency-key#CHAIN_EMERGENCY_PK',
  relayer: 'vault:relayers/relayer#CHAIN_RELAYER_PK',
};
const RECORDS = {
  'owners/agent-owner': { CHAIN_OWNER_PK: KEY.owner },
  'owners/emergency-key': { CHAIN_EMERGENCY_PK: KEY.emergency },
  'relayers/relayer': { CHAIN_RELAYER_PK: KEY.relayer },
};

function setEnv(over) {
  process.env.CHAIN_PROFILE = 'production';
  process.env.CHAIN_RPC_URL = 'https://sepolia.example';
  process.env.SMART_ACCOUNT_ARTIFACT = '/tmp/SmartAccount.json';
  for (const [k, v] of Object.entries(over)) {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
}

test('production + KMS：env 明文操作密钥 → PRODUCTION_PLAINTEXT_KEY_REJECTED', async () => {
  const resolver = await createVaultSecretResolver({
    ...VAULT, refs: [REFS.owner, REFS.emergency, REFS.relayer], transport: stubTransport(RECORDS),
  });
  setEnv({ CHAIN_OWNER_PK: KEY.owner, CHAIN_EMERGENCY_PK: REFS.emergency, CHAIN_RELAYER_PK: REFS.relayer });
  assert.throws(
    () => buildChainEnvConfig({ secretResolver: resolver }),
    (e) => e.code === 'PRODUCTION_PLAINTEXT_KEY_REJECTED',
  );
});

test('production + KMS：三枚密钥均为 vault ref → 解析为真实密钥（GAP-001 闭合）', async () => {
  const resolver = await createVaultSecretResolver({
    ...VAULT, refs: [REFS.owner, REFS.emergency, REFS.relayer], transport: stubTransport(RECORDS),
  });
  setEnv({ CHAIN_OWNER_PK: REFS.owner, CHAIN_EMERGENCY_PK: REFS.emergency, CHAIN_RELAYER_PK: REFS.relayer });
  const cfg = buildChainEnvConfig({ secretResolver: resolver });
  assert.equal(cfg.profile, 'production');
  assert.equal(cfg.ownerPk, KEY.owner);
  assert.equal(cfg.emergencyPk, KEY.emergency);
  assert.equal(cfg.relayerPk, KEY.relayer);
});

test('production 无 KMS resolver（env 明文）→ 行为不变，不触发明文门禁', () => {
  setEnv({ CHAIN_OWNER_PK: KEY.owner, CHAIN_EMERGENCY_PK: KEY.emergency, CHAIN_RELAYER_PK: KEY.relayer });
  // 不传 secretResolver：与 Sprint 5/6 env 直读一致，直接返回明文（宽容路径保留）。
  const cfg = buildChainEnvConfig({ profile: 'production' });
  assert.equal(cfg.ownerPk, KEY.owner);
});

// ── 复核修复：不可解析 ref 精确拒绝（PRODUCTION_SECRET_UNRESOLVED） ─────────
test('production + KMS：file:/env: ref（vault resolver 不支持）→ PRODUCTION_SECRET_UNRESOLVED，不静默回退 anvil', async () => {
  const resolver = await createVaultSecretResolver({
    ...VAULT, refs: [REFS.owner, REFS.emergency, REFS.relayer], transport: stubTransport(RECORDS),
  });
  for (const badRef of ['file:/keys/owner', 'env:OWNER_PK']) {
    setEnv({ CHAIN_OWNER_PK: badRef, CHAIN_EMERGENCY_PK: REFS.emergency, CHAIN_RELAYER_PK: REFS.relayer });
    assert.throws(
      () => buildChainEnvConfig({ secretResolver: resolver }),
      (e) => e.code === 'PRODUCTION_SECRET_UNRESOLVED' && e.message.includes('CHAIN_OWNER_PK'),
      `ref=${badRef}`,
    );
  }
});

test('production + KMS：vault ref 字段写错（warm 命中路径但字段缺失）→ PRODUCTION_SECRET_UNRESOLVED', async () => {
  const resolver = await createVaultSecretResolver({
    ...VAULT, refs: [REFS.owner, REFS.emergency, REFS.relayer], transport: stubTransport(RECORDS),
  });
  setEnv({
    CHAIN_OWNER_PK: REFS.owner,
    CHAIN_EMERGENCY_PK: 'vault:owners/emergency-key#CHAIN_EMERGENCY_PK_TYPO',
    CHAIN_RELAYER_PK: REFS.relayer,
  });
  assert.throws(
    () => buildChainEnvConfig({ secretResolver: resolver }),
    (e) => e.code === 'PRODUCTION_SECRET_UNRESOLVED',
  );
});

// ── 复核修复：env 驱动工厂（运维接线入口） ────────────────────────────────
test('createSecretResolverFromEnv：未设置 backend / 非 kms → null（默认路径行为不变）', async () => {
  assert.equal(await createSecretResolverFromEnv({ env: {} }), null);
  assert.equal(await createSecretResolverFromEnv({ env: { NEXUS_SECRET_BACKEND: 'env' } }), null);
  assert.equal(await createSecretResolverFromEnv({ env: { NEXUS_SECRET_BACKEND: '' } }), null);
});

test('createSecretResolverFromEnv：backend=kms 缺 addr/token → SECRET_KMS_NOT_CONFIGURED', async () => {
  await assert.rejects(
    () => createSecretResolverFromEnv({ env: { NEXUS_SECRET_BACKEND: 'kms' } }),
    (e) => e.code === 'SECRET_KMS_NOT_CONFIGURED',
  );
});

test('createSecretResolverFromEnv：warm 三枚操作密钥 ref → 可直接驱动 buildChainEnvConfig（GAP-001 运维闭环）', async () => {
  // 生产中工厂与 buildChainEnvConfig 同读 process.env；测试里分别注入两个读取面
  // （工厂 warm 读注入 env 的 CHAIN_* ref，chain-config 读 process.env），值保持一致。
  setEnv({ CHAIN_OWNER_PK: REFS.owner, CHAIN_EMERGENCY_PK: REFS.emergency, CHAIN_RELAYER_PK: REFS.relayer });
  const env = {
    NEXUS_SECRET_BACKEND: 'kms',
    NEXUS_VAULT_ADDR: VAULT.addr,
    NEXUS_VAULT_TOKEN: VAULT.token,
    CHAIN_OWNER_PK: REFS.owner,
    CHAIN_EMERGENCY_PK: REFS.emergency,
    CHAIN_RELAYER_PK: REFS.relayer,
  };
  const resolver = await createSecretResolverFromEnv({ env, transport: stubTransport(RECORDS) });
  assert.equal(resolver.backend, 'kms');
  const cfg = buildChainEnvConfig({ secretResolver: resolver });
  assert.equal(cfg.ownerPk, KEY.owner);
  assert.equal(cfg.emergencyPk, KEY.emergency);
  assert.equal(cfg.relayerPk, KEY.relayer);
});
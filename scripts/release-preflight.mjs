#!/usr/bin/env node
/**
 * release-preflight.mjs — Sprint 7 T4: 环境发布前置检查 (preflight)
 *
 * 在「发布 / 部署」动作之前对目标环境做一致性 + fail-closed 校验。发布流程
 * （.github/workflows/npm-publish.yml 的 preflight job）与本地运营者共用同一
 * 入口：对 staging/production 盘 preflight 缺密码 / 缺 artifact / 版本不一致 →
 * 拒绝进入发布（退出码 1）。
 *
 * 检查项（复用已有实现，不重复造轮子）：
 *   [A] profile 校验（T2）：loadDeploymentProfile({dryRun:true}) —— 缺必填键
 *       fail-closed。
 *   [B] chain 配置面（chain-config.buildChainEnvConfig）：外部 RPC 必填、relayer
 *       键必填、拒绝 anvil 默认键、owner/relayer 分离、production artifact 必填 +
 *       solc 版本绑定（inspectArtifactBinding + artifactExists）。
 *   [C] 共享 store 可写性：配置 SQLite 共享后端（多实例协调/去重）→ 目标目录可写。
 *   [D] 链上可达性 / nonce 池（可选）：
 *       CHAIN_RPC_URL 可达 → 打印链高度（chain up）；不可达 → WARN（非致命），
 *       保证「无外部服务也能全绿」（Sprint 7 关键约束 1）。--strict-chain 才失败。
 *   [E] 6 包版本一致性（复用 release-bump 的 resolve 语义，只校验不写）：每包
 *       交叉引用 `^X.Y.0` 必须与对应包的实际 major.minor 对齐；不一致 → 失败
 *       （说明版本未 lockstep，过早发布会埋「发布断层」P0）。
 *
 * 用法：
 *   NEXUS_PROFILE_FILE=examples/profile.testnet.env node scripts/release-preflight.mjs
 *   NEXUS_PROFILE_FILE=examples/profile.testnet.env node scripts/release-preflight.mjs --strict-chain
 *   CHAIN_PROFILE=production node scripts/release-preflight.mjs --package-versions  # 仅跑 E
 *
 * 退出码 0 = 可发布；1 = 存在 FAIL 项，禁止进入发布。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeploymentProfile, __resetProfileForTest } from '../mcp-server/src/deployment-profile.js';
import {
  buildChainEnvConfig,
  inspectArtifactBinding,
  artifactExists,
} from '../mcp-server/src/chain-config.js';
import { createSecretResolverFromEnv } from '../mcp-server/src/kms-provider.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const strictChain = args.includes('--strict-chain');

const RESULTS = { PASS: 0, FAIL: 0, WARN: 0 };

function mark(status, label, detail = '') {
  RESULTS[status]++;
  console.log(`  [${status.padEnd(4)}] ${label}${detail ? ` — ${detail}` : ''}`);
}

// ── [A] profile 校验（T2 dry-run，fail-closed） ───────────────────────────
function checkProfile() {
  console.log('\n[A] Deployment profile 校验（dry-run，fail-closed）');
  const file = (process.env.NEXUS_PROFILE_FILE || '').trim();
  if (!file) {
    mark('WARN', 'profile', '未设置 NEXUS_PROFILE_FILE——按 CHAIN_PROFILE env 直读校验');
    return;
  }
  try {
    // dryRun=true：只加载+校验，不写 process.env（preflight 语义）。
    const res = loadDeploymentProfile({ dryRun: true, forceReload: true });
    mark('PASS', `NEXUS_PROFILE_FILE=${file}`, `profile=${res.profile || '(env 直读)'}`);
    // 校验通过后把 profile env 合并进 process.env（仅未显式设置者），
    // 供 [B][C][D] 下游用 profile 的默认值做真实检查。
    for (const [k, v] of Object.entries(res.env || {})) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    if (res.profile && process.env.CHAIN_PROFILE === undefined) process.env.CHAIN_PROFILE = res.profile;
  } catch (err) {
    mark('FAIL', `NEXUS_PROFILE_FILE=${file}`, `${err.code || 'ERR'} ${err.message}`);
  }
}

// ── [B] chain 配置面 + artifact 绑定 ───────────────────────────────────────
async function checkChainConfig() {
  console.log('\n[B] Chain 配置面（fail-closed）+ artifact 绑定');
  // 复核修复 F：占位符密钥/RPC（REPLACE_*、example.org）非空即可通过 schema 校验，
  // 但拿占位符发布等于带病上线 —— fail-closed 阻断（此前仅 [D] 对 RPC 占位符 WARN）。
  // 前置于 buildChainEnvConfig：配置面自身的失败（早退）不能掩盖占位符检测。
  const placeholderRe = /REPLACE_|example\.org/;
  for (const k of ['CHAIN_RPC_URL', 'CHAIN_OWNER_PK', 'CHAIN_EMERGENCY_PK', 'CHAIN_RELAYER_PK']) {
    const v = process.env[k];
    if (v && placeholderRe.test(v)) {
      mark('FAIL', '占位符检测', `${k} 仍为占位符值——替换为真实受控值后才能发布`);
    }
  }
  // KMS 接线（GAP-001）：NEXUS_SECRET_BACKEND=kms → 从 Vault warm 解析操作密钥并
  // 走 chain-config 的 production 门禁；未启用 → null（env 直读，行为不变）。
  // 构造失败（缺 addr/token / warm 不可达）→ FAIL 早退，不回落明文 env 校验。
  let secretResolver;
  try {
    secretResolver = await createSecretResolverFromEnv();
  } catch (err) {
    mark('FAIL', 'KMS secret resolver', `${err.code || 'ERR'} ${err.message}`);
    return;
  }
  const profile = (process.env.CHAIN_PROFILE || 'local').trim().toLowerCase();
  let cfg;
  try {
    cfg = buildChainEnvConfig({ profile, secretResolver: secretResolver ?? undefined });
    const bits = [`profile=${cfg.profile}`];
    if (cfg.useLocalChain) bits.push('local-chain');
    else bits.push(`rpc=${cfg.rpcUrl}`);
    mark('PASS', 'chain-config 配置面', bits.join(' '));
  } catch (err) {
    mark('FAIL', 'chain-config 配置面', `${err.code || 'ERR'} ${err.message}`);
    return;
  }

  const artifactPath = process.env.SMART_ACCOUNT_ARTIFACT;
  if (cfg.profile === 'production' && !artifactPath) {
    mark('FAIL', 'artifact 绑定', 'production 必须显式 SMART_ACCOUNT_ARTIFACT（buildChainEnvConfig 已拦截）');
    return;
  }
  if (!artifactPath) {
    mark('WARN', 'artifact 绑定', '未配 SMART_ACCOUNT_ARTIFACT（非 production 可跳过）');
    return;
  }
  if (!artifactExists(artifactPath)) {
    mark('FAIL', 'artifact 绑定', `SMART_ACCOUNT_ARTIFACT 不存在: ${artifactPath}`);
    return;
  }
  try {
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    const bind = inspectArtifactBinding(artifact, process.env.SMART_ACCOUNT_SOLC_VERSION || undefined);
    if (bind.matches) {
      mark('PASS', 'artifact 绑定', `${bind.contractName} @ solc ${bind.solcVersion}`);
    } else {
      mark('FAIL', 'artifact 绑定', `合同=${bind.contractName} solc=${bind.solcVersion}，与期望不一致`);
    }
  } catch (err) {
    mark('FAIL', 'artifact 绑定', `产物解析失败: ${err.message}`);
  }
}

// ── [C] 共享 store 可写性 ──────────────────────────────────────────────────
function checkStoreWritable() {
  console.log('\n[C] 共享 store 可写性（多实例协调/去重依赖）');
  const stateFile = (process.env.SMART_ACCOUNT_STATE_FILE || '').trim();
  const backend = (process.env.NEXUS_STORE_BACKEND || '').trim().toLowerCase();
  const shared = backend === 'sqlite' || /\.(sqlite3?|db)$/i.test(stateFile);
  if (!stateFile) {
    mark('WARN', '共享 store', '未配置 SMART_ACCOUNT_STATE_FILE（纯内存/单机，无需写检查）');
    return;
  }
  const dir = dirname(stateFile);
  // 复核修复 B：绝对路径 state 文件（生产常见 /var/lib/... 或 Windows D:\data\...）
  // 不得再 join(ROOT, ...) —— join 会把绝对分量当相对拼接，探测写到错误目录，
  // 可写性检查 false-PASS。
  const absDir = isAbsolute(dir) ? dir : join(ROOT, dir);
  try {
    mkdirSync(absDir, { recursive: true });
    const probe = join(absDir, `.preflight-${process.pid}`);
    writeFileSync(probe, '', 'utf8');
    unlinkSync(probe);
    mark('PASS', '共享 store 可写', `${stateFile}（backend=${shared ? 'sqlite(shared)' : 'local/json'}）`);
  } catch (err) {
    // 多实例共享后端的写入是协调/去重依赖——不可写即 fail-closed；local/json 单机
    // 即使现在不可写也仅告警（启动时仍会自愈重建）。
    mark(shared ? 'FAIL' : 'WARN', '共享 store 可写', `无法写入 ${stateFile}: ${err.message}`);
  }
}

// ── [D] 链上可达性 / nonce 池（可选） ──────────────────────────────────────
async function checkChainReachable() {
  console.log('\n[D] 链上可达性 / nonce 池（可选门禁）');
  const rpcUrl = process.env.CHAIN_RPC_URL || '';
  if (!rpcUrl || /REPLACE_|example\.org/.test(rpcUrl)) {
    if (rpcUrl) mark('WARN', '链上 nonce 池', 'RPC 为占位符，跳过真实探测');
    else mark('WARN', '链上 nonce 池', '未配置 CHAIN_RPC_URL（local 可跳过）');
    return;
  }
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    const height = data?.result ? parseInt(data.result, 16) : 'unknown';
    mark('PASS', '链上 nonce 池 / RPC 可达', `链高度 ${height}`);
  } catch (err) {
    const msg = `RPC 不可达: ${err.message}`;
    if (strictChain) mark('FAIL', '链上 nonce 池', msg);
    else mark('WARN', '链上 nonce 池', `${msg}（非致命，--strict-chain 才阻断）`);
  }
}

// ── [E] 6 包版本一致性（lockstep） ─────────────────────────────────────────
const PUBLISHED = {
  'packages/agent-keys': null,
  'packages/agent-sdk': null,
  'packages/chain-eth': null,
  'packages/chain-sol': null,
  'packages/chain-adapters': null,
  'mcp-server': null,
};
const SCAN = ['package.json', ...Object.keys(PUBLISHED).map((p) => `${p}/package.json`)];

// caret 语义判活：version 是否落在 ^A.B.C 区间内（0.x 语义：^0.2.2 表示
// >=0.2.2 && <0.3.0）。只校验「实际版本可达」，不强制 canonical 写法
// （^0.2.2 与 ^0.2.0 同族，均可达 0.2.2 —— 引用无需逐字归一）。
function caretSatisfies(range, version) {
  const rm = /^\^(\d+)\.(\d+)\.(\d+)$/.exec((range || '').trim());
  const vm = /^(\d+)\.(\d+)\.(\d+)/.exec((version || '').trim());
  if (!rm || !vm) return true; // 非 caret 或无法解析 → 不误报
  const [, lA, lB, lC] = rm.map(Number);
  const [vA, vB, vC] = vm.slice(1).map(Number);
  const gte = (vA > lA) || (vA === lA && vB > lB) || (vA === lA && vB === lB && vC >= lC);
  if (!gte) return false;
  // upper bound（排他）
  let uA = lA, uB = lB, uC = lC;
  if (lA > 0) { uA = lA + 1; uB = 0; uC = 0; }
  else if (lB > 0) { uB = lB + 1; uC = 0; }
  else { uC = lC + 1; }
  return (vA < uA) || (vA === uA && vB < uB) || (vA === uA && vB === uB && vC < uC);
}

function checkVersionConsistency() {
  console.log('\n[E] 6 包版本一致性检查（lockstep，防「发布断层」P0）');
  if (!existsSync(join(ROOT, 'package.json'))) {
    mark('WARN', '发布包校验', '未在仓库根执行，跳过');
    return;
  }
  const nameByDir = {};
  const verByDir = {};
  let missing = false;
  for (const dir of Object.keys(PUBLISHED)) {
    const p = join(ROOT, dir, 'package.json');
    if (!existsSync(p)) { mark('FAIL', dir, 'package.json 缺失'); missing = true; continue; }
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    nameByDir[dir] = pkg.name;
    verByDir[dir] = pkg.version;
  }
  let inconsistencies = 0;
  for (const abspath of SCAN) {
    const file = join(ROOT, abspath);
    if (!existsSync(file)) continue;
    let pkg;
    try { pkg = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const ranges = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    for (const dir of Object.keys(PUBLISHED)) {
      const name = nameByDir[dir];
      const ver = verByDir[dir];
      if (!name || !ver) continue;
      for (const field of ranges) {
        const dep = pkg[field];
        const range = dep && dep[name];
        if (range && /^\^/.test(range) && !caretSatisfies(range, ver)) {
          inconsistencies++;
          mark('FAIL', `${abspath}: ${name} ${range}`, `无法解析到已发布版本 ${ver}（跨 major.minor 断层）`);
        }
      }
    }
  }
  if (missing) return;
  if (inconsistencies === 0) mark('PASS', '全部发布包交叉引用与版本 lockstep');
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`NexusGenesis Release Preflight — cwd=${ROOT}`);
  checkProfile();
  await checkChainConfig();
  checkStoreWritable();
  await checkChainReachable();
  checkVersionConsistency();

  console.log('\n──── 汇总 ────');
  console.log(`  PASS: ${RESULTS.PASS}   WARN: ${RESULTS.WARN}   FAIL: ${RESULTS.FAIL}`);
  const ok = RESULTS.FAIL === 0;
  console.log(ok ? '\nPREFLIGHT PASS — 可进入发布/部署。' : '\nPREFLIGHT FAIL — 存在阻断项，禁止进入发布。');
  __resetProfileForTest();
  process.exit(ok ? 0 : 1);
}

await main().catch((err) => {
  console.error('\nPREFLIGHT ERROR:', err && err.message ? err.message : err);
  process.exit(1);
});
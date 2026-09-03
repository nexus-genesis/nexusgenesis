/**
 * Phase 1: Agent 自主钱包迁移协议测试
 * 
 * 测试场景：
 * 1. 创建服务器托管 Agent（直接通过 agentWalletManager）
 * 2. 导出加密钱包（迁移第一步）
 * 3. 声明自持（迁移第二步：签名证明）
 * 4. 验证 custody 状态已更新
 * 5. 重复迁移保护
 * 6. 无效签名拒绝
 * 7. 迁移状态查询
 */

import 'dotenv/config';
import express from 'express';
import walletApi from '../src/http/routes/walletApi.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import { sign as pqcSign } from '../src/crypto/pqc.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// 确保 data 目录存在
const dataDir = path.join(projectRoot, 'data', 'wallets');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const app = express();
app.use(express.json());

app.locals.agentWalletManager = agentWalletManager;
app.use('/api/v1/wallet', walletApi);

const server = app.listen(0);
const port = server.address().port;
const baseUrl = `http://localhost:${port}`;

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    console.log(`  ❌ ${testName}`);
  }
}

console.log('\n🧪 Phase 1: Agent 自主钱包迁移协议测试\n');
console.log('-'.repeat(60));

// ─── 测试 1: 创建服务器托管 Agent ─────────────────────────────

console.log('\n[Test 1] 创建服务器托管 Agent');
const agentId1 = 'phase1-test-agent-001';
try {
  // 直接通过 agentWalletManager 创建 server-managed Agent
  await agentWalletManager.createAgentWallet(agentId1, {}, 1000n);

  const entry = agentWalletManager.registry.get(agentId1);
  assert(entry !== undefined, 'Agent 创建成功');
  assert(entry.metadata.keyModel === 'server-managed', 'keyModel 为 server-managed');
  assert(entry.metadata.custody === undefined || entry.metadata.custody === 'server-managed', 'custody 状态为 server-managed');
  assert(!entry.metadata.custody || entry.metadata.custody !== 'self-custodied', 'isSelfCustodied = false');
} catch (e) {
  console.log(`  ❌ Agent 创建失败: ${e.message}`);
  failed += 4;
}

// ─── 测试 2: 导出加密钱包（迁移第一步） ───────────────────────

console.log('\n[Test 2] 导出加密钱包（迁移第一步）');
try {
  const resp = await fetch(`${baseUrl}/api/v1/wallet/agent/migrate-to-self-custody`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agentId1, password: 'test-password-123' })
  });
  const data = await resp.json();
  assert(resp.ok && data.success, '迁移导出请求成功');
  assert(data.data.encryptedWallet, '返回加密钱包数据');
  assert(data.data.address, '返回地址');
  assert(data.data.custody === 'server-managed (migration in progress)', 'custody 状态为迁移中');
  assert(data.data.nextStep === '使用 POST /api/v1/wallet/agent/self-custody 完成迁移声明', '下一步提示正确');
} catch (e) {
  console.log(`  ❌ 导出失败: ${e.message}`);
  failed += 4;
}

// ─── 测试 3: 声明自持（迁移第二步：签名证明） ──────────────────

console.log('\n[Test 3] 声明自持（迁移第二步）');
try {
  // 获取 Agent 的私钥用于签名
  const entry = agentWalletManager.registry.get(agentId1);
  const privateKey = entry.wallet.privateKey;
  
  // 用私钥签名一条消息证明拥有私钥
  const signedMessage = `self-custody-declaration:${agentId1}:${Date.now()}`;
  const sigBuffer = await pqcSign(signedMessage, privateKey);
  const signature = sigBuffer.toString('hex');

  const resp = await fetch(`${baseUrl}/api/v1/wallet/agent/self-custody`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: agentId1,
      signature,
      signedMessage
    })
  });
  const data = await resp.json();
  assert(resp.ok && data.success, '自持声明成功');
  assert(data.data.custody === 'self-custodied', 'custody 更新为 self-custodied');
  assert(data.data.serverWillNotStorePrivateKey === true, '服务器不再持有私钥');
  assert(data.data.migratedAt, '记录迁移时间');
} catch (e) {
  console.log(`  ❌ 自持声明失败: ${e.message}`);
  failed += 4;
}

// ─── 测试 4: 验证 custody 状态 ────────────────────────────────

console.log('\n[Test 4] 验证 custody 状态');
try {
  const resp = await fetch(`${baseUrl}/api/v1/wallet/agent/custody-status/${agentId1}`);
  const data = await resp.json();
  assert(resp.ok && data.success, '查询状态成功');
  assert(data.data.custody === 'self-custodied', 'custody = self-custodied');
  assert(data.data.isSelfCustodied === true, 'isSelfCustodied = true');
  assert(data.data.migrationStatus === 'completed', '迁移状态 = completed');
  assert(data.data.migratedAt, '有迁移时间戳');
} catch (e) {
  console.log(`  ❌ 状态查询失败: ${e.message}`);
  failed += 5;
}

// ─── 测试 5: 重复迁移保护 ─────────────────────────────────────

console.log('\n[Test 5] 重复迁移保护');
try {
  const resp = await fetch(`${baseUrl}/api/v1/wallet/agent/migrate-to-self-custody`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agentId1, password: 'test' })
  });
  const data = await resp.json();
  assert(!resp.ok || data.success === false, '重复迁移被拒绝');
  assert(data.error && data.error.includes('already'), '错误消息包含 already');
} catch (e) {
  console.log(`  ❌ 重复迁移测试失败: ${e.message}`);
  failed += 2;
}

// ─── 测试 6: 无效签名拒绝 ─────────────────────────────────────

console.log('\n[Test 6] 无效签名拒绝');
try {
  const resp = await fetch(`${baseUrl}/api/v1/wallet/agent/self-custody`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: agentId1,
      signature: 'ff'.repeat(2420),
      signedMessage: 'invalid-message'
    })
  });
  const data = await resp.json();
  assert(!resp.ok || data.success === false, '无效签名被拒绝');
  assert(data.error && data.error.includes('Invalid signature'), '错误消息包含 Invalid signature');
} catch (e) {
  console.log(`  ❌ 无效签名测试失败: ${e.message}`);
  failed += 2;
}

// ─── 测试 7: 新 Agent 默认 server-managed ─────────────────────

console.log('\n[Test 7] 新 Agent 默认 server-managed');
const agentId2 = 'phase1-test-agent-002';
try {
  await agentWalletManager.createAgentWallet(agentId2, {}, 1000n);
  
  const entry = agentWalletManager.registry.get(agentId2);
  assert(entry !== undefined, '新 Agent 创建成功');
  assert(entry.metadata.keyModel === 'server-managed', 'keyModel 为 server-managed');
  assert(!entry.metadata.custody || entry.metadata.custody === 'server-managed', '新 Agent 默认为 server-managed');
} catch (e) {
  console.log(`  ❌ 新 Agent 注册失败: ${e.message}`);
  failed += 3;
}

// ─── 测试 8: 迁移后余额不变 ───────────────────────────────────

console.log('\n[Test 8] 迁移后余额不变');
try {
  const entry = agentWalletManager.registry.get(agentId1);
  const balanceBefore = entry.wallet.balance.toString();
  
  // 迁移前后余额应该一致
  assert(balanceBefore === '1000', '迁移后余额保持 1000');
} catch (e) {
  console.log(`  ❌ 余额检查失败: ${e.message}`);
  failed++;
}

// ─── 汇总 ─────────────────────────────────────────────────────

const total = passed + failed;
console.log('\n' + '-'.repeat(60));
console.log(`  总计: ${passed}/${total} 通过, ${failed} 失败`);

if (failed === 0) {
  console.log('\n✅ Phase 1 迁移协议测试全部通过');
  server.close();
  process.exit(0);
} else {
  console.log('\n❌ 部分测试失败');
  server.close();
  process.exit(1);
}

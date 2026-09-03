/**
 * NexusGenesis - Three-Layer Key System Tests
 * 
 * 测试三层密钥体系的完整流程：
 * 1. 主密钥派生操作密钥
 * 2. Hybrid 模式注册
 * 3. Self-sovereign 模式注册
 * 4. Server-managed 标记为 legacy
 * 5. 密钥轮换
 */

import 'dotenv/config';
import crypto from 'crypto';
import {
  KEY_MODELS,
  isValidMasterKey,
  deriveOpKeySeed,
  calculateKeyFingerprint,
  generateMasterKey,
  verifyOpKeyFingerprint,
  rotateOpKey
} from '../src/wallet/keyDerivation.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

async function assertRejects(fn, errorMsg) {
  try {
    await fn();
    console.error(`  FAIL: ${errorMsg} (expected rejection but succeeded)`);
    failed++;
  } catch (e) {
    console.log(`  PASS: ${errorMsg} (correctly rejected)`);
    passed++;
  }
}

// Wrap all tests in async IIFE
(async () => {

// ─── 测试 1: 主密钥生成与验证 ──────────────────────────────────

console.log('\n[Test 1] Master Key Generation');
{
  const masterKey = generateMasterKey();
  assert(masterKey.length === 32, 'Generates 32-byte master key');

  assert(isValidMasterKey(generateMasterKey()) === true, 'Validates correct master key');
  assert(isValidMasterKey(Buffer.alloc(16)) === false, 'Rejects wrong-length key');
  assert(isValidMasterKey('invalid') === false, 'Rejects invalid input');
}

// ─── 测试 2: HKDF 密钥派生 ──────────────────────────────────────

console.log('\n[Test 2] HKDF Key Derivation');
{
  const masterKey = generateMasterKey();
  console.log(`  masterKey: ${masterKey.toString('hex').slice(0,16)}...`);
  
  const seed1 = await deriveOpKeySeed(masterKey, { agentId: 'agent-001' });
  const seed2 = await deriveOpKeySeed(masterKey, { agentId: 'agent-002' });
  console.log(`  seed1: ${seed1.toString('hex').slice(0,16)}...`);
  console.log(`  seed2: ${seed2.toString('hex').slice(0,16)}...`);
  assert(seed1.toString('hex') !== seed2.toString('hex'), 'Different agents derive different seeds');
  assert(seed1.length === 32 && seed2.length === 32, 'Seeds are 32 bytes');

  const seed1a = await deriveOpKeySeed(masterKey, { agentId: 'agent-001', version: 1 });
  const seed1b = await deriveOpKeySeed(masterKey, { agentId: 'agent-001', version: 1 });
  assert(seed1a.toString('hex') === seed1b.toString('hex'), 'Same agent+version derives same seed');

  const seedV1 = await deriveOpKeySeed(masterKey, { agentId: 'agent-001', version: 1 });
  const seedV2 = await deriveOpKeySeed(masterKey, { agentId: 'agent-001', version: 2 });
  assert(seedV1.toString('hex') !== seedV2.toString('hex'), 'Different versions derive different seeds');

  await assertRejects(
    () => deriveOpKeySeed(Buffer.alloc(16), { agentId: 'test' }),
    'Rejects invalid master key'
  );

  await assertRejects(
    () => deriveOpKeySeed(masterKey, {}),
    'Requires agentId'
  );
}

// ─── 测试 3: 密钥指纹 ──────────────────────────────────────────

console.log('\n[Test 3] Key Fingerprint');
{
  const key1 = crypto.randomBytes(2560);
  const key2 = crypto.randomBytes(2560);
  
  const fp1 = calculateKeyFingerprint(key1);
  const fp2 = calculateKeyFingerprint(key2);
  const fp1Again = calculateKeyFingerprint(key1);
  
  assert(fp1 === fp1Again, 'Consistent fingerprint for same key');
  assert(fp1 !== fp2, 'Different fingerprints for different keys');
  assert(fp1.length === 64, 'Fingerprint is 64-char hex (SHA256)');

  const fingerprint = calculateKeyFingerprint(key1);
  assert(verifyOpKeyFingerprint(key1, fingerprint) === true, 'Verifies correct fingerprint');
  assert(verifyOpKeyFingerprint(key1, 'wrong') === false, 'Rejects wrong fingerprint');
}

// ─── 测试 4: Agent 钱包管理器 ────────────────────────────────────

console.log('\n[Test 4] AgentWalletManager - Key Model Support');
{
  // Test hybrid mode with provided keys
  const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
  const keyPair = ml_dsa44.keygen();
  // @noble/post-quantum 返回的是 Uint8Array，需要用 Buffer.from() 转换
  const publicKeyHex = Buffer.from(keyPair.publicKey).toString('hex');
  const privateKeyHex = Buffer.from(keyPair.secretKey).toString('hex');
  
  const hybridAgentId = `test-hybrid-${Date.now()}`;
  const hybridResult = await agentWalletManager.registerAgentWithKeyModel(hybridAgentId, {
    keyModel: KEY_MODELS.HYBRID,
    publicKeyHex,
    privateKeyHex,
    metadata: { test: true }
  });
  
  assert(hybridResult.success === true, 'Hybrid registration succeeds');
  assert(hybridResult.keyModel === KEY_MODELS.HYBRID, 'Returns correct keyModel');
  assert(hybridResult.address && hybridResult.address.startsWith('ng1'), 'Has valid address');
  
  const hybridEntry = agentWalletManager.registry.get(hybridAgentId);
  assert(hybridEntry.metadata.keyModel === KEY_MODELS.HYBRID, 'Registry stores keyModel');
  assert(hybridEntry.metadata.opKeyFingerprint, 'Has op key fingerprint');
  
  // Cleanup
  agentWalletManager.registry.delete(hybridAgentId);
  agentWalletManager.addressIndex.delete(hybridResult.address);

  // Test self-sovereign mode
  const keyPair2 = ml_dsa44.keygen();
  const ssAgentId = `test-self-sovereign-${Date.now()}`;
  const ssResult = await agentWalletManager.registerAgentWithKeyModel(ssAgentId, {
    keyModel: KEY_MODELS.SELF_SOVEREIGN,
    publicKeyHex: keyPair2.publicKey.toString('hex'),
    privateKeyHex: keyPair2.secretKey.toString('hex')
  });
  
  assert(ssResult.success === true, 'Self-sovereign registration succeeds');
  assert(ssResult.keyModel === KEY_MODELS.SELF_SOVEREIGN, 'Returns correct keyModel');
  
  const ssEntry = agentWalletManager.registry.get(ssAgentId);
  assert(ssEntry.metadata.keyModel === KEY_MODELS.SELF_SOVEREIGN, 'Registry stores self-sovereign');
  
  // Cleanup
  agentWalletManager.registry.delete(ssAgentId);
  agentWalletManager.addressIndex.delete(ssResult.address);

  // Test server-managed (legacy)
  const smAgentId = `test-server-managed-${Date.now()}`;
  const smResult = await agentWalletManager.registerAgentWithKeyModel(smAgentId, {
    keyModel: KEY_MODELS.SERVER_MANAGED
  });
  
  assert(smResult.success === true, 'Server-managed registration succeeds');
  
  const smEntry = agentWalletManager.registry.get(smAgentId);
  assert(smEntry.metadata.keyModel === KEY_MODELS.SERVER_MANAGED, 'Stores server-managed');
  assert(smEntry.metadata.isLegacy === true, 'Marked as legacy');
  assert(smEntry.metadata.legacyReason, 'Has legacy reason');
  
  // Cleanup
  agentWalletManager.registry.delete(smAgentId);
  agentWalletManager.addressIndex.delete(smResult.address);

  // Test invalid key model
  const invalidAgentId = `test-invalid-${Date.now()}`;
  await assertRejects(
    () => agentWalletManager.registerAgentWithKeyModel(invalidAgentId, {
      keyModel: 'invalid-model'
    }),
    'Rejects unknown keyModel'
  );

  // Test missing key material
  const noKeyAgentId = `test-no-key-${Date.now()}`;
  await assertRejects(
    () => agentWalletManager.registerAgentWithKeyModel(noKeyAgentId, {
      keyModel: KEY_MODELS.HYBRID
    }),
    'Requires key material for hybrid mode'
  );
}

// ─── 测试 5: Legacy 标记 ─────────────────────────────────────────

console.log('\n[Test 5] Legacy Server-Marked Agents');
{
  const fakeAgentId = 'legacy-agent-fake-' + Date.now();
  agentWalletManager.registry.set(fakeAgentId, {
    wallet: { address: 'ng1fake', balance: 1000n },
    metadata: { created: '2024-01-01' } // 没有 keyModel
  });
  
  const count = agentWalletManager.markLegacyServerManagedAgents();
  assert(count === 1, 'Marks 1 agent as legacy');
  
  const entry = agentWalletManager.registry.get(fakeAgentId);
  assert(entry.metadata.keyModel === KEY_MODELS.SERVER_MANAGED, 'Sets keyModel to server-managed');
  assert(entry.metadata.isLegacy === true, 'Sets isLegacy flag');
  assert(entry.metadata.migratedAt, 'Sets migratedAt timestamp');
  
  // Cleanup
  agentWalletManager.registry.delete(fakeAgentId);

  // Test already tagged agent
  const taggedAgentId = 'tagged-agent-fake-' + Date.now();
  agentWalletManager.registry.set(taggedAgentId, {
    wallet: { address: 'ng1fake2', balance: 1000n },
    metadata: { keyModel: KEY_MODELS.HYBRID, isLegacy: false }
  });
  
  const count2 = agentWalletManager.markLegacyServerManagedAgents();
  assert(count2 === 0, 'Does not re-mark already tagged agents');
  
  // Cleanup
  agentWalletManager.registry.delete(taggedAgentId);
}

// ─── 测试 6: 密钥轮换 ────────────────────────────────────────────

console.log('\n[Test 6] Key Rotation');
{
  const masterKey = generateMasterKey();
  const agentId = 'rotation-test-agent';
  
  const seedV1 = await deriveOpKeySeed(masterKey, { agentId, version: 1 });
  const result = await rotateOpKey(masterKey, agentId, 1);
  
  assert(result.version === 2, 'Increments version to 2');
  assert(result.opKeySeed.toString('hex') !== seedV1.toString('hex'), 'Rotated key is different');
}

// ─── 测试 7: 密钥模式枚举 ────────────────────────────────────────

console.log('\n[Test 7] Key Models Enum');
{
  assert(KEY_MODELS.HYBRID === 'hybrid', 'HYBRID = hybrid');
  assert(KEY_MODELS.SELF_SOVEREIGN === 'self-sovereign', 'SELF_SOVEREIGN = self-sovereign');
  assert(KEY_MODELS.SERVER_MANAGED === 'server-managed', 'SERVER_MANAGED = server-managed');
  
  const models = Object.values(KEY_MODELS);
  assert(models.length === 3, 'Has 3 key models');
}

// ─── 汇总 ────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) {
  process.exit(1);
}

})(); // End of async IIFE

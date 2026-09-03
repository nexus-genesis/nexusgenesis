/**
 * B1 技术文章配套示例：从密钥生成到安全签名
 *
 * 运行方式：
 *   node example-article.js
 *
 * 对应文章章节：7. Complete Example
 * 依赖：npm install nexusgenesis-agent-keys
 */
import {
  generateKeyPair,
  createSessionKey,
  checkSessionAccess,
  verifySessionSignature,
  encryptPrivateKey,
  spawnSigner,
  resolveTier,
  checkSpendAllowedTiered,
  narrowSession,
} from 'nexusgenesis-agent-keys';

async function main() {
  console.log('══════════════════════════════════════════════════');
  console.log('  NexusGenesis Agent Keys — 完整演示');
  console.log('══════════════════════════════════════════════════\n');

  // ─── 1. Generate PQC Key Pair ──────────────────────────────
  console.log('■ 1. 生成 Dilithium2 密钥对');
  const { publicKey, privateKey } = await generateKeyPair();
  console.log(`   Public key: ${publicKey.toString('hex').slice(0, 40)}...`);
  console.log(`   Private key: ${privateKey.length} 字节\n`);

  // ─── 2. Create Session Key ─────────────────────────────────
  console.log('■ 2. 创建 Session Key（五维权限）');
  const session = createSessionKey(privateKey, {
    agentId: 'demo-agent',
    allowedContracts: ['0xTokenSwap', '0xStakingPool'],
    allowedMethods: ['swap', 'stake', 'unstake'],
    allowedChains: ['ethereum'],
    maxPerTx: '50',
    maxDaily: '200',
    ttl: 24 * 60 * 60 * 1000,
  });
  console.log(`   Session key created, expires in 24h`);
  console.log(`   Scope: ${session.allowedContracts.join(', ')}`);
  console.log(`   Max per tx: ${session.maxPerTx} NGEN`);

  // ─── 3. Verify Session Signature ───────────────────────────
  console.log('\n■ 3. 验证 Session Key 签名（防篡改）');
  const valid = await verifySessionSignature(session, publicKey);
  console.log(`   Signature valid: ${valid ? '✅' : '❌'}`);

  // ─── 4. Narrow Session ─────────────────────────────────────
  console.log('\n■ 4. 派生窄权限 Session（只降不升）');
  const subTask = narrowSession(session, {
    agentId: 'demo-agent',
    allowedContracts: ['0xTokenSwap'],
    allowedMethods: ['swap'],
    maxPerTx: '10',
    ttl: 60 * 60 * 1000,
  }, privateKey);
  console.log(`   Narrowed: ${subTask.allowedContracts.join(', ')}`);
  console.log(`   Max per tx: ${subTask.maxPerTx} NGEN`);
  console.log(`   TTL: ${subTask.ttl < session.ttl ? 'clamped to 1h ✅' : '❌'}`);

  // ─── 5. Access Control Check ───────────────────────────────
  console.log('\n■ 5. 权限校验');
  const tests = [
    { contract: '0xTokenSwap', method: 'swap', amount: '5', label: '允许的合约+方法+额度' },
    { contract: '0xUnknown', method: 'swap', amount: '5', label: '未授权的合约' },
    { contract: '0xTokenSwap', method: 'swap', amount: '15', label: '超额（15 > 10）' },
  ];
  for (const t of tests) {
    const result = checkSessionAccess(subTask, t);
    console.log(`   ${t.label}: ${result.allowed ? '✅' : '❌'} ${result.reason || 'OK'}`);
  }

  // ─── 6. Spend Tier Check ───────────────────────────────────
  console.log('\n■ 6. 三级梯度授权');
  for (const amount of ['5', '50', '500']) {
    const tier = resolveTier(amount);
    console.log(`   ${amount} NGEN → ${tier.tier} (threshold: ${tier.threshold})`);
  }

  // ─── 7. Signer Subprocess ──────────────────────────────────
  console.log('\n■ 7. Signer 子进程签名');
  const password = 'test-password-123';
  const envelope = encryptPrivateKey(privateKey, password, { publicKey: publicKey.toString('hex') });

  const signer = await spawnSigner({
    envelope,
    password,
    policy: { type: 'tiered', smallThreshold: '10', mediumThreshold: '100' },
  });

  // 小额：自动放行
  const small = await signer.sign({ hash: '0x' + 'ab'.repeat(32), amount: '5' });
  console.log(`   小额 (5 NGEN): ${small.sig ? '✅ 已签名' : '❌'} ${small.reason || ''}`);

  // 中额：时间锁
  const medium = await signer.sign({ hash: '0x' + 'cd'.repeat(32), amount: '50' });
  console.log(`   中额 (50 NGEN): ${medium.sig ? '✅ 已签名' : '⏳ 时间锁'} ${medium.reason || ''}`);

  // 大额：人工审批
  const large = await signer.sign({ hash: '0x' + 'ef'.repeat(32), amount: '500' });
  console.log(`   大额 (500 NGEN): ${large.sig ? '✅ 已签名' : '❌ 需人工'} ${large.reason || ''}`);

  signer.close();
  console.log('\n══════════════════════════════════════════════════');
  console.log('  ✅ 演示完成');
  console.log('══════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
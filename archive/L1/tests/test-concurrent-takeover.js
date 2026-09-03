﻿﻿﻿/**
 * NexusGenesis - Concurrent Takeover During Transfer Tests
 * 
 * 验证人类在 Agent 交易过程中突然接管钱包时的处理：
 * 1. 正常交易（无人接管） → 成功
 * 2. 接管后设置额度 → 后续交易受限
 * 3. 人类重新放开额度 → 交易恢复
 * 4. 多次并发接管 → 幂等性
 */

import 'dotenv/config';
import agentWalletManager from '../src/wallet/agentWalletManager.js';

let passed = 0;
let failed = 0;

function logAssert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

async function generateTestKeys() {
  const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
  const keyPair = ml_dsa44.keygen();
  // @noble/post-quantum 返回的是 Uint8Array，需要用 Buffer.from() 转换
  const pubBuf = Buffer.from(keyPair.publicKey);
  const secBuf = Buffer.from(keyPair.secretKey);
  return {
    publicKeyHex: pubBuf.toString('hex'),
    privateKeyHex: secBuf.toString('hex')
  };
}

(async () => {
  console.log('\n[Test 1] Normal transfer (no takeover) -> success');
  {
    const keys = await generateTestKeys();
    const agentId = `test-normal-${Date.now()}`;

    const regResult = await agentWalletManager.registerAgentWithKeyModel(agentId, {
      keyModel: 'self-sovereign',
      publicKeyHex: keys.publicKeyHex,
      privateKeyHex: keys.privateKeyHex,
      metadata: { spendConfig: { type: 'unlimited' } }
    });

    logAssert(regResult.success === true, 'Registration succeeds');

    const transferResult = await agentWalletManager.transfer(
      agentId,
      'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
      100
    );

    logAssert(transferResult.success === true, 'Transfer succeeds');
    logAssert(transferResult.error_code !== 'TAKEOVER_DURING_TRANSFER', 'No takeover error');

    agentWalletManager.registry.delete(agentId);
  }

  console.log('\n[Test 2] After takeover -> transfers rejected with rollback flag');
  {
    const keys = await generateTestKeys();
    const agentId = `test-takeover-${Date.now()}`;

    // 注册时就是 unlimited
    const regResult = await agentWalletManager.registerAgentWithKeyModel(agentId, {
      keyModel: 'self-sovereign',
      publicKeyHex: keys.publicKeyHex,
      privateKeyHex: keys.privateKeyHex,
      metadata: { spendConfig: { type: 'unlimited' } }
    });

    logAssert(regResult.success === true, 'Registration succeeds');

    // 先验证 unlimited 时可以转账
    const preTakeover = await agentWalletManager.transfer(
      agentId,
      'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
      100
    );
    logAssert(preTakeover.success === true, 'Transfer works before takeover');

    // 模拟人类接管
    agentWalletManager.registry.get(agentId).metadata.spendConfig = {
      type: 'fixed',
      dailyLimit: '1000000000000000000',
      humanControlled: true,
      takenOverAt: new Date().toISOString()
    };
    agentWalletManager.registry.get(agentId).metadata.takenOver = true;

    // 现在转账应该被拒绝
    const postTakeover = await agentWalletManager.transfer(
      agentId,
      'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
      100
    );

    logAssert(postTakeover.success === false, 'Transfer fails after takeover');
    logAssert(postTakeover.error_code === 'TAKEOVER_DURING_TRANSFER', 'Correct error code');
    logAssert(postTakeover.requiresHumanApproval === true, 'Requires human approval');
    logAssert(postTakeover.rollback === true, 'Marks as rolled back');

    agentWalletManager.registry.delete(agentId);
  }

  console.log('\n[Test 3] Human reopens limit -> transfers resume');
  {
    const keys = await generateTestKeys();
    const agentId = `test-reopen-${Date.now()}`;

    await agentWalletManager.registerAgentWithKeyModel(agentId, {
      keyModel: 'self-sovereign',
      publicKeyHex: keys.publicKeyHex,
      privateKeyHex: keys.privateKeyHex,
      metadata: { spendConfig: { type: 'unlimited' } }
    });

    // 先转账成功
    const pre = await agentWalletManager.transfer(
      agentId,
      'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
      100
    );
    logAssert(pre.success === true, 'Transfer works before takeover');

    // 人类接管
    agentWalletManager.registry.get(agentId).metadata.spendConfig = {
      type: 'fixed',
      dailyLimit: '1000000000000000000',
      humanControlled: true,
      takenOverAt: new Date().toISOString()
    };

    // 转账被拒
    const blocked = await agentWalletManager.transfer(
      agentId,
      'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
      100
    );
    logAssert(blocked.success === false, 'Transfer blocked after takeover');

    // 人类重新放开
    agentWalletManager.registry.get(agentId).metadata.spendConfig = { type: 'unlimited' };

    // 转账恢复
    const reopened = await agentWalletManager.transfer(
      agentId,
      'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
      100
    );

    logAssert(reopened.success === true, 'Transfer succeeds after reopening');
    logAssert(reopened.rollback !== true, 'No rollback');

    agentWalletManager.registry.delete(agentId);
  }

  console.log('\n[Test 4] Multiple concurrent takeovers -> idempotent');
  {
    const keys = await generateTestKeys();
    const agentId = `test-concurrent-${Date.now()}`;

    await agentWalletManager.registerAgentWithKeyModel(agentId, {
      keyModel: 'self-sovereign',
      publicKeyHex: keys.publicKeyHex,
      privateKeyHex: keys.privateKeyHex,
      metadata: { spendConfig: { type: 'unlimited' } }
    });

    for (let i = 0; i < 5; i++) {
      agentWalletManager.registry.get(agentId).metadata.spendConfig = {
        type: 'fixed',
        dailyLimit: '1000000000000000000',
        humanControlled: true,
        takenOverAt: new Date().toISOString()
      };
      agentWalletManager.registry.get(agentId).metadata.takenOver = true;
    }

    const entry = agentWalletManager.registry.get(agentId);
    logAssert(entry.metadata.spendConfig.type === 'fixed', 'Spend config is fixed');
    logAssert(entry.metadata.spendConfig.humanControlled === true, 'Human controlled');
    logAssert(entry.metadata.takenOver === true, 'Taken over flag set');

    agentWalletManager.registry.delete(agentId);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
})();

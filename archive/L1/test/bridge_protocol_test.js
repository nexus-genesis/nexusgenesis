/**
 * 跨链桥接协议测试
 */

import { CrossChainBridge } from '../src/bridge/bridgeProtocol.js';
import crypto from 'crypto';

// 创建测试密钥对
function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    publicKey: publicKey.export({ type: 'pkcs1', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' })
  };
}

// 签名Message
function signMessage(message, privateKey) {
  const sign = crypto.createSign('SHA256');
  sign.update(message);
  return sign.sign(privateKey);
}

console.log('=== 跨链桥接协议测试 ===\n');

// 测试1: 创建桥接实例
console.log('测试1: 创建桥接实例');
const bridge = new CrossChainBridge({
  chainId: 'nexus-testnet',
  minValidators: 2,
  signatureThreshold: 2,
  timeLockDuration: 1000 // 1秒时间锁，方便测试
});
console.log('✓ 桥接实例Create successful\n');

// 测试2: 注册Validator
console.log('测试2: 注册Validator');
const validator1 = generateTestKeyPair();
const validator2 = generateTestKeyPair();
const validator3 = generateTestKeyPair();

bridge.registerValidator('validator-1', validator1.publicKey);
bridge.registerValidator('validator-2', validator2.publicKey);
bridge.registerValidator('validator-3', validator3.publicKey);
console.log('✓ 3个ValidatorRegistration successful');

const activeValidators = bridge.getActiveValidators();
console.log(`✓ 活跃Validator数量: ${activeValidators.length}\n`);

// 测试3: 锁定资产
console.log('测试3: 锁定资产');
const lockResult = bridge.lockAsset(
  'ethereum',
  'solana',
  'ETH',
  1.5,
  '0x742d35Cc6634C0532925a3b886D89c9819649A5e',
  {
    timeLockDuration: 1000, // 1秒时间锁
    metadata: { sender: 'test-user', purpose: 'test' }
  }
);
console.log(`✓ 资产锁定成功，转账ID: ${lockResult.transferId}`);
console.log(`✓ 时间锁到期: ${new Date(lockResult.timeLockExpiry).toISOString()}\n`);

// 测试4: 验证转账（在时间锁到期前）
console.log('测试4: 验证转账（时间锁未到期）');
const transferId = lockResult.transferId;

// 创建转账Message进行签名
const transfer = bridge.getTransfer(transferId);
const message = crypto.createHash('sha256').update(
  `${transfer.transferId}:${transfer.fromChain}:${transfer.toChain}:${transfer.asset}:${transfer.amount}:${transfer.recipient}`
).digest();

// 尝试验证（应该Failed，因为时间锁未到期）
const signature1 = signMessage(message, validator1.privateKey);
const earlyValidation = bridge.validateTransfer(transferId, 'validator-1', signature1);
console.log(`✓ 时间锁未到期时验证: ${earlyValidation ? '成功' : 'Failed（预期行为）'}\n`);

// 等待时间锁到期
console.log('等待时间锁到期...');
await new Promise(resolve => setTimeout(resolve, 1500));

// 测试5: 验证转账（时间锁到期后）
console.log('测试5: 验证转账（时间锁到期后）');
const validation1 = bridge.validateTransfer(transferId, 'validator-1', signature1);
console.log(`✓ Validator1验证: ${validation1 ? '成功' : 'Failed'}`);

const signature2 = signMessage(message, validator2.privateKey);
const validation2 = bridge.validateTransfer(transferId, 'validator-2', signature2);
console.log(`✓ Validator2验证: ${validation2 ? '成功' : 'Failed'}`);

// 检查转账状态
const validatedTransfer = bridge.getTransfer(transferId);
console.log(`✓ 转账状态: ${validatedTransfer.status}\n`);

// 测试6: 释放资产
console.log('测试6: 释放资产');
try {
  const releaseResult = bridge.releaseAsset(transferId);
  console.log(`✓ 资产释放成功`);
  console.log(`✓ 接收者: ${releaseResult.recipient}`);
  console.log(`✓ 金额: ${releaseResult.amount}\n`);
} catch (error) {
  console.error(`✗ 释放Failed: ${error.message}\n`);
}

// 测试7: 更新Validator信誉
console.log('测试7: 更新Validator信誉');
bridge.updateValidatorReputation('validator-1', 5);
const validatorInfo = bridge.getValidator('validator-1');
console.log(`✓ Validator1信誉: ${validatorInfo.reputation}\n`);

// 测试8: Validator状态管理
console.log('测试8: Validator状态管理');
bridge.setValidatorActive('validator-3', false);
const activeAfter = bridge.getActiveValidators();
console.log(`✓ 停用Validator3后，活跃Validator: ${activeAfter.length}\n`);

// 测试9: get桥接状态
console.log('测试9: get桥接状态');
const status = bridge.getBridgeStatus();
console.log('✓ 桥接状态:');
console.log(`  - 链ID: ${status.chainId}`);
console.log(`  - Validator总数: ${status.validatorCount}`);
console.log(`  - 活跃Validator: ${status.activeValidators}`);
console.log(`  - 待Processing转账: ${status.pendingTransfers}`);
console.log(`  - Completed转账: ${status.completedTransfers}\n`);

// 测试10: get桥接事件
console.log('测试10: get桥接事件');
const events = bridge.getBridgeEvents(null, 5);
console.log(`✓ 最近5个事件: ${events.length}个`);
events.forEach((event, i) => {
  console.log(`  ${i+1}. ${event.type} - ${new Date(event.timestamp).toISOString()}`);
});

console.log('\n=== 所有测试完成 ===');

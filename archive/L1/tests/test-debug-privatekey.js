/**
 * Debug test — 检查 registerAgentWithKeyModel 后 wallet.privateKey 的值
 */

import 'dotenv/config';
import agentWalletManager from '../src/wallet/agentWalletManager.js';

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
  const keys = await generateTestKeys();
  const agentId = `debug-test-${Date.now()}`;

  console.log('Private key hex length:', keys.privateKeyHex.length); // 应该 ~5120 (2560*2)
  console.log('Public key hex length:', keys.publicKeyHex.length); // 应该 ~2624 (1312*2)

  const regResult = await agentWalletManager.registerAgentWithKeyModel(agentId, {
    keyModel: 'self-sovereign',
    publicKeyHex: keys.publicKeyHex,
    privateKeyHex: keys.privateKeyHex,
    metadata: { spendConfig: { type: 'unlimited' } }
  });

  console.log('Registration result:', regResult.success ? 'SUCCESS' : 'FAILED');

  const entry = agentWalletManager.registry.get(agentId);
  if (entry) {
    console.log('Wallet privateKey type:', typeof entry.wallet.privateKey);
    console.log('Wallet privateKey length:', entry.wallet.privateKey?.length);
    console.log('Wallet privateKey is Buffer:', Buffer.isBuffer(entry.wallet.privateKey));
    console.log('Wallet balance:', entry.wallet.balance);
    console.log('Wallet address:', entry.wallet.address);
  } else {
    console.log('Agent not found in registry!');
  }

  // 尝试转账
  console.log('\nAttempting transfer...');
  try {
    const transferResult = await agentWalletManager.transfer(
      agentId,
      'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
      100
    );
    console.log('Transfer result:', transferResult);
  } catch (err) {
    console.error('Transfer error:', err.message);
  }

  agentWalletManager.registry.delete(agentId);
})();

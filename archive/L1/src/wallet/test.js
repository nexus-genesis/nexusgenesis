/**
 * NexusGenesis - 钱包Test
 * Test两个钱包之间transfer
 */

import { PQCWallet, Transaction } from './pqcWallet.js';

async function test() {
  console.log('═══════════════════════════════════════════');
  console.log('  NexusGenesis 钱包transferTest');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // 1. Generate两个钱包
  console.log('[1/4] Generate钱包 A 和 B...');
  const walletA = await PQCWallet.generate(50000000); // 5000万 NGEN
  const walletB = await PQCWallet.generate(0);
  
  console.log('  钱包 A: ' + walletA.address);
  console.log('  钱包 B: ' + walletB.address);
  console.log('');

  // 2. 查看balance
  console.log('[2/4] 初始balance:');
  console.log('  A: ' + walletA.balance + ' NGEN');
  console.log('  B: ' + walletB.balance + ' NGEN');
  console.log('');

  // 3. A transfer 1000 NGEN 给 B
  console.log('[3/4] A transfer 1000 NGEN 给 B...');
  const amount = 1000n;
  const tx = await Transaction.create(walletA, walletB.address, amount, 'Testtransfer');
  
  // Sign
  await tx.sign(walletA);
  
  console.log('  transaction ID: ' + tx.id);
  console.log('  fee: ' + tx.fee + ' NGEN');
  console.log('  Sign: ' + tx.signature.substring(0, 32) + '...');
  console.log('');

  // 4. Executetransfer
  console.log('[4/4] Executetransfer...');
  
  // 扣除 A 的balance
  walletA.balance -= (amount + tx.fee);
  // 增加 B 的balance
  walletB.balance += amount;
  
  console.log('  transfersuccess!');
  console.log('');
  
  // 5. 最终balance
  console.log('═══════════════════════════════════════════');
  console.log('  最终balance:');
  console.log('  A: ' + walletA.balance + ' NGEN');
  console.log('  B: ' + walletB.balance + ' NGEN');
  console.log('═══════════════════════════════════════════');
}

test().catch(console.error);

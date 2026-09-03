/**
 * AINVM Extended Instructions Test
 * 验证新增指令和合约示例
 */

import assert from 'assert';
import { test } from 'node:test';
import AINVM from '../src/vm/ainvm.js';
import { generateDIDBytecode, generateRegisterIdentityBytecode } from '../contracts/examples/didContract.js';
import { generateStakingBytecode, generateStakeBytecode } from '../contracts/examples/stakingContract.js';
import { generateMultiSigBytecode, generateSubmitTransactionBytecode } from '../contracts/examples/multisigContract.js';
import { CrossChainBridge, LightClient } from '../src/bridge/bridgeProtocol.js';

const GAS_LIMIT = 10000;

test('Test 1: AND instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x05, 0x01, 0x03, 0x0D, 0x0B]); // PUSH 5, PUSH 3, AND, HALT
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[0], 1, '5 & 3 should be 1');
  console.log('✅ AND instruction works');
});

test('Test 2: OR instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x05, 0x01, 0x03, 0x0E, 0x0B]); // PUSH 5, PUSH 3, OR, HALT
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[0], 7, '5 | 3 should be 7');
  console.log('✅ OR instruction works');
});

test('Test 3: NOT instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x05, 0x0F, 0x0B]); // PUSH 5, NOT, HALT
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[0], ~5, '~5 should be correct');
  console.log('✅ NOT instruction works');
});

test('Test 4: XOR instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x05, 0x01, 0x03, 0x16, 0x0B]); // PUSH 5, PUSH 3, XOR, HALT
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[0], 6, '5 ^ 3 should be 6');
  console.log('✅ XOR instruction works');
});

test('Test 5: EQ instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x05, 0x01, 0x05, 0x17, 0x0B]); // PUSH 5, PUSH 5, EQ, HALT
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[0], 1, '5 == 5 should be 1');
  console.log('✅ EQ instruction works');
});

test('Test 6: LT instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x03, 0x01, 0x05, 0x18, 0x0B]); // PUSH 3, PUSH 5, LT, HALT
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[0], 1, '5 < 3 should be 1');
  console.log('✅ LT instruction works');
});

test('Test 7: GT instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x03, 0x01, 0x05, 0x19, 0x0B]); // PUSH 3, PUSH 5, GT, HALT
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[0], 0, '5 > 3 should be 0');
  console.log('✅ GT instruction works');
});

test('Test 8: MOD instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x07, 0x01, 0x03, 0x1A, 0x0B]); // PUSH 7, PUSH 3, MOD, HALT (stack: 7,3 -> 7%3)
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[0], 1, '7 % 3 should be 1');
  console.log('✅ MOD instruction works');
});

test('Test 9: DUP instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x05, 0x1D, 0x0B]); // PUSH 5, DUP, HALT
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack.length, 2, 'Stack should have 2 items');
  assert.strictEqual(result.stack[0], 5, 'First item should be 5');
  assert.strictEqual(result.stack[1], 5, 'Second item should be 5');
  console.log('✅ DUP instruction works');
});

test('Test 10: SWAP instruction', () => {
  const vm = new AINVM();
  vm.loadProgram([0x01, 0x03, 0x01, 0x05, 0x1E, 0x0B]); // PUSH 3, PUSH 5, SWAP, HALT
  const result = vm.execute(GAS_LIMIT);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[0], 5, 'First item should be 5');
  assert.strictEqual(result.stack[1], 3, 'Second item should be 3');
  console.log('✅ SWAP instruction works');
});

test('Test 11: DID contract deployment', () => {
  const vm = new AINVM();
  const bytecode = generateDIDBytecode();
  const program = bytecode.slice(2).match(/.{2}/g).map(b => parseInt(b, 16));
  vm.loadProgram(program);
  const result = vm.execute(GAS_LIMIT);
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.memory['0'], 0, 'identityCount should be 0');
  assert.strictEqual(result.memory['1'], 0, 'verificationCount should be 0');
  assert.strictEqual(result.memory['2'], 0, 'revokedCount should be 0');
  console.log('✅ DID contract deployment works');
});

test('Test 12: DID register identity', () => {
  const vm = new AINVM();
  const bytecode = generateRegisterIdentityBytecode();
  const program = bytecode.slice(2).match(/.{2}/g).map(b => parseInt(b, 16));
  vm.loadProgram(program);
  const result = vm.execute(GAS_LIMIT);
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.memory['0'], 1, 'identityCount should be 1');
  console.log('✅ DID register identity works');
});

test('Test 13: Staking contract deployment', () => {
  const vm = new AINVM();
  const bytecode = generateStakingBytecode();
  const program = bytecode.slice(2).match(/.{2}/g).map(b => parseInt(b, 16));
  vm.loadProgram(program);
  const result = vm.execute(GAS_LIMIT);
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.memory['0'], 0, 'totalStaked should be 0');
  assert.strictEqual(result.memory['1'], 0, 'totalRewards should be 0');
  assert.strictEqual(result.memory['2'], 0, 'stakerCount should be 0');
  console.log('✅ Staking contract deployment works');
});

test('Test 14: Stake function', () => {
  const vm = new AINVM();
  const bytecode = generateStakeBytecode(100);
  const program = bytecode.slice(2).match(/.{2}/g).map(b => parseInt(b, 16));
  vm.loadProgram(program);
  const result = vm.execute(GAS_LIMIT);
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.memory['0'], 100, 'totalStaked should be 100');
  assert.strictEqual(result.memory['2'], 1, 'stakerCount should be 1');
  console.log('✅ Stake function works');
});

test('Test 15: MultiSig contract deployment', () => {
  const vm = new AINVM();
  const bytecode = generateMultiSigBytecode(2, 3);
  const program = bytecode.slice(2).match(/.{2}/g).map(b => parseInt(b, 16));
  vm.loadProgram(program);
  const result = vm.execute(GAS_LIMIT);
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.memory['0'], 2, 'requiredSignatures should be 2');
  assert.strictEqual(result.memory['1'], 3, 'totalOwners should be 3');
  assert.strictEqual(result.memory['2'], 0, 'transactionCount should be 0');
  console.log('✅ MultiSig contract deployment works');
});

test('Test 16: Gas optimization', () => {
  const vm = new AINVM();
  const original = [0x01, 0x00, 0x01, 0x00, 0x0B]; // PUSH 0, PUSH 0, HALT
  const optimized = vm.optimizeBytecode(original);
  const stats = vm.calculateOptimizationStats(original, optimized);
  
  assert.ok(stats.gasSavings >= 0, 'Gas savings should be non-negative');
  console.log(`✅ Gas optimization: ${stats.gasSavings} gas saved (${stats.savingsPercent}%)`);
});

test('Test 17: Cross-chain bridge', () => {
  const bridge = new CrossChainBridge({
    chainId: 'nexusgenesis',
    supportedChains: ['nexus', 'ethereum', 'bitcoin', 'solana'],
    minValidators: 2
  });
  
  bridge.registerValidator('val1', 'pubkey1');
  bridge.registerValidator('val2', 'pubkey2');
  
  const lock = bridge.lockAsset('nexus', 'ethereum', 'NGEN', 1000, '0xabc');
  assert.ok(lock.transferId, 'Transfer ID should exist');
  assert.strictEqual(lock.status, 'locked', 'Status should be locked');
  
  const status = bridge.getBridgeStatus();
  assert.strictEqual(status.validatorCount, 2, 'Should have 2 validators');
  assert.strictEqual(status.pendingTransfers, 1, 'Should have 1 pending transfer');
  
  console.log('✅ Cross-chain bridge works');
});

test('Test 18: Light client sync', () => {
  const bridge = new CrossChainBridge();
  const client = new LightClient(bridge);
  
  client.syncHeader(1, { transactions: ['tx1', 'tx2'] });
  client.syncHeader(2, { transactions: ['tx3'] });
  
  const status = client.getSyncStatus();
  assert.strictEqual(status.syncHeight, 2, 'Sync height should be 2');
  assert.strictEqual(status.headerCount, 2, 'Should have 2 headers');
  
  console.log('✅ Light client sync works');
});

console.log('\n=== AINVM Extended Tests ===');

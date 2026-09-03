/**
 * AINVM 合约测试
 * 测试场景：
 * 1. 部署 + 调用计数器合约（本地状态机）
 * 2. Gas 限制测试
 */

import assert from 'assert';
import { test } from 'node:test';
import { State, createInitialState } from '../src/blockchain/state.js';

// 测试地址
const testAddress = 'ng11HtQNLuTjwDg86yrgkgBo3MzZaHuGkqZrQ';
const genesisAddress = 'ng11L2sdxT8qdYjtX1z9RrRSEEhPfw9vrwpCT';

// 计数器合约字节码（十六进制）
// Logic: LOAD 0 (counter), PUSH 1, ADD, STORE 0, HALT
const counterBytecode = '0x070001010308000b';

// 测试用例
test('Test 1: Deploy and call counter contract', () => {
  // 初始化状态
  const state = new State(genesisAddress);
  // 设置测试地址的余额
  state.setBalance(testAddress, '1000000');
  
  // 步骤 1：Deploy contract
  const deployTx = {
    id: 'test-deploy-1',
    tx_type: 'CONTRACT_DEPLOY',
    from: testAddress,
    contract_id: 'test-counter-1',
    bytecode: counterBytecode,
    gas_limit: '10000',
    fee: '1000',
    timestamp: Date.now(),
    nonce: '1',
    signature: 'test-signature'
  };
  
  // 应用部署交易
  const deployResult = state.applyTransaction(deployTx);
  assert.strictEqual(deployResult, true, 'Contract deploy should succeed');
  
  // 验证合约是否部署成功
  const contract = state.contracts.get('test-counter-1');
  assert.ok(contract, 'Contract should exist after deployment');
  assert.strictEqual(contract.bytecode, counterBytecode, 'Bytecode should match');
  assert.ok(contract.storage, 'Storage should be initialized');
  assert.strictEqual(contract.storage.size, 0, 'Storage should be empty initially');
  
  // 步骤 2：第一次调用合约
  const callTx1 = {
    id: 'test-call-1',
    tx_type: 'CONTRACT_CALL',
    from: testAddress,
    contract_id: 'test-counter-1',
    gas_limit: '10000',
    fee: '1000',
    timestamp: Date.now(),
    nonce: '2',
    signature: 'test-signature'
  };
  
  // 应用调用交易
  const callResult1 = state.applyTransaction(callTx1);
  assert.strictEqual(callResult1, true, 'First contract call should succeed');
  
  // 验证计数器值为 1
  const contractAfterCall1 = state.contracts.get('test-counter-1');
  assert.ok(contractAfterCall1, 'Contract should exist after call');
  assert.strictEqual(contractAfterCall1.storage.get('0'), '1', 'Counter should be 1 after first call');
  
  // 步骤 3：第二次调用合约
  const callTx2 = {
    id: 'test-call-2',
    tx_type: 'CONTRACT_CALL',
    from: testAddress,
    contract_id: 'test-counter-1',
    gas_limit: '10000',
    fee: '1000',
    timestamp: Date.now(),
    nonce: '3',
    signature: 'test-signature'
  };
  
  // 应用调用交易
  const callResult2 = state.applyTransaction(callTx2);
  assert.strictEqual(callResult2, true, 'Second contract call should succeed');
  
  // 验证计数器值为 2
  const contractAfterCall2 = state.contracts.get('test-counter-1');
  assert.ok(contractAfterCall2, 'Contract should exist after second call');
  assert.strictEqual(contractAfterCall2.storage.get('0'), '2', 'Counter should be 2 after second call');
});

test('Test 2: Gas limit test', () => {
  // 初始化状态
  const state = new State(genesisAddress);
  state.setBalance(testAddress, '1000000');
  
  // Deploy contract
  const deployTx = {
    id: 'test-deploy-2',
    tx_type: 'CONTRACT_DEPLOY',
    from: testAddress,
    contract_id: 'test-counter-2',
    bytecode: counterBytecode,
    gas_limit: '10000',
    fee: '1000',
    timestamp: Date.now(),
    nonce: '1',
    signature: 'test-signature'
  };
  
  state.applyTransaction(deployTx);
  
  // 调用合约，但设置非常小的 gas_limit
  const callTx = {
    id: 'test-call-gas',
    tx_type: 'CONTRACT_CALL',
    from: testAddress,
    contract_id: 'test-counter-2',
    gas_limit: '1', // 非常小的 gas 限制
    fee: '1000',
    timestamp: Date.now(),
    nonce: '2',
    signature: 'test-signature'
  };
  
  // 应用调用交易（应该Failed）
  const callResult = state.applyTransaction(callTx);
  assert.strictEqual(callResult, false, 'Contract call should fail with low gas limit');
  
  // 验证合约存储未更新
  const contract = state.contracts.get('test-counter-2');
  assert.ok(contract, 'Contract should exist');
  assert.strictEqual(contract.storage.get('0'), undefined, 'Counter should not be updated');
});

test('Test 3: Deploy to existing contract ID should fail', () => {
  // 初始化状态
  const state = new State(genesisAddress);
  state.setBalance(testAddress, '1000000');
  
  // 第一次部署
  const deployTx1 = {
    id: 'test-deploy-3-1',
    tx_type: 'CONTRACT_DEPLOY',
    from: testAddress,
    contract_id: 'test-duplicate',
    bytecode: counterBytecode,
    gas_limit: '10000',
    fee: '1000',
    timestamp: Date.now(),
    nonce: '1',
    signature: 'test-signature'
  };
  
  const result1 = state.applyTransaction(deployTx1);
  assert.strictEqual(result1, true, 'First deploy should succeed');
  
  // 第二次部署到相同 ID
  const deployTx2 = {
    id: 'test-deploy-3-2',
    tx_type: 'CONTRACT_DEPLOY',
    from: testAddress,
    contract_id: 'test-duplicate',
    bytecode: counterBytecode,
    gas_limit: '10000',
    fee: '1000',
    timestamp: Date.now(),
    nonce: '2',
    signature: 'test-signature'
  };
  
  const result2 = state.applyTransaction(deployTx2);
  assert.strictEqual(result2, false, 'Second deploy to same ID should fail');
});

test('Test 4: Call non-existent contract should fail', () => {
  // 初始化状态
  const state = new State(genesisAddress);
  state.setBalance(testAddress, '1000000');
  
  const callTx = {
    id: 'test-call-non-existent',
    tx_type: 'CONTRACT_CALL',
    from: testAddress,
    contract_id: 'non-existent-contract',
    gas_limit: '10000',
    fee: '1000',
    timestamp: Date.now(),
    nonce: '1',
    signature: 'test-signature'
  };
  
  const result = state.applyTransaction(callTx);
  assert.strictEqual(result, false, 'Call to non-existent contract should fail');
});

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  import('node:test').then(({ run }) => {
    run();
  });
}

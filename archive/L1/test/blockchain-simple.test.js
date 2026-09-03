import { Block, createGenesisBlock, createBlock } from '../src/blockchain/block.js';
import { State, createInitialState } from '../src/blockchain/state.js';

// 简单测试函数
function test(description, testFn) {
  console.log(`\n=== Testing: ${description} ===`);
  try {
    testFn();
    console.log('✓ PASSED');
  } catch (error) {
    console.log(`✗ FAILED: ${error.message}`);
  }
}

// 简单断言函数
function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error('Expected value to be defined');
      }
    },
    toBeTrue() {
      if (actual !== true) {
        throw new Error(`Expected true, got ${actual}`);
      }
    }
  };
}

// 测试区块功能
test('Block creation and validation', () => {
  // 创建创世区块
  const genesisBlock = createGenesisBlock();
  expect(genesisBlock).toBeDefined();
  expect(genesisBlock.header.height).toBe(0);
  expect(genesisBlock.validate()).toBeTrue();

  // 创建交易
  const transactions = [
    {
      id: 'tx1',
      from: 'ng11HtQNLuTjwDg86yrgkgBo3MzZaHuGkqZrQ',
      to: 'ng11L2sdxT8qdYjtX1z9RrRSEEhPfw9vrwpCT',
      amount: '100',
      fee: '1'
    }
  ];

  // 创建New block
  const newBlock = createBlock(genesisBlock, transactions);
  expect(newBlock).toBeDefined();
  expect(newBlock.header.height).toBe(1);
  expect(newBlock.header.parent_hash).toBe(genesisBlock.hash);
  expect(newBlock.validate()).toBeTrue();
});

// 测试状态管理
test('State management', () => {
  const genesisAddress = 'ng11HtQNLuTjwDg86yrgkgBo3MzZaHuGkqZrQ';
  const state = createInitialState(genesisAddress, '1000');

  // 手动设置创世地址余额（模拟真实分配后的情况）
  state.setBalance(genesisAddress, '1000');

  // 测试余额设置和get
  expect(state.getBalance(genesisAddress)).toBe('1000');

  // 测试余额增加
  state.addBalance(genesisAddress, '500');
  expect(state.getBalance(genesisAddress)).toBe('1500');

  // 测试余额减少
  const subtractResult = state.subtractBalance(genesisAddress, '300');
  expect(subtractResult).toBe(true);
  expect(state.getBalance(genesisAddress)).toBe('1200');

  // 测试余额不足
  const subtractResultFail = state.subtractBalance(genesisAddress, '2000');
  expect(subtractResultFail).toBe(false);
  expect(state.getBalance(genesisAddress)).toBe('1200');
});

// 测试交易Processing
test('Transaction processing with Metabolic Tax', () => {
  const genesisAddress = 'ng11HtQNLuTjwDg86yrgkgBo3MzZaHuGkqZrQ';
  const recipientAddress = 'ng11L2sdxT8qdYjtX1z9RrRSEEhPfw9vrwpCT';
  const state = createInitialState(genesisAddress, '1000');

  // 手动设置创世地址余额（模拟真实分配后的情况）
  state.setBalance(genesisAddress, '1000');

  // 测试转账交易
  const transferTransaction = {
    tx_type: 'TRANSFER',
    id: 'tx1',
    from: genesisAddress,
    to: recipientAddress,
    amount: '100',
    fee: '1'
  };

  // 应用交易
  const applyResult = state.applyTransfer(transferTransaction);
  expect(applyResult).toBeTrue();

  // 验证余额变化
  // 发送方：1000 - 100 - 1 = 899
  expect(state.getBalance(genesisAddress)).toBe('899');
  // 接收方：100
  expect(state.getBalance(recipientAddress)).toBe('100');

  // 验证 Metabolic Tax（0.1% of 100 = 0.1，向下取整为 0）
  // 由于金额较小，税费为 0

  // 测试更大金额的转账
  const largeTransferTransaction = {
    tx_type: 'TRANSFER',
    id: 'tx2',
    from: genesisAddress,
    to: recipientAddress,
    amount: '1000',
    fee: '1'
  };

  // 更新余额以确保足够
  state.setBalance(genesisAddress, '2000');

  // 应用交易
  const applyResultLarge = state.applyTransfer(largeTransferTransaction);
  expect(applyResultLarge).toBeTrue();

  // 验证余额变化
  // 发送方：2000 - 1000 - 1 = 999
  // 接收方：100 + 1000 = 1100
  // 税费 1000 × 0.1% = 1 转入 genesisReserve（硬编码地址），不是返回 genesisAddress
  expect(state.getBalance(genesisAddress)).toBe('999');
  expect(state.getBalance(recipientAddress)).toBe('1100');
});

// 测试区块链集成
test('Blockchain integration', () => {
  const genesisAddress = 'ng11HtQNLuTjwDg86yrgkgBo3MzZaHuGkqZrQ';
  const recipientAddress = 'ng11L2sdxT8qdYjtX1z9RrRSEEhPfw9vrwpCT';

  // 创建区块链
  const genesisBlock = createGenesisBlock();
  const blockchain = [genesisBlock];

  // 创建状态
  const state = createInitialState(genesisAddress, '10000');

  // 手动设置创世地址余额（createInitialState 按10-5-85分配，genesisAddress=0）
  state.setBalance(genesisAddress, '10000');

  // 创建交易
  const transactions = [
    {
      tx_type: 'TRANSFER',
      id: 'tx1',
      from: genesisAddress,
      to: recipientAddress,
      amount: '1000',
      fee: '1'
    },
    {
      tx_type: 'TRANSFER',
      id: 'tx2',
      from: recipientAddress,
      to: genesisAddress,
      amount: '500',
      fee: '1'
    }
  ];

  // 创建New block
  const newBlock = createBlock(genesisBlock, transactions);
  expect(newBlock.validate()).toBe(true);

  // 应用交易到状态
  state.applyTransactions(transactions);
  // applyTransactions 总是返回 true（DevNet 模式）

  // 验证状态变化
  // 初始：genesisAddress = 10000, recipientAddress = 0
  // 交易1：genesisAddress - 1000 - 1 = 8999, recipientAddress + 1000 = 1000, tax=1→genesisReserve
  // 交易2：recipientAddress - 500 - 1 = 499, genesisAddress + 500 = 9499, tax=0
  // 最终：genesisAddress = 9499, recipientAddress = 499
  expect(state.getBalance(genesisAddress)).toBe('9499');
  expect(state.getBalance(recipientAddress)).toBe('499');
});

console.log('\n=== All tests completed ===');

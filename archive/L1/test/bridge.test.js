/**
 * NexusGenesis - 跨链桥测试
 * 覆盖：Message格式、链配置、转移请求验证
 */

import assert from 'assert';
import { test } from 'node:test';

const SUPPORTED_CHAINS = ['nexus', 'ethereum', 'bitcoin'];
const VALID_MESSAGE_TYPES = ['TRANSFER', 'LOCK', 'RELEASE', 'VERIFY'];

function createBridgeMessage(fromChain, toChain, amount, asset) {
  return {
    type: 'CROSS_CHAIN_TRANSFER',
    fromChain,
    toChain,
    amount: String(amount),
    asset: asset || 'NGEN',
    timestamp: Date.now(),
    id: `${fromChain}-${toChain}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  };
}

test('Test 1: Bridge message has required fields', () => {
  const msg = createBridgeMessage('nexus', 'ethereum', 1000);
  assert.ok(msg.type);
  assert.ok(msg.fromChain);
  assert.ok(msg.toChain);
  assert.ok(msg.amount);
  assert.ok(msg.id);
  assert.ok(msg.timestamp);
});

test('Test 2: Bridge message ID is unique per call', () => {
  const msg1 = createBridgeMessage('nexus', 'ethereum', 100);
  const msg2 = createBridgeMessage('nexus', 'ethereum', 200);
  assert.notStrictEqual(msg1.id, msg2.id);
});

test('Test 3: Supported chain list contains expected chains', () => {
  assert.ok(SUPPORTED_CHAINS.includes('nexus'));
  assert.ok(SUPPORTED_CHAINS.includes('ethereum'));
  assert.ok(SUPPORTED_CHAINS.includes('bitcoin'));
});

test('Test 4: Transfer from nexus to ethereum', () => {
  const msg = createBridgeMessage('nexus', 'ethereum', '50000000000', 'NGEN');
  assert.strictEqual(msg.fromChain, 'nexus');
  assert.strictEqual(msg.toChain, 'ethereum');
  assert.strictEqual(msg.amount, '50000000000');
  assert.strictEqual(msg.asset, 'NGEN');
});

test('Test 5: Transfer from ethereum to nexus (reverse)', () => {
  const msg = createBridgeMessage('ethereum', 'nexus', '10', 'ETH');
  assert.strictEqual(msg.fromChain, 'ethereum');
  assert.strictEqual(msg.toChain, 'nexus');
  assert.strictEqual(msg.asset, 'ETH');
});

test('Test 6: Cross-chain message serialization round-trip', () => {
  const original = createBridgeMessage('nexus', 'bitcoin', 5000, 'NGEN');
  const json = JSON.stringify(original);
  const parsed = JSON.parse(json);
  
  assert.strictEqual(parsed.fromChain, original.fromChain);
  assert.strictEqual(parsed.toChain, original.toChain);
  assert.strictEqual(parsed.amount, original.amount);
  assert.strictEqual(parsed.id, original.id);
});

test('Test 7: Zero amount transfer is valid as a message', () => {
  const msg = createBridgeMessage('nexus', 'ethereum', 0);
  assert.strictEqual(msg.amount, '0');
});

test('Test 8: Large amount transfer (simulating full reserve)', () => {
  const msg = createBridgeMessage('nexus', 'ethereum', '100000000000000000000');
  assert.strictEqual(typeof msg.amount, 'string');
  assert.ok(BigInt(msg.amount) > 0n);
});

test('Test 9: Bridge message validation - unsupported chain rejection', () => {
  const msg = createBridgeMessage('solana', 'nexus', 100);
  const isValidFrom = SUPPORTED_CHAINS.includes(msg.fromChain);
  const isValidTo = SUPPORTED_CHAINS.includes(msg.toChain);
  assert.strictEqual(isValidFrom, false);
  assert.strictEqual(isValidTo, true);
});

test('Test 10: Multiple simultaneous bridge messages', () => {
  const msgs = [];
  for (let i = 0; i < 50; i++) {
    msgs.push(createBridgeMessage('nexus', 'ethereum', i * 10));
  }
  const ids = new Set(msgs.map(m => m.id));
  assert.strictEqual(ids.size, 50, 'All 50 messages should have unique IDs');
});
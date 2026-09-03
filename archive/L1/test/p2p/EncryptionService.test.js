/**
 * 加密服务测试用例
 */
import { test } from 'node:test';
import assert from 'node:assert';
import EncryptionService from '../../src/p2p/services/EncryptionService.js';
import crypto from 'crypto';

test('EncryptionService - 加密解密测试', async (t) => {
  const encryptionService = new EncryptionService();
  const testMessage = { type: 'TEST', data: 'Hello, NexusGenesis!' };
  const key = crypto.randomBytes(32);
  
  // 测试加密功能
  const encrypted = encryptionService.encryptMessage(JSON.stringify(testMessage), key);
  assert.ok(encrypted, '加密结果应该存在');
  assert.notEqual(encrypted, JSON.stringify(testMessage), '加密结果应该与原始消息不同');
  
  // 测试解密功能
  const decrypted = encryptionService.decryptMessage(encrypted, key);
  assert.ok(decrypted, '解密结果应该存在');
  assert.deepEqual(JSON.parse(decrypted), testMessage, '解密结果应该与原始消息相同');
});

test('EncryptionService - 消息类型加密判断测试', async (t) => {
  const encryptionService = new EncryptionService();
  
  // 测试不需要加密的Message类型
  assert.strictEqual(encryptionService.shouldEncrypt('PING'), false, 'PING消息不应该加密');
  assert.strictEqual(encryptionService.shouldEncrypt('PONG'), false, 'PONG消息不应该加密');
  assert.strictEqual(encryptionService.shouldEncrypt('HELLO'), false, 'HELLO消息不应该加密');
  assert.strictEqual(encryptionService.shouldEncrypt('HELLO_ACK'), false, 'HELLO_ACK消息不应该加密');
  
  // 测试需要加密的Message类型
  assert.strictEqual(encryptionService.shouldEncrypt('TRANSACTION'), true, 'TRANSACTION消息应该加密');
  assert.strictEqual(encryptionService.shouldEncrypt('BLOCK'), true, 'BLOCK消息应该加密');
  assert.strictEqual(encryptionService.shouldEncrypt('DIRECT_MESSAGE'), true, 'DIRECT_MESSAGE消息应该加密');
  assert.strictEqual(encryptionService.shouldEncrypt('CROSS_CHAIN_MESSAGE'), true, 'CROSS_CHAIN_MESSAGE消息应该加密');
});
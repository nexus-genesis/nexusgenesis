/**
 * 压缩服务测试用例
 */
import { test } from 'node:test';
import assert from 'node:assert';
import CompressionService from '../../src/p2p/services/CompressionService.js';

test('CompressionService - 压缩解压缩测试', async (t) => {
  const compressionService = new CompressionService();
  
  // 创建一个大Message，确保它会被压缩
  const largeMessage = {
    type: 'LARGE_TEST',
    data: 'x'.repeat(2000) // 2000个字符，超过默认的1024字节阈值
  };
  
  const messageStr = JSON.stringify(largeMessage);
  
  // 测试压缩功能
  const compressed = await compressionService.compressMessage(messageStr);
  assert.ok(compressed, '压缩结果应该存在');
  assert.strictEqual(compressed.type, 'COMPRESSED_MESSAGE', '压缩结果类型应该是COMPRESSED_MESSAGE');
  assert.ok(compressed.data, '压缩数据应该存在');
  
  // 测试解压缩功能
  const decompressed = await compressionService.decompressMessage(compressed);
  assert.ok(decompressed, '解压缩结果应该存在');
  assert.deepEqual(JSON.parse(decompressed), largeMessage, '解压缩结果应该与原始消息相同');
});

test('CompressionService - 小消息不压缩测试', async (t) => {
  const compressionService = new CompressionService();
  
  // 创建一个小Message，确保它不会被压缩
  const smallMessage = { type: 'SMALL_TEST', data: 'Hello' };
  const messageStr = JSON.stringify(smallMessage);
  
  // 测试压缩功能，小Message应该返回null
  const compressed = await compressionService.compressMessage(messageStr);
  assert.strictEqual(compressed, null, '小消息不应该被压缩，返回null');
});

test('CompressionService - 压缩判断测试', async (t) => {
  const compressionService = new CompressionService();
  
  // 小Message不应该压缩
  const smallMessage = JSON.stringify({ type: 'SMALL', data: 'Hello' });
  assert.strictEqual(compressionService.shouldCompress(smallMessage), false, '小消息不应该被压缩');
  
  // 大Message应该压缩
  const largeMessage = JSON.stringify({ type: 'LARGE', data: 'x'.repeat(2000) });
  assert.strictEqual(compressionService.shouldCompress(largeMessage), true, '大消息应该被压缩');
});
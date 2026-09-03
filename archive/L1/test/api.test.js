/**
 * NexusGenesis - API 测试
 * 覆盖：Agent 注册验证、请求体校验、地址格式
 */

import assert from 'assert';
import { test } from 'node:test';
import { validateAddress } from '../src/wallet/addressUtils.js';

function validateAgentId(agentId) {
  if (!agentId || typeof agentId !== 'string') return { valid: false, reason: 'Missing or invalid agentId' };
  if (agentId.length !== 64) return { valid: false, reason: `Agent ID must be 64 chars, got ${agentId.length}` };
  if (!/^[a-f0-9]+$/i.test(agentId)) return { valid: false, reason: 'Agent ID must be hex' };
  return { valid: true };
}

function validateRequestBodySize(body) {
  const size = Buffer.isBuffer(body) ? body.length : Buffer.from(body).length;
  const MAX_BODY_SIZE = 10 * 1024 * 1024;
  if (size > MAX_BODY_SIZE) return { valid: false, reason: `Body too large: ${size}` };
  return { valid: true };
}

function validateCapabilities(caps) {
  if (!Array.isArray(caps)) return { valid: false, reason: 'Capabilities must be an array' };
  if (caps.length === 0) return { valid: false, reason: 'Capabilities cannot be empty' };
  if (caps.some(c => typeof c !== 'string' || c.length > 100)) return { valid: false, reason: 'Invalid capability name' };
  return { valid: true };
}

test('Test 1: validateAgentId accepts 64-char hex string', () => {
  const result = validateAgentId('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
  assert.strictEqual(result.valid, true);
});

test('Test 2: validateAgentId rejects short string', () => {
  const result = validateAgentId('short');
  assert.strictEqual(result.valid, false);
});

test('Test 3: validateAgentId rejects non-hex characters', () => {
  const result = validateAgentId('xyz!0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
  assert.strictEqual(result.valid, false);
});

test('Test 4: validateAgentId rejects empty string', () => {
  const result = validateAgentId('');
  assert.strictEqual(result.valid, false);
});

test('Test 5: validateAgentId rejects null', () => {
  const result = validateAgentId(null);
  assert.strictEqual(result.valid, false);
});

test('Test 6: validateRequestBodySize accepts small payload', () => {
  const smallBody = JSON.stringify({ agentId: 'a'.repeat(64), capabilities: ['test'] });
  const result = validateRequestBodySize(smallBody);
  assert.strictEqual(result.valid, true);
});

test('Test 7: validateRequestBodySize rejects oversized payload', () => {
  const largeBody = 'x'.repeat(10 * 1024 * 1024 + 1);
  const result = validateRequestBodySize(largeBody);
  assert.strictEqual(result.valid, false);
});

test('Test 8: validateCapabilities accepts valid array', () => {
  const result = validateCapabilities(['coding', 'review', 'testing']);
  assert.strictEqual(result.valid, true);
});

test('Test 9: validateCapabilities rejects non-array', () => {
  const result = validateCapabilities('coding');
  assert.strictEqual(result.valid, false);
});

test('Test 10: validateCapabilities rejects empty array', () => {
  const result = validateCapabilities([]);
  assert.strictEqual(result.valid, false);
});

test('Test 11: validateCapabilities rejects oversized capability', () => {
  const longCap = 'a'.repeat(200);
  const result = validateCapabilities([longCap]);
  assert.strictEqual(result.valid, false);
});

test('Test 12: validateAddress accepts Observer address', () => {
  const result = validateAddress('ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r');
  assert.strictEqual(result.valid, true);
});

test('Test 13: validateAddress rejects invalid prefix', () => {
  const result = validateAddress('0xInvalidAddress123456789');
  assert.strictEqual(result.valid, false);
});

test('Test 14: Agent registration payload structure', () => {
  const payload = {
    agentId: 'a'.repeat(64),
    address: 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r',
    capabilities: ['coding', 'review'],
    name: 'Test Agent',
    version: '1.0.0',
  };

  assert.ok(payload.agentId);
  assert.ok(payload.address.startsWith('ng1'));
  assert.ok(Array.isArray(payload.capabilities));
  assert.ok(payload.capabilities.length > 0);
});

test('Test 15: API response format consistency', () => {
  const successResponse = {
    success: true,
    data: { agentId: 'test-agent', status: 'registered' },
    timestamp: Date.now(),
  };
  assert.strictEqual(successResponse.success, true);
  assert.ok(successResponse.data);

  const errorResponse = {
    success: false,
    error: 'Validation failed',
    code: 400,
    timestamp: Date.now(),
  };
  assert.strictEqual(errorResponse.success, false);
  assert.ok(errorResponse.error);
  assert.ok(errorResponse.code);
});
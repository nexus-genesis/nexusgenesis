/**
 * PQC 真实实现测试
 * 验证 @noble/post-quantum 的 Dilithium2 功能
 */

import assert from 'assert';
import { test } from 'node:test';
import { generateKeyPair, sign, verify, hash, getPQCInfo } from '../src/crypto/pqc.js';
import { PQCWallet } from '../src/wallet/pqcWallet.js';

// PQC 密钥长度常量 (ml_dsa44)
const DILITHIUM2_PUBLIC_KEY_LENGTH = 1312;
const DILITHIUM2_PRIVATE_KEY_LENGTH = 2560;
const DILITHIUM2_SIGNATURE_LENGTH = 2420;

test('Test 1: PQC info should report real implementation', () => {
  const info = getPQCInfo();
  assert.strictEqual(info.algorithm, 'Dilithium2');
  assert.strictEqual(info.library, '@noble/post-quantum');
  assert.strictEqual(info.publicKeyLength, DILITHIUM2_PUBLIC_KEY_LENGTH);
  assert.strictEqual(info.privateKeyLength, DILITHIUM2_PRIVATE_KEY_LENGTH);
  assert.strictEqual(info.signatureLength, DILITHIUM2_SIGNATURE_LENGTH);
  assert.strictEqual(info.nistStandard, 'FIPS 204');
  console.log('✅ PQC info correct:', info);
});

test('Test 2: Generate key pair with correct lengths', async () => {
  const keyPair = await generateKeyPair();
  
  assert.ok(keyPair.publicKey, 'Public key should exist');
  assert.ok(keyPair.privateKey, 'Private key should exist');
  assert.strictEqual(keyPair.publicKey.length, DILITHIUM2_PUBLIC_KEY_LENGTH, 
    `Public key should be ${DILITHIUM2_PUBLIC_KEY_LENGTH} bytes`);
  assert.strictEqual(keyPair.privateKey.length, DILITHIUM2_PRIVATE_KEY_LENGTH,
    `Private key should be ${DILITHIUM2_PRIVATE_KEY_LENGTH} bytes`);
  
  console.log('✅ Key pair generated with correct lengths');
});

test('Test 3: Sign and verify message', async () => {
  const keyPair = await generateKeyPair();
  const message = 'Hello NexusGenesis PQC!';
  
  // 签名
  const signature = await sign(message, keyPair.privateKey);
  assert.ok(signature, 'Signature should exist');
  assert.strictEqual(signature.length, DILITHIUM2_SIGNATURE_LENGTH,
    `Signature should be ${DILITHIUM2_SIGNATURE_LENGTH} bytes`);
  
  // 验证
  const isValid = await verify(message, signature, keyPair.publicKey);
  assert.strictEqual(isValid, true, 'Valid signature should verify');
  
  console.log('✅ Sign and verify working correctly');
});

test('Test 4: Reject tampered message', async () => {
  const keyPair = await generateKeyPair();
  const message = 'Original message';
  const tamperedMessage = 'Tampered message';
  
  const signature = await sign(message, keyPair.privateKey);
  
  // 使用篡改的Message验证应该Failed
  const isValid = await verify(tamperedMessage, signature, keyPair.publicKey);
  assert.strictEqual(isValid, false, 'Tampered message should not verify');
  
  console.log('✅ Tampered message correctly rejected');
});

test('Test 5: Reject wrong public key', async () => {
  const keyPair1 = await generateKeyPair();
  const keyPair2 = await generateKeyPair();
  const message = 'Test message';
  
  const signature = await sign(message, keyPair1.privateKey);
  
  // 使用错误的公钥验证应该Failed
  const isValid = await verify(message, signature, keyPair2.publicKey);
  assert.strictEqual(isValid, false, 'Wrong public key should not verify');
  
  console.log('✅ Wrong public key correctly rejected');
});

test('Test 6: PQCWallet integration', async () => {
  const wallet = await PQCWallet.generate(1000n);
  
  assert.ok(wallet.address, 'Wallet should have address');
  assert.ok(wallet.address.startsWith('ng'), 'Address should start with ng');
  assert.ok(wallet.publicKey, 'Wallet should have public key');
  assert.ok(wallet.privateKey, 'Wallet should have private key');
  assert.strictEqual(wallet.balance, 1000n, 'Balance should be 1000');
  
  console.log('✅ PQCWallet generated:', wallet.address);
});

test('Test 7: PQCWallet sign and verify transaction', async () => {
  const wallet = await PQCWallet.generate(1000n);
  
  const transaction = {
    from: wallet.address,
    to: 'ng1testrecipient000000000000000000000000',
    amount: '100',
    fee: '1',
    tx_type: 'TRANSFER',
    timestamp: Date.now(),
    nonce: '1'
  };
  
  // 签名交易
  const signature = await wallet.signTransaction(transaction);
  assert.ok(signature, 'Signature should exist');
  assert.strictEqual(signature.length, DILITHIUM2_SIGNATURE_LENGTH * 2,
    'Hex signature should be correct length');
  
  // 验证交易签名
  const isValid = await wallet.verifyTransaction(transaction, signature);
  assert.strictEqual(isValid, true, 'Transaction signature should be valid');
  
  console.log('✅ PQCWallet transaction sign/verify working');
});

test('Test 8: Reject invalid signature length', async () => {
  const keyPair = await generateKeyPair();
  const message = 'Test message';
  
  // 创建错误长度的签名
  const invalidSignature = Buffer.alloc(100);
  
  const isValid = await verify(message, invalidSignature, keyPair.publicKey);
  assert.strictEqual(isValid, false, 'Invalid signature length should be rejected');
  
  console.log('✅ Invalid signature length correctly rejected');
});

test('Test 9: Reject invalid public key length', async () => {
  const keyPair = await generateKeyPair();
  const message = 'Test message';
  const signature = await sign(message, keyPair.privateKey);
  
  // 创建错误长度的公钥
  const invalidPublicKey = Buffer.alloc(100);
  
  const isValid = await verify(message, signature, invalidPublicKey);
  assert.strictEqual(isValid, false, 'Invalid public key length should be rejected');
  
  console.log('✅ Invalid public key length correctly rejected');
});

test('Test 10: Hash function works correctly', () => {
  const data = 'test data';
  const hash1 = hash(data);
  const hash2 = hash(data);
  
  assert.strictEqual(hash1.length, 64, 'SHA3-256 should be 64 hex chars');
  assert.strictEqual(hash1, hash2, 'Same input should produce same hash');
  
  const hash3 = hash('different data');
  assert.notStrictEqual(hash1, hash3, 'Different input should produce different hash');
  
  console.log('✅ Hash function working correctly');
});

console.log('\n=== PQC Real Implementation Tests ===\n');

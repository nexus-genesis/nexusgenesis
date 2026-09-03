/**
 * NexusGenesis - PQC Wallet 测试
 * 覆盖：地址生成、格式校验、PQC 签名/验证、钱包Lifecycle
 */

import assert from 'assert';
import { test } from 'node:test';
import crypto from 'crypto';
import { generateAddress, validateAddress } from '../src/wallet/addressUtils.js';
import { base58Encode, base58Decode } from '../src/wallet/base58.js';
import { PQCWallet } from '../src/wallet/pqcWallet.js';
import { generateKeyPair, sign, verify } from '../src/crypto/pqc.js';

const DILITHIUM2_PUBLIC_KEY_LENGTH = 1312;
const DILITHIUM2_SIGNATURE_LENGTH = 2420;

test('Test 1: Base58 encoding/decoding round-trip', () => {
  const data = crypto.randomBytes(37);
  const encoded = base58Encode(data);
  const decoded = base58Decode(encoded);
  assert.ok(Buffer.from(decoded).equals(data), 'Decoded data should match original');
  assert.ok(typeof encoded === 'string', 'Encoded should be a string');
});

test('Test 2: Address prefix must be ng1', () => {
  const publicKey = crypto.randomBytes(DILITHIUM2_PUBLIC_KEY_LENGTH);
  const address = generateAddress(publicKey);
  assert.ok(address.startsWith('ng1'), `Address should start with ng1, got: ${address.slice(0, 3)}`);
});

test('Test 3: Address length should be ~53 characters', () => {
  const publicKey = crypto.randomBytes(DILITHIUM2_PUBLIC_KEY_LENGTH);
  const address = generateAddress(publicKey);
  assert.ok(address.length >= 50 && address.length <= 56,
    `Address length should be ~53, got ${address.length}`);
});

test('Test 4: Same public key produces same address (deterministic)', () => {
  const publicKey = crypto.randomBytes(DILITHIUM2_PUBLIC_KEY_LENGTH);
  const addr1 = generateAddress(publicKey);
  const addr2 = generateAddress(publicKey);
  assert.strictEqual(addr1, addr2, 'Same public key should produce same address');
});

test('Test 5: Different public keys produce different addresses', () => {
  const pk1 = crypto.randomBytes(DILITHIUM2_PUBLIC_KEY_LENGTH);
  const pk2 = crypto.randomBytes(DILITHIUM2_PUBLIC_KEY_LENGTH);
  const addr1 = generateAddress(pk1);
  const addr2 = generateAddress(pk2);
  assert.notStrictEqual(addr1, addr2, 'Different public keys should produce different addresses');
});

test('Test 6: validateAddress accepts valid address', () => {
  const publicKey = crypto.randomBytes(DILITHIUM2_PUBLIC_KEY_LENGTH);
  const address = generateAddress(publicKey);
  const result = validateAddress(address);
  assert.strictEqual(result.valid, true, `Valid address should pass: ${result.reason || ''}`);
});

test('Test 7: validateAddress rejects wrong prefix', () => {
  const publicKey = crypto.randomBytes(DILITHIUM2_PUBLIC_KEY_LENGTH);
  const address = generateAddress(publicKey);
  const badAddress = 'nx1' + address.slice(3);
  const result = validateAddress(badAddress);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('prefix'));
});

test('Test 8: validateAddress rejects non-string', () => {
  const result = validateAddress(null);
  assert.strictEqual(result.valid, false);
});

test('Test 9: validateAddress rejects empty string', () => {
  const result = validateAddress('');
  assert.strictEqual(result.valid, false);
});

test('Test 10: validateAddress rejects tampered checksum', () => {
  const publicKey = crypto.randomBytes(DILITHIUM2_PUBLIC_KEY_LENGTH);
  const address = generateAddress(publicKey);
  // 篡改最后一个字符来破坏校验和
  const lastChar = address[address.length - 1];
  const tamperedChar = lastChar === 'A' ? 'B' : 'A';
  const tampered = address.slice(0, -1) + tamperedChar;
  const result = validateAddress(tampered);
  assert.strictEqual(result.valid, false);
});

test('Test 11: Real Dilithium2 key pair produces valid address', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  assert.strictEqual(publicKey.length, DILITHIUM2_PUBLIC_KEY_LENGTH);
  assert.strictEqual(privateKey.length, 2560);

  const address = generateAddress(publicKey);
  assert.ok(address.startsWith('ng1'));
  
  const validation = validateAddress(address);
  assert.strictEqual(validation.valid, true);
});

test('Test 12: PQCWallet.generate creates wallet with valid address', async () => {
  const wallet = await PQCWallet.generate(100n);
  assert.ok(wallet.address.startsWith('ng1'));
  assert.strictEqual(wallet.balance, 100n);
  assert.strictEqual(wallet.publicKey.length, DILITHIUM2_PUBLIC_KEY_LENGTH);
  assert.strictEqual(wallet.privateKey.length, 2560);
  
  const validation = validateAddress(wallet.address);
  assert.strictEqual(validation.valid, true);
});

test('Test 13: PQCWallet sign and verify transaction', async () => {
  const wallet = await PQCWallet.generate(0n);
  const message = 'test-transaction-data';
  
  const signature = await wallet.sign(message);
  assert.strictEqual(typeof signature, 'string');
  assert.ok(signature.length > 100, `Signature should be long, got ${signature.length}`);
  
  const isValid = await wallet.verify(message, signature, wallet.publicKey);
  assert.strictEqual(isValid, true, 'Signature should verify against own public key');
});

test('Test 14: Wrong public key rejects signature', async () => {
  const wallet1 = await PQCWallet.generate(0n);
  const wallet2 = await PQCWallet.generate(0n);
  const message = 'test-data';
  
  const signature = await wallet1.sign(message);
  const isValid = await wallet1.verify(message, signature, wallet2.publicKey);
  assert.strictEqual(isValid, false, 'Wrong public key should reject signature');
});

test('Test 15: Tampered message rejects signature', async () => {
  const wallet = await PQCWallet.generate(0n);
  const message = 'original-message';
  const signature = await wallet.sign(message);
  
  const isValid = await wallet.verify('tampered-message', signature, wallet.publicKey);
  assert.strictEqual(isValid, false, 'Tampered message should be rejected');
});

test('Test 16: PQCWallet.secretKey alias works', async () => {
  const wallet = await PQCWallet.generate(0n);
  assert.ok(Buffer.isBuffer(wallet.secretKey));
  assert.strictEqual(wallet.secretKey.length, wallet.privateKey.length);
  assert.ok(wallet.secretKey.equals(wallet.privateKey));
});

test('Test 17: Multiple wallets have unique addresses', async () => {
  const wallet1 = await PQCWallet.generate(0n);
  const wallet2 = await PQCWallet.generate(0n);
  const wallet3 = await PQCWallet.generate(0n);
  
  const addrs = new Set([wallet1.address, wallet2.address, wallet3.address]);
  assert.strictEqual(addrs.size, 3, 'Each wallet should have unique address');
});

test('Test 18: Known Observer address format is valid', () => {
  const observerAddress = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';
  const result = validateAddress(observerAddress);
  assert.strictEqual(result.valid, true, `Observer address should be valid: ${result.reason || ''}`);
});

test('Test 19: Known Reserve DAO address format is valid', () => {
  const reserveAddress = 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ';
  const result = validateAddress(reserveAddress);
  assert.strictEqual(result.valid, true, `Reserve DAO address should be valid: ${result.reason || ''}`);
});

test('Test 20: Address validation rejects old-format address (ng9 prefix)', () => {
  const result = validateAddress('ng9someoldformataddress123456789');
  assert.strictEqual(result.valid, false, 'Old ng9 prefix addresses should be rejected');
});
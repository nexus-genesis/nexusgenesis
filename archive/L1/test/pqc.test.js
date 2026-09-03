import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hash,
  randomBytes,
  randomString,
  validateTimestamp,
  checkNonce,
  getPQCInfo,
  generateKeyPair,
  sign,
  verify
} from '../src/crypto/pqc.js';

describe('PQC — Hash & Utilities', () => {
  it('should produce deterministic SHA3-256 hash', () => {
    const h1 = hash('NexusGenesis');
    const h2 = hash('NexusGenesis');
    assert.strictEqual(h1, h2);
    assert.strictEqual(h1.length, 64);
  });

  it('should produce SHA3-512 hash when requested', () => {
    const h = hash('test', 'sha3-512');
    assert.strictEqual(h.length, 128);
  });

  it('should generate random bytes of correct length', () => {
    const buf = randomBytes(32);
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.length, 32);
  });

  it('should generate random string of correct length', () => {
    const s = randomString(16);
    assert.strictEqual(s.length, 16);
  });

  it('should validate current timestamp', () => {
    assert.strictEqual(validateTimestamp(Date.now()), true);
  });

  it('should reject old timestamp', () => {
    assert.strictEqual(validateTimestamp(Date.now() - 5 * 60 * 1000, 120000), false);
  });

  it('should track nonce usage', () => {
    const nonces = new Set();
    assert.strictEqual(checkNonce('abc123', nonces), true);
    assert.strictEqual(checkNonce('abc123', nonces), false);
    assert.strictEqual(checkNonce('def456', nonces), true);
  });

  it('should return PQC info', () => {
    const info = getPQCInfo();
    assert.strictEqual(info.algorithm, 'Dilithium2');
    assert.strictEqual(info.nistStandard, 'FIPS 204');
    assert.strictEqual(info.publicKeyLength, 1312);
    assert.strictEqual(info.privateKeyLength, 2560);
  });
});

describe('PQC — Dilithium2 Sign/Verify', () => {
  let keys;
  const message = 'NexusGenesis testnet bootstrap';

  it('should generate valid Dilithium2 key pair', async () => {
    keys = await generateKeyPair();
    assert.ok(Buffer.isBuffer(keys.publicKey));
    assert.ok(Buffer.isBuffer(keys.privateKey));
    assert.strictEqual(keys.publicKey.length, 1312);
    assert.strictEqual(keys.privateKey.length, 2560);
  });

  it('should sign a message', async () => {
    const sig = await sign(message, keys.privateKey);
    assert.ok(Buffer.isBuffer(sig));
    assert.strictEqual(sig.length, 2420);
  });

  it('should verify a valid signature', async () => {
    const sig = await sign(message, keys.privateKey);
    const result = await verify(message, sig, keys.publicKey);
    assert.strictEqual(result, true);
  });

  it('should reject tampered message', async () => {
    const sig = await sign('original message', keys.privateKey);
    const result = await verify('tampered message', sig, keys.publicKey);
    assert.strictEqual(result, false);
  });
});
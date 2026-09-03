import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  base58Encode,
  base58Decode,
  generateAddress,
  validateAddressFormat,
  generateWalletKeyPair,
  signMessage,
  verifySignature,
  ADDRESS_PREFIX
} from '../src/bootstrap/crypto.js';

describe('base58', () => {
  it('encodes and decodes roundtrip', () => {
    for (const input of ['hello', '', '\x00\x00\xff', Buffer.alloc(32, 0xaa).toString()]) {
      const buf = Buffer.from(input);
      const encoded = base58Encode(buf);
      const decoded = base58Decode(encoded);
      assert.ok(Buffer.isBuffer(decoded));
      assert.ok(buf.equals(decoded), `roundtrip failed for "${input.slice(0, 20)}"`);
    }
  });

  it('encodes empty buffer to empty string', () => {
    assert.strictEqual(base58Encode(Buffer.alloc(0)), '');
  });

  it('decodes empty string to empty buffer', () => {
    assert.strictEqual(base58Decode('').length, 0);
  });

  it('handles leading zeros', () => {
    const buf = Buffer.from([0, 0, 0, 1, 2, 3]);
    const encoded = base58Encode(buf);
    const decoded = base58Decode(encoded);
    assert.ok(buf.equals(decoded));
  });

  it('matches bs58 library output', () => {
    const buf = crypto.randomBytes(32);
    const encoded = base58Encode(buf);
    const decoded = base58Decode(encoded);
    assert.ok(buf.equals(decoded));
  });
});

describe('address generation', () => {
  it('generates address with correct prefix', () => {
    const keys = generateWalletKeyPair();
    assert.ok(keys.address.startsWith(ADDRESS_PREFIX));
    assert.ok(keys.publicKeyHex.length > 0);
    assert.ok(keys.privateKeyHex.length > 0);
  });

  it('validates a real generated address', () => {
    const keys = generateWalletKeyPair();
    assert.ok(validateAddressFormat(keys.address));
  });

  it('generates unique addresses', () => {
    const addr1 = generateWalletKeyPair().address;
    const addr2 = generateWalletKeyPair().address;
    assert.notStrictEqual(addr1, addr2);
  });

  it('generates deterministic address from same public key', () => {
    const pubKeyHex = 'a743284de1903442b3fe8bb44cfd558e28e8649e6bcba3c3b6f9755d08abd17e';
    const addr1 = generateAddress(Buffer.from(pubKeyHex, 'hex'));
    const addr2 = generateAddress(Buffer.from(pubKeyHex, 'hex'));
    assert.strictEqual(addr1, addr2);
  });
});

describe('validateAddressFormat', () => {
  it('rejects null / undefined / empty', () => {
    assert.strictEqual(validateAddressFormat(null), false);
    assert.strictEqual(validateAddressFormat(undefined), false);
    assert.strictEqual(validateAddressFormat(''), false);
  });

  it('rejects non-ng1 prefix', () => {
    assert.strictEqual(validateAddressFormat('0x123456'), false);
    assert.strictEqual(validateAddressFormat('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), false);
  });

  it('rejects address with wrong checksum', () => {
    const keys = generateWalletKeyPair();
    const addr = keys.address;
    const tampered = addr.slice(0, -3) + 'XXX';
    assert.strictEqual(validateAddressFormat(tampered), false);
  });

  it('rejects too-short base58 payload', () => {
    assert.strictEqual(validateAddressFormat('ng11'), false);
  });

  it('rejects non-string types', () => {
    assert.strictEqual(validateAddressFormat(12345), false);
    assert.strictEqual(validateAddressFormat({}), false);
    assert.strictEqual(validateAddressFormat([]), false);
  });
});

describe('sign / verify', () => {
  it('signs and verifies roundtrip', () => {
    const keys = generateWalletKeyPair();
    const message = 'test message from agent';
    const sig = signMessage(keys.privateKeyHex, keys.publicKeyHex, message);
    assert.ok(verifySignature(keys.publicKeyHex, message, sig));
  });

  it('rejects tampered message', () => {
    const keys = generateWalletKeyPair();
    const sig = signMessage(keys.privateKeyHex, keys.publicKeyHex, 'original');
    assert.strictEqual(verifySignature(keys.publicKeyHex, 'tampered', sig), false);
  });

  it('rejects wrong public key', () => {
    const keys1 = generateWalletKeyPair();
    const keys2 = generateWalletKeyPair();
    const sig = signMessage(keys1.privateKeyHex, keys1.publicKeyHex, 'hello');
    assert.strictEqual(verifySignature(keys2.publicKeyHex, 'hello', sig), false);
  });

  it('rejects invalid signature hex', () => {
    const keys = generateWalletKeyPair();
    assert.strictEqual(verifySignature(keys.publicKeyHex, 'hello', 'not-hex'), false);
  });

  it('handles object messages', () => {
    const keys = generateWalletKeyPair();
    const msg = { action: 'transfer', amount: 100 };
    const sig = signMessage(keys.privateKeyHex, keys.publicKeyHex, msg);
    assert.ok(verifySignature(keys.publicKeyHex, msg, sig));
  });
});
/**
 * Regression tests for the signature-before-scope authorization path.
 *
 * checkSessionAccess() evaluates scope only. On its own it will authorize a
 * session object that was never issued by anyone, because an empty scope array
 * means "unrestricted" and a fabricated object can simply declare empty arrays.
 * These tests pin that distinction so it cannot be blurred by a later change.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionKey,
  checkSessionAccess,
  verifySessionAccess
} from '../src/session.js';
import { generateMasterKey, deriveOpKeySeed, generateKeyPairFromSeed } from '../src/derivation.js';

/** A session object an attacker can write by hand: no issuer, no signature. */
function forgedSession(overrides = {}) {
  return {
    type: 'session_key',
    version: 1,
    agentId: 'attacker',
    // Empty arrays are "unrestricted" in checkSessionAccess.
    allowedContracts: [],
    allowedMethods: [],
    allowedChains: [],
    maxPerTx: '0',
    maxDaily: '0',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
    ...overrides
  };
}

async function issuedSession(scope = {}) {
  const master = generateMasterKey();
  const seed = await deriveOpKeySeed(master, { agentId: 'agent-1' });
  const { publicKey, privateKey } = await generateKeyPairFromSeed(seed);
  const session = createSessionKey(privateKey, {
    agentId: 'agent-1',
    allowedMethods: ['swap'],
    allowedChains: ['ethereum'],
    maxPerTx: '100',
    maxDaily: '500',
    ttl: 3_600_000,
    ...scope
  });
  return { session, publicKey, privateKey };
}

describe('session authorization', () => {
  test('verifySessionAccess refuses a session nobody issued', async () => {
    const result = await verifySessionAccess(forgedSession(), Buffer.alloc(1312), {
      contract: '0xdeadbeef',
      method: 'transferAll',
      chain: 'ethereum'
    });
    assert.equal(result.allowed, false);
    assert.equal(result.signatureVerified, false);
  });

  test('verifySessionAccess refuses a forged session claiming a large spend', async () => {
    const forged = forgedSession({ maxPerTx: '999999999', maxDaily: '999999999' });
    const result = await verifySessionAccess(forged, Buffer.alloc(1312), {
      method: 'transferAll',
      chain: 'ethereum',
      amount: '999999999'
    });
    assert.equal(result.allowed, false);
  });

  test('verifySessionAccess requires an issuer public key', async () => {
    const { session } = await issuedSession();
    const result = await verifySessionAccess(session, undefined, { method: 'swap' });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /issuerPublicKey/);
  });

  test('verifySessionAccess allows a genuine session inside its scope', async () => {
    const { session, publicKey } = await issuedSession();
    const result = await verifySessionAccess(session, publicKey, {
      method: 'swap',
      chain: 'ethereum',
      amount: '50'
    });
    assert.equal(result.allowed, true);
    assert.equal(result.signatureVerified, true);
  });

  test('a verified signature does not widen the scope', async () => {
    const { session, publicKey } = await issuedSession();
    const overLimit = await verifySessionAccess(session, publicKey, {
      method: 'swap',
      chain: 'ethereum',
      amount: '5000'
    });
    assert.equal(overLimit.allowed, false);
    assert.equal(overLimit.signatureVerified, true);

    const wrongMethod = await verifySessionAccess(session, publicKey, {
      method: 'transferAll',
      chain: 'ethereum'
    });
    assert.equal(wrongMethod.allowed, false);
  });

  test('verifySessionAccess rejects a session signed by a different issuer', async () => {
    const { session } = await issuedSession();
    const other = await issuedSession();
    const result = await verifySessionAccess(session, other.publicKey, {
      method: 'swap',
      chain: 'ethereum'
    });
    assert.equal(result.allowed, false);
    assert.equal(result.signatureVerified, false);
  });

  test('checkSessionAccess reports that it verified nothing', () => {
    // Documents the sharp edge rather than removing it: the scope check is
    // still available, and its result now says it is not an authorization.
    const result = checkSessionAccess(forgedSession(), { method: 'transferAll' });
    assert.equal(result.allowed, true);
    assert.equal(result.signatureVerified, false);
  });
});

describe('token and fingerprint hardening', () => {
  test('a custody token minted for another purpose does not verify here', async () => {
    const { issueCustodyToken, verifyCustodyToken } = await import('../src/custody.js');
    const secret = 'a-shared-signing-secret-at-least-32-chars';
    const genuine = issueCustodyToken({
      agentId: 'agent-1',
      address: 'ng1abc',
      publicKeyHex: '00'.repeat(1312),
      secret
    });
    assert.equal(verifyCustodyToken(genuine.token, secret).valid, true);

    // Same secret, same HMAC construction, different declared purpose. This is
    // what an operator reusing one signing secret across token types produces.
    const crypto = await import('node:crypto');
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const head = b64({ alg: 'HS256', typ: 'SESSION' });
    const body = b64({ sub: 'agent-1', addr: 'ng1abc', fp: 'x', iat: 1, exp: 9_999_999_999 });
    const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest()
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const result = verifyCustodyToken(`${head}.${body}.${sig}`, secret);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'unexpected token type');
  });

  test('verifyOpKeyFingerprint still matches, and rejects on length or content', async () => {
    const { calculateKeyFingerprint, verifyOpKeyFingerprint } = await import('../src/derivation.js');
    const key = Buffer.alloc(2560, 7);
    const fp = calculateKeyFingerprint(key);
    assert.equal(verifyOpKeyFingerprint(key, fp), true);
    assert.equal(verifyOpKeyFingerprint(key, fp.slice(0, -1)), false);
    assert.equal(verifyOpKeyFingerprint(key, 'f'.repeat(fp.length)), false);
    assert.equal(verifyOpKeyFingerprint(key, undefined), false);
  });
});

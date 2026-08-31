import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateKeyPair,
  sign,
  verify,
  hash,
  randomBytes,
  getPQCInfo,
  encryptPrivateKey,
  decryptPrivateKey,
  verifyPassword,
  isValidEnvelope,
  KEY_MODELS,
  deriveOpKeySeed,
  generateMasterKey,
  calculateKeyFingerprint,
  generateAddress,
  validateAddress,
  PQCWallet,
  Transaction,
  issueCustodyToken,
  verifyCustodyToken,
  publicKeyFingerprint,
  SPEND_MODES,
  checkSpendAllowed,
  takeoverGuard,
  takeoverWallet
} from '../src/index.js';

// ─── PQC ────────────────────────────────────────────────────────────────
test('generateKeyPair produces valid Dilithium2 key pair', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  assert.equal(privateKey.length, 2560);
  assert.equal(publicKey.length, 1312);
});

test('sign and verify round-trip', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const sig = Buffer.from(await sign('hello', privateKey));
  assert.equal(sig.length, 2420);
  assert.equal(await verify('hello', sig, publicKey), true);
  assert.equal(await verify('tampered', sig, publicKey), false);
});

test('hash and randomBytes are non-trivial', () => {
  assert.equal(hash('data').length, 64);
  assert.equal(randomBytes(16).length, 16);
});

test('getPQCInfo reports FIPS 204', () => {
  assert.equal(getPQCInfo().algorithm, 'ML-DSA-44');
  // The round-3 name stays available for consumers that matched on it.
  assert.equal(getPQCInfo().legacyName, 'Dilithium2');
  assert.equal(getPQCInfo().nistStandard, 'FIPS 204');
});

// ─── Encryption ─────────────────────────────────────────────────────────
test('encrypt/decrypt private key round-trip', () => {
  const { privateKey } = { privateKey: Buffer.from('a'.repeat(64), 'hex') };
  const envelope = encryptPrivateKey(privateKey, 'correct horse battery', { address: 'ng1xxx' });
  assert.equal(isValidEnvelope(envelope), true);
  const recovered = decryptPrivateKey(envelope, 'correct horse battery');
  assert.deepEqual(recovered, privateKey);
  assert.equal(verifyPassword(envelope, 'wrong password'), false);
});

test('AES-GCM rejects tampered ciphertext', () => {
  const privateKey = Buffer.from('b'.repeat(64), 'hex');
  const envelope = encryptPrivateKey(privateKey, 'password1234');
  envelope.ciphertext = envelope.ciphertext.slice(0, -2) + '00';
  assert.throws(() => decryptPrivateKey(envelope, 'password1234'));
});

// ─── Derivation ─────────────────────────────────────────────────────────
test('deriveOpKeySeed is deterministic per (agentId, version)', async () => {
  const master = generateMasterKey();
  const a1 = await deriveOpKeySeed(master, { agentId: 'agent-1', version: 1 });
  const a2 = await deriveOpKeySeed(master, { agentId: 'agent-1', version: 1 });
  const b = await deriveOpKeySeed(master, { agentId: 'agent-2', version: 1 });
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
});

test('KEY_MODELS exposes all three modes', () => {
  assert.deepEqual(KEY_MODELS, {
    HYBRID: 'hybrid',
    SELF_SOVEREIGN: 'self-sovereign',
    SERVER_MANAGED: 'server-managed'
  });
});

// ─── Address ────────────────────────────────────────────────────────────
test('generateAddress produces valid ng1 address', async () => {
  const { publicKey } = await generateKeyPair();
  const address = generateAddress(publicKey);
  assert.ok(address.startsWith('ng1'));
  assert.equal(validateAddress(address).valid, true);
  assert.equal(validateAddress('ng1broken').valid, false);
});

// ─── Wallet ─────────────────────────────────────────────────────────────
test('PQCWallet generate + sign/verify', async () => {
  const wallet = await PQCWallet.generate();
  assert.ok(wallet.address.startsWith('ng1'));
  const sig = await wallet.sign('payload');
  assert.equal(await wallet.verify('payload', sig), true);
});

test('PQCWallet encrypted export/import', async () => {
  const wallet = await PQCWallet.generate();
  const envelope = wallet.exportEncrypted('passphrase');
  const restored = PQCWallet.importEncrypted(envelope, 'passphrase');
  assert.equal(restored.address, wallet.address);
  const wrong = PQCWallet.importEncrypted(envelope, 'wrong');
  assert.equal(wrong, null);
});

test('Transaction create + sign + verify', async () => {
  const from = await PQCWallet.generate(1000n);
  const to = await PQCWallet.generate();
  const tx = Transaction.create(from, to.address, 100n, 1n);
  await tx.sign(from);
  assert.equal(await tx.verify(from), true);
});

// ─── Custody ────────────────────────────────────────────────────────────
test('custody token issue/verify with secret', async () => {
  const { publicKey } = await generateKeyPair();
  const pubHex = publicKey.toString('hex');
  const { token } = issueCustodyToken({ agentId: 'a1', address: 'ng1xxx', publicKeyHex: pubHex, secret: 's'.repeat(32) });
  const ok = verifyCustodyToken(token, 's'.repeat(32), { agentId: 'a1' });
  assert.equal(ok.valid, true);
  const bad = verifyCustodyToken(token, 'other-secret-'.repeat(4));
  assert.equal(bad.valid, false);
});

test('publicKeyFingerprint is stable', async () => {
  const { publicKey } = await generateKeyPair();
  const hex = publicKey.toString('hex');
  assert.equal(publicKeyFingerprint(hex), publicKeyFingerprint(hex));
});

// ─── Takeover ───────────────────────────────────────────────────────────
test('checkSpendAllowed enforces limits', () => {
  assert.equal(checkSpendAllowed({ type: 'unlimited' }, { amount: 1e9 }).allowed, true);
  assert.equal(checkSpendAllowed({ type: 'limit', maxPerTx: 100 }, { amount: 200 }).allowed, false);
  assert.equal(checkSpendAllowed({ type: 'require-approval' }, { amount: 1 }).requiresApproval, true);
});

test('takeoverGuard detects control change', () => {
  assert.equal(takeoverGuard({ type: 'unlimited' }, { type: 'unlimited' }), true);
  assert.equal(takeoverGuard({ type: 'unlimited' }, { type: 'require-approval' }), false);
});

test('takeoverWallet rotates to require-approval', async () => {
  const master = generateMasterKey();
  const { config, version } = await takeoverWallet(master, 'agent-1', 1);
  assert.equal(config.type, SPEND_MODES.REQUIRE_APPROVAL);
  assert.equal(version, 2);
});
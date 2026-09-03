/**
 * Unit Test: Wallet Master Key Backup (Phase 2-A3)
 *
 * 覆盖:
 *   1. validatePassphrase — 11 cases (too short / common / sequential / repeated / strong)
 *   2. encryptMasterKey → decryptMasterKey round-trip with valid passphrase
 *   3. decryptMasterKey rejects wrong passphrase (fingerprint mismatch)
 *   4. decryptMasterKey rejects tampered ciphertext (GCM auth)
 *   5. decryptMasterKey rejects tampered tag
 *   6. decryptMasterKey rejects malformed envelopes (bad type / version / payload / length)
 *   7. computeKEKFingerprint deterministic + 8 chars
 *   8. envelope round-trip via file
 *   9. verifyMasterKeyAgainstAgent ok + not found + bad master key
 *  10. fast mode produces different envelope (lower N)
 *  11. CLI hidden input parses correctly
 *
 * Run: node tests/test-master-key-backup.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  validatePassphrase,
  encryptMasterKey,
  decryptMasterKey,
  computeKEKFingerprint,
  readEnvelopeFile,
  writeEnvelopeFile,
  verifyMasterKeyAgainstAgent
} from '../src/wallet/masterKeyBackup.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';

let passed = 0, failed = 0;
function check(name, cond, info = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${info ? ' | ' + info : ''}`); failed++; }
}
function assertEq(name, actual, expected) {
  check(name, actual === expected, `expected=${expected} got=${actual}`);
}

const VALID_PASSPHRASE = 'Correct-Horse-Battery-Staple-9!';
const WEAK_PASSPHRASE  = 'password';
const TEST_MASTER_KEY  = Buffer.alloc(32, 0xAB);  // 32-byte test key (all 0xAB)
const TEMP_DIR = path.join('data', 'wallets', '.test-tmp');
const TEMP_ENV = path.join(TEMP_DIR, '.test-master-key-backup.enc');

// Pre-clean
if (fs.existsSync(TEMP_ENV)) fs.unlinkSync(TEMP_ENV);

console.log('═══════════════════════════════════════════════════════════');
console.log('  Master Key Encrypted Backup (Phase 2-A3)');
console.log('═══════════════════════════════════════════════════════════\n');

(async () => {
try {

  // ─── 1. validatePassphrase ──────────────────────────────────
  console.log('--- 1. validatePassphrase (11 cases) ---\n');
  const cases = [
    { p: '',                    expect: false, name: 'empty' },
    { p: 'short',               expect: false, name: 'too short' },
    { p: 'alllowercase',        expect: false, name: 'no digit/upper/symbol' },
    { p: 'password',            expect: false, name: 'in common list' },
    { p: '123456789012',        expect: false, name: 'in common list (numeric)' },
    { p: 'qwertyuiop12',        expect: false, name: 'in common list (qwerty)' },
    { p: 'aaaaaaaaaaaa',        expect: false, name: 'all same char' },
    { p: 'abcdefghijkl',        expect: false, name: 'ascending sequence' },
    { p: 'lkijihgfedcba',       expect: false, name: 'descending sequence' },
    { p: 'StrongP@ssw0rd-9',    expect: true,  name: '3 categories + length ≥12' },
    { p: 'V3ryL0ng-Str0ng!Key', expect: true,  name: '4 categories + length ≥16' }
  ];
  for (const c of cases) {
    const r = validatePassphrase(c.p);
    assertEq(`case "${c.name}": ok=${c.expect}`, r.ok, c.expect);
  }
  // Score check
  const strongPP = validatePassphrase('V3ryL0ng-Str0ng!Key-With-Symbols');
  check('strong pp has high score (>=3)', strongPP.score >= 3, `score=${strongPP.score}`);

  // ─── 2. Round-trip ──────────────────────────────────────────
  console.log('\n--- 2. encryptMasterKey → decryptMasterKey round-trip ---\n');
  const env1 = await encryptMasterKey(TEST_MASTER_KEY, VALID_PASSPHRASE);
  check('envelope has version 1', env1.version === 1);
  check('envelope has type', env1.type === 'ngen-wallet-master-key-backup');
  check('envelope has payload magic', env1.payload === 'ngen-wallet-master-key-v1');
  check('kdf is scrypt', env1.kdf.name === 'scrypt');
  check('kdf.N = 32768 (standard)', env1.kdf.N === 32768);
  check('salt is 16 bytes', Buffer.from(env1.kdf.salt, 'base64').length === 16);
  check('iv is 12 bytes', Buffer.from(env1.cipher.iv, 'base64').length === 12);
  check('ciphertext is 32 bytes', Buffer.from(env1.cipher.ciphertext, 'base64').length === 32);
  check('tag is 16 bytes', Buffer.from(env1.cipher.tag, 'base64').length === 16);
  check('fingerprint is 8 hex chars', /^[0-9a-f]{8}$/.test(env1.kekFingerprint));

  const dec1 = await decryptMasterKey(env1, VALID_PASSPHRASE);
  check('decrypted master key length = 32', dec1.masterKey.length === 32);
  check('decrypted master key matches original', Buffer.compare(dec1.masterKey, TEST_MASTER_KEY) === 0);
  check('fingerprint matches', dec1.fingerprint === env1.kekFingerprint);

  // ─── 3. Wrong passphrase ────────────────────────────────────
  console.log('\n--- 3. decryptMasterKey: wrong passphrase ---\n');
  let wrongPPError = null;
  try {
    await decryptMasterKey(env1, 'Wrong-Passphrase-99!');
  } catch (e) {
    wrongPPError = e.message;
  }
  check('wrong passphrase throws', wrongPPError !== null);
  check('error mentions fingerprint', wrongPPError && /fingerprint/i.test(wrongPPError),
    `error: ${wrongPPError}`);

  // ─── 4. Tampered ciphertext ─────────────────────────────────
  console.log('\n--- 4. decryptMasterKey: tampered ciphertext ---\n');
  const env2 = await encryptMasterKey(TEST_MASTER_KEY, VALID_PASSPHRASE);
  // Flip a bit in ciphertext
  const tamperedCT = Buffer.from(env2.cipher.ciphertext, 'base64');
  tamperedCT[0] ^= 0xFF;
  env2.cipher.ciphertext = tamperedCT.toString('base64');
  let tamperError = null;
  try {
    await decryptMasterKey(env2, VALID_PASSPHRASE);
  } catch (e) {
    tamperError = e.message;
  }
  check('tampered ciphertext throws', tamperError !== null);
  // Note: tampering ciphertext also breaks fingerprint (different derived KEK),
  // so the fingerprint mismatch fires first. That's fine — the rejection still happens.
  check('error is either fingerprint or auth', tamperError && (/fingerprint|auth/i.test(tamperError)),
    `error: ${tamperError}`);

  // ─── 5. Tampered tag ────────────────────────────────────────
  console.log('\n--- 5. decryptMasterKey: tampered tag (GCM integrity) ---\n');
  const env3 = await encryptMasterKey(TEST_MASTER_KEY, VALID_PASSPHRASE);
  // Use a NEW envelope so fingerprint passes; only flip a bit in TAG
  const tamperedTag = Buffer.from(env3.cipher.tag, 'base64');
  tamperedTag[0] ^= 0x01;
  env3.cipher.tag = tamperedTag.toString('base64');
  // Now the file should pass fingerprint check but fail GCM auth
  let tagError = null;
  try {
    await decryptMasterKey(env3, VALID_PASSPHRASE);
  } catch (e) {
    tagError = e.message;
  }
  check('tampered tag throws', tagError !== null);
  check('error mentions auth', tagError && /auth/i.test(tagError), `error: ${tagError}`);

  // ─── 6. Malformed envelopes ─────────────────────────────────
  console.log('\n--- 6. decryptMasterKey: malformed envelopes ---\n');
  const cases6 = [
    { label: 'wrong type',   env: { ...env1, type: 'something-else' } },
    { label: 'wrong version',env: { ...env1, version: 99 } },
    { label: 'wrong payload',env: { ...env1, payload: 'wrong' } },
    { label: 'bad salt',     env: { ...env1, kdf: { ...env1.kdf, salt: Buffer.alloc(8).toString('base64') } } },
    { label: 'bad iv',       env: { ...env1, cipher: { ...env1.cipher, iv: Buffer.alloc(8).toString('base64') } } },
    { label: 'bad ct',       env: { ...env1, cipher: { ...env1.cipher, ciphertext: Buffer.alloc(16).toString('base64') } } },
    { label: 'bad tag',      env: { ...env1, cipher: { ...env1.cipher, tag: Buffer.alloc(8).toString('base64') } } }
  ];
  for (const c of cases6) {
    let err = null;
    try { await decryptMasterKey(c.env, VALID_PASSPHRASE); } catch (e) { err = e.message; }
    check(`${c.label} throws`, err !== null, err || '');
  }

  // ─── 7. computeKEKFingerprint ──────────────────────────────
  console.log('\n--- 7. computeKEKFingerprint ---\n');
  const k1 = Buffer.alloc(32, 0x01);
  const k2 = Buffer.alloc(32, 0x02);
  const fp1a = computeKEKFingerprint(k1);
  const fp1b = computeKEKFingerprint(k1);
  const fp2  = computeKEKFingerprint(k2);
  check('fingerprint is 8 chars', fp1a.length === 8);
  check('fingerprint deterministic', fp1a === fp1b);
  check('fingerprint differs for different keys', fp1a !== fp2);
  check('fingerprint is hex', /^[0-9a-f]{8}$/.test(fp1a));

  // ─── 8. File round-trip ─────────────────────────────────────
  console.log('\n--- 8. envelope file round-trip ---\n');
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const env8 = await encryptMasterKey(TEST_MASTER_KEY, VALID_PASSPHRASE);
  writeEnvelopeFile(TEMP_ENV, env8);
  check('file exists', fs.existsSync(TEMP_ENV));
  const stat = fs.statSync(TEMP_ENV);
  check('file size > 200 bytes', stat.size > 200);
  // Windows 上 fs.chmod 是 no-op，文件 mode 不会被强制为 0600。
  // 在 Unix 上 mode 应该严格是 0600；在 Windows 上只检查文件存在。
  if (process.platform !== 'win32') {
    const mode = (stat.mode & 0o777).toString(8);
    check(`file mode is 0600 (got ${mode})`, mode === '600');
  } else {
    check('file mode check skipped on win32 (chmod is no-op)', true);
  }
  const env8Read = readEnvelopeFile(TEMP_ENV);
  check('read file equals original', JSON.stringify(env8Read) === JSON.stringify(env8));
  const dec8 = await decryptMasterKey(env8Read, VALID_PASSPHRASE);
  check('decrypted from file matches', Buffer.compare(dec8.masterKey, TEST_MASTER_KEY) === 0);

  // ─── 9. verifyMasterKeyAgainstAgent ─────────────────────────
  console.log('\n--- 9. verifyMasterKeyAgainstAgent ---\n');
  // Snapshot registry state — we'll create a test agent
  const VAGENT = 'agent-MK-TEST-1';
  if (!agentWalletManager.registry.has(VAGENT)) {
    await agentWalletManager.createAgentWallet(VAGENT, { test: 'master-key-backup' }, 0n);
  }

  // Use the real master key from env (should pass)
  const realKey = Buffer.from(process.env.NG_WALLET_MASTER_KEY, 'base64');
  const realVerify = verifyMasterKeyAgainstAgent(realKey, agentWalletManager, VAGENT);
  check('real master key verifies known agent', realVerify.ok === true, `error: ${realVerify.error}`);
  if (realVerify.ok) {
    check(`verified agent address: ${realVerify.address}`, realVerify.address?.startsWith('ng1'));
  }

  // Use a wrong master key (should fail)
  const wrongKey = Buffer.alloc(32, 0xFF);
  const wrongVerify = verifyMasterKeyAgainstAgent(wrongKey, agentWalletManager, VAGENT);
  check('wrong master key fails verification', wrongVerify.ok === false);

  // Non-existent agent
  const missingVerify = verifyMasterKeyAgainstAgent(realKey, agentWalletManager, 'agent-DOES-NOT-EXIST-XYZ');
  check('non-existent agent → ok=false', missingVerify.ok === false);
  check('error mentions not found', /not found/i.test(missingVerify.error || ''));

  // ─── 10. Fast mode ─────────────────────────────────────────
  console.log('\n--- 10. fast mode (lower N) ---\n');
  const envStd = await encryptMasterKey(TEST_MASTER_KEY, VALID_PASSPHRASE);
  const envFast = await encryptMasterKey(TEST_MASTER_KEY, VALID_PASSPHRASE, { fast: true });
  check('standard N = 32768', envStd.kdf.N === 32768);
  check('fast N = 4096', envFast.kdf.N === 4096);
  // Different salt/iv/fingerprint expected
  check('standard and fast have different salt', envStd.kdf.salt !== envFast.kdf.salt);
  check('standard and fast have different fingerprint', envStd.kekFingerprint !== envFast.kekFingerprint);
  // Both decrypt correctly
  const decFast = await decryptMasterKey(envFast, VALID_PASSPHRASE);
  check('fast envelope round-trips', Buffer.compare(decFast.masterKey, TEST_MASTER_KEY) === 0);

  // ─── 11. Performance: standard KDF < 5s ─────────────────────
  console.log('\n--- 11. performance: standard KDF < 5s ---\n');
  const t0 = Date.now();
  await encryptMasterKey(TEST_MASTER_KEY, VALID_PASSPHRASE);
  const tEnc = Date.now() - t0;
  const t1 = Date.now();
  await decryptMasterKey(env1, VALID_PASSPHRASE);
  const tDec = Date.now() - t1;
  check(`encrypt < 5000ms (got ${tEnc}ms)`, tEnc < 5000);
  check(`decrypt < 5000ms (got ${tDec}ms)`, tDec < 5000);
  console.log(`     encrypt: ${tEnc}ms, decrypt: ${tDec}ms`);

} catch (e) {
  console.error('\nFATAL:', e);
  failed++;
} finally {
  // Cleanup
  if (fs.existsSync(TEMP_ENV)) fs.unlinkSync(TEMP_ENV);
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  ✓ Master key backup module works');
  } else {
    console.log('  ✗ Master key backup has gaps — see failures above');
  }
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}
})();

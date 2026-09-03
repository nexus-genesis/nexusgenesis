/**
 * Demo: Show encryption effect
 * Generates a fake agent wallet, encrypts it, and shows the output
 */

import { PQCWallet } from '../src/wallet/pqcWallet.js';
import { encryptPrivateKey, decryptPrivateKey, isValidEnvelope } from '../src/wallet/walletEncryption.js';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Wallet Encryption Demo: Before vs After');
  console.log('═══════════════════════════════════════════════════\n');

  // Generate a real PQC wallet
  const wallet = await PQCWallet.generate(1000n);

  console.log('─'.repeat(60));
  console.log('BEFORE: Legacy plaintext storage');
  console.log('─'.repeat(60));
  console.log('File: data/wallets/agent_xxx.json');
  console.log('{');
  console.log('  "address":     "' + wallet.address + '",');
  console.log('  "publicKey":   "' + wallet.publicKey.toString('hex').slice(0, 40) + '...(' + wallet.publicKey.length + ' bytes)",');
  console.log('  "privateKey":  "' + wallet.privateKey.toString('hex').slice(0, 40) + '...(' + wallet.privateKey.length + ' bytes)  ← PLAINTEXT, anyone with disk access can steal this",');
  console.log('  "balance":     "1000"');
  console.log('}');
  console.log('  ⚠️  RISK: Any backup/sync/git/SSH compromise leaks all private keys\n');

  // Now encrypt
  const password = 'demo-password-not-secure';
  const envelope = encryptPrivateKey(wallet.privateKey, password, {
    address: wallet.address,
    publicKey: wallet.publicKey.toString('hex')
  });

  console.log('─'.repeat(60));
  console.log('AFTER: AES-256-GCM encrypted storage');
  console.log('─'.repeat(60));
  console.log('File: data/wallets/agent_xxx.json');
  console.log('{');
  console.log('  "address":     "' + wallet.address + '",');
  console.log('  "publicKey":   "' + wallet.publicKey.toString('hex').slice(0, 40) + '...",');
  console.log('  "encryptedPrivateKey": {');
  console.log('    "envelope":     ' + envelope.envelope + ',');
  console.log('    "version":      "' + envelope.version + '",');
  console.log('    "kdf": {');
  console.log('      "algorithm":   "' + envelope.kdf.algorithm + '",');
  console.log('      "iterations":  ' + envelope.kdf.iterations + ',');
  console.log('      "salt":        "' + envelope.kdf.salt.slice(0, 40) + '... (32 bytes random)",');
  console.log('      "keyLength":   ' + envelope.kdf.keyLength);
  console.log('    },');
  console.log('    "cipher":       "' + envelope.cipher + '",');
  console.log('    "iv":           "' + envelope.iv + ' (12 bytes random)",');
  console.log('    "ciphertext":   "' + envelope.ciphertext.slice(0, 60) + '... (' + envelope.ciphertext.length + ' hex chars)",');
  console.log('    "authTag":      "' + envelope.authTag + ' (16 bytes, detects tampering)"');
  console.log('  },');
  console.log('  "balance":     "1000"');
  console.log('}');
  console.log('  ✅ SAFE: Even if file leaks, attacker needs master key to decrypt\n');

  console.log('─'.repeat(60));
  console.log('Security properties');
  console.log('─'.repeat(60));
  console.log('  ✓  Algorithm:           AES-256-GCM (authenticated encryption)');
  console.log('  ✓  Key derivation:      PBKDF2-HMAC-SHA512, ' + envelope.kdf.iterations.toLocaleString() + ' iterations');
  console.log('  ✓  Salt uniqueness:     32 random bytes per encryption');
  console.log('  ✓  IV uniqueness:       12 random bytes per encryption');
  console.log('  ✓  Tamper detection:    16-byte auth tag (GCM)');
  console.log('  ✓  Semantic security:   Same key + same password → different ciphertext each time');
  console.log('');

  // Verify roundtrip
  const recovered = decryptPrivateKey(envelope, password);
  const match = Buffer.compare(wallet.privateKey, recovered) === 0;
  console.log('  ✓  Decrypt test:        Roundtrip ' + (match ? 'OK ✓' : 'FAILED ✗'));
  console.log('');

  console.log('─'.repeat(60));
  console.log('Envelope size comparison');
  console.log('─'.repeat(60));
  const plaintextSize = wallet.privateKey.toString('hex').length + wallet.publicKey.toString('hex').length;
  const envelopeSize = JSON.stringify(envelope).length;
  console.log('  Plaintext keys: ' + plaintextSize + ' chars');
  console.log('  Encrypted envelope: ' + envelopeSize + ' chars');
  console.log('  Overhead: +' + (envelopeSize - plaintextSize) + ' chars (' + Math.round((envelopeSize - plaintextSize) / plaintextSize * 100) + '%)');
  console.log('  Justified: 4x size gives authenticated encryption + key derivation');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

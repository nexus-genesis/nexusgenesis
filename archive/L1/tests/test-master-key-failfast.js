// Test: NG_WALLET_MASTER_KEY fail-fast behavior (Phase 2 production hardening)
//
// Each scenario runs in a fresh child process so the module-level
// singleton is re-initialized cleanly. We just dynamically import the
// full module — this is slow (~37s for the real 176-wallet registry)
// but exercises the actual production code path end-to-end.
//
// Scenarios:
//   1. production + missing env var    → throw FATAL
//   2. production + invalid base64     → throw FATAL
//   3. production + wrong length       → throw FATAL
//   4. production + valid env var      → load from env (success)
//   5. mainnet + missing env var       → throw FATAL (same as production)
//   6. dev + missing env var           → fall back (warn, no throw)
//   7. dev + valid env var             → load from env

import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const VALID_KEY = 'ZkwtU4HCN7eb1LlsVDfZI1ZS3DlxCHdfafJJqZVDksQ='; // 32 bytes / 44 b64
const SHORT_KEY = 'aGVsbG8='; // 5 bytes
const GARBAGE   = '!!!not-base64!!!';

let passed = 0, failed = 0;
function check(name, cond, info = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${info ? ' | ' + info : ''}`); failed++; }
}

function runScenario(label, env, expectThrow, expectLogContains) {
  const tmpFile = path.join(os.tmpdir(), `ng-failfast-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  const targetFile = pathToFileURL(
    path.join(projectRoot, 'src', 'wallet', 'agentWalletManager.js')
  ).href;

  // Minimal driver: just import the module and report whether the
  // constructor threw. The full 176-wallet registry load happens
  // synchronously in the constructor; if it succeeds, masterKey is set.
  const driver = `
const targetFile = ${JSON.stringify(targetFile)};
(async () => {
  try {
    const mod = await import(targetFile);
    const w = mod.default || mod.agentWalletManager;
    if (!w) { console.log('NO_DEFAULT_EXPORT'); process.exit(0); }
    if (!w.masterKey) { console.log('NO_MASTER_KEY'); process.exit(0); }
    console.log('LOADED_OK length=' + w.masterKey.length);
    process.exit(0);
  } catch (e) {
    console.log('THROWN: ' + e.message);
    process.exit(e.message.includes('FATAL') ? 42 : 1);
  }
})();
`;
  fs.writeFileSync(tmpFile, driver);

  try {
    const result = spawnSync(process.execPath, [tmpFile], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      // 60s timeout: the real registry load takes ~37s on this machine.
      timeout: 60000
    });

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const code = result.status;
    const threw = code === 42 || stdout.includes('THROWN') || stderr.includes('THROWN');
    const loaded = stdout.includes('LOADED_OK');
    const actual = threw ? 'throw' : (loaded ? 'load' : 'other');
    const expected = expectThrow ? 'throw' : 'load';
    const logMatch = !expectLogContains || stdout.includes(expectLogContains) || stderr.includes(expectLogContains);

    check(`${label}: expected=${expected} got=${actual} exit=${code}`,
      actual === expected && logMatch,
      `stdout=${stdout.slice(0, 250).replace(/\n/g, ' | ')} stderr=${stderr.slice(0, 250).replace(/\n/g, ' | ')}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  NG_WALLET_MASTER_KEY fail-fast (Phase 2 production)');
  console.log('  NOTE: load scenarios take ~37s each (176-wallet registry)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // ─── Production scenarios ───────────────────────────────────────
  console.log('--- Production (NODE_ENV=production) ---\n');

  runScenario(
    '1. production + NO env var  → expect throw',
    { NODE_ENV: 'production', NG_WALLET_MASTER_KEY: '' },
    true, 'FATAL'
  );

  runScenario(
    '2. production + invalid base64 → expect throw',
    { NODE_ENV: 'production', NG_WALLET_MASTER_KEY: GARBAGE },
    true, 'FATAL'
  );

  runScenario(
    '3. production + wrong length (5 bytes) → expect throw',
    { NODE_ENV: 'production', NG_WALLET_MASTER_KEY: SHORT_KEY },
    true, 'wrong length'
  );

  runScenario(
    '4. production + valid 32-byte env var → expect load',
    { NODE_ENV: 'production', NG_WALLET_MASTER_KEY: VALID_KEY },
    false, 'LOADED_OK'
  );

  // ─── Mainnet (treated same as production) ──────────────────────
  console.log('\n--- Mainnet (NODE_ENV=mainnet) ---\n');

  runScenario(
    '5. mainnet + NO env var → expect throw (same as production)',
    { NODE_ENV: 'mainnet', NG_WALLET_MASTER_KEY: '' },
    true, 'FATAL'
  );

  // ─── Dev (must still work — no regression) ─────────────────────
  console.log('\n--- Dev (NODE_ENV=development) — regression check ---\n');

  runScenario(
    '6. dev + NO env var → expect load (warn + fall back to file/generate)',
    { NODE_ENV: 'development', NG_WALLET_MASTER_KEY: '' },
    false, 'LOADED_OK'
  );

  runScenario(
    '7. dev + valid env var → expect load from env',
    { NODE_ENV: 'development', NG_WALLET_MASTER_KEY: VALID_KEY },
    false, 'LOADED_OK'
  );

  // ─── Summary ────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  ✓ fail-fast works in production, dev behavior preserved');
  } else {
    console.log('  ✗ fail-fast has gaps — see failures above');
  }
  console.log('═══════════════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
})();

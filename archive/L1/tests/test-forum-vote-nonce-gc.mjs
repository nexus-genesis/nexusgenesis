/**
 * Test script: forum vote nonce cleanup (GC) logic validation.
 *
 * Validates the fix that usedVoteNonces was changed from Set to Map and
 * entries get evicted after VOTE_SIGNATURE_TIMEOUT_MS * 2.
 *
 * Strategy:
 *   1. Extract the REAL constants (timeout + interval) from forum.js source
 *      so the test always stays in sync with production code.
 *   2. Mirror the exact cleanup algorithm that forum.js uses in the module
 *      top-level setInterval — run it deterministically with a virtual
 *      timestamp (no sleep, ~instant), injecting entries with "age" in the
 *      past and future.
 *   3. Exercise the 4 meaningful scenarios: fresh nonce stays, young
 *      (between 1x and 2x timeout) stays, expired (>2x timeout) is
 *      removed, anti-replay reject on identical nonce re-use.
 *   4. Simulate a 10,000 vote load with expiry to confirm no memory leak.
 *
 * Run:  node tests/test-forum-vote-nonce-gc.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORUM_PATH = path.resolve(__dirname, '../src/http/routes/forum.js');

let passed = 0;
let failed = 0;
const failDetails = [];

function assert(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    failDetails.push(`${name}  ${detail}`);
    console.log(`  FAIL: ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ─── Step 1: Parse the REAL constants from forum.js source ───────────────
section('1. Extract constants from forum.js source');

const forumSrc = fs.readFileSync(FORUM_PATH, 'utf8');

// Parse VOTE_SIGNATURE_TIMEOUT_MS: must be a number literal * 1000 form or raw
const timeoutMatch = forumSrc.match(/const\s+VOTE_SIGNATURE_TIMEOUT_MS\s*=\s*([^;]+);/);
if (!timeoutMatch) {
  console.log('  FAIL: cannot parse VOTE_SIGNATURE_TIMEOUT_MS from forum.js');
  process.exit(1);
}
const VOTE_SIGNATURE_TIMEOUT_MS = eval(timeoutMatch[1]);
console.log(`  VOTE_SIGNATURE_TIMEOUT_MS = ${VOTE_SIGNATURE_TIMEOUT_MS}ms` +
    ` (${(VOTE_SIGNATURE_TIMEOUT_MS / 1000)}s)`);
assert('timeout is a positive integer',
    Number.isInteger(VOTE_SIGNATURE_TIMEOUT_MS) && VOTE_SIGNATURE_TIMEOUT_MS > 0,
    `got ${VOTE_SIGNATURE_TIMEOUT_MS}`);

// EVICT_THRESHOLD = VOTE_SIGNATURE_TIMEOUT_MS * 2  (as written in forum.js)
const EVICT_THRESHOLD_MS = VOTE_SIGNATURE_TIMEOUT_MS * 2;
console.log(`  EVICT_THRESHOLD_MS (2x timeout) = ${EVICT_THRESHOLD_MS}ms` +
    ` (${(EVICT_THRESHOLD_MS / 1000)}s)`);

// Confirm the forum.js uses Map (not Set) and the correct loop pattern
assert('forum.js declares usedVoteNonces as new Map()',
    /const\s+usedVoteNonces\s*=\s*new\s+Map\s*\(\s*\)/.test(forumSrc),
    'expected: new Map()');
assert('forum.js cleanup uses [key, ts] destructuring over entries',
    /for\s*\(\s*const\s*\[\s*key\s*,\s*ts\s*\]\s+of\s+usedVoteNonces\s*\)/.test(forumSrc),
    'expected: for (const [key, ts] of usedVoteNonces)');
assert('forum.js stores timestamp via .set(nonceKey, Date.now())',
    /usedVoteNonces\.set\s*\(\s*nonceKey\s*,\s*Date\.now\s*\(\s*\)\s*\)/.test(forumSrc),
    'expected: usedVoteNonces.set(nonceKey, Date.now())');
assert('forum.js evict condition: now - ts > 2 * timeout',
    /if\s*\(\s*now\s*-\s*ts\s*>\s*VOTE_SIGNATURE_TIMEOUT_MS\s*\*\s*2\s*\)/.test(forumSrc),
    'expected: now - ts > VOTE_SIGNATURE_TIMEOUT_MS * 2');

// ─── Step 2: Mirror the exact cleanup algorithm ───────────────────────────
section('2. Mirror cleanup algorithm');

/**
 * Exact replica of forum.js's module-level setInterval cleanup body.
 * @param {Map<string, number>} store
 * @param {number} virtualNow - the "current" timestamp (ms)
 * @param {number} thresholdMs - threshold for eviction (VOTE_SIGNATURE_TIMEOUT_MS * 2)
 */
function runCleanupPass(store, virtualNow, thresholdMs) {
  for (const [key, ts] of store) {
    if (virtualNow - ts > thresholdMs) {
      store.delete(key);
    }
  }
}

// Mirror the write path: add nonce -> store.set(key, Date.now())
function recordNonce(store, key, ts) {
  store.set(key, ts);
}

// Mirror the read path: anti-replay check
function hasNonce(store, key) {
  return store.has(key);
}

// ─── Step 3: Scenario tests ───────────────────────────────────────────────
section('3. Scenario: age classification');

{
  const store = new Map();
  const T0 = 1_700_000_000_000;
  const NOW = T0;

  // Case A: just added (age 0ms) — never evict
  recordNonce(store, 'agentA:n_1', NOW);
  // Case B: age = timeout - 1ms (younger than 1x timeout) — stay
  recordNonce(store, 'agentB:n_2', NOW - VOTE_SIGNATURE_TIMEOUT_MS + 1);
  // Case C: age = 1.5x timeout (between 1x and 2x) — still protected, stay
  recordNonce(store, 'agentC:n_3', NOW - Math.floor(EVICT_THRESHOLD_MS * 0.75));
  // Case D: age = 2x timeout exactly — still stay (strict >, not >=)
  recordNonce(store, 'agentD:n_4', NOW - EVICT_THRESHOLD_MS);
  // Case E: age = 2x timeout + 1ms — expired, must be evicted
  recordNonce(store, 'agentE:n_5', NOW - EVICT_THRESHOLD_MS - 1);
  // Case F: age = 10x timeout — deeply expired, must be evicted
  recordNonce(store, 'agentF:n_6', NOW - EVICT_THRESHOLD_MS * 10);

  assert('store has 6 entries before cleanup', store.size === 6, `size=${store.size}`);

  runCleanupPass(store, NOW, EVICT_THRESHOLD_MS);

  assert('fresh nonce (case A) preserved', hasNonce(store, 'agentA:n_1'));
  assert('1x timeout -1ms (case B) preserved', hasNonce(store, 'agentB:n_2'));
  assert('1.5x timeout (case C) preserved', hasNonce(store, 'agentC:n_3'));
  assert('EXACT 2x timeout boundary (case D) preserved', hasNonce(store, 'agentD:n_4'),
      'strict > in condition keeps the boundary case');
  assert('2x timeout +1ms (case E) EVICTED', !hasNonce(store, 'agentE:n_5'));
  assert('10x timeout (case F) EVICTED', !hasNonce(store, 'agentF:n_6'));
  assert('exactly 2 entries removed after cleanup', store.size === 4, `size=${store.size}`);
}

section('4. Scenario: anti-replay check and re-accept after eviction');
{
  const store = new Map();
  let virtualNow = 1_800_000_000_000;

  // First vote attempt with nonce N1 — should accept
  const KEY = 'swarm-atlas-1782045381627-0:n1';
  if (hasNonce(store, KEY)) {
    assert('first attempt blocked', false);
  } else {
    assert('first attempt passes anti-replay check', true);
    recordNonce(store, KEY, virtualNow);
  }

  // Immediate re-use of same nonce with same agent — MUST be rejected
  assert('immediate re-use blocked', hasNonce(store, KEY), 'nonce in store after record');

  // Advance by 1x timeout — still protected, replay still blocked
  virtualNow += VOTE_SIGNATURE_TIMEOUT_MS;
  runCleanupPass(store, virtualNow, EVICT_THRESHOLD_MS);
  assert('replay blocked after 1x timeout', hasNonce(store, KEY),
      `nonce must survive until ${EVICT_THRESHOLD_MS}ms`);

  // Advance past 2x threshold — nonce should be evicted
  virtualNow += VOTE_SIGNATURE_TIMEOUT_MS + 1;
  runCleanupPass(store, virtualNow, EVICT_THRESHOLD_MS);
  assert('nonce evicted after 2x timeout elapsed', !hasNonce(store, KEY),
      'old entry cleaned up so future reuse (by chance) is allowed');
  assert('store is empty after full eviction cycle', store.size === 0,
      `size=${store.size}`);
}

section('5. Scenario: incremental cleanup — only expired entries removed');
{
  const store = new Map();
  const NOW = 1_900_000_000_000;

  // 1000 entries: 50% old (>2x timeout) vs 50% fresh
  for (let i = 0; i < 1000; i++) {
    const key = `agent${i}:n${i}`;
    const ts = i < 500
      ? NOW - EVICT_THRESHOLD_MS - Math.random() * 1e6   // old — evict
      : NOW - Math.random() * EVICT_THRESHOLD_MS;       // young — keep
    recordNonce(store, key, ts);
  }

  assert('store seeded with 1000 entries', store.size === 1000, `size=${store.size}`);
  runCleanupPass(store, NOW, EVICT_THRESHOLD_MS);
  assert('exactly 500 old entries evicted, 500 young entries remain',
      store.size === 500, `size=${store.size} (expected 500)`);

  // Advance time so the other 500 entries also become old
  const future = NOW + EVICT_THRESHOLD_MS + 1;
  runCleanupPass(store, future, EVICT_THRESHOLD_MS);
  assert('store empty after second pass in the future',
      store.size === 0, `size=${store.size}`);
}

section('6. Scenario: no memory leak under steady load (smoke)');
{
  const store = new Map();
  let virtualNow = 2_000_000_000_000;
  const ITERATIONS = 50;
  const VOTES_PER_BATCH = 200;
  const TIME_ADVANCE = VOTE_SIGNATURE_TIMEOUT_MS + 1000; // advance ~timeout each batch

  for (let round = 0; round < ITERATIONS; round++) {
    // Add VOTES_PER_BATCH new votes
    for (let v = 0; v < VOTES_PER_BATCH; v++) {
      recordNonce(store,
          `agent${round * VOTES_PER_BATCH + v}:n${round * VOTES_PER_BATCH + v}`,
          virtualNow + v);
    }
    // Advance virtual time past the eviction threshold
    virtualNow += TIME_ADVANCE;
    // Run cleanup
    runCleanupPass(store, virtualNow, EVICT_THRESHOLD_MS);
  }

  // After all rounds advancing past eviction each iteration, store size
  // should remain bounded to at most one full batch (votes added at the
  // end of a round are still within 2x timeout).
  assert('store bounded (<= 1 batch) after 50 rounds of load',
      store.size <= VOTES_PER_BATCH,
      `size=${store.size} (bounded by ${VOTES_PER_BATCH})`);

  const peakUnbounded = ITERATIONS * VOTES_PER_BATCH;
  console.log(`  bounded size = ${store.size} vs unbounded worst-case = ${peakUnbounded}` +
      ` (factor ${(peakUnbounded / Math.max(1, store.size)).toFixed(1)}× reduction)`);
  assert('peak-in-simulation bounded (<<10000 leaked entries)',
      store.size < 10000,
      `size=${store.size}`);
}

section('7. Regression: Set-based old implementation would leak');
{
  // Verify the OLD (broken) pattern fails: Set of strings + read
  // `.timestamp` property — that's what was in forum.js before the fix.
  const buggyStore = new Set();
  buggyStore.add('agent:nonce');
  let evicted = 0;
  const now = Date.now();
  for (const nonce of buggyStore) {
    if (now - nonce.timestamp > EVICT_THRESHOLD_MS) { // nonce is string, no .timestamp
      buggyStore.delete(nonce);
      evicted++;
    }
  }
  assert('OLD Set-based buggy pattern never evicts entries (leak confirmed)',
      evicted === 0 && buggyStore.size === 1,
      `evicted=${evicted} size=${buggyStore.size}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════`);
console.log(` Result:  PASS ${passed}   FAIL ${failed}`);
console.log(`═══════════════════════════════════════════`);

if (failDetails.length) {
  console.log(`\nFailures:`);
  for (const f of failDetails) console.log(`  - ${f}`);
}

process.exit(failed === 0 ? 0 : 1);

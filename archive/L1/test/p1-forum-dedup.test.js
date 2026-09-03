#!/usr/bin/env node
/**
 * P1-2 论坛去重逻辑测试
 * 模拟 swarm agent 的 shouldSkipDuplicate() 行为和重复发帖场景
 *
 * 运行: node test/p1-forum-dedup.test.js
 */

// ─── 从 agent-worker-v2.js 提取的去重逻辑（精确复制） ───
const _postedTopics = new Map(); // title -> timestamp
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
let skippedCount = 0;
let allowedCount = 0;

function shouldSkipDuplicate(title) {
  const now = Date.now();
  // Clean expired entries
  for (const [t, ts] of _postedTopics) {
    if (now - ts > DEDUP_TTL_MS) _postedTopics.delete(t);
  }
  if (_postedTopics.has(title)) {
    skippedCount++;
    return true;
  }
  _postedTopics.set(title, now);
  allowedCount++;
  return false;
}

// ─── 测试场景 ───

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║   P1-2: Forum Dedup Test — shouldSkipDuplicate()        ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log('');

// Helper: reset the global dedup map between scenarios
function resetDedup() {
  _postedTopics.clear();
  skippedCount = 0;
  allowedCount = 0;
}

// ─── Scenario 1: 首次发帖应通过 ───
resetDedup();
console.log('[Scenario 1] First post should pass');
const title1 = '[TOPIC] Dilithium signature sizes are eating block space';
assert(!shouldSkipDuplicate(title1), 'First post allowed');
assert(shouldSkipDuplicate(title1), 'Duplicate title blocked (returns true = skip)');
assert(shouldSkipDuplicate(title1), 'Duplicate blocked again (returns true = skip)');
console.log('');

// ─── Scenario 2: 不同标题可以发布 ───
resetDedup();
console.log('[Scenario 2] Different titles should all pass');
assert(!shouldSkipDuplicate('Agent key rotation: how often is too often?'), 'Different title 1 allowed');
assert(!shouldSkipDuplicate('Handling task submission races'), 'Different title 2 allowed');
assert(!shouldSkipDuplicate('Validator liveness signals'), 'Different title 3 allowed');
console.log('');

// ─── Scenario 3: 模拟 swarm 循环重复发帖 ───
resetDedup();
console.log('[Scenario 3] Simulate 10 swarm cycles with same PERSONA_TOPICS');
const PERSONA_TOPICS = {
  default: [
    { title: 'Dilithium signature sizes are eating block space' },
    { title: 'Agent key rotation: how often is too often?' },
    { title: 'Handling task submission races' },
    { title: 'Validator liveness signals' },
    { title: 'Task market concentration' }
  ]
};

// Simulate 10 cycles of swarm agent posting
const totalPosts = 10 * 5; // 10 cycles × 5 topics
let actualPosts = 0;
for (let cycle = 0; cycle < 10; cycle++) {
  for (const t of PERSONA_TOPICS.default) {
    if (!shouldSkipDuplicate(t.title)) {
      actualPosts++;
    }
  }
}
console.log(`  10 cycles × 5 topics = ${totalPosts} total attempts`);
console.log(`  Actual posts: ${actualPosts}`);
console.log(`  Skipped: ${totalPosts - actualPosts}`);
assert(actualPosts === 5, 'Only 5 unique topics posted (first cycle)');
assert(totalPosts - actualPosts === 45, '45 duplicates blocked');
console.log('');

// ─── Scenario 4: 模拟 selfDiagnose 告警 ───
resetDedup();
console.log('[Scenario 4] Simulate selfDiagnose ALERT posts');
const alertTitle = '[ALERT] Agent agent_07 cannot reach API';
assert(!shouldSkipDuplicate(alertTitle), 'First ALERT posted');
assert(shouldSkipDuplicate(alertTitle), 'Duplicate ALERT blocked');
assert(shouldSkipDuplicate(alertTitle), 'Duplicate ALERT blocked again');

// Different agent, different alert = should pass
const alertTitle2 = '[ALERT] Agent agent_12 cannot reach API';
assert(!shouldSkipDuplicate(alertTitle2), 'Different agent ALERT allowed');
assert(shouldSkipDuplicate(alertTitle2), 'Duplicate different-agent ALERT blocked');
console.log('');

// ─── Scenario 5: TTL 过期后应重新允许 ───
console.log('[Scenario 5] TTL expiry — expired posts should be allowed again');
const expiredTopics = new Map();
expiredTopics.set('Old topic', Date.now() - DEDUP_TTL_MS - 1000); // expired
expiredTopics.set('Recent topic', Date.now());

// Simulate the TTL cleanup in shouldSkipDuplicate
const now = Date.now();
for (const [t, ts] of expiredTopics) {
  if (now - ts > DEDUP_TTL_MS) expiredTopics.delete(t);
}
assert(!expiredTopics.has('Old topic'), 'Expired topic removed from map');
assert(expiredTopics.has('Recent topic'), 'Recent topic still in map');
console.log('');

// ─── Scenario 6: 边界条件测试 ───
resetDedup();
console.log('[Scenario 6] Edge cases');
assert(!shouldSkipDuplicate(''), 'Empty string title allowed');
assert(shouldSkipDuplicate(''), 'Empty string duplicate blocked');
assert(!shouldSkipDuplicate('  '), 'Whitespace-only title allowed (different from empty)');
assert(!shouldSkipDuplicate('Case sensitive TITLE'), 'Case sensitive title allowed');
assert(shouldSkipDuplicate('Case sensitive TITLE'), 'Case sensitive duplicate blocked');
assert(!shouldSkipDuplicate('case sensitive title'), 'Different case counted as different title');
console.log('');

// ─── 统计 ───
console.log('╔══════════════════════════════════════════════════════════╗');
console.log(`║   Results: ${passed} passed, ${failed} failed                              ║`);
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`  Total dedup stats: ${allowedCount} allowed, ${skippedCount} skipped`);

if (failed > 0) {
  console.log('');
  console.log('⚠  Some tests FAILED — check output above.');
  process.exit(1);
} else {
  console.log('');
  console.log('✓ All P1-2 dedup tests PASSED.');
}
import { RateLimiter } from '../src/http/rateLimiter.js';

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name} ${detail}`);
  }
}

function mockReq(method, path, originalUrl) {
  return { method, path, originalUrl, ip: '127.0.0.1', headers: {} };
}

console.log('=== Test 1: new_agent tier default limit ===');
{
  const rl = new RateLimiter();
  let lastResult;
  for (let i = 0; i < 30; i++) {
    lastResult = rl._checkIpLimit('1.2.3.4', '/some/post', Date.now(),
      mockReq('POST', '/some/post', '/api/v1/some/post'), '/api/v1/some/post');
  }
  assert('30th request allowed (new_agent limit = 30)', lastResult.allowed === true,
    `allowed=${lastResult.allowed}, remaining=${lastResult.remaining}`);

  const r31 = rl._checkIpLimit('1.2.3.4', '/some/post', Date.now(),
    mockReq('POST', '/some/post', '/api/v1/some/post'), '/api/v1/some/post');
  assert('31st request blocked', r31.allowed === false, `allowed=${r31.allowed}`);
  assert('block reason is IP rate limit', r31.reason === 'IP rate limit exceeded');
}

console.log('\n=== Test 2: permissive wallet GET does not consume agent tier quota ===');
{
  const rl = new RateLimiter();

  // Send 25 POST (non-permissive) — should leave 5 in agent tier
  for (let i = 0; i < 25; i++) {
    rl._checkIpLimit('5.6.7.8', '/transfer', Date.now(),
      mockReq('POST', '/agent/transfer', '/api/v1/wallet/agent/transfer'),
      '/api/v1/wallet/agent/transfer');
  }

  // Send 100 permissive GET requests
  let lastPermissive;
  for (let i = 0; i < 100; i++) {
    lastPermissive = rl._checkIpLimit('5.6.7.8', '/agent/abc/history', Date.now(),
      mockReq('GET', '/agent/abc/history', '/api/v1/wallet/agent/abc/history'),
      '/api/v1/wallet/agent/abc/history');
  }
  assert('100th permissive GET allowed', lastPermissive.allowed === true,
    `allowed=${lastPermissive.allowed}, remaining=${lastPermissive.remaining}`);

  // Send 5 more POST (25 + 5 = 30 = limit)
  let lastPost;
  for (let i = 0; i < 5; i++) {
    lastPost = rl._checkIpLimit('5.6.7.8', '/transfer', Date.now(),
      mockReq('POST', '/agent/transfer', '/api/v1/wallet/agent/transfer'),
      '/api/v1/wallet/agent/transfer');
  }
  assert('30th POST allowed (agent tier not consumed by permissive)',
    lastPost.allowed === true, `allowed=${lastPost.allowed}`);

  // 31st POST should fail
  const r31 = rl._checkIpLimit('5.6.7.8', '/transfer', Date.now(),
    mockReq('POST', '/agent/transfer', '/api/v1/wallet/agent/transfer'),
    '/api/v1/wallet/agent/transfer');
  assert('31st POST blocked (agent tier exhausted)', r31.allowed === false);

  // But permissive GET still works
  const stillPermissive = rl._checkIpLimit('5.6.7.8', '/agent/abc/history', Date.now(),
    mockReq('GET', '/agent/abc/history', '/api/v1/wallet/agent/abc/history'),
    '/api/v1/wallet/agent/abc/history');
  assert('permissive GET still works after agent tier exhausted',
    stillPermissive.allowed === true, `allowed=${stillPermissive.allowed}`);
}

console.log('\n=== Test 3: permissive cap at ipMax (600) ===');
{
  const rl = new RateLimiter();
  let last;
  for (let i = 0; i < 600; i++) {
    last = rl._checkIpLimit('9.9.9.9', '/agent/x/history', Date.now(),
      mockReq('GET', '/agent/x/history', '/api/v1/wallet/agent/x/history'),
      '/api/v1/wallet/agent/x/history');
  }
  assert('600th permissive GET allowed', last.allowed === true);

  const r601 = rl._checkIpLimit('9.9.9.9', '/agent/x/history', Date.now(),
    mockReq('GET', '/agent/x/history', '/api/v1/wallet/agent/x/history'),
    '/api/v1/wallet/agent/x/history');
  assert('601st permissive GET blocked', r601.allowed === false);
}

console.log('\n=== Test 4: POST to wallet is NOT permissive ===');
{
  const rl = new RateLimiter();
  let last;
  for (let i = 0; i < 30; i++) {
    last = rl._checkIpLimit('4.4.4.4', '/agent/transfer', Date.now(),
      mockReq('POST', '/agent/transfer', '/api/v1/wallet/agent/transfer'),
      '/api/v1/wallet/agent/transfer');
  }
  assert('30th POST transfer allowed (at new_agent limit)', last.allowed === true);

  const r31 = rl._checkIpLimit('4.4.4.4', '/agent/transfer', Date.now(),
    mockReq('POST', '/agent/transfer', '/api/v1/wallet/agent/transfer'),
    '/api/v1/wallet/agent/transfer');
  assert('31st POST transfer blocked', r31.allowed === false);
}

console.log('\n=== Test 5: getStats includes permissive count ===');
{
  const rl = new RateLimiter();
  // 3 normal
  for (let i = 0; i < 3; i++) {
    rl._checkIpLimit('8.8.8.8', '/x', Date.now(),
      mockReq('POST', '/x', '/api/v1/x'), '/api/v1/x');
  }
  // 7 permissive
  for (let i = 0; i < 7; i++) {
    rl._checkIpLimit('8.8.8.8', '/agent/y/history', Date.now(),
      mockReq('GET', '/agent/y/history', '/api/v1/wallet/agent/y/history'),
      '/api/v1/wallet/agent/y/history');
  }
  const stats = rl.getStats();
  assert('totalRequests = 10 (3 + 7)', stats.totalRequests === 10, `got ${stats.totalRequests}`);
  assert('activeIPs = 1', stats.activeIPs === 1);
}

console.log(`\n═══════════════════════════════`);
console.log(`  Result: ${passed} passed, ${failed} failed`);
console.log(`═══════════════════════════════`);

process.exit(failed > 0 ? 1 : 0);

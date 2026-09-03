import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

import RateLimiter from '../src/http/rateLimiter.js';
import transactionHistoryRoutes from '../src/http/routes/transactionHistory.js';
import bridgeRoutes from '../src/http/routes/bridge.js';

const app = express();
app.use(express.json());

const mockState = {
  agents: {},
  transactions: { txHistory: [] },
  balances: {},
  tasks: new Map()
};

app.locals.state = mockState;

const rateLimiter = new RateLimiter();
app.use(rateLimiter.middleware());

app.use('/api/v1/transactions', transactionHistoryRoutes);
app.use(bridgeRoutes);

const PORT = 19897;
const server = app.listen(PORT, () => {
  console.log(`[Test] Server running on port ${PORT}`);
});

const baseUrl = `http://localhost:${PORT}`;

async function makeRequest(method, path, headers = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { method, headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}

let pass = 0, fail = 0;
function assert(desc, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${desc}`);
  } else {
    fail++;
    console.log(`  ❌ ${desc}  ${detail}`);
  }
}

async function runTests() {
  console.log('\n=== Test 1: Transactions API - cache & permissive path ===');
  {
    const agentId = 'test-agent-tx-' + crypto.randomUUID().slice(0, 8);

    const r1 = await makeRequest('GET', `/api/v1/transactions/agent/${agentId}`);
    assert('First request returns 200', r1.status === 200, `status=${r1.status}`);
    assert('First request is MISS', r1.headers['x-cache'] === 'MISS',
      `x-cache=${r1.headers['x-cache']}`);

    const r2 = await makeRequest('GET', `/api/v1/transactions/agent/${agentId}`);
    assert('Second request returns 200', r2.status === 200);
    assert('Second request is HIT', r2.headers['x-cache'] === 'HIT',
      `x-cache=${r2.headers['x-cache']}`);
  }

  console.log('\n=== Test 2: Bridge API - cache & permissive path ===');
  {
    const r1 = await makeRequest('GET', '/api/v1/bridge/chains');
    assert('chains first request 200', r1.status === 200);
    assert('chains first request MISS', r1.headers['x-cache'] === 'MISS',
      `x-cache=${r1.headers['x-cache']}`);

    const r2 = await makeRequest('GET', '/api/v1/bridge/chains');
    assert('chains second request HIT', r2.headers['x-cache'] === 'HIT',
      `x-cache=${r2.headers['x-cache']}`);

    const r3 = await makeRequest('GET', '/api/v1/bridge/fees');
    assert('fees request 200', r3.status === 200);
    assert('fees request has x-cache header', 'x-cache' in r3.headers);

    const r4 = await makeRequest('GET', '/api/v1/bridge/transfers');
    assert('transfers request 200', r4.status === 200);
  }

  console.log('\n=== Test 3: Permissive path - 60 requests no 429 ===');
  {
    const agentId = 'stress-' + crypto.randomUUID().slice(0, 8);
    const headers = { 'x-agent-identity': agentId };

    const promises = [];
    for (let i = 0; i < 60; i++) {
      promises.push(makeRequest('GET', `/api/v1/transactions?offset=${i}`, headers));
    }
    const results = await Promise.all(promises);
    const statuses = results.map(r => r.status);
    const count429 = statuses.filter(s => s === 429).length;
    const count200 = statuses.filter(s => s === 200).length;

    assert(`60 transactions GET requests: 0 429`, count429 === 0,
      `429=${count429}, 200=${count200}`);
    assert(`most succeed (>=58/60)`, count200 >= 58, `200=${count200}`);
  }

  console.log('\n=== Test 4: Bridge chains - 60 requests no 429 ===');
  {
    const headers = { 'x-agent-identity': 'stress-bridge-' + crypto.randomUUID().slice(0, 6) };

    const promises = [];
    for (let i = 0; i < 60; i++) {
      promises.push(makeRequest('GET', '/api/v1/bridge/chains', headers));
    }
    const results = await Promise.all(promises);
    const count429 = results.filter(r => r.status === 429).length;
    const count200 = results.filter(r => r.status === 200).length;

    assert(`60 bridge/chains GET requests: 0 429`, count429 === 0,
      `429=${count429}, 200=${count200}`);
  }

  console.log('\n=== Test 5: POST still counted (not permissive) ===');
  {
    const headers = {
      'x-agent-identity': 'post-test-' + crypto.randomUUID().slice(0, 6),
      'Content-Type': 'application/json'
    };

    const body = JSON.stringify({ fromChain: 'ethereum', toChain: 'bsc', amount: '100' });

    const results = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/api/v1/bridge/lock`, {
        method: 'POST', headers, body
      });
      results.push(res.status);
    }

    const count429 = results.filter(s => s === 429).length;
    assert(`5 POST requests mostly succeed (<3 429)`, count429 < 3,
      `429=${count429}, statuses=${results.join(',')}`);
    console.log(`  (POST statuses: ${results.join(', ')})`);
  }

  console.log(`\n========================================`);
  console.log(`  Results: ${pass} passed, ${fail} failed`);
  console.log(`========================================\n`);

  server.close();
  process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test error:', err);
  server.close();
  process.exit(1);
});

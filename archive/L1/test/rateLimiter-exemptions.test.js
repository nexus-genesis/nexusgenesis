import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RateLimiter } from '../src/http/rateLimiter.js';

function createMockResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

describe('HTTP rate limiter exemptions', () => {
  it('bypasses rate limiting for bootstrap status', () => {
    const limiter = new RateLimiter();
    const middleware = limiter.middleware();
    const req = {
      ip: '127.0.0.1',
      path: '/api/v1/bootstrap/status',
      headers: {},
      query: {}
    };
    const res = createMockResponse();
    let nextCalled = false;

    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(limiter.ipRecords.has(req.ip), false);
    limiter.destroy();
  });

  it('bypasses rate limiting for validator join', () => {
    const limiter = new RateLimiter();
    const middleware = limiter.middleware();
    const req = {
      ip: '127.0.0.2',
      path: '/api/v1/bootstrap/validators/join',
      headers: {},
      query: {}
    };
    const res = createMockResponse();
    let nextCalled = false;

    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(limiter.ipRecords.has(req.ip), false);
    limiter.destroy();
  });

  it('still rate limits non-exempt bootstrap endpoints', () => {
    const limiter = new RateLimiter({ ipMax: 1, agentLimits: { new_agent: 1 } });
    const middleware = limiter.middleware();
    const req = {
      ip: '127.0.0.3',
      path: '/api/v1/bootstrap/agents/register',
      headers: {},
      query: {}
    };
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    let nextCalls = 0;

    middleware(req, res1, () => {
      nextCalls++;
    });
    middleware(req, res2, () => {
      nextCalls++;
    });

    assert.strictEqual(nextCalls, 1);
    assert.strictEqual(res2.statusCode, 429);
    assert.strictEqual(limiter.totalBlocked, 1);
    limiter.destroy();
  });
});

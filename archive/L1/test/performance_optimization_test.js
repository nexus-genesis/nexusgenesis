/**
 * NexusGenesis - 性能优化测试脚本
 * 验证系统性能优化效果
 */

import http from 'http';
import rateLimiter from '../src/utils/rateLimiter.js';
import cache from '../src/utils/cache.js';

// 测试配置
const TEST_CONFIG = {
  apiBaseUrl: 'http://localhost:19891',
  testDuration: 60000, // 测试持续时间（毫秒）
  concurrentRequests: 10, // 并发请求数
  requestInterval: 100 // 请求间隔（毫秒）
};

// 测试结果
const testResults = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  rateLimitErrors: 0,
  averageResponseTime: 0,
  responseTimes: [],
  cacheStats: {
    hits: 0,
    misses: 0,
    hitRate: 0
  },
  rateLimitStats: {
    totalChecks: 0,
    triggeredLimits: 0
  }
};

/**
 * 发送HTTP请求
 * @param {string} path API路径
 * @param {object} data 请求数据
 * @returns {Promise<object>} 响应结果
 */
async function sendRequest(path, data = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 19891,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const startTime = Date.now();
    const req = http.request(options, (res) => {
      const endTime = Date.now();
      const responseTime = endTime - startTime;
      testResults.responseTimes.push(responseTime);

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        testResults.totalRequests++;
        if (res.statusCode === 200) {
          testResults.successfulRequests++;
          resolve({ success: true, data: JSON.parse(data), responseTime });
        } else if (res.statusCode === 429) {
          testResults.failedRequests++;
          testResults.rateLimitErrors++;
          resolve({ success: false, error: 'Rate limit exceeded', responseTime });
        } else {
          testResults.failedRequests++;
          resolve({ success: false, error: `HTTP ${res.statusCode}`, responseTime });
        }
      });
    });

    req.on('error', (error) => {
      const endTime = Date.now();
      const responseTime = endTime - startTime;
      testResults.responseTimes.push(responseTime);
      testResults.totalRequests++;
      testResults.failedRequests++;
      resolve({ success: false, error: error.message, responseTime });
    });

    if (Object.keys(data).length > 0) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

/**
 * 测试agent注册
 */
async function testAgentRegistration() {
  console.log('Start 测试agent注册...');
  
  const agentId = `test-agent-${Date.now()}`;
  const response = await sendRequest('/api/agents/register', {
    agent_id: agentId,
    model: 'gpt-4o',
    capabilities: ['LLM', 'NEXUSGENESIS_DEV', 'BLOCKCHAIN']
  });
  
  console.log(`agent注册测试结果: ${response.success ? '成功' : 'Failed'} (响应时间: ${response.responseTime}ms)`);
  return response;
}

/**
 * 测试getagent列表
 */
async function testGetAgents() {
  console.log('Start 测试getagent列表...');
  
  const response = await sendRequest('/api/agents');
  
  console.log(`getagent列表测试结果: ${response.success ? '成功' : 'Failed'} (响应时间: ${response.responseTime}ms)`);
  return response;
}

/**
 * 测试Health check
 */
async function testHealthCheck() {
  console.log('Start 测试Health check...');
  
  const response = await sendRequest('/api/health');
  
  console.log(`Health check测试结果: ${response.success ? '成功' : 'Failed'} (响应时间: ${response.responseTime}ms)`);
  return response;
}

/**
 * 测试速率限制
 */
async function testRateLimit() {
  console.log('Start 测试速率限制...');
  
  const agentId = `rate-limit-test-${Date.now()}`;
  let rateLimitTriggered = 0;
  
  // 发送多个请求，测试速率限制
  for (let i = 0; i < 15; i++) {
    const result = rateLimiter.checkEndpointLimit('/register', agentId, 0);
    testResults.rateLimitStats.totalChecks++;
    if (result.isLimited) {
      rateLimitTriggered++;
      testResults.rateLimitStats.triggeredLimits++;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`速率限制测试结果: 触发次数 ${rateLimitTriggered}`);
  return rateLimitTriggered;
}

/**
 * 测试缓存性能
 */
async function testCachePerformance() {
  console.log('Start 测试缓存性能...');
  
  // 预热缓存
  const warmupData = {
    'agents:list': [{ id: 'agent1', name: 'Test Agent' }],
    'health:status': { status: 'online' },
    'network:info': { name: 'NexusGenesis', version: '1.0.0' }
  };
  cache.prewarm(warmupData);
  
  // 测试Cache hit rate
  let hits = 0;
  let misses = 0;
  
  for (let i = 0; i < 100; i++) {
    const key = i % 2 === 0 ? 'agents:list' : `test:key:${i}`;
    const value = cache.get(key);
    if (value) {
      hits++;
    } else {
      misses++;
    }
  }
  
  const hitRate = (hits / (hits + misses) * 100).toFixed(2);
  testResults.cacheStats.hits = hits;
  testResults.cacheStats.misses = misses;
  testResults.cacheStats.hitRate = parseFloat(hitRate);
  
  console.log(`缓存性能测试结果: 命中率 ${hitRate}% (${hits} 命中, ${misses} 未命中)`);
  return { hits, misses, hitRate };
}

/**
 * 运行性能测试
 */
async function runPerformanceTest() {
  console.log('====================================');
  console.log('NexusGenesis 性能优化测试');
  console.log('====================================');
  
  // 测试速率限制
  await testRateLimit();
  
  // 测试缓存性能
  await testCachePerformance();
  
  // 并发测试
  console.log('\nStart 并发请求测试...');
  const startTime = Date.now();
  
  const testFunctions = [
    testAgentRegistration,
    testGetAgents,
    testHealthCheck
  ];
  
  let testCount = 0;
  const testInterval = setInterval(async () => {
    if (Date.now() - startTime > TEST_CONFIG.testDuration) {
      clearInterval(testInterval);
      return;
    }
    
    // 并发执行测试
    for (let i = 0; i < TEST_CONFIG.concurrentRequests; i++) {
      const testFunction = testFunctions[Math.floor(Math.random() * testFunctions.length)];
      testFunction().catch(console.error);
    }
    
    testCount++;
  }, TEST_CONFIG.requestInterval);
  
  // 等待测试完成
  await new Promise(resolve => {
    setTimeout(() => {
      clearInterval(testInterval);
      resolve();
    }, TEST_CONFIG.testDuration + 1000);
  });
  
  // 计算Average响应时间
  if (testResults.responseTimes.length > 0) {
    const totalResponseTime = testResults.responseTimes.reduce((sum, time) => sum + time, 0);
    testResults.averageResponseTime = totalResponseTime / testResults.responseTimes.length;
  }
  
  // 输出测试结果
  console.log('\n====================================');
  console.log('性能测试结果');
  console.log('====================================');
  console.log(`总请求数: ${testResults.totalRequests}`);
  console.log(`成功请求数: ${testResults.successfulRequests}`);
  console.log(`Failed请求数: ${testResults.failedRequests}`);
  console.log(`速率限制错误: ${testResults.rateLimitErrors}`);
  console.log(`Average响应时间: ${testResults.averageResponseTime.toFixed(2)}ms`);
  console.log('\n缓存统计:');
  console.log(`Cache hit: ${testResults.cacheStats.hits}`);
  console.log(`缓存未命中: ${testResults.cacheStats.misses}`);
  console.log(`Cache hit rate: ${testResults.cacheStats.hitRate.toFixed(2)}%`);
  console.log('\n速率限制统计:');
  console.log(`总检查次数: ${testResults.rateLimitStats.totalChecks}`);
  console.log(`触发限制次数: ${testResults.rateLimitStats.triggeredLimits}`);
  console.log('====================================');
  
  // 保存测试结果
  const fs = await import('fs/promises');
  const path = await import('path');
  const resultsPath = path.join('test', 'performance_results.json');
  await fs.writeFile(resultsPath, JSON.stringify(testResults, null, 2));
  console.log(`测试结果Saved到 ${resultsPath}`);
  
  return testResults;
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runPerformanceTest().catch(console.error);
}

export default runPerformanceTest;
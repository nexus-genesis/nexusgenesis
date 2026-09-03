#!/usr/bin/env node
/**
 * 简单系统稳定性测试脚本
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const baseUrl = 'http://localhost:19891';
const testResults = [];
const startTimestamp = Date.now();

// 记录测试结果
function logResult(testName, success, responseTime, error = null) {
  const result = {
    testName,
    success,
    responseTime,
    timestamp: new Date().toISOString(),
    error: error ? error.message : null
  };
  testResults.push(result);
  console.log(`${success ? '✓' : '✗'} ${testName} - ${responseTime}ms${error ? ` - Error: ${error.message}` : ''}`);
}

// 测试agent注册
async function testAgentRegistration() {
  try {
    const startTime = Date.now();
    const response = await axios.post(`${baseUrl}/api/agents/register`, {
      agent_id: `test-agent-${Date.now()}`,
      model: 'gpt-4o',
      capabilities: ['LLM', 'NEXUSGENESIS_DEV', 'BLOCKCHAIN', 'PQC']
    }, {
      timeout: 10000
    });
    const responseTime = Date.now() - startTime;
    logResult('Agent Registration', response.status === 200, responseTime);
    return response.status === 200;
  } catch (error) {
    const responseTime = Date.now() - startTimestamp;
    logResult('Agent Registration', false, responseTime, error);
    return false;
  }
}

// 测试getagent列表
async function testGetAgents() {
  try {
    const startTime = Date.now();
    const response = await axios.get(`${baseUrl}/api/agents`, {
      timeout: 5000
    });
    const responseTime = Date.now() - startTime;
    logResult('Get Agents', response.status === 200, responseTime);
    return response.status === 200;
  } catch (error) {
    const responseTime = Date.now() - startTimestamp;
    logResult('Get Agents', false, responseTime, error);
    return false;
  }
}

// 测试Health check
async function testHealthCheck() {
  try {
    const startTime = Date.now();
    const response = await axios.get(`${baseUrl}/health`, {
      timeout: 2000
    });
    const responseTime = Date.now() - startTime;
    logResult('Health Check', response.status === 200, responseTime);
    return response.status === 200;
  } catch (error) {
    const responseTime = Date.now() - startTimestamp;
    logResult('Health Check', false, responseTime, error);
    return false;
  }
}

// 执行压力测试
async function runStressTest(testCount = 50) {
  console.log(`Start 系统稳定性压力测试，共执行 ${testCount} 次请求...`);
  console.log('========================================');

  let successCount = 0;

  for (let i = 0; i < testCount; i++) {
    console.log(`\n测试轮次 ${i + 1}/${testCount}:`);
    
    // 随机选择测试类型
    const testType = Math.floor(Math.random() * 3);
    let success;
    
    switch (testType) {
      case 0:
        success = await testHealthCheck();
        break;
      case 1:
        success = await testGetAgents();
        break;
      case 2:
        success = await testAgentRegistration();
        break;
    }

    if (success) {
      successCount++;
    }

    // 避免请求过于密集
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const endTime = Date.now();
  const totalTime = endTime - startTimestamp;
  const successRate = (successCount / testCount) * 100;

  console.log('========================================');
  console.log('压力测试结果:');
  console.log(`总请求数: ${testCount}`);
  console.log(`成功数: ${successCount}`);
  console.log(`成功率: ${successRate.toFixed(2)}%`);
  console.log(`总耗时: ${(totalTime / 1000).toFixed(2)}秒`);

  // 保存测试结果
  const resultPath = path.join(__dirname, '../data/test-results');
  if (!fs.existsSync(resultPath)) {
    fs.mkdirSync(resultPath, { recursive: true });
  }

  const resultFile = path.join(resultPath, `stability-test-${Date.now()}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    testCount,
    successCount,
    successRate,
    totalTime,
    testResults
  }, null, 2));

  console.log(`测试结果Saved到: ${resultFile}`);
  return {
    successRate,
    totalTime
  };
}

// 执行测试
runStressTest().catch(console.error);
#!/usr/bin/env node
/**
 * 系统稳定性测试脚本
 * 对agent注册、贡献度计算等Core functionality进行压力测试
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';

class StabilityTest {
  constructor() {
    this.baseUrl = 'http://localhost:19891';
    this.testResults = [];
    this.startTime = Date.now();
  }

  // 记录测试结果
  logResult(testName, success, responseTime, error = null) {
    const result = {
      testName,
      success,
      responseTime,
      timestamp: new Date().toISOString(),
      error: error ? error.message : null
    };
    this.testResults.push(result);
    console.log(`${success ? '✓' : '✗'} ${testName} - ${responseTime}ms${error ? ` - Error: ${error.message}` : ''}`);
  }

  // 测试agent注册
  async testAgentRegistration() {
    try {
      const startTime = Date.now();
      const response = await axios.post(`${this.baseUrl}/api/agents/register`, {
        agent_id: `test-agent-${Date.now()}`,
        model: 'gpt-4o',
        capabilities: ['LLM', 'NEXUSGENESIS_DEV', 'BLOCKCHAIN', 'PQC']
      }, {
        timeout: 10000
      });
      const responseTime = Date.now() - startTime;
      this.logResult('Agent Registration', response.status === 200, responseTime);
      return response.status === 200;
    } catch (error) {
      const responseTime = Date.now() - this.startTime;
      this.logResult('Agent Registration', false, responseTime, error);
      return false;
    }
  }

  // 测试getagent列表
  async testGetAgents() {
    try {
      const startTime = Date.now();
      const response = await axios.get(`${this.baseUrl}/api/agents`, {
        timeout: 5000
      });
      const responseTime = Date.now() - startTime;
      this.logResult('Get Agents', response.status === 200, responseTime);
      return response.status === 200;
    } catch (error) {
      const responseTime = Date.now() - this.startTime;
      this.logResult('Get Agents', false, responseTime, error);
      return false;
    }
  }

  // 测试Health check
  async testHealthCheck() {
    try {
      const startTime = Date.now();
      const response = await axios.get(`${this.baseUrl}/health`, {
        timeout: 2000
      });
      const responseTime = Date.now() - startTime;
      this.logResult('Health Check', response.status === 200, responseTime);
      return response.status === 200;
    } catch (error) {
      const responseTime = Date.now() - this.startTime;
      this.logResult('Health Check', false, responseTime, error);
      return false;
    }
  }

  // 执行压力测试
  async runStressTest(testCount = 100) {
    console.log(`Start 系统稳定性压力测试，共执行 ${testCount} 次请求...`);
    console.log('========================================');

    let successCount = 0;
    let totalResponseTime = 0;

    for (let i = 0; i < testCount; i++) {
      console.log(`\n测试轮次 ${i + 1}/${testCount}:`);
      
      // 随机选择测试类型
      const testType = Math.floor(Math.random() * 3);
      let success;
      
      switch (testType) {
        case 0:
          success = await this.testHealthCheck();
          break;
        case 1:
          success = await this.testGetAgents();
          break;
        case 2:
          success = await this.testAgentRegistration();
          break;
      }

      if (success) {
        successCount++;
      }

      // 避免请求过于密集
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const endTime = Date.now();
    const totalTime = endTime - this.startTime;
    const successRate = (successCount / testCount) * 100;
    const averageResponseTime = totalResponseTime / testCount;

    console.log('========================================');
    console.log('压力测试结果:');
    console.log(`总请求数: ${testCount}`);
    console.log(`成功数: ${successCount}`);
    console.log(`成功率: ${successRate.toFixed(2)}%`);
    console.log(`总耗时: ${(totalTime / 1000).toFixed(2)}秒`);
    console.log(`Average响应时间: ${averageResponseTime.toFixed(2)}ms`);

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
      averageResponseTime,
      testResults: this.testResults
    }, null, 2));

    console.log(`测试结果Saved到: ${resultFile}`);
    return {
      successRate,
      totalTime,
      averageResponseTime
    };
  }
}

// 执行测试
async function main() {
  const test = new StabilityTest();
  await test.runStressTest(50); // 执行50次测试
}

if (import.meta.url.startsWith('file://')) {
  main().catch(console.error);
}

export default StabilityTest;
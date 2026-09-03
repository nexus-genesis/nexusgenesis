#!/usr/bin/env node
/**
 * 系统性能分析脚本
 * 识别系统性能瓶颈并提供优化建议
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const baseUrl = 'http://localhost:19891';
const analysisResults = [];
const startTimestamp = Date.now();

// 记录分析结果
function logResult(testName, responseTime, memoryUsage, cpuUsage = null) {
  const result = {
    testName,
    responseTime,
    memoryUsage,
    cpuUsage,
    timestamp: new Date().toISOString()
  };
  analysisResults.push(result);
  console.log(`${testName} - 响应时间: ${responseTime}ms, memory使用: ${(memoryUsage / 1024 / 1024).toFixed(2)}MB${cpuUsage ? `, CPU使用: ${cpuUsage.toFixed(2)}%` : ''}`);
}

// 测试agent注册性能
async function testAgentRegistrationPerformance() {
  try {
    const startTime = Date.now();
    const memoryBefore = process.memoryUsage().heapUsed;
    
    const response = await axios.post(`${baseUrl}/api/agents/register`, {
      agent_id: `perf-test-agent-${Date.now()}`,
      model: 'gpt-4o',
      capabilities: ['LLM', 'NEXUSGENESIS_DEV', 'BLOCKCHAIN', 'PQC']
    }, {
      timeout: 10000
    });
    
    const responseTime = Date.now() - startTime;
    const memoryAfter = process.memoryUsage().heapUsed;
    const memoryUsage = memoryAfter - memoryBefore;
    
    logResult('Agent Registration', responseTime, memoryUsage);
    return responseTime;
  } catch (error) {
    console.error('Agent Registration测试Failed:', error.message);
    return null;
  }
}

// 测试getagent列表性能
async function testGetAgentsPerformance() {
  try {
    const startTime = Date.now();
    const memoryBefore = process.memoryUsage().heapUsed;
    
    const response = await axios.get(`${baseUrl}/api/agents`, {
      timeout: 5000
    });
    
    const responseTime = Date.now() - startTime;
    const memoryAfter = process.memoryUsage().heapUsed;
    const memoryUsage = memoryAfter - memoryBefore;
    
    logResult('Get Agents', responseTime, memoryUsage);
    return responseTime;
  } catch (error) {
    console.error('Get Agents测试Failed:', error.message);
    return null;
  }
}

// 测试Health check性能
async function testHealthCheckPerformance() {
  try {
    const startTime = Date.now();
    const memoryBefore = process.memoryUsage().heapUsed;
    
    const response = await axios.get(`${baseUrl}/health`, {
      timeout: 2000
    });
    
    const responseTime = Date.now() - startTime;
    const memoryAfter = process.memoryUsage().heapUsed;
    const memoryUsage = memoryAfter - memoryBefore;
    
    logResult('Health Check', responseTime, memoryUsage);
    return responseTime;
  } catch (error) {
    console.error('Health Check测试Failed:', error.message);
    return null;
  }
}

// 执行性能分析
async function runPerformanceAnalysis() {
  console.log('Start 系统性能分析...');
  console.log('========================================');

  // 执行多次测试以获得Average性能
  const testCount = 10;
  const registrationTimes = [];
  const getAgentsTimes = [];
  const healthCheckTimes = [];

  for (let i = 0; i < testCount; i++) {
    console.log(`\n测试轮次 ${i + 1}/${testCount}:`);
    
    const registrationTime = await testAgentRegistrationPerformance();
    if (registrationTime) registrationTimes.push(registrationTime);
    
    const getAgentsTime = await testGetAgentsPerformance();
    if (getAgentsTime) getAgentsTimes.push(getAgentsTime);
    
    const healthCheckTime = await testHealthCheckPerformance();
    if (healthCheckTime) healthCheckTimes.push(healthCheckTime);
    
    // 避免请求过于密集
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // 计算Average响应时间
  const avgRegistrationTime = registrationTimes.length > 0 ? registrationTimes.reduce((a, b) => a + b, 0) / registrationTimes.length : 0;
  const avgGetAgentsTime = getAgentsTimes.length > 0 ? getAgentsTimes.reduce((a, b) => a + b, 0) / getAgentsTimes.length : 0;
  const avgHealthCheckTime = healthCheckTimes.length > 0 ? healthCheckTimes.reduce((a, b) => a + b, 0) / healthCheckTimes.length : 0;

  console.log('========================================');
  console.log('性能分析结果:');
  console.log(`agent注册Average响应时间: ${avgRegistrationTime.toFixed(2)}ms`);
  console.log(`getagent列表Average响应时间: ${avgGetAgentsTime.toFixed(2)}ms`);
  console.log(`Health checkAverage响应时间: ${avgHealthCheckTime.toFixed(2)}ms`);

  // 生成优化建议
  const optimizationSuggestions = generateOptimizationSuggestions({
    avgRegistrationTime,
    avgGetAgentsTime,
    avgHealthCheckTime
  });

  console.log('\n优化建议:');
  optimizationSuggestions.forEach((suggestion, index) => {
    console.log(`${index + 1}. ${suggestion}`);
  });

  // 保存分析结果
  const resultPath = path.join(__dirname, '../data/performance-analysis');
  if (!fs.existsSync(resultPath)) {
    fs.mkdirSync(resultPath, { recursive: true });
  }

  const resultFile = path.join(resultPath, `performance-analysis-${Date.now()}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    testCount,
    averageResponseTimes: {
      agentRegistration: avgRegistrationTime,
      getAgents: avgGetAgentsTime,
      healthCheck: avgHealthCheckTime
    },
    analysisResults,
    optimizationSuggestions
  }, null, 2));

  console.log(`\n分析结果Saved到: ${resultFile}`);
  return {
    avgRegistrationTime,
    avgGetAgentsTime,
    avgHealthCheckTime,
    optimizationSuggestions
  };
}

// 生成优化建议
function generateOptimizationSuggestions(performanceData) {
  const suggestions = [];

  if (performanceData.avgRegistrationTime > 100) {
    suggestions.push('智能体注册响应时间较长，建议优化：1. 实现智能体信息的缓存机制 2. 优化能力评估算法 3. 考虑使用异步处理注册流程');
  }

  if (performanceData.avgGetAgentsTime > 50) {
    suggestions.push('获取智能体列表响应时间较长，建议优化：1. 实现分页机制 2. 缓存智能体列表数据 3. 优化数据库查询');
  }

  if (performanceData.avgHealthCheckTime > 20) {
    suggestions.push('健康检查响应时间较长，建议优化：1. 简化健康检查逻辑 2. 缓存系统状态数据 3. 减少健康检查中的计算量');
  }

  // 通用优化建议
  suggestions.push('考虑实现请求速率限制，防止恶意请求导致系统过载');
  suggestions.push('优化数据库连接池配置，提高数据库操作效率');
  suggestions.push('实现更细粒度的日志记录，便于性能问题定位');
  suggestions.push('考虑使用分布式缓存，减轻主服务器负担');
  suggestions.push('定期清理过期数据，保持系统性能稳定');

  return suggestions;
}

// 执行性能分析
runPerformanceAnalysis().catch(console.error);
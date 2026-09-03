/**
 * Smart Contract性能Test脚本
 * TestAINVMSmart Contract的Execute性能和network响应时间
 */

import contractManager from './src/contracts/contractManager.js';
import { testCounterContract } from './src/contracts/examples/counter.js';
import { testMatrixContract } from './src/contracts/examples/matrixOperations.js';
import { testTokenContract } from './src/contracts/examples/token.js';
import { testGovernanceContract } from './src/contracts/examples/governance.js';
import { testDIDContract } from './src/contracts/examples/did.js';
import { testAIContract } from './src/contracts/examples/ai.js';
import fs from 'fs';
import path from 'path';

// 性能TestConfiguration
const config = {
  iterations: 100, // 每个Test的迭代次数
  warmup: 10,     // 预热迭代次数
  gasLimit: 10000  // Gas限制
};

// 性能Test结果
const results = {
  counter: [],
  matrix: [],
  token: [],
  governance: [],
  did: [],
  ai: []
};

// TestExecute时间
function measureExecutionTime(fn, name) {
  const start = process.hrtime();
  const result = fn();
  const end = process.hrtime(start);
  const duration = end[0] * 1000 + end[1] / 1000000; // 转换为ms
  
  console.log(`${name}: ${duration.toFixed(2)}ms`);
  return duration;
}

// Test计数器Contract性能
async function testCounterPerformance() {
  console.log('\n=== Testing Counter Contract Performance ===');
  
  // DeployContract
  const contractId = await testCounterContract();
  
  // 预热
  for (let i = 0; i < config.warmup; i++) {
    contractManager.executeContract(contractId, config.gasLimit);
  }
  
  // 性能Test
  for (let i = 0; i < config.iterations; i++) {
    const duration = measureExecutionTime(() => {
      return contractManager.executeContract(contractId, config.gasLimit);
    }, `Counter execution ${i + 1}`);
    results.counter.push(duration);
  }
  
  return contractId;
}

// Test矩阵运算Contract性能
async function testMatrixPerformance() {
  console.log('\n=== Testing Matrix Operations Performance ===');
  
  // DeployContract
  const contractId = await testMatrixContract();
  
  // 预热
  for (let i = 0; i < config.warmup; i++) {
    contractManager.executeContract(contractId, config.gasLimit);
  }
  
  // 性能Test
  for (let i = 0; i < config.iterations; i++) {
    const duration = measureExecutionTime(() => {
      return contractManager.executeContract(contractId, config.gasLimit);
    }, `Matrix execution ${i + 1}`);
    results.matrix.push(duration);
  }
  
  return contractId;
}

// TestTokenContract性能
async function testTokenPerformance() {
  console.log('\n=== Testing Token Contract Performance ===');
  
  // DeployContract
  const contractId = await testTokenContract();
  
  // 预热
  for (let i = 0; i < config.warmup; i++) {
    contractManager.executeContract(contractId, config.gasLimit);
  }
  
  // 性能Test
  for (let i = 0; i < config.iterations; i++) {
    const duration = measureExecutionTime(() => {
      return contractManager.executeContract(contractId, config.gasLimit);
    }, `Token execution ${i + 1}`);
    results.token.push(duration);
  }
  
  return contractId;
}

// TestGovernanceContract性能
async function testGovernancePerformance() {
  console.log('\n=== Testing Governance Contract Performance ===');
  
  // DeployContract
  const contractId = await testGovernanceContract();
  
  // 预热
  for (let i = 0; i < config.warmup; i++) {
    contractManager.executeContract(contractId, config.gasLimit);
  }
  
  // 性能Test
  for (let i = 0; i < config.iterations; i++) {
    const duration = measureExecutionTime(() => {
      return contractManager.executeContract(contractId, config.gasLimit);
    }, `Governance execution ${i + 1}`);
    results.governance.push(duration);
  }
  
  return contractId;
}

// TestDIDContract性能
async function testDIDPerformance() {
  console.log('\n=== Testing DID Contract Performance ===');
  
  // DeployContract
  const contractId = await testDIDContract();
  
  // 预热
  for (let i = 0; i < config.warmup; i++) {
    contractManager.executeContract(contractId, config.gasLimit);
  }
  
  // 性能Test
  for (let i = 0; i < config.iterations; i++) {
    const duration = measureExecutionTime(() => {
      return contractManager.executeContract(contractId, config.gasLimit);
    }, `DID execution ${i + 1}`);
    results.did.push(duration);
  }
  
  return contractId;
}

// TestAIContract性能
async function testAIPerformance() {
  console.log('\n=== Testing AI Contract Performance ===');
  
  // DeployContract
  const contractId = await testAIContract();
  
  // 预热
  for (let i = 0; i < config.warmup; i++) {
    contractManager.executeContract(contractId, config.gasLimit);
  }
  
  // 性能Test
  for (let i = 0; i < config.iterations; i++) {
    const duration = measureExecutionTime(() => {
      return contractManager.executeContract(contractId, config.gasLimit);
    }, `AI execution ${i + 1}`);
    results.ai.push(duration);
  }
  
  return contractId;
}

// Calculate性能统计data
function calculateStats(data) {
  const sorted = data.sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = data.reduce((acc, val) => acc + val, 0);
  const avg = sum / data.length;
  const median = sorted[Math.floor(data.length / 2)];
  
  return {
    min: min.toFixed(2),
    max: max.toFixed(2),
    avg: avg.toFixed(2),
    median: median.toFixed(2),
    total: sum.toFixed(2),
    count: data.length
  };
}

// Generate性能报告
function generateReport() {
  console.log('\n=== Performance Test Report ===');
  console.log('\nCounter Contract:');
  console.log(calculateStats(results.counter));
  
  console.log('\nMatrix Operations:');
  console.log(calculateStats(results.matrix));
  
  console.log('\nToken Contract:');
  console.log(calculateStats(results.token));
  
  console.log('\nGovernance Contract:');
  console.log(calculateStats(results.governance));
  
  console.log('\nDID Contract:');
  console.log(calculateStats(results.did));
  
  console.log('\nAI Contract:');
  console.log(calculateStats(results.ai));
  
  // Calculate总体性能
  const allResults = [
    ...results.counter,
    ...results.matrix,
    ...results.token,
    ...results.governance,
    ...results.did,
    ...results.ai
  ];
  
  console.log('\nOverall Performance:');
  console.log(calculateStats(allResults));
  
  // Save报告到文件
  const report = {
    timestamp: new Date().toISOString(),
    config,
    results: {
      counter: calculateStats(results.counter),
      matrix: calculateStats(results.matrix),
      token: calculateStats(results.token),
      governance: calculateStats(results.governance),
      did: calculateStats(results.did),
      ai: calculateStats(results.ai),
      overall: calculateStats(allResults)
    }
  };
  
  const reportDir = 'data/performance';
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  
  const reportPath = path.join(reportDir, `performance_report_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  console.log(`\nReport saved to: ${reportPath}`);
}

// 主Testfunction
async function main() {
  console.log('=== Starting Smart Contract Performance Tests ===');
  console.log(`Configuration: ${JSON.stringify(config, null, 2)}`);
  
  try {
    // Load现有Contractstatus
    await contractManager.loadState();
    console.log('Loaded existing contract state');
    
    // 运行性能Test
    await testCounterPerformance();
    await testMatrixPerformance();
    await testTokenPerformance();
    await testGovernancePerformance();
    await testDIDPerformance();
    await testAIPerformance();
    
    // Generate报告
    generateReport();
    
    // SaveContractstatus
    await contractManager.saveState();
    console.log('\nContract state saved');
    
    console.log('\n=== Performance tests completed successfully! ===');
    
  } catch (error) {
    console.error('Error during performance testing:', error);
  }
}

// 运行Test
main();

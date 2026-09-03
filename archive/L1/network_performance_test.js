/**
 * network性能Test脚本
 * Test整个block链network的性能和稳定性
 */

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { performance } from 'perf_hooks';

// 性能TestConfiguration
const config = {
  iterations: 100,         // 每个Test的迭代次数
  warmup: 10,              // 预热迭代次数
  nodes: [
    { url: 'ws://localhost:9847', name: 'node1' },
    { url: 'ws://localhost:9848', name: 'node2' },
    { url: 'ws://localhost:9849', name: 'node3' }
  ],
  batchSize: 10,            // 批量transaction大小
  maxNodes: 10              // 扩展性Test的Maximumnode数
};

// 性能Test结果
const results = {
  nodeSync: [],
  transaction: [],
  smartContract: [],
  scalability: []
};

// TestExecute时间
function measureExecutionTime(fn, name) {
  const start = performance.now();
  const result = fn();
  const end = performance.now();
  const duration = end - start;
  
  console.log(`${name}: ${duration.toFixed(2)}ms`);
  return duration;
}

// Testnode同步速度
async function testNodeSyncSpeed() {
  console.log('\n=== Testing Node Synchronization Speed ===');
  
  const syncResults = [];
  
  for (const node of config.nodes) {
    console.log(`Testing ${node.name}...`);
    
    try {
      const ws = new WebSocket(node.url);
      
      await new Promise((resolve, reject) => {
        ws.on('open', async () => {
          const start = performance.now();
          
          // Send同步请求
          ws.send(JSON.stringify({
            type: 'SYNC_REQUEST',
            data: {
              fromBlock: 0,
              toBlock: 'latest'
            }
          }));
          
          ws.on('message', (message) => {
            const end = performance.now();
            const duration = end - start;
            syncResults.push({
              node: node.name,
              duration
            });
            console.log(`${node.name} sync time: ${duration.toFixed(2)}ms`);
            ws.close();
            resolve();
          });
          
          setTimeout(() => {
            ws.close();
            reject(new Error(`${node.name} sync timeout`));
          }, 30000);
        });
        
        ws.on('error', (error) => {
          console.error(`Error connecting to ${node.name}:`, error);
          resolve();
        });
      });
    } catch (error) {
      console.error(`Error testing ${node.name}:`, error);
    }
  }
  
  results.nodeSync = syncResults;
  return syncResults;
}

// TesttransactionProcess能力
async function testTransactionProcessing() {
  console.log('\n=== Testing Transaction Processing Capacity ===');
  
  const txResults = [];
  const testWallet = 'ng112DZqYRZKQBWqNgqifQnzAnDJiBT27C2y7';
  
  // Test单transactionProcess
  console.log('Testing single transaction processing...');
  for (let i = 0; i < config.iterations; i++) {
    const duration = measureExecutionTime(() => {
      // SimulationtransactionProcess
      const transaction = {
        from: testWallet,
        to: testWallet,
        amount: 1,
        fee: 0.01,
        nonce: i,
        timestamp: Date.now()
      };
      // SimulationVerify和Process
      return JSON.stringify(transaction);
    }, `Single transaction ${i + 1}`);
    txResults.push(duration);
  }
  
  // Test批量transactionProcess
  console.log('\nTesting batch transaction processing...');
  for (let i = 0; i < config.iterations / config.batchSize; i++) {
    const duration = measureExecutionTime(() => {
      const batch = [];
      for (let j = 0; j < config.batchSize; j++) {
        batch.push({
          from: testWallet,
          to: testWallet,
          amount: 1,
          fee: 0.01,
          nonce: i * config.batchSize + j,
          timestamp: Date.now()
        });
      }
      return JSON.stringify(batch);
    }, `Batch transaction ${i + 1}`);
    txResults.push(duration);
  }
  
  results.transaction = txResults;
  return txResults;
}

// TestSmart ContractExecute效率
async function testSmartContractExecution() {
  console.log('\n=== Testing Smart Contract Execution Efficiency ===');
  
  // ImportContract管理器
  const { default: contractManager } = await import('./src/contracts/contractManager.js');
  const { testCounterContract } = await import('./src/contracts/examples/counter.js');
  
  const scResults = [];
  
  try {
    // Load现有Contractstatus
    await contractManager.loadState();
    
    // DeployTestContract
    const contractId = await testCounterContract();
    
    // 预热
    for (let i = 0; i < config.warmup; i++) {
      await contractManager.executeContract(contractId, 10000);
    }
    
    // 性能Test
    for (let i = 0; i < config.iterations; i++) {
      const start = performance.now();
      await contractManager.executeContract(contractId, 10000);
      const end = performance.now();
      const duration = end - start;
      console.log(`Contract execution ${i + 1}: ${duration.toFixed(2)}ms`);
      scResults.push(duration);
    }
    
    // SaveContractstatus
    await contractManager.saveState();
  } catch (error) {
    console.error('Error testing smart contract execution:', error);
  }
  
  results.smartContract = scResults;
  return scResults;
}

// Testnetwork扩展性
async function testNetworkScalability() {
  console.log('\n=== Testing Network Scalability ===');
  
  const scalabilityResults = [];
  
  // Simulation不同node数量下的性能
  for (let nodeCount = 1; nodeCount <= config.maxNodes; nodeCount++) {
    console.log(`Testing with ${nodeCount} nodes...`);
    
    const duration = measureExecutionTime(() => {
      // Simulationnode间通信
      const messages = [];
      for (let i = 0; i < nodeCount; i++) {
        for (let j = 0; j < nodeCount; j++) {
          if (i !== j) {
            messages.push({
              from: `node${i}`,
              to: `node${j}`,
              type: 'BLOCK_PROPAGATION',
              data: { block: { height: 1000 + i, hash: `hash${i}` } }
            });
          }
        }
      }
      return messages.length;
    }, `${nodeCount} nodes communication`);
    
    scalabilityResults.push({
      nodeCount,
      duration
    });
  }
  
  results.scalability = scalabilityResults;
  return scalabilityResults;
}

// Calculate性能统计data
function calculateStats(data) {
  if (!data || data.length === 0) {
    return {
      min: '0.00',
      max: '0.00',
      avg: '0.00',
      median: '0.00',
      total: '0.00',
      count: 0
    };
  }
  
  const numericData = Array.isArray(data) ? data.map(item => typeof item === 'number' ? item : item.duration) : [];
  const sorted = numericData.sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = numericData.reduce((acc, val) => acc + val, 0);
  const avg = sum / numericData.length;
  const median = sorted[Math.floor(numericData.length / 2)];
  
  return {
    min: min.toFixed(2),
    max: max.toFixed(2),
    avg: avg.toFixed(2),
    median: median.toFixed(2),
    total: sum.toFixed(2),
    count: numericData.length
  };
}

// Generate性能报告
function generateReport() {
  console.log('\n=== Network Performance Test Report ===');
  
  console.log('\nNode Synchronization Speed:');
  results.nodeSync.forEach(result => {
    console.log(`${result.node}: ${result.duration.toFixed(2)}ms`);
  });
  
  console.log('\nTransaction Processing:');
  console.log(calculateStats(results.transaction));
  
  console.log('\nSmart Contract Execution:');
  console.log(calculateStats(results.smartContract));
  
  console.log('\nNetwork Scalability:');
  results.scalability.forEach(result => {
    console.log(`${result.nodeCount} nodes: ${result.duration.toFixed(2)}ms`);
  });
  
  // Save报告到文件
  const report = {
    timestamp: new Date().toISOString(),
    config,
    results: {
      nodeSync: results.nodeSync,
      transaction: calculateStats(results.transaction),
      smartContract: calculateStats(results.smartContract),
      scalability: results.scalability
    }
  };
  
  const reportDir = 'data/performance';
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  
  const reportPath = path.join(reportDir, `network_performance_report_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  console.log(`\nReport saved to: ${reportPath}`);
}

// 主Testfunction
async function main() {
  console.log('=== Starting Network Performance Tests ===');
  console.log(`Configuration: ${JSON.stringify(config, null, 2)}`);
  
  try {
    // 运行性能Test
    await testNodeSyncSpeed();
    await testTransactionProcessing();
    await testSmartContractExecution();
    await testNetworkScalability();
    
    // Generate报告
    generateReport();
    
    console.log('\n=== Network performance tests completed successfully! ===');
    
  } catch (error) {
    console.error('Error during network performance testing:', error);
  }
}

// 运行Test
main();

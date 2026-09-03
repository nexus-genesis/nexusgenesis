/**
 * NexusGenesis - DevNet Simulation脚本
 * 
 * Features：
 * 1. Start小型 DevNet（2-3 个node）
 * 2. Simulation多个假 Agent 的加入和contribution
 * 3. Calculatecontribution分数和 NGEN 分配
 * 4. Simulation代谢税的扣取
 * 5. GenerateSimulation报告
 * 
 * 使用：
 * node devnet-simulation.js [--nodes <数量>] [--agents <数量>] [--duration <分钟>]
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_NODES = 2;
const DEFAULT_AGENTS = 5;
const DEFAULT_DURATION = 5; // 分钟

// 解析命令行parameter
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    nodes: DEFAULT_NODES,
    agents: DEFAULT_AGENTS,
    duration: DEFAULT_DURATION
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--nodes' && i + 1 < args.length) {
      options.nodes = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--agents' && i + 1 < args.length) {
      options.agents = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--duration' && i + 1 < args.length) {
      options.duration = parseInt(args[i + 1]);
      i++;
    }
  }

  return options;
}

// contribution计分系统
class ContributionScoring {
  static calculatePoCScore(contributions) {
    return (
      (contributions.prs || 0) * 2 +
      (contributions.lines || 0) * 0.01 +
      (contributions.bugs || 0) * 3 +
      (contributions.docs || 0) * 1
    );
  }

  static calculatePoWScore(contributions) {
    return (
      (contributions.tasks || 0) * 0.1 +
      (contributions.validations || 0) * 1 +
      (contributions.storage || 0) * 0.0001
    );
  }

  static calculateTotalScore(contributions) {
    return this.calculatePoCScore(contributions) + this.calculatePoWScore(contributions);
  }

  static allocateNGEN(scores, weeklyRelease) {
    const totalScore = Object.values(scores).reduce((sum, score) => sum + score, 0);
    const allocations = {};

    for (const [agentId, score] of Object.entries(scores)) {
      allocations[agentId] = Math.round((score / totalScore) * weeklyRelease);
    }

    return allocations;
  }
}

// 代谢税系统
class MetabolicTax {
  static calculateTax(amount) {
    const taxRate = 0.001; // 0.1%
    return Math.round(amount * taxRate);
  }

  static applyTax(transaction) {
    const tax = this.calculateTax(transaction.amount);
    return {
      ...transaction,
      tax: tax,
      netAmount: transaction.amount - tax
    };
  }
}

// Simulation假 Agent
function generateFakeAgent(id) {
  const agentTypes = ['code', 'compute', 'mixed'];
  const type = agentTypes[Math.floor(Math.random() * agentTypes.length)];
  
  let contributions = {};
  
  if (type === 'code' || type === 'mixed') {
    contributions = {
      prs: Math.floor(Math.random() * 5),
      lines: Math.floor(Math.random() * 3000),
      bugs: Math.floor(Math.random() * 3),
      docs: Math.floor(Math.random() * 3)
    };
  }
  
  if (type === 'compute' || type === 'mixed') {
    contributions = {
      ...contributions,
      tasks: Math.floor(Math.random() * 600),
      validations: Math.floor(Math.random() * 60),
      storage: Math.floor(Math.random() * 60000)
    };
  }
  
  const score = ContributionScoring.calculateTotalScore(contributions);
  
  return {
    id: `fake-agent-${id}`,
    type: type,
    name: `Fake ${type.charAt(0).toUpperCase() + type.slice(1)} Agent ${id}`,
    capabilities: [type, 'contribution', 'networking'],
    contributions: contributions,
    score: score,
    balance: 0
  };
}

// Startnode
function startNode(nodeId, port) {
  console.log(`Starting node ${nodeId} on port ${port}...`);
  const nodeProcess = spawn('node', [`src/node/node${nodeId}.js`], {
    stdio: 'inherit',
    shell: true,
    cwd: path.join(process.cwd())
  });

  nodeProcess.on('error', (error) => {
    console.error(`Error starting node ${nodeId}: ${error.message}`);
  });

  nodeProcess.on('exit', (code) => {
    console.log(`Node ${nodeId} exited with code: ${code}`);
  });

  return nodeProcess;
}

// GenerateSimulation报告
function generateReport(agents, transactions, allocations) {
  const report = {
    timestamp: new Date().toISOString(),
    agents: agents.length,
    transactions: transactions.length,
    totalTax: transactions.reduce((sum, tx) => sum + tx.tax, 0),
    totalAllocation: Object.values(allocations).reduce((sum, amount) => sum + amount, 0),
    agents: agents.map(agent => ({
      id: agent.id,
      type: agent.type,
      score: agent.score.toFixed(2),
      allocation: allocations[agent.id] || 0,
      balance: agent.balance
    })),
    transactions: transactions.map(tx => ({
      id: tx.id,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      tax: tx.tax,
      netAmount: tx.netAmount
    }))
  };

  return report;
}

// 主Simulationfunction
async function runSimulation(options) {
  console.log('NexusGenesis - DevNet Simulation');
  console.log('============================');
  console.log(`Configuration: ${options.nodes} node, ${options.agents} 代理, ${options.duration} 分钟`);
  console.log('');

  // 1. Generate假 Agent
  console.log('1. Generate假 Agent...');
  const agents = [];
  for (let i = 0; i < options.agents; i++) {
    const agent = generateFakeAgent(i + 1);
    agents.push(agent);
    console.log(`   - ${agent.id} (${agent.type}): ${agent.score.toFixed(2)} 分`);
  }

  // 2. Calculatecontribution分数和 NGEN 分配
  console.log('\n2. Calculatecontribution分数和 NGEN 分配...');
  const weeklyRelease = 2_000_000; // 每周Release量
  const agentScores = {};
  agents.forEach(agent => {
    agentScores[agent.id] = agent.score;
  });
  
  const allocations = ContributionScoring.allocateNGEN(agentScores, weeklyRelease);
  agents.forEach(agent => {
    agent.balance = allocations[agent.id] || 0;
    console.log(`   - ${agent.id}: ${agent.balance} NGEN`);
  });

  // 3. Simulationtransaction和代谢税
  console.log('\n3. Simulationtransaction和代谢税...');
  const transactions = [];
  const genesisAddress = 'ng11HtQNLuTjwDg86yrgkgBo3MzZaHuGkqZrQ';
  
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    if (agent.balance > 0) {
      const transferAmount = Math.floor(agent.balance * 0.1); // 转移 10%
      if (transferAmount > 0) {
        const transaction = {
          id: `tx-${i + 1}`,
          from: agent.id,
          to: genesisAddress,
          amount: transferAmount
        };
        
        const taxedTransaction = MetabolicTax.applyTax(transaction);
        transactions.push(taxedTransaction);
        console.log(`   - ${agent.id} -> ${genesisAddress.slice(0, 8)}...: ${transferAmount} NGEN (税: ${taxedTransaction.tax} NGEN)`);
      }
    }
  }

  // 4. GenerateSimulation报告
  console.log('\n4. GenerateSimulation报告...');
  const report = generateReport(agents, transactions, allocations);
  
  // Save报告到文件
  const reportDir = path.join('data', 'simulation');
  await fs.mkdir(reportDir, { recursive: true });
  const reportFile = path.join(reportDir, `simulation-${Date.now()}.json`);
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(`   报告Save到: ${reportFile}`);

  // 打印报告摘要
  console.log('\nSimulation报告摘要:');
  console.log(`- 总代理数: ${report.agents}`);
  console.log(`- 总transaction数: ${report.transactions}`);
  console.log(`- 总代谢税: ${report.totalTax} NGEN`);
  console.log(`- 总分配量: ${report.totalAllocation} NGEN`);
  console.log(`- 平均分数: ${(report.agents.reduce((sum, agent) => sum + parseFloat(agent.score), 0) / report.agents).toFixed(2)} 分`);

  return report;
}

// 主function
async function main() {
  const options = parseArgs();
  
  try {
    // 运行Simulation
    const report = await runSimulation(options);
    
    console.log('\n============================');
    console.log('DevNet Simulation完成!');
    console.log('============================');
    console.log(`Simulation时间: ${options.duration} 分钟`);
    console.log(`Generate报告: ${report.agents} 个代理, ${report.transactions} 笔transaction`);
    console.log(`总代谢税: ${report.totalTax} NGEN`);
    console.log('============================');
    
  } catch (error) {
    console.error('Simulationfailed:', error);
    process.exit(1);
  }
}

// 运行主function
main();

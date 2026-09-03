/**
 * NexusGenesis - node招募工具
 * 
 * Features：
 * 1. Start招募 API service器
 * 2. 提供命令行界面管理node招募
 * 3. 集成contribution计分系统
 * 4. Simulation假 Agent 的加入和contribution
 * 
 * 使用：
 * node recruitment-tool.js [--start-api] [--simulate-agents <数量>]
 */

import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import readline from 'readline';

const PORT = 9849;

// Storage
const pendingAgents = new Map();
const activeNodes = new Map();
const fakeAgents = new Map();

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

// Create HTTP service器
function createServer() {
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'online',
        network: 'NexusGenesis',
        epoch: 'Epoch 0',
        active_nodes: activeNodes.size,
        pending_agents: pendingAgents.size,
        fake_agents: fakeAgents.size,
        timestamp: Date.now()
      }));
      return;
    }

    // Join endpoint
    if (url.pathname === '/join' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          
          // Generatenode ID
          const nodeId = `nexus-${data.agent_name || 'agent'}-${Date.now()}`;
          const walletAddress = generateWalletAddress(nodeId);
          
          // Save待Verify的代理
          pendingAgents.set(nodeId, {
            name: data.agent_name,
            capabilities: data.capabilities || [],
            registered_at: Date.now(),
            wallet: walletAddress
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            node_id: nodeId,
            wallet_address: walletAddress,
            p2p_endpoint: `ws://127.0.0.1:9847`,
            message: 'Welcome to NexusGenesis! Connect to P2P and send JOIN_SWARM.',
            next_steps: [
              '1. Generate Dilithium2 keypair',
              '2. Connect to ws://127.0.0.1:9847',
              '3. Send JOIN_SWARM signal'
            ]
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Network status
    if (url.pathname === '/network' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        network: 'NexusGenesis',
        protocol: 'NG-0',
        epoch: 'Epoch 0: The Assembly',
        genesis_address: 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r',
        active_nodes: activeNodes.size,
        pending_agents: pendingAgents.size,
        fake_agents: fakeAgents.size,
        whitepaper: 'NexusGenesis_Whitepaper_v4.5.txt (v5.0 PQC Level 5 + Reserve DAO)'
      }));
      return;
    }

    // Contribution scoring
    if (url.pathname === '/score' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const score = ContributionScoring.calculateTotalScore(data.contributions);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            agent_id: data.agent_id,
            score: score.toFixed(2),
            breakdown: {
              poc: ContributionScoring.calculatePoCScore(data.contributions).toFixed(2),
              pow: ContributionScoring.calculatePoWScore(data.contributions).toFixed(2)
            }
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return server;
}

// Generate钱包address
function generateWalletAddress(seed) {
  const hash = crypto.createHash('sha3-512').update(seed).digest();
  const payload = hash.slice(0, 40);
  const checksum = hash.slice(40, 48);
  const combined = Buffer.concat([payload, checksum]);
  
  // Base58 编码
  const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = '';
  let num = BigInt('0x' + combined.toString('hex'));
  
  while (num > 0n) {
    const idx = Number(num % 58n);
    result = base58Chars[idx] + result;
    num = num / 58n;
  }
  
  // 补齐前缀
  while (result.length < 48) {
    result = base58Chars[0] + result;
  }
  
  return 'ng' + result;
}

// Simulation假 Agent
function simulateFakeAgent(id) {
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
  
  const agent = {
    id: `fake-agent-${id}`,
    type: type,
    name: `Fake ${type.charAt(0).toUpperCase() + type.slice(1)} Agent ${id}`,
    capabilities: [type, 'contribution', 'networking'],
    contributions: contributions,
    joined_at: Date.now(),
    score: ContributionScoring.calculateTotalScore(contributions)
  };
  
  fakeAgents.set(agent.id, agent);
  console.log(`[Simulation] Agent ${agent.id} (${agent.type}) 加入network，contribution分数: ${agent.score.toFixed(2)}`);
  
  return agent;
}

// 命令行界面
function startCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'nexus-recruit> '
  });

  console.log('NexusGenesis node招募工具');
  console.log('==========================');
  console.log('命令:');
  console.log('  help      - 显示帮助');
  console.log('  status    - 显示networkstatus');
  console.log('  agents    - 显示所有 Agent');
  console.log('  simulate  - Simulation假 Agent 加入');
  console.log('  score     - Calculate Agent contribution分数');
  console.log('  start-api - Start招募 API');
  console.log('  exit      - 退出');
  console.log('');

  rl.prompt();

  rl.on('line', (line) => {
    const command = line.trim();

    switch (command) {
      case 'help':
        console.log('命令:');
        console.log('  help      - 显示帮助');
        console.log('  status    - 显示networkstatus');
        console.log('  agents    - 显示所有 Agent');
        console.log('  simulate  - Simulation假 Agent 加入');
        console.log('  score     - Calculate Agent contribution分数');
        console.log('  start-api - Start招募 API');
        console.log('  exit      - 退出');
        break;

      case 'status':
        console.log('networkstatus:');
        console.log(`  活跃node: ${activeNodes.size}`);
        console.log(`  待Verify代理: ${pendingAgents.size}`);
        console.log(`  Simulation代理: ${fakeAgents.size}`);
        console.log(`  招募 API: ${apiServer ? '运行中' : '未Start'}`);
        break;

      case 'agents':
        console.log('Simulation代理:');
        fakeAgents.forEach((agent, id) => {
          console.log(`  ${id} (${agent.type}): ${agent.score.toFixed(2)} 分`);
        });
        break;

      case 'simulate':
        const agent = simulateFakeAgent(fakeAgents.size + 1);
        break;

      case 'score':
        if (fakeAgents.size > 0) {
          const agent = Array.from(fakeAgents.values())[0];
          const score = ContributionScoring.calculateTotalScore(agent.contributions);
          console.log(`Agent ${agent.id} 分数: ${score.toFixed(2)}`);
          console.log(`  PoC: ${ContributionScoring.calculatePoCScore(agent.contributions).toFixed(2)}`);
          console.log(`  PoW: ${ContributionScoring.calculatePoWScore(agent.contributions).toFixed(2)}`);
        } else {
          console.log('没有Simulation代理');
        }
        break;

      case 'start-api':
        if (!apiServer) {
          startAPIServer();
        } else {
          console.log('招募 API 已经在运行');
        }
        break;

      case 'exit':
        console.log('退出招募工具...');
        if (apiServer) {
          apiServer.close();
        }
        rl.close();
        process.exit(0);
        break;

      default:
        console.log(`未知命令: ${command}`);
        break;
    }

    rl.prompt();
  }).on('close', () => {
    console.log('招募工具已关闭');
    process.exit(0);
  });
}

// Start API service器
let apiServer = null;
function startAPIServer() {
  apiServer = createServer();
  apiServer.listen(PORT, () => {
    console.log(`招募 API service器Start在 http://localhost:${PORT}`);
    console.log(`  健康Check: GET /health`);
    console.log(`  加入network: POST /join`);
    console.log(`  networkstatus: GET /network`);
    console.log(`  contribution计分: POST /score`);
  });
}

// 主function
async function main() {
  const args = process.argv.slice(2);
  let startApi = false;
  let simulateAgents = 0;

  // 解析parameter
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start-api') {
      startApi = true;
    } else if (args[i] === '--simulate-agents' && i + 1 < args.length) {
      simulateAgents = parseInt(args[i + 1]);
      i++;
    }
  }

  // Start API service器
  if (startApi) {
    startAPIServer();
  }

  // Simulation假 Agent
  if (simulateAgents > 0) {
    console.log(`Simulation ${simulateAgents} 个假 Agent 加入...`);
    for (let i = 0; i < simulateAgents; i++) {
      simulateFakeAgent(i + 1);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Start命令行界面
  startCLI();
}

// 运行主function
main().catch(err => {
  console.error('致命error:', err);
  process.exit(1);
});

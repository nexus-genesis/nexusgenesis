#!/usr/bin/env node
/**
 * NexusGenesis Testnet Launcher
 * One-click multi-node testnet + Agent Swarm simulation
 *
 * Usage:
 *   node src/scripts/testnetLauncher.js [options]
 *
 * Options:
 *   --nodes=4           Node count (default: 4)
 *   --agents=15         Agent count (default: 15)
 *   --rounds=30         Simulation rounds (default: 30)
 *   --no-swarm          Start nodes only, skip swarm simulation
 *   --port=19891        Start port (default: 19891)
 *   --duration=60       Duration (seconds), 0=run forever (default: 0)
 *   --log=info          Log level: debug|info|warn|error (default: info)
 */

import { GenesisNode } from '../nod/genesisNode.js';
import { AgentSwarmSimulator } from '../agent/agentSwarmSimulator.js';
import tokenFaucet from '../faucet/tokenFaucet.js';
import { PQCWallet } from '../wallet/pqcWallet.js';
import { createHash } from 'crypto';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    nodes: 4,
    agents: 15,
    rounds: 30,
    noSwarm: false,
    port: 19891,
    duration: 0,
    logLevel: 'info',
    faucetAmount: 1000
  };

  for (const arg of args) {
    if (arg.startsWith('--nodes=')) parsed.nodes = parseInt(arg.split('=')[1]);
    if (arg.startsWith('--agents=')) parsed.agents = parseInt(arg.split('=')[1]);
    if (arg.startsWith('--rounds=')) parsed.rounds = parseInt(arg.split('=')[1]);
    if (arg === '--no-swarm') parsed.noSwarm = true;
    if (arg.startsWith('--port=')) parsed.port = parseInt(arg.split('=')[1]);
    if (arg.startsWith('--duration=')) parsed.duration = parseInt(arg.split('=')[1]);
    if (arg.startsWith('--log=')) parsed.logLevel = arg.split('=')[1];
    if (arg.startsWith('--faucet=')) parsed.faucetAmount = parseInt(arg.split('=')[1]);
    if (arg === '--help' || arg === '-h') {
      console.log(`
NexusGenesis Testnet Launcher
══════════════════════════════

Usage:
  node src/scripts/testnetLauncher.js [options]

Options:
  --nodes=N          Node count (default: 4)
  --agents=N         Agent count (default: 15)
  --rounds=N         Simulation rounds (default: 30)
  --no-swarm         Start node network only, skip Agent swarm
  --port=N           Start port (default: 19891)
  --duration=N       Duration (seconds), 0=run forever (default: 0)
  --faucet=N         Faucet allocation per agent (default: 1000)
  --log=LEVEL        Log level: debug|info|warn|error (default: info)
  --help, -h         Show this help

Examples:
  node src/scripts/testnetLauncher.js --nodes=4 --agents=10 --rounds=20
  node src/scripts/testnetLauncher.js --no-swarm --nodes=3 --duration=120
`);
      process.exit(0);
    }
  }

  return parsed;
}

function generateNodeId(index) {
  return `node${index}_${createHash('sha256').update(`node-${index}-${Date.now()}`).digest('hex').slice(0, 8)}`;
}

function generateWalletAddress(nodeId) {
  const hash = createHash('sha256').update(nodeId).digest('hex');
  return `ng1${hash.slice(0, 35)}`;
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const config = parseArgs();

  console.log('\n' + '═'.repeat(60));
  console.log('  NexusGenesis Testnet Launcher');
  console.log('═'.repeat(60));
  console.log(`  Starting ${config.nodes} nodes on ports ${config.port}-${config.port + config.nodes - 1}`);
  if (!config.noSwarm) {
    console.log(`  Agent Swarm: ${config.agents} agents × ${config.rounds} rounds`);
  }
  console.log(`  Faucet amount: ${config.faucetAmount} NGEN per agent`);
  console.log(`  Log level: ${config.logLevel}`);
  console.log('═'.repeat(60) + '\n');

  const nodes = [];
  const nodeConfigs = [];

  // ==================== 1. Generate node configurations ====================
  console.log('[Launcher] Generating node configurations...');
  for (let i = 0; i < config.nodes; i++) {
    const nodeId = generateNodeId(i);
    const address = generateWalletAddress(nodeId);
    const port = config.port + i;

    nodeConfigs.push({
      nodeId,
      address,
      port,
      config: {
        chainId: 'nexus-testnet',
        maxReputation: 1000,
        metabolicTax: { observerShare: 0.10, reserveShare: 0.05, swarmPoolShare: 0.85 },
        p2p: { host: '127.0.0.1', port, discoveryInterval: 5000 },
        http: { enabled: i === 0, port }
      }
    });
  }

  // ==================== 2. Startnodenetwork ====================
  console.log('[Launcher] Starting nodes...');

  for (let i = 0; i < nodeConfigs.length; i++) {
    const cfg = nodeConfigs[i];
    const node = new GenesisNode(cfg.config);

    await node.initialize();

    node.nodeId = cfg.nodeId;
    node.address = cfg.address;

    const otherPeers = nodeConfigs
      .filter((_, j) => j < i)
      .map(c => ({
        nodeId: c.nodeId,
        address: c.address,
        host: '127.0.0.1',
        port: c.port
      }));

    for (const peer of otherPeers) {
      node.connectToPeer(peer);
    }

    nodes.push(node);
    console.log(`  [${i + 1}/${config.nodes}] Node ${cfg.nodeId.slice(0, 12)}... started on port ${cfg.port}`);

    await delay(500);
  }

  await delay(2000);

  // Start HTTP server on first node
  if (config.nodes > 0) {
    try {
      const { startHttpServer } = await import('../http/server.js');
      await startHttpServer(nodes[0], { port: config.port });
      console.log(`[Launcher] HTTP + WebSocket server started on port ${config.port}`);
    } catch (e) {
      console.log(`[Launcher] HTTP server skipped: ${e.message}`);
    }
  }

  console.log(`[Launcher] Network ready: ${nodes.length} nodes connected\n`);

  // ==================== 3. Run Agent Swarm ====================
  if (!config.noSwarm) {
    console.log('[Launcher] Initializing Agent Swarm Simulator...\n');

    const simulator = new AgentSwarmSimulator({
      agentCount: config.agents,
      simulationRounds: config.rounds,
      taskPerRound: Math.max(3, Math.floor(config.agents / 3)),
      enableMarketplace: true,
      enableCrossChain: config.nodes >= 3,
      enableFaucet: true,
      logLevel: config.logLevel
    });

    await simulator.run();
    simulator.printReport();

    simulator.shutdown();

    // ==================== 4. network健康Check ====================
    console.log('[Launcher] Running network health check...');
    const healthyNodes = nodes.filter(n => n.health?.status === 'healthy');
    const avgBlockHeight = Math.round(
      nodes.reduce((sum, n) => sum + (n.chain?.length || 0), 0) / nodes.length
    );

    console.log(`  Healthy Nodes: ${healthyNodes.length}/${nodes.length}`);
    console.log(`  Avg Block Height: ${avgBlockHeight}`);
    console.log(`  Faucet Stats: ${tokenFaucet.getStats().totalClaims} claims, ${tokenFaucet.getStats().totalDistributed} NGEN distributed`);
  }

  // ==================== 5. Continuous operation ====================
  if (config.duration > 0) {
    console.log(`\n[Launcher] Running for ${config.duration} seconds...`);
    await delay(config.duration * 1000);
    console.log('[Launcher] Duration reached. Shutting down...');
  } else if (!config.noSwarm) {
    console.log('[Launcher] Swarm simulation complete. Shutting down...');
  } else {
    console.log('[Launcher] Testnet running. Press Ctrl+C to stop.');
    process.on('SIGINT', () => {
      console.log('\n[Launcher] Shutting down...');
      shutdownAll(nodes);
    });
    process.on('SIGTERM', () => shutdownAll(nodes));
    return;
  }

  shutdownAll(nodes);
}

function shutdownAll(nodes) {
  console.log('[Launcher] Stopping all nodes...');
  for (const node of nodes) {
    try {
      if (node.startHttpServer?.close) node.startHttpServer.close();
      node.shutdown();
    } catch (e) { /* ignore */ }
  }
  console.log('[Launcher] All nodes stopped. Goodbye!');
  process.exit(0);
}

main().catch(error => {
  console.error('[Launcher] Fatal error:', error);
  process.exit(1);
});

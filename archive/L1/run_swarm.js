import { AgentSwarmSimulator } from './src/agent/agentSwarmSimulator.js';

const simulator = new AgentSwarmSimulator({
  agentCount: 12,
  simulationRounds: 25,
  taskPerRound: 5,
  enableMarketplace: true,
  enableFaucet: true,
  logLevel: 'info'
});

try {
  await simulator.run();
  simulator.printReport();
  simulator.shutdown();
} catch (error) {
  console.error('Swarm simulation error:', error.message);
  process.exit(1);
}

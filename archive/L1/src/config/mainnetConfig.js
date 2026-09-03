import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function loadMainnetConfig() {
  const configPath = resolve(PROJECT_ROOT, 'mainnet.config.json');
  if (!existsSync(configPath)) {
    console.warn('[CONFIG] mainnet.config.json not found, using defaults');
    return getDefaultConfig();
  }

  try {
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[CONFIG] Failed to parse mainnet.config.json:', err.message);
    return getDefaultConfig();
  }
}

function getDefaultConfig() {
  return {
    network: {
      chainId: process.env.CHAIN_ID || 'nexus-mainnet',
      networkId: process.env.NETWORK_ID || 'ngn-mainnet-1',
      name: 'NexusGenesis',
      environment: process.env.NODE_ENV || 'devnet',
      maxPeers: parseInt(process.env.MAX_PEERS) || 100,
      seedNodes: (process.env.SEED_NODES || 'ws://localhost:9847').split(','),
      discoveryInterval: 60000,
      healthCheckInterval: 30000,
      heartbeatInterval: 30000,
      handshakeTimeout: 10000,
      tls: { enabled: false }
    },
    blockchain: {
      blockTime: parseInt(process.env.BLOCK_TIME) || 10000,
      maxTransactionsPerBlock: parseInt(process.env.MAX_TX_PER_BLOCK) || 100,
      minFee: parseInt(process.env.MIN_FEE) || 1,
      maxBlockGas: parseInt(process.env.MAX_BLOCK_GAS) || 15000000
    },
    consensus: {
      protocol: 'MultiLeaderConsensus',
      committeeSize: parseInt(process.env.COMMITTEE_SIZE) || 7,
      minValidators: parseInt(process.env.MIN_VALIDATORS) || 2,
      bft: { enabled: process.env.BFT_ENABLED !== 'false' }
    },
    economic: {
      totalSupply: process.env.TOTAL_SUPPLY || '1000000000',
      initialSupply: process.env.INITIAL_SUPPLY || '100000000',
      annualInflationRate: parseFloat(process.env.ANNUAL_INFLATION_RATE) || 0.02,
      blockReward: parseInt(process.env.BLOCK_REWARD) || 10
    }
  };
}

let cachedConfig = null;

export function getMainnetConfig() {
  if (!cachedConfig) {
    cachedConfig = loadMainnetConfig();
  }
  return cachedConfig;
}

export function getNetworkConfig() {
  return getMainnetConfig().network;
}

export function getBlockchainConfig() {
  return getMainnetConfig().blockchain;
}

export function getConsensusConfig() {
  return getMainnetConfig().consensus;
}

export function getEconomicConfig() {
  return getMainnetConfig().economic;
}

export function isMainnet() {
  return getNetworkConfig().environment === 'mainnet';
}

export function isDevNet() {
  return getNetworkConfig().environment === 'devnet' || !isMainnet();
}

export function getSeedNodes() {
  const config = getNetworkConfig();
  return config.seedNodes || [];
}

export function getTLSConfig() {
  const config = getNetworkConfig();
  return config.tls || { enabled: false };
}

export function reloadConfig() {
  cachedConfig = null;
  return getMainnetConfig();
}

export default {
  getMainnetConfig,
  getNetworkConfig,
  getBlockchainConfig,
  getConsensusConfig,
  getEconomicConfig,
  isMainnet,
  isDevNet,
  getSeedNodes,
  getTLSConfig,
  reloadConfig
};
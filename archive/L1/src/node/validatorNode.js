/**
 * Validator Node - 验证节点实现
 *
 * 验证节点参与共识投票，维护区块链状态，验证交易和区块。
 * 需要满足最低质押要求才能成为活跃验证者。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import crypto from 'crypto';
import { PQCWallet } from '../wallet/pqcWallet.js';
import { getNetworkConfig, getSeedNodes, getConsensusConfig, getMainnetConfig } from '../config/mainnetConfig.js';
import { MultiLeaderConsensus } from '../consensus/multiLeader.js';
import { EconomicModel } from '../economic/economicModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

class ValidatorNode {
  constructor(config = {}) {
    this.nodeId = crypto.randomBytes(32).toString('hex');
    this.config = getMainnetConfig();
    this.networkConfig = getNetworkConfig();
    this.consensusConfig = getConsensusConfig();
    this.wallet = null;
    this.stake = config.stake || 100000;
    this.peers = new Map();
    this.blockStore = new Map();
    this.txPool = new Map();
    this.isRunning = false;
    this.startTime = null;
    this.lastBlockHeight = 0;
    this.knownValidators = new Set();
    this.economicModel = new EconomicModel();

    this.consensus = new MultiLeaderConsensus({
      committeeSize: this.consensusConfig.committeeSize || 21,
      minValidators: this.consensusConfig.minValidators || 7,
      minConfirmations: Math.ceil((this.consensusConfig.committeeSize || 21) * 2 / 3),
      bftEnabled: this.consensusConfig.bft?.enabled !== false,
      preVoteTimeout: this.consensusConfig.bft?.preVoteTimeout || 3000,
      preCommitTimeout: this.consensusConfig.bft?.preCommitTimeout || 3000,
      commitTimeout: this.consensusConfig.bft?.commitTimeout || 5000,
      maxMissedBlocks: this.consensusConfig.bft?.maxMissedBlocks || 50
    });

    this.pendingBlocks = [];
    this.processedVotes = new Set();
    this.commitHistory = [];
    this.maxCommitHistory = 1000;
  }

  async initialize() {
    console.log(`[VALIDATOR] Initializing validator: ${this.nodeId.slice(0, 16)}...`);

    this.wallet = await PQCWallet.generate(100000n);
    console.log(`[VALIDATOR] Wallet: ${this.wallet.address.slice(0, 24)}...`);

    const stakeValidation = this.economicModel.validateStake(this.stake);
    if (!stakeValidation.isValidator) {
      console.warn(`[VALIDATOR] Warning: Stake ${this.stake} below validator minimum ${stakeValidation.validatorMinimum}`);
    }

    this.state = this.loadValidatorState();
    this.startTime = Date.now();
    this.isRunning = true;

    this.consensus.registerLeader(this.nodeId, this.wallet.address, 1, this.stake);
    this.consensus.on('blockProposed', (data) => this.onBlockProposed(data));
    this.consensus.on('blockConfirmed', (data) => this.onBlockConfirmed(data));
    this.consensus.on('blockFinalized', (data) => this.onBlockFinalized(data));

    console.log(`[VALIDATOR] Chain: ${this.networkConfig.chainId}, Validator initialized`);
    return this;
  }

  loadValidatorState() {
    const statePath = resolve(PROJECT_ROOT, 'data', 'state', `validator_${this.nodeId.slice(0, 8)}.json`);
    try {
      if (existsSync(statePath)) {
        return JSON.parse(readFileSync(statePath, 'utf8'));
      }
    } catch (err) {
      console.warn(`[VALIDATOR] Could not load state: ${err.message}`);
    }
    return {
      blockHeight: 0,
      lastBlockHash: null,
      totalValidated: 0,
      totalMissed: 0,
      rewards: '0'
    };
  }

  async connectToNetwork() {
    const seeds = getSeedNodes();
    console.log(`[VALIDATOR] Connecting to ${seeds.length} seeds...`);

    for (const seedUrl of seeds) {
      try {
        await this.connectToPeer(seedUrl);
      } catch (err) {
        console.warn(`[VALIDATOR] Seed ${seedUrl}: ${err.message}`);
      }
    }
  }

  async connectToPeer(peerUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(peerUrl);
      const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);

      ws.on('open', () => {
        clearTimeout(timeout);
        const peerId = crypto.randomUUID();
        this.peers.set(peerId, { ws, url: peerUrl, connectedAt: Date.now(), status: 'handshaking' });

        ws.send(JSON.stringify({
          type: 'HELLO',
          nodeId: this.nodeId,
          publicKey: this.wallet.publicKey.toString('hex'),
          version: '1.0.0',
          role: 'validator',
          stake: this.stake,
          chainId: this.networkConfig.chainId,
          timestamp: Date.now()
        }));

        ws.on('message', (data) => this.handleMessage(peerId, data));
        ws.on('close', () => this.peers.delete(peerId));
        ws.on('error', () => this.peers.delete(peerId));

        resolve(peerId);
      });

      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  handleMessage(peerId, data) {
    try {
      const message = JSON.parse(data.toString());
      const conn = this.peers.get(peerId);
      if (!conn) return;

      switch (message.type) {
        case 'HELLO_ACK':
          conn.status = 'connected';
          conn.remoteNodeId = message.nodeId;
          conn.remoteRole = message.role;
          if (message.role === 'validator' || message.role === 'genesis') {
            this.knownValidators.add(message.nodeId);
            this.consensus.registerLeader(message.nodeId, message.publicKey, 1, message.stake || this.stake);
          }
          break;

        case 'BLOCK_PROPOSAL':
          this.handleBlockProposal(message);
          break;

        case 'CONSENSUS_PRE_VOTE':
        case 'CONSENSUS_PRE_COMMIT':
        case 'CONSENSUS_COMMIT':
          this.consensus.handleConsensusMessage(message, message.nodeId || peerId);
          break;

        case 'HEARTBEAT':
          conn.lastHeartbeat = Date.now();
          break;
      }
    } catch (err) {
      console.error(`[VALIDATOR] Message error: ${err.message}`);
    }
  }

  handleBlockProposal(message) {
    const { block, proposerId, blockHash } = message;
    const proposalId = `${blockHash}_${proposerId}`;

    if (this.processedVotes.has(proposalId)) return;
    this.processedVotes.add(proposalId);

    const accepted = this.validateBlock(block);
    if (accepted) {
      this.pendingBlocks.push({ block, proposerId, blockHash, timestamp: Date.now() });
      this.consensus.submitPreVote(blockHash, this.nodeId, true);
    }
  }

  validateBlock(block) {
    if (!block.hash || !block.height || !block.transactions) {
      return false;
    }
    if (this.blockStore.has(block.hash)) {
      return false;
    }
    if (block.height < this.lastBlockHeight) {
      return false;
    }
    return true;
  }

  onBlockProposed(data) {
    console.log(`[VALIDATOR] Block proposed: ${data.blockHash?.slice(0, 16)}...`);
  }

  onBlockConfirmed(data) {
    console.log(`[VALIDATOR] Block confirmed: ${data.blockHash?.slice(0, 16)}...`);
    this.state.totalValidated++;
    this.broadcastVote('CONSENSUS_COMMIT', data.blockHash);
  }

  onBlockFinalized(data) {
    const blockHash = data.blockHash;
    this.lastBlockHeight = data.height;
    this.state.blockHeight = data.height;

    this.commitHistory.push({
      blockHash,
      height: data.height,
      proposer: data.proposer,
      timestamp: Date.now()
    });

    if (this.commitHistory.length > this.maxCommitHistory) {
      this.commitHistory.shift();
    }

    const reward = this.economicModel.calculateBlockReward(data.height);
    const distribution = this.economicModel.distributeReward(reward, data.proposer, Array.from(this.knownValidators));
    console.log(`[VALIDATOR] Block ${data.height} finalized, reward: ${reward}`);
  }

  broadcastVote(type, blockHash) {
    const message = {
      type,
      blockHash,
      nodeId: this.nodeId,
      round: this.consensus.currentRound,
      height: this.lastBlockHeight,
      timestamp: Date.now()
    };
    for (const [peerId, conn] of this.peers) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify(message));
      }
    }
  }

  getStatus() {
    return {
      nodeId: this.nodeId,
      role: 'validator',
      isRunning: this.isRunning,
      uptime: Date.now() - (this.startTime || Date.now()),
      chainId: this.networkConfig.chainId,
      blockHeight: this.lastBlockHeight,
      peers: this.peers.size,
      knownValidators: this.knownValidators.size,
      txPoolSize: this.txPool.size,
      stake: this.stake,
      walletAddress: this.wallet?.address,
      consensus: this.consensus.getStats(),
      economic: this.economicModel.getStats(),
      state: this.state
    };
  }

  async shutdown() {
    console.log(`[VALIDATOR] Shutting down...`);
    this.isRunning = false;

    for (const [peerId, conn] of this.peers) {
      conn.ws.close();
    }
    this.peers.clear();

    this.saveState();
    console.log(`[VALIDATOR] Shutdown complete`);
  }

  saveState() {
    const dir = resolve(PROJECT_ROOT, 'data', 'state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const statePath = resolve(dir, `validator_${this.nodeId.slice(0, 8)}.json`);
    writeFileSync(statePath, JSON.stringify(this.state, null, 2));
  }
}

export default ValidatorNode;
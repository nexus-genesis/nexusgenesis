/**
 * Cross-chain桥 Relay 中继network增强 (P2-2)
 * 中继node管理, 多跳路由, Message传递protocol, 费用marketplace
 */

const SUPPORTED_CHAINS = ['ethereum', 'bsc', 'polygon', 'solana', 'avalanche', 'arbitrum'];

const CHAIN_CONFIGS = {
  ethereum: { name: 'Ethereum', avgBlockTime: 12, confirmBlocks: 15, baseFee: 0.005 },
  bsc: { name: 'BSC', avgBlockTime: 3, confirmBlocks: 20, baseFee: 0.001 },
  polygon: { name: 'Polygon', avgBlockTime: 2, confirmBlocks: 30, baseFee: 0.0005 },
  solana: { name: 'Solana', avgBlockTime: 0.4, confirmBlocks: 32, baseFee: 0.0001 },
  avalanche: { name: 'Avalanche', avgBlockTime: 2, confirmBlocks: 20, baseFee: 0.001 },
  arbitrum: { name: 'Arbitrum', avgBlockTime: 0.25, confirmBlocks: 40, baseFee: 0.002 }
};

export class RelayNode {
  constructor({ id, address, stake, supportedChains, uptime = 1.0 }) {
    this.id = id;
    this.address = address;
    this.stake = stake;
    this.supportedChains = supportedChains;
    this.uptime = uptime;
    this.totalRelayed = 0;
    this.totalFeesEarned = 0;
    this.lastActive = Date.now();
    this.reputation = 1.0;
    this.active = true;
  }

  updateReputation() {
    this.reputation = (this.uptime * 0.4 + 
      Math.min(this.totalRelayed / 1000, 1) * 0.3 + 
      Math.min(this.stake / 10000, 1) * 0.3);
    return this.reputation;
  }

  recordRelay(amount) {
    this.totalRelayed++;
    this.totalFeesEarned += amount;
    this.lastActive = Date.now();
  }

  getScore() {
    return this.reputation * this.stake * this.uptime;
  }
}

export class RelayNetwork {
  constructor() {
    this.nodes = new Map();
    this.routes = new Map();
    this.messageQueue = [];
    this.feeMarket = new FeeMarket();
    this.stats = {
      totalRelays: 0,
      totalVolume: 0,
      activeRoutes: 0,
      averageLatency: 0
    };
  }

  registerNode(config) {
    const node = new RelayNode({
      id: config.id || `relay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...config
    });
    this.nodes.set(node.id, node);
    return node;
  }

  removeNode(nodeId) {
    return this.nodes.delete(nodeId);
  }

  getNode(nodeId) {
    return this.nodes.get(nodeId);
  }

  getActiveNodes() {
    return [...this.nodes.values()].filter(n => n.active);
  }

  getNodesForChain(chainId) {
    return [...this.nodes.values()]
      .filter(n => n.active && n.supportedChains.includes(chainId))
      .sort((a, b) => b.getScore() - a.getScore());
  }

  findRoute(sourceChain, targetChain, options = {}) {
    const cacheKey = `${sourceChain}_${targetChain}`;

    if (this.routes.has(cacheKey) && !options.forceRefresh) {
      return this.routes.get(cacheKey);
    }

    const directRelayers = this.getNodesForChain(sourceChain)
      .filter(n => n.supportedChains.includes(targetChain));

    if (directRelayers.length > 0) {
      const route = {
        type: 'direct',
        sourceChain,
        targetChain,
        hops: 1,
        relayers: [directRelayers[0]],
        estimatedTime: this._estimateTime(sourceChain, targetChain),
        estimatedFee: this.feeMarket.getFee(sourceChain, targetChain),
        reliability: directRelayers[0].reputation
      };
      this.routes.set(cacheKey, route);
      return route;
    }

    const multiHopRoute = this._findMultiHopRoute(sourceChain, targetChain);
    if (multiHopRoute) {
      this.routes.set(cacheKey, multiHopRoute);
      return multiHopRoute;
    }

    return null;
  }

  _findMultiHopRoute(sourceChain, targetChain) {
    for (const intermediate of SUPPORTED_CHAINS) {
      if (intermediate === sourceChain || intermediate === targetChain) continue;

      const firstLeg = this.getNodesForChain(sourceChain)
        .find(n => n.supportedChains.includes(intermediate));

      const secondLeg = this.getNodesForChain(intermediate)
        .find(n => n.supportedChains.includes(targetChain));

      if (firstLeg && secondLeg) {
        return {
          type: 'multi-hop',
          sourceChain,
          targetChain,
          hops: 2,
          path: [sourceChain, intermediate, targetChain],
          relayers: [firstLeg, secondLeg],
          estimatedTime: this._estimateTime(sourceChain, intermediate) + this._estimateTime(intermediate, targetChain),
          estimatedFee: this.feeMarket.getFee(sourceChain, intermediate) + this.feeMarket.getFee(intermediate, targetChain),
          reliability: Math.min(firstLeg.reputation, secondLeg.reputation)
        };
      }
    }
    return null;
  }

  _estimateTime(sourceChain, targetChain) {
    const source = CHAIN_CONFIGS[sourceChain];
    const target = CHAIN_CONFIGS[targetChain];
    if (!source || !target) return 300;

    return (source.avgBlockTime * source.confirmBlocks + 
            target.avgBlockTime * target.confirmBlocks) * 1.2;
  }

  executeRelay(transfer) {
    const route = this.findRoute(transfer.sourceChain, transfer.targetChain);
    if (!route) {
      return { success: false, error: 'No route found' };
    }

    for (const relayer of route.relayers) {
      relayer.recordRelay(route.estimatedFee / route.relayers.length);
    }

    this.stats.totalRelays++;
    this.stats.totalVolume += transfer.amount || 0;

    return {
      success: true,
      transferId: `relay_${Date.now()}`,
      route,
      executedAt: Date.now(),
      status: 'completed'
    };
  }

  getNetworkStats() {
    return {
      totalNodes: this.nodes.size,
      activeNodes: this.getActiveNodes().length,
      ...this.stats,
      chainCoverage: this._getChainCoverage(),
      topRelayers: this._getTopRelayers(5)
    };
  }

  _getChainCoverage() {
    const coverage = {};
    for (const chain of SUPPORTED_CHAINS) {
      coverage[chain] = this.getNodesForChain(chain).length;
    }
    return coverage;
  }

  _getTopRelayers(limit) {
    return [...this.nodes.values()]
      .sort((a, b) => b.totalRelayed - a.totalRelayed)
      .slice(0, limit)
      .map(n => ({
        id: n.id,
        address: n.address,
        totalRelayed: n.totalRelayed,
        totalFeesEarned: n.totalFeesEarned,
        reputation: n.updateReputation()
      }));
  }
}

export class FeeMarket {
  constructor() {
    this.baseFees = {};
    this.congestionMultipliers = {};

    for (const chain of SUPPORTED_CHAINS) {
      if (CHAIN_CONFIGS[chain]) {
        this.baseFees[chain] = CHAIN_CONFIGS[chain].baseFee;
        this.congestionMultipliers[chain] = 1.0;
      }
    }
  }

  getFee(sourceChain, targetChain) {
    const sourceFee = this.baseFees[sourceChain] || 0.001;
    const targetFee = this.baseFees[targetChain] || 0.001;
    const sourceMultiplier = this.congestionMultipliers[sourceChain] || 1.0;
    const targetMultiplier = this.congestionMultipliers[targetChain] || 1.0;

    return Math.round((sourceFee * sourceMultiplier + targetFee * targetMultiplier) * 1e6) / 1e6;
  }

  updateCongestion(chainId, multiplier) {
    this.congestionMultipliers[chainId] = Math.max(0.5, Math.min(multiplier, 5.0));
  }

  getAllFees() {
    const fees = {};
    for (const source of SUPPORTED_CHAINS) {
      fees[source] = {};
      for (const target of SUPPORTED_CHAINS) {
        if (source !== target) {
          fees[source][target] = this.getFee(source, target);
        }
      }
    }
    return fees;
  }
}

export default RelayNetwork;
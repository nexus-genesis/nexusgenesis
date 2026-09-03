import { MessageHandler } from './MessageHandler.js';

export class AgentDiscoveryMessageHandler extends MessageHandler {
  constructor(p2pServer, agentNetworkDiscovery) {
    super(p2pServer);
    this.agentNetworkDiscovery = agentNetworkDiscovery;
  }

  async handle(peerId, msg) {
    if (!this.agentNetworkDiscovery) return false;
    return this.agentNetworkDiscovery.handle(peerId, msg);
  }
}
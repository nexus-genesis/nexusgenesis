import { MessageHandler } from './MessageHandler.js';

export class TransactionHandler extends MessageHandler {
  /**
   * ProcessingtransactionMessage
   */
  async handle(peerId, msg) {
    console.log(`Transaction received: ${msg.tx?.id}`);
    
    if (!this.p2pServer.node || !this.p2pServer.node.validateTransaction) {
      return false;
    }
    
    const validation = await this.p2pServer.node.validateTransaction(msg.tx);
    if (!validation.valid) {
      console.log(`Transaction validation failed: ${validation.reason}`);
      this.p2pServer.send(peerId, { 
        type: 'TX_REJECTED', 
        txId: msg.tx.id, 
        reason: validation.reason 
      });
      return false;
    }
    
    if (this.p2pServer.node.addToMempool) {
      await this.p2pServer.node.addToMempool(msg.tx);
    }
    
    this.p2pServer.broadcast(msg, peerId);
    return true;
  }
}
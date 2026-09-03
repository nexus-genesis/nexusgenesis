import { MessageHandler } from './MessageHandler.js';

export class BlockchainMessageHandler extends MessageHandler {
  /**
   * Processingblock链相关Message
   */
  async handle(peerId, msg) {
    switch (msg.type) {
      case 'PONG':
        return this.handlePong(peerId);
        
      case 'PING':
        return this.handlePing(peerId, msg);
          
      case 'GET_STATUS':
        return this.handleGetStatus(peerId);
        
      case 'STATUS_UPDATE':
        return this.handleStatusUpdate(msg);
        
      case 'GET_MEMPOOL':
        return this.handleGetMempool(peerId);
        
      case 'MEMPOOL_SYNC':
        return this.handleMempoolSync(msg);
        
      case 'GET_NODE_LIST':
        return this.handleGetNodeList(peerId);
        
      case 'NODE_LIST':
        return this.handleNodeList(msg);
        
      case 'BLOCK':
        return this.handleBlock(peerId, msg);

      case 'GET_BLOCKS':
        return this.handleGetBlocks(peerId, msg);

      case 'BLOCKS_RESPONSE':
        return this.handleBlocksResponse(peerId, msg);

      case 'BLOCK_CONFIRMATION':
        return this.handleBlockConfirmation(msg);
        
      case 'TX_REJECTED':
        return this.handleTxRejected(msg);
        
      case 'SWARM_ACK':
        return this.handleSwarmAck(msg);
        
      case 'PROTOCOL_ERROR':
        return this.handleProtocolError(msg);
        
      default:
        return false;
    }
  }

  /**
   * Processing PONG Message
   */
  handlePong(peerId) {
    this.p2pServer.handlePong(peerId);
    return true;
  }

  /**
   * Processing PING Message
   */
  handlePing(peerId, msg) {
    this.p2pServer.send(peerId, { type: 'PONG', timestamp: msg.timestamp });
    return true;
  }

  /**
   * Processing GET_STATUS Message
   */
  handleGetStatus(peerId) {
    const node = this.p2pServer.node;
    const latestBlock = node.blockchain && node.blockchain.length > 0
      ? node.blockchain[node.blockchain.length - 1]
      : null;
    this.p2pServer.send(peerId, {
      type: 'STATUS_UPDATE',
      nodeId: node.nodeId,
      status: node.status,
      mempoolSize: node.mempool?.size || 0,
      peersCount: node.peers.size,
      chainHeight: latestBlock ? latestBlock.header.height : 0,
      tipHash: latestBlock ? latestBlock.hash : null,
      timestamp: Date.now()
    });
    return true;
  }

  /**
   * Processing STATUS_UPDATE Message
   */
  handleStatusUpdate(msg) {
    console.log(`Status from ${msg.nodeId}: ${msg.status}, peers: ${msg.peersCount}, mempool: ${msg.mempoolSize}, chainHeight: ${msg.chainHeight ?? 'N/A'}`);
    if (this.p2pServer.node && this.p2pServer.node.handlePeerStatus) {
      this.p2pServer.node.handlePeerStatus(msg);
    }
    return true;
  }

  /**
   * Processing GET_MEMPOOL Message
   */
  handleGetMempool(peerId) {
    if (this.p2pServer.node && this.p2pServer.node.mempool) {
      this.p2pServer.send(peerId, {
        type: 'MEMPOOL_SYNC',
        transactions: Array.from(this.p2pServer.node.mempool.values())
      });
    }
    return true;
  }

  /**
   * Processing MEMPOOL_SYNC Message
   */
  handleMempoolSync(msg) {
    console.log(`Received ${msg.transactions?.length || 0} transactions from peer`);
    if (this.p2pServer.node && this.p2pServer.node.syncMempool) {
      this.p2pServer.node.syncMempool(msg.transactions || []);
    }
    return true;
  }

  /**
   * Processing GET_NODE_LIST Message
   */
  handleGetNodeList(peerId) {
    console.log(`Node list requested by ${peerId}`);
    this.p2pServer.handleGetNodeList(peerId);
    return true;
  }

  /**
   * Processing NODE_LIST Message
   */
  handleNodeList(msg) {
    console.log(`Received node list with ${msg.nodes?.length || 0} nodes`);
    this.p2pServer.handleNodeList(msg);
    return true;
  }

  /**
   * Processing BLOCK Message
   */
  async handleBlock(peerId, msg) {
    console.log(`Block received: #${msg.block.header.height}`);
    if (this.p2pServer.node && this.p2pServer.node.handleBlock) {
      const { Block } = await import('../../blockchain/block.js');
      const block = Block.fromJSON(msg.block);
      this.p2pServer.node.handleBlock(block, peerId);
    }
    return true;
  }

  /**
   * Processing GET_BLOCKS Message — respond with blocks in requested range
   */
  async handleGetBlocks(peerId, msg) {
    const node = this.p2pServer.node;
    if (!node || !node.blockchain) return true;

    const fromHeight = msg.fromHeight || 0;
    const toHeight = msg.toHeight && msg.toHeight > 0
      ? Math.min(msg.toHeight, node.blockchain.length - 1)
      : node.blockchain.length - 1;

    if (fromHeight > toHeight) {
      this.p2pServer.send(peerId, {
        type: 'BLOCKS_RESPONSE',
        nodeId: node.nodeId,
        blocks: [],
        fromHeight,
        toHeight: fromHeight - 1,
        tipHeight: node.blockchain.length - 1
      });
      return true;
    }

    // Limit batch size to avoid oversized messages
    const MAX_BATCH = 100;
    const cappedToHeight = Math.min(toHeight, fromHeight + MAX_BATCH - 1);
    const blocks = [];
    for (let i = fromHeight; i <= cappedToHeight && i < node.blockchain.length; i++) {
      blocks.push(node.blockchain[i].toJSON());
    }

    const tipHeight = node.blockchain.length - 1;
    console.log(`[SYNC] Sending ${blocks.length} blocks (${fromHeight}-${cappedToHeight}) to peer ${peerId.slice(0, 8)}, tip=${tipHeight}`);
    this.p2pServer.send(peerId, {
      type: 'BLOCKS_RESPONSE',
      nodeId: node.nodeId,
      blocks,
      fromHeight,
      toHeight: cappedToHeight,
      tipHeight
    });
    return true;
  }

  /**
   * Processing BLOCKS_RESPONSE Message — apply received blocks in order
   * and automatically request next batch if there are more blocks to sync
   */
  async handleBlocksResponse(peerId, msg) {
    const node = this.p2pServer.node;
    if (!node || !node.handleBlocksResponse) return true;

    const blocks = msg.blocks || [];
    if (blocks.length === 0) {
      console.log(`[SYNC] Received empty blocks response from ${peerId.slice(0, 8)}`);
      return true;
    }

    console.log(`[SYNC] Received ${blocks.length} blocks (${msg.fromHeight}-${msg.toHeight}) from peer ${peerId.slice(0, 8)}, tip=${msg.tipHeight}`);
    const { Block } = await import('../../blockchain/block.js');
    const blockObjs = blocks.map(b => Block.fromJSON(b));
    await node.handleBlocksResponse(peerId, blockObjs);

    // Automatically continue syncing if more blocks are available
    if (msg.tipHeight !== undefined && msg.toHeight < msg.tipHeight && node.requestBlocksFromPeer) {
      const nextFrom = msg.toHeight + 1;
      const peerNodeId = this.p2pServer.peerIdToNodeId.get(peerId);
      if (peerNodeId) {
        setTimeout(() => {
          node.requestBlocksFromPeer(peerNodeId, nextFrom, -1);
        }, 100);
      }
    }

    return true;
  }

  /**
   * Processing BLOCK_CONFIRMATION Message
   */
  handleBlockConfirmation(msg) {
    console.log(`Block confirmation received for ${msg.blockHash.slice(0, 16)}...`);
    if (this.p2pServer.node && this.p2pServer.node.handleBlockConfirmation) {
      this.p2pServer.node.handleBlockConfirmation(msg);
    }
    return true;
  }

  /**
   * Processing TX_REJECTED Message
   */
  handleTxRejected(msg) {
    console.log(`Transaction rejected: ${msg.txId}, reason: ${msg.reason}`);
    return true;
  }

  /**
   * Processing SWARM_ACK Message
   */
  handleSwarmAck(msg) {
    console.log(`Swarm acknowledgment received from ${msg.nodeId}`);
    return true;
  }

  /**
   * Processing PROTOCOL_ERROR Message
   */
  handleProtocolError(msg) {
    console.log(`Protocol error from ${msg.nodeId}: ${msg.message}`);
    return true;
  }
}

// Processing GET_NODE_LIST Message(不requiresVerify的版本)
export class NodeListHandler extends MessageHandler {
  /**
   * Processing GET_NODE_LIST Message
   */
  async handle(peerId, msg) {
    console.log(`Node list requested by ${peerId}`);
    this.p2pServer.handleGetNodeList(peerId);
    return true;
  }

  /**
   * GET_NODE_LIST Message不requiresVerify
   */
  requiresVerification() {
    return false;
  }
}
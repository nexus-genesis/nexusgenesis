/**
 * StateSyncMessageHandler
 * 处理 P2P 状态同步消息
 * 
 * 协议流程：
 * 1. 新节点发送 STATE_SYNC_REQUEST（从 fromHeight 开始请求区块）
 * 2. 对端响应 STATE_SYNC_RESPONSE（包含区块列表）
 * 3. 请求方应用区块，继续请求下一批直到同步完成
 */

import { MessageHandler } from './MessageHandler.js';

export class StateSyncMessageHandler extends MessageHandler {
  /**
   * 处理状态同步消息
   */
  async handle(peerId, msg) {
    switch (msg.type) {
      case 'STATE_SYNC_REQUEST':
        return this.handleStateSyncRequest(peerId, msg);

      case 'STATE_SYNC_RESPONSE':
        return this.handleStateSyncResponse(peerId, msg);

      default:
        return false;
    }
  }

  /**
   * 处理 STATE_SYNC_REQUEST — 对端请求同步状态
   * 从指定高度开始发送区块
   */
  async handleStateSyncRequest(peerId, msg) {
    const node = this.p2pServer.node;
    if (!node || !node.blockchain) {
      console.log(`[SYNC] No blockchain available for peer ${peerId.slice(0, 8)}`);
      return true;
    }

    const fromHeight = msg.fromHeight || 0;
    const maxBlocks = msg.maxBlocks || 100;

    // 找到需要同步的区块范围
    const tipHeight = node.blockchain.length - 1;
    if (fromHeight > tipHeight) {
      console.log(`[SYNC] Peer already up to date (our tip=${tipHeight}, requested from=${fromHeight})`);
      this.p2pServer.send(peerId, {
        type: 'STATE_SYNC_RESPONSE',
        nodeId: node.nodeId,
        blocks: [],
        fromHeight,
        toHeight: fromHeight - 1,
        tipHeight,
        synced: true
      });
      return true;
    }

    // 截取区块范围，限制批次大小
    const toHeight = Math.min(fromHeight + maxBlocks - 1, tipHeight);
    const blocks = [];

    for (let i = fromHeight; i <= toHeight && i <= tipHeight; i++) {
      if (node.blockchain[i]) {
        blocks.push(node.blockchain[i].toJSON());
      }
    }

    console.log(
      `[SYNC] Sending ${blocks.length} blocks (${fromHeight}-${toHeight}) ` +
      `to peer ${peerId.slice(0, 8)}, tip=${tipHeight}`
    );

    this.p2pServer.send(peerId, {
      type: 'STATE_SYNC_RESPONSE',
      nodeId: node.nodeId,
      blocks,
      fromHeight,
      toHeight,
      tipHeight,
      synced: toHeight >= tipHeight
    });

    return true;
  }

  /**
   * 处理 STATE_SYNC_RESPONSE — 接收对端发送的区块
   */
  async handleStateSyncResponse(peerId, msg) {
    const node = this.p2pServer.node;
    if (!node || !node.handleBlocksResponse) {
      console.log(`[SYNC] Node does not support handleBlocksResponse`);
      return true;
    }

    const blocks = msg.blocks || [];
    if (blocks.length === 0) {
      console.log(`[SYNC] Empty state sync response from ${peerId.slice(0, 8)}, synced: ${msg.synced}`);
      return true;
    }

    console.log(
      `[SYNC] Received ${blocks.length} blocks (${msg.fromHeight}-${msg.toHeight}) ` +
      `from peer ${peerId.slice(0, 8)}, tip=${msg.tipHeight}, synced=${msg.synced}`
    );

    const { Block } = await import('../../blockchain/block.js');
    const blockObjs = blocks.map(b => Block.fromJSON(b));

    await node.handleBlocksResponse(peerId, blockObjs);

    // 如果未完全同步，继续请求下一批
    if (!msg.synced && node.requestBlocksFromPeer) {
      const nextFrom = msg.toHeight + 1;
      const peerNodeId = this.p2pServer.peerIdToNodeId.get(peerId);
      if (peerNodeId) {
        // Small delay to avoid overwhelming the peer
        setTimeout(() => {
          node.requestBlocksFromPeer(peerNodeId, nextFrom, -1);
        }, 100);
      }
    }

    return true;
  }
}

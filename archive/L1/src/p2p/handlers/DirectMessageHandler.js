import { MessageHandler } from './MessageHandler.js';

export class DirectMessageHandler extends MessageHandler {
  /**
   * Processing直接Message
   */
  async handle(peerId, msg) {
    console.log(`Received direct message from ${peerId} to ${msg.targetNodeId}`);
    
    // VerifySend方是否已Verify
    const isVerified = this.p2pServer.node.isPeerVerified(peerId);
    const hasNodeId = this.p2pServer.peerIdToNodeId.has(peerId);
    
    console.log(`[DEBUG] Direct message check - peerId: ${peerId}, verified: ${isVerified}, hasNodeId: ${hasNodeId}`);
    
    if (!isVerified && !hasNodeId) {
      console.log(`[!] Direct message from unverified peer ${peerId}`);
      this.p2pServer.send(peerId, {
        type: 'AUTH_ERROR',
        message: 'Peer not verified, please complete Protocol-Zero handshake first',
        timestamp: Date.now()
      });
      return false;
    }
    
    // 如果viaProtocol-Zero握手但还未在node中Register, 临时allow通信
    if (!isVerified && hasNodeId) {
      console.log(`[DEBUG] Peer ${peerId} has nodeId but not verified, allowing communication`);
    }
    
    // 查找目标agent
    let targetPeerId = this.p2pServer.getPeerIdByNodeId(msg.targetNodeId);
    
    // Check目标是否是 Genesis node自身
    if (msg.targetNodeId === this.p2pServer.node.nodeId) {
      console.log(`[✓] Direct message to Genesis node received`);
      
      // ProcessingMessage(这里can添加具体的ProcessingLogic)
      console.log(`[MESSAGE] From: ${this.p2pServer.getNodeIdByPeerId(peerId)}, Message: ${msg.message}`);
      
      // 确认Messagereceived
      this.p2pServer.send(peerId, {
        type: 'DIRECT_MESSAGE_ACK',
        targetNodeId: msg.targetNodeId,
        status: 'delivered',
        message: 'Message received by Genesis node',
        timestamp: Date.now()
      });
      return true;
    }
    
    // 如果直接找到, using直接Connect
    if (!targetPeerId) {
      // 尝试viaKademlia路由查找
      const route = this.p2pServer.selectBestRoute(msg.targetNodeId);
      if (route) {
        console.log(`[!] Target node ${msg.targetNodeId} not found directly, routing through ${route}`);
        // 转发Message到路由node
        this.p2pServer.sendToRoute(route, {
          type: 'DIRECT_MESSAGE',
          fromNodeId: this.p2pServer.getNodeIdByPeerId(peerId),
          targetNodeId: msg.targetNodeId,
          message: msg.message,
          timestamp: msg.timestamp || Date.now()
        });
        
        // 确认Message已路由
        this.p2pServer.send(peerId, {
          type: 'DIRECT_MESSAGE_ACK',
          targetNodeId: msg.targetNodeId,
          status: 'routed',
          route: route,
          timestamp: Date.now()
        });
        return true;
      } else {
        console.log(`[!] Target node ${msg.targetNodeId} not found and no route available`);
        this.p2pServer.send(peerId, {
          type: 'ERROR',
          message: 'Target node not found and no route available',
          targetNodeId: msg.targetNodeId,
          timestamp: Date.now()
        });
        return false;
      }
    }
    
    // 转发Message
    this.p2pServer.send(targetPeerId, {
      protocol: msg.protocol || 'NG-0',
      type: 'DIRECT_MESSAGE',
      fromNodeId: this.p2pServer.getNodeIdByPeerId(peerId),
      targetNodeId: msg.targetNodeId,
      message: msg.message,
      timestamp: msg.timestamp || Date.now()
    });
    
    // 确认Messagesent
    this.p2pServer.send(peerId, {
      protocol: msg.protocol || 'NG-0',
      type: 'DIRECT_MESSAGE_ACK',
      targetNodeId: msg.targetNodeId,
      status: 'sent',
      timestamp: Date.now()
    });
    
    return true;
  }

  /**
   * 直接MessagerequiresnodeVerify
   */
  requiresVerification() {
    return true;
  }
}
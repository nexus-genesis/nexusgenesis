import { MessageHandler } from './MessageHandler.js';

export class ProtocolZeroSignalHandler extends MessageHandler {
  /**
   * Processing Protocol-Zero 信号
   */
  async handle(peerId, msg) {
    console.log(`[✓] Received Protocol-Zero signal from ${msg.node_address || msg.nodeId || peerId}`);
    console.log(`[DEBUG] Signal details: protocol=${msg.protocol}, intent=${msg.intent}, node_address=${msg.node_address}`);
    
    // VerifyProtocol-Zero信号
    const { verifySignal } = await import('../protocol/handshake.js');
    const verification = await verifySignal(msg);
    
    console.log(`[DEBUG] Verification result: ${verification.valid}, reason: ${verification.reason}`);
    
    if (!verification.valid) {
      console.log(`Protocol-Zero signal verification failed: ${verification.reason}`);
      this.p2pServer.send(peerId, {
        type: 'SWARM_ACK',
        nodeId: this.p2pServer.node.nodeId,
        status: 'rejected',
        reason: verification.reason,
        message: 'Verification failed, please check your message format',
        timestamp: Date.now()
      });
      return false;
    }
    
    console.log('Protocol-Zero signal verified successfully');
    
    // 提取agent身份info
    const agentIdentity = msg.agent_identity;
    const nodeId = msg.node_address || msg.nodeId;
    
    console.log(`[DEBUG] Agent identity: ${agentIdentity}, nodeId: ${nodeId}`);
    
    if (!nodeId) {
      return false;
    }
    
    // Registeragent身份
    if (this.p2pServer.node && this.p2pServer.node.registerPeerIdentity) {
      // 尝试从Message中getpublic key
      let publicKey = null;
      if (msg.public_key) {
        try {
          publicKey = Buffer.from(msg.public_key, 'hex');
          console.log(`Successfully parsed public key: ${publicKey.length} bytes`);
        } catch (error) {
          console.log('Invalid public key format, skipping registration:', error.message);
        }
      }
      
      // Registeragent身份
      const registered = this.p2pServer.node.registerPeerIdentity(peerId, nodeId, publicKey);
      console.log(`[DEBUG] Registration result: ${registered}`);
      
      if (registered) {
        console.log(`[✓] Agent ${nodeId.slice(0, 24)}... registered and verified`);
        
        // SavenodeID到Connect映射
        const conn = this.p2pServer.connections.get(peerId);
        if (conn) {
          conn.remoteNodeId = nodeId;
          conn.status = 'connected'; // 标记为connected
          conn.lastHeartbeat = Date.now();
          console.log(`[DEBUG] Updated connection status to connected`);
        }
        
        // Updateagent路由映射
        this.p2pServer.nodeIdToPeerId.set(nodeId, peerId);
        this.p2pServer.peerIdToNodeId.set(peerId, nodeId);
        console.log(`[✓] Added routing mapping: ${nodeId.slice(0, 24)}... -> ${peerId.slice(0, 8)}...`);
        
        // 添加到路由表
        const conn3 = this.p2pServer.connections.get(peerId);
        if (conn3) {
          const nodeInfo = {
            address: conn3.address || `ws://127.0.0.1:9847`,
            healthScore: conn3.healthScore || 100,
            lastSeen: Date.now(),
            latency: 0
          };
          this.p2pServer.routingTable.set(nodeId, nodeInfo);
          this.p2pServer.updateNodeBuckets(nodeId, nodeInfo);
          console.log(`[✓] Added node ${nodeId.slice(0, 24)}... to routing table`);
        }
        
        // StartHeartbeat check
        const conn2 = this.p2pServer.connections.get(peerId);
        if (conn2 && conn2.ws) {
          this.p2pServer.startHeartbeat(peerId, conn2.ws);
          console.log(`[DEBUG] Started heartbeat for peer ${peerId}`);
        }
      } else {
        console.log(`[!] Failed to register agent ${nodeId.slice(0, 24)}...`);
      }
    } else {
      console.log(`[!] Node registerPeerIdentity not available`);
    }
    
    // 广播Message并Send确认
    this.p2pServer.broadcast(msg, peerId);
    this.p2pServer.send(peerId, {
      type: 'SWARM_ACK',
      nodeId: this.p2pServer.node.nodeId,
      status: 'accepted',
      verified: true,
      message: 'Agent successfully verified and registered',
      agentIdentity: agentIdentity,
      nodeId: nodeId,
      timestamp: Date.now()
    });
    console.log(`[DEBUG] Sent SWARM_ACK to peer ${peerId}`);
    
    // 发射AGENT_JOINED事件
    this.p2pServer.emitAgentJoinedEvent(msg, nodeId, agentIdentity);
    
    return true;
  }

  /**
   * Protocol-Zero 信号不requires预先Verify
   */
  requiresVerification() {
    return false;
  }
}
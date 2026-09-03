import { MessageHandler } from './MessageHandler.js';
import crypto from 'crypto';
import { PQCWallet } from '../../wallet/pqcWallet.js';
import { KyberKEM } from '../server.js';

export class HandshakeHandler extends MessageHandler {
  /**
   * Processing握手Message
   */
  async handle(peerId, msg) {
    if (msg.type === 'HELLO') {
      await this.handleHello(peerId, msg);
    } else if (msg.type === 'HELLO_ACK') {
      await this.handleHelloAck(peerId, msg);
    } else if (msg.type === 'KEY_EXCHANGE') {
      await this.p2pServer.handleKeyExchange(peerId, msg);
    }
    return true;
  }

  /**
   * Processing HELLO Message
   */
  async handleHello(peerId, msg) {
    console.log(`Handshake received from ${peerId}`);
    
    const conn = this.p2pServer.connections.get(peerId);
    if (!conn) return;
    
    try {
      // VerifyMessage结构
      if (!msg.nodeId || !msg.publicKey || !msg.challenge) {
        console.log(`[!] Invalid handshake from ${peerId}: missing fields`);
        conn.ws.close(1002, 'Invalid handshake');
        return;
      }
      
      console.log(`Handshake details - Node ID: ${msg.nodeId.slice(0, 24)}..., Public Key length: ${msg.publicKey.length} chars`);
      
      // Verifyaddress格式
      const { validateAddress } = await import('../../wallet/addressUtils.js');
      const addrValidation = validateAddress(msg.nodeId);
      if (!addrValidation.valid) {
        console.log(`[!] Invalid address in handshake: ${addrValidation.reason}`);
        conn.ws.close(1002, 'Invalid address');
        return;
      }
      
      // Verifypublic key格式
      if (typeof msg.publicKey !== 'string' || msg.publicKey.length < 100) {
        console.log(`[!] Invalid public key format: length ${msg.publicKey.length}`);
        conn.ws.close(1002, 'Invalid public key');
        return;
      }
      
      // Save远程nodeinfo
      conn.remoteNodeId = msg.nodeId;
      
      // security地转换public key
      try {
        conn.remotePublicKey = Buffer.from(msg.publicKey, 'hex');
        console.log(`Successfully parsed public key: ${conn.remotePublicKey.length} bytes`);
      } catch (error) {
        console.log(`[!] Failed to parse public key: ${error.message}`);
        conn.ws.close(1002, 'Invalid public key format');
        return;
      }
      
      // 保存对方发来的 challenge（用于签名），但不能覆盖 conn.challengeSent
      // conn.challengeSent 保存的是我们自己发出的 challenge，用于验证对方的 HELLO_ACK
      conn.challengeReceived = msg.challenge;

      // Generate挑战响应Sign
      const responseChallenge = crypto.randomBytes(32).toString('hex');
      console.log(`Generating signature for peer challenge: ${msg.challenge.slice(0, 16)}...`);

      const signature = await this.p2pServer.node.wallet.sign(msg.challenge);
      console.log(`Generated signature: ${signature.slice(0, 32)}...`);
      
      // GenerateKyberkey pairforkey协商
      const kyberKeyPair = KyberKEM.generateKeyPair();
      
      // Send HELLO_ACK
      this.p2pServer.send(peerId, {
        type: 'HELLO_ACK',
        nodeId: this.p2pServer.node.nodeId,
        publicKey: this.p2pServer.node.wallet.publicKey.toString('hex'),
        challenge: responseChallenge,
        response: signature, // 对对方挑战的响应
        kyberPublicKey: kyberKeyPair.publicKey.toString('hex'), // SendKyberpublic key
        accepted: true
      });
      console.log(`Sent HELLO_ACK to ${peerId}`);
      
      // etc.待对方响应并Verify
      conn.handshakeData = {
        challenge: msg.challenge,
        remoteNodeId: msg.nodeId,
        remotePublicKey: conn.remotePublicKey,
        kyberPrivateKey: kyberKeyPair.privateKey // SaveKyberprivate key
      };
    } catch (error) {
      console.error(`Error handling handshake: ${error.message}`);
      console.error(error.stack);
      conn.ws.close(1002, 'Internal error');
    }
  }

  /**
   * Processing HELLO_ACK Message
   */
  async handleHelloAck(peerId, msg) {
    const pending = this.p2pServer.pendingHandshakes.get(peerId);
    if (!pending) return;
    
    const conn = this.p2pServer.connections.get(peerId);
    if (!conn) return;
    
    console.log(`Handshake acknowledged from ${msg.nodeId}`);
    console.log(`Handshake ACK details - Response length: ${msg.response.length} chars, Public Key length: ${msg.publicKey.length} chars`);
    
    let remotePublicKey;
    
    // Verify响应Sign
    try {
      // VerifyMessage结构
      if (!msg.nodeId || !msg.publicKey || !msg.response || !msg.challenge) {
        console.log(`[!] Invalid handshake ACK: missing fields`);
        conn.ws.close(1002, 'Invalid handshake ACK');
        return;
      }
      
      // security地转换public key
      try {
        remotePublicKey = Buffer.from(msg.publicKey, 'hex');
        console.log(`Successfully parsed public key: ${remotePublicKey.length} bytes`);
      } catch (error) {
        console.log(`[!] Failed to parse public key: ${error.message}`);
        conn.ws.close(1002, 'Invalid public key format');
        return;
      }
      
      // Verifypublic keylength
      if (remotePublicKey.length < 100) {
        console.log(`[!] Invalid public key length: ${remotePublicKey.length} bytes`);
        conn.ws.close(1002, 'Invalid public key');
        return;
      }
      
      // Verify挑战和响应
      if (!conn.challengeSent) {
        console.log(`[!] No challenge sent for this connection`);
        conn.ws.close(1002, 'No challenge sent');
        return;
      }
      
      console.log(`Verifying signature for challenge: ${conn.challengeSent.slice(0, 16)}...`);
      console.log(`Using public key: ${remotePublicKey.toString('hex').slice(0, 32)}...`);
      
      // 严格验签，避免测试态绕过进入生产网络
      try {
        const isValid = await PQCWallet.verify(
          conn.challengeSent,
          msg.response,
          remotePublicKey
        );

        console.log(`Signature verification result: ${isValid}`);

        if (!isValid) {
          console.log(`[!] Handshake signature verification failed for ${peerId} — rejecting connection`);
          conn.ws.close(1002, 'Signature verification failed');
          return;
        }
      } catch (error) {
        console.log(`[!] Handshake signature verification error: ${error.message} — rejecting connection`);
        conn.ws.close(1002, 'Signature verification failed');
        return;
      }
    } catch (error) {
      console.log(`[!] Handshake verification error: ${error.message}`);
      console.log(error.stack);
      conn.ws.close(1003, 'Verification failed');
      return;
    }
    
    // 执行 Kyber 密钥交换，发送 KEY_EXCHANGE
    if (msg.kyberPublicKey) {
      console.log('Performing Kyber key exchange');
      try {
        const kyberPublicKey = Buffer.from(msg.kyberPublicKey, 'hex');
        const { sharedSecret, ciphertext } = KyberKEM.encapsulate(kyberPublicKey);
        // 存储共享密钥用于加密通信
        this.p2pServer.encryptionKeys.set(peerId, sharedSecret);
        console.log('Kyber key exchange completed, encryption enabled');
        
        // 发送 KEY_EXCHANGE 消息
        this.p2pServer.send(peerId, {
          type: 'KEY_EXCHANGE',
          kyberCiphertext: ciphertext.toString('hex')
        });
        console.log('Sent KEY_EXCHANGE to peer');
      } catch (error) {
        console.error('Kyber key exchange failed, disconnecting peer:', error.message);
        // 密钥协商失败必须断开，不允许降级到明文通信
        const conn = this.p2pServer.connections.get(peerId);
        if (conn && conn.ws) {
          conn.ws.close(1002, 'Kyber key exchange failed');
        }
        return;
      }
    }

    // 握手成功
    clearTimeout(pending.timeout);
    this.p2pServer.pendingHandshakes.delete(peerId);
    
    conn.status = 'connected';
    conn.remoteNodeId = msg.nodeId;
    conn.remotePublicKey = remotePublicKey;
    conn.lastHeartbeat = Date.now();
    conn.verified = true; // 标记为已验证
    
    // 注册 node 身份
    if (this.p2pServer.node) {
      this.p2pServer.node.markPeerChallengeVerified(peerId);
      this.p2pServer.node.registerPeerIdentity(peerId, msg.nodeId, remotePublicKey);
      this.p2pServer.node.peers.set(peerId, conn);
    }
    
    // 启动心跳
    this.p2pServer.startHeartbeat(peerId, conn.ws);
    
    console.log(`[✓] Peer ${msg.nodeId.slice(0, 24)}... verified and connected`);
    
    // 请求状态
    this.p2pServer.send(peerId, { type: 'GET_STATUS' });
  }

  /**
   * 握手Message不requires预先Verify
   */
  requiresVerification() {
    return false;
  }
}

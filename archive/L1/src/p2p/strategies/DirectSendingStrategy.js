/**
 * 直接Send策略
 * forSend紧急Message或小Message, 直接Send, 不进行批Processing
 */
import MessageSendingStrategy from './MessageSendingStrategy.js';
import EncryptionService from '../services/EncryptionService.js';
import CompressionService from '../services/CompressionService.js';

class DirectSendingStrategy extends MessageSendingStrategy {
  constructor(encryptionService, compressionService, encryptionKeys) {
    super();
    this.encryptionService = encryptionService;
    this.compressionService = compressionService;
    this.encryptionKeys = encryptionKeys; // peerId -> sharedSecret
  }

  async send(peerId, message, connection) {
    if (!connection || !connection.ws || connection.ws.readyState !== 1) {
      return;
    }

    try {
      let messageStr = JSON.stringify(message);
      const bytesSent = messageStr.length;
      
      // 加密Message(如果有共享key)
      const sharedSecret = this.encryptionKeys.get(peerId);
      if (sharedSecret && this.encryptionService.shouldEncrypt(message.type)) {
        const encryptedData = this.encryptionService.encryptMessage(messageStr, sharedSecret);
        message = { type: 'ENCRYPTED_MESSAGE', data: encryptedData };
        messageStr = JSON.stringify(message);
      }
      
      // 压缩Message
      const compressedMessage = await this.compressionService.compressMessage(messageStr);
      
      // Send message
      if (compressedMessage) {
        connection.ws.send(JSON.stringify(compressedMessage));
      } else {
        connection.ws.send(messageStr);
      }
      
      this.updateTrafficStats(peerId, bytesSent);
    } catch (error) {
      console.error(`[!] Error sending message directly to peer ${peerId}:`, error.message);
    }
  }
  
  getName() {
    return 'direct';
  }
  
  shouldUse(message) {
    // 心跳etc.紧急Message, 直接Send
    return message.type === 'PING' || message.type === 'PONG' || message.type === 'HELLO' || message.type === 'HELLO_ACK';
  }
  
  /**
   * Update流量统计
   * @param {string} peerId - Peer nodesID
   * @param {number} bytesSent - Send的字节数
   */
  updateTrafficStats(peerId, bytesSent) {
    // 这里can添加流量统计Logic
    // 暂时为空, requires集成到现有流量统计系统
  }
}

export default DirectSendingStrategy;

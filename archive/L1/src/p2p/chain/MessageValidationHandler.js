/**
 * MessageVerifyHandler
 * 负责VerifyMessage的格式和有效性
 */
import MessageHandlerChain from './MessageHandlerChain.js';
import crypto from 'crypto';

class MessageValidationHandler extends MessageHandlerChain {
  /**
   * ProcessingMessage
   * @param {string} peerId - Peer nodesID
   * @param {object} message - Message对象
   * @param {object} context - Processing上下文
   * @returns {Promise<boolean>} Processing是否success
   */
  async handle(peerId, message, context) {
    // CheckMessage格式
    if (!message || typeof message !== 'object') {
      console.log(`[!] Invalid message format from ${peerId}`);
      context.p2pServer.send(peerId, {
        type: 'PROTOCOL_ERROR',
        message: 'Invalid message format, must be a JSON object',
        timestamp: Date.now()
      });
      return false;
    }
    
    // CheckMessagetype
    if (!message.type || typeof message.type !== 'string') {
      console.log(`[!] Missing or invalid message type from ${peerId}`);
      context.p2pServer.send(peerId, {
        type: 'PROTOCOL_ERROR',
        message: 'Missing or invalid message type',
        timestamp: Date.now()
      });
      return false;
    }
    
    // call下一个Handler
    return super.handle(peerId, message, context);
  }
}

export default MessageValidationHandler;
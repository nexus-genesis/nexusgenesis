/**
 * MessageProcessingHandler
 * 负责call实际的MessageHandler来ProcessingMessage
 */
import MessageHandlerChain from './MessageHandlerChain.js';

class MessageProcessingHandler extends MessageHandlerChain {
  /**
   * ProcessingMessage
   * @param {string} peerId - Peer nodesID
   * @param {object} message - Message对象
   * @param {object} context - Processing上下文
   * @returns {Promise<boolean>} Processing是否success
   */
  async handle(peerId, message, context) {
    // 特殊Processing: Protocol-Zero 信号(包含 protocol 字段的情况)
    if (message.protocol === 'NG-0' && message.intent) {
      const handler = context.handlerRegistry.getHandler('PROTOCOL_ZERO');
      if (handler) {
        await handler.handle(peerId, message);
        return true;
      }
    }
    
    // getMessageHandler
    const handler = context.handlerRegistry.getHandler(message.type);
    
    if (!handler) {
      console.log(`Unknown message type: ${message.type} from ${peerId}`);
      return false;
    }
    
    // Check是否requiresnodeVerify
    if (handler.requiresVerification() && context.node && !context.node.isPeerVerified(peerId)) {
      console.log(`[!] Ignoring message from unverified peer ${peerId}`);
      context.p2pServer.send(peerId, {
        type: 'AUTH_ERROR',
        message: 'Peer not verified, please complete Protocol-Zero handshake first',
        timestamp: Date.now()
      });
      return false;
    }
    
    // ProcessingMessage
    await handler.handle(peerId, message);
    return true;
  }
}

export default MessageProcessingHandler;
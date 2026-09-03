/**
 * Message去重Handler
 * 负责CheckMessage是否已经Processing过, 避免重复Processing
 */
import MessageHandlerChain from './MessageHandlerChain.js';
import crypto from 'crypto';

class MessageDeduplicationHandler extends MessageHandlerChain {
  /**
   * ProcessingMessage
   * @param {string} peerId - Peer nodesID
   * @param {object} message - Message对象
   * @param {object} context - Processing上下文
   * @returns {Promise<boolean>} Processing是否success
   */
  async handle(peerId, message, context) {
    // CalculateMessagehash
    const msgHash = crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex');
    
    // CheckMessage是否已经Processing过
    if (context.seenMessages.has(msgHash)) {
      console.log(`[!] Duplicate message detected from ${peerId}, skipping`);
      return false;
    }
    
    // 将Messagehash添加到已Processing集合
    context.seenMessages.add(msgHash);
    
    // 限制已ProcessingMessage集合的大小
    if (context.seenMessages.size > 10000) {
      const arr = Array.from(context.seenMessages);
      context.seenMessages = new Set(arr.slice(-5000));
    }
    
    // call下一个Handler
    return super.handle(peerId, message, context);
  }
}

export default MessageDeduplicationHandler;
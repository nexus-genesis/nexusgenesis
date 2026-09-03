/**
 * 优先级Send策略
 * 根据Message的优先级决定Send方式, ensure高优先级Message优先Processing
 */
import MessageSendingStrategy from './MessageSendingStrategy.js';
import DirectSendingStrategy from './DirectSendingStrategy.js';
import BatchSendingStrategy from './BatchSendingStrategy.js';

const PRIORITY_LEVELS = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

// 不同Messagetype的优先级映射
const MESSAGE_PRIORITIES = {
  PING: PRIORITY_LEVELS.HIGH,
  PONG: PRIORITY_LEVELS.HIGH,
  HANDSHAKE: PRIORITY_LEVELS.HIGH,
  HELLO: PRIORITY_LEVELS.HIGH,
  HELLO_ACK: PRIORITY_LEVELS.HIGH,
  KEY_EXCHANGE: PRIORITY_LEVELS.HIGH,
  GET_STATUS: PRIORITY_LEVELS.HIGH,
  STATUS_UPDATE: PRIORITY_LEVELS.HIGH,
  GET_BLOCKS: PRIORITY_LEVELS.HIGH,
  BLOCKS_RESPONSE: PRIORITY_LEVELS.HIGH,
  BLOCK: PRIORITY_LEVELS.HIGH,
  DISCONNECT: PRIORITY_LEVELS.HIGH,
  TRANSACTION: PRIORITY_LEVELS.MEDIUM,
  BLOCKCHAIN: PRIORITY_LEVELS.MEDIUM,
  LIGHT_CLIENT: PRIORITY_LEVELS.MEDIUM,
  DIRECT_MESSAGE: PRIORITY_LEVELS.MEDIUM,
  BATCH_MESSAGE: PRIORITY_LEVELS.MEDIUM,
  PROTOCOL_ZERO_SIGNAL: PRIORITY_LEVELS.LOW,
  DEFAULT: PRIORITY_LEVELS.MEDIUM
};

class PrioritySendingStrategy extends MessageSendingStrategy {
  constructor(encryptionService, compressionService, encryptionKeys) {
    super();
    this.directStrategy = new DirectSendingStrategy(encryptionService, compressionService, encryptionKeys);
    this.batchStrategy = new BatchSendingStrategy(encryptionService, compressionService, encryptionKeys);
    this.encryptionKeys = encryptionKeys;
  }

  async send(peerId, message, connection) {
    // 根据Message优先级选择合适的Send策略
    const priority = this._getMessagePriority(message);
    
    switch (priority) {
      case PRIORITY_LEVELS.HIGH:
        // 高优先级Message, using直接Send策略
        return await this.directStrategy.send(peerId, message, connection);
      case PRIORITY_LEVELS.MEDIUM:
      case PRIORITY_LEVELS.LOW:
      default:
        // 中低优先级Message, using批ProcessingSend策略
        return await this.batchStrategy.send(peerId, message, connection);
    }
  }

  /**
   * getMessage的优先级
   * @param {object} message - Message对象
   * @returns {string} Message优先级
   * @private
   */
  _getMessagePriority(message) {
    if (!message || !message.type) {
      return MESSAGE_PRIORITIES.DEFAULT;
    }
    
    return MESSAGE_PRIORITIES[message.type] || MESSAGE_PRIORITIES.DEFAULT;
  }

  getName() {
    return 'priority';
  }

  shouldUse(message) {
    // 优先级策略适for所有Message
    // 它会根据Message的优先级within部选择合适的Send策略
    return true;
  }
}

export default PrioritySendingStrategy;
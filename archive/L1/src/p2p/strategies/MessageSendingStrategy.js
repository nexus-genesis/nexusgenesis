/**
 * MessageSend策略接口
 * 定义不同Send策略的统一接口
 */
class MessageSendingStrategy {
  /**
   * Send message
   * @param {string} peerId - Peer nodesID
   * @param {object} message - Message对象
   * @param {object} connection - Connect对象
   * @returns {Promise<void>} Sendcomplete的Promise
   */
  async send(peerId, message, connection) {
    throw new Error('send method must be implemented by concrete strategy');
  }
  
  /**
   * get策略名称
   * @returns {string} 策略名称
   */
  getName() {
    throw new Error('getName method must be implemented by concrete strategy');
  }
  
  /**
   * Check是否shouldusing该策略
   * @param {object} message - Message对象
   * @returns {boolean} 是否shouldusing该策略
   */
  shouldUse(message) {
    throw new Error('shouldUse method must be implemented by concrete strategy');
  }
}

export default MessageSendingStrategy;

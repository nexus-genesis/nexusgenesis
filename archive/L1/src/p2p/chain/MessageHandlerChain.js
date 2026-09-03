/**
 * MessageProcessing职责链基class
 * 定义了职责链的基本接口和实现
 */
class MessageHandlerChain {
  constructor() {
    this.nextHandler = null;
  }

  /**
   * Set下一个Handler
   * @param {MessageHandlerChain} nextHandler - 下一个Handler
   * @returns {MessageHandlerChain} 下一个Handler, support链式call
   */
  setNext(nextHandler) {
    this.nextHandler = nextHandler;
    return nextHandler;
  }

  /**
   * ProcessingMessage
   * @param {string} peerId - Peer nodesID
   * @param {object} message - Message对象
   * @param {object} context - Processing上下文
   * @returns {Promise<boolean>} Processing是否success
   */
  async handle(peerId, message, context) {
    // 子class实现具体的ProcessingLogic
    if (this.nextHandler) {
      return await this.nextHandler.handle(peerId, message, context);
    }
    return true;
  }
}

export default MessageHandlerChain;
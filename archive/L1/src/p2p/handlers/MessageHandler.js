/**
 * MessageHandler基class
 * 所有MessageHandler都should继承此class
 */
export class MessageHandler {
  constructor(p2pServer) {
    this.p2pServer = p2pServer;
  }

  /**
   * ProcessingMessage
   * @param {string} peerId - Peer nodes ID
   * @param {object} msg - Message对象
   * @returns {Promise<boolean>} 是否successProcessing
   */
  async handle(peerId, msg) {
    throw new Error('handle method must be implemented by subclass');
  }

  /**
   * VerifyMessage格式
   * @param {object} msg - Message对象
   * @returns {boolean} 是否有效
   */
  validate(msg) {
    return true;
  }

  /**
   * Check是否requiresnodeVerify
   * @returns {boolean}
   */
  requiresVerification() {
    return true;
  }
}
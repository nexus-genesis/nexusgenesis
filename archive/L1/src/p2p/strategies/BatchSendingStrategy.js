/**
 * 批ProcessingSend策略
 * for非紧急Message的批ProcessingSend, 提高network效率
 */
import MessageSendingStrategy from './MessageSendingStrategy.js';
import DirectSendingStrategy from './DirectSendingStrategy.js';

const BATCH_INTERVAL = 100; // message批Process间隔(ms)
const MAX_BATCH_SIZE = 100; // Maximum批Processmessage数

class BatchSendingStrategy extends MessageSendingStrategy {
  constructor(encryptionService, compressionService, encryptionKeys) {
    super();
    this.directStrategy = new DirectSendingStrategy(encryptionService, compressionService, encryptionKeys);
    this.batchQueues = new Map(); // peerId -> message队列
    this.batchTimers = new Map(); // peerId -> 批Process定时器
    this.encryptionKeys = encryptionKeys;
  }

  async send(peerId, message, connection) {
    // 将Message加入批Processing队列
    this.enqueueMessage(peerId, message, connection);
  }
  
  /**
   * 将Message加入批Processing队列
   * @param {string} peerId - Peer nodesID
   * @param {object} message - Message对象
   * @param {object} connection - Connect对象
   */
  enqueueMessage(peerId, message, connection) {
    if (!this.batchQueues.has(peerId)) {
      this.batchQueues.set(peerId, []);
    }
    
    const queue = this.batchQueues.get(peerId);
    queue.push({ message, connection });
    
    // 如果队列达到Maximum容量, 立即Processing
    if (queue.length >= MAX_BATCH_SIZE) {
      this.processBatch(peerId);
      return;
    }
    
    // Set批Processing定时器
    if (!this.batchTimers.has(peerId)) {
      const timer = setTimeout(() => {
        this.processBatch(peerId);
      }, BATCH_INTERVAL);
      this.batchTimers.set(peerId, timer);
    }
  }
  
  /**
   * Processing批Processing队列
   * @param {string} peerId - Peer nodesID
   */
  async processBatch(peerId) {
    const queue = this.batchQueues.get(peerId);
    if (!queue || queue.length === 0) {
      return;
    }
    
    // 清除定时器
    if (this.batchTimers.has(peerId)) {
      clearTimeout(this.batchTimers.get(peerId));
      this.batchTimers.delete(peerId);
    }
    
    // Create批ProcessingMessage
    const batchMessages = queue.map(item => item.message);
    const firstConnection = queue[0].connection;
    
    const batchMessage = {
      type: 'BATCH_MESSAGE',
      messages: batchMessages,
      timestamp: Date.now()
    };
    
    // using直接Send策略Send批ProcessingMessage
    await this.directStrategy.send(peerId, batchMessage, firstConnection);
    
    // 清空队列
    this.batchQueues.set(peerId, []);
  }
  
  getName() {
    return 'batch';
  }
  
  shouldUse(message) {
    // 非紧急Message, 加入批Processing队列
    return !this.directStrategy.shouldUse(message);
  }
}

export default BatchSendingStrategy;

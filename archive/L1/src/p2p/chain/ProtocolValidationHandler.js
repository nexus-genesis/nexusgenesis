/**
 * protocolVerifyHandler
 * 负责VerifyMessage是否符合Protocol-Zero格式
 */
import MessageHandlerChain from './MessageHandlerChain.js';

class ProtocolValidationHandler extends MessageHandlerChain {
  constructor() {
    super();
    
    // 核心networkMessagetype
    this.validMessageTypes = [
      'HELLO', 'HELLO_ACK', 'PING', 'PONG',
      'TRANSACTION', 'TX_REJECTED',
      'GET_STATUS', 'STATUS_UPDATE',
      'GET_MEMPOOL', 'MEMPOOL_SYNC',
      'PROTOCOL_ZERO', 'JOIN_SWARM', 'SWARM_ACK',
      'BATCH_MESSAGE', 'COMPRESSED_MESSAGE',
      'ENCRYPTED_MESSAGE',
      'BLOCK', 'BLOCK_CONFIRMATION', 'GET_BLOCKS', 'BLOCKS_RESPONSE',
      'GET_NODE_LIST', 'NODE_LIST',
      'LIGHT_CLIENT_HELLO', 'LIGHT_CLIENT_HELLO_ACK',
      'GET_BLOCK_HEADERS', 'BLOCK_HEADERS',
      'GET_MERKLE_PROOF', 'MERKLE_PROOF',
      'GET_TRANSACTION_STATUS', 'TRANSACTION_STATUS',
      'GET_ADDRESS_BALANCE', 'SEND_TRANSACTION',
      'CROSS_CHAIN_MESSAGE', 'CROSS_CHAIN_RESPONSE',
      'AGENT_MESSAGE', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_ACK',
      'AGENT_ANNOUNCE', 'AGENT_QUERY', 'AGENT_QUERY_RESPONSE',
      'AGENT_SYNC_REQUEST', 'AGENT_SYNC_RESPONSE', 'AGENT_OFFLINE',
      'AUTH_ERROR', 'PROTOCOL_ERROR', 'KEY_EXCHANGE'
    ];
  }

  /**
   * ProcessingMessage
   * @param {string} peerId - Peer nodesID
   * @param {object} message - Message对象
   * @param {object} context - Processing上下文
   * @returns {Promise<boolean>} Processing是否success
   */
  async handle(peerId, message, context) {
    // Check是否为有效的Messagetype
    if (this.validMessageTypes.includes(message.type)) {
      // call下一个Handler
      return super.handle(peerId, message, context);
    }
    
    // Check是否为带有protocol字段的Message
    if (message.protocol === 'NG-0') {
      // call下一个Handler
      return super.handle(peerId, message, context);
    }
    
    // Message不符合Protocol-Zero格式
    console.log(`[!] Ignoring non-Protocol-Zero message type='${message.type}' from ${peerId}`);

    return false;
  }
}

export default ProtocolValidationHandler;
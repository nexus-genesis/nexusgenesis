import { ProtocolZeroSignalHandler } from './ProtocolZeroSignalHandler.js';
import { DirectMessageHandler } from './DirectMessageHandler.js';
import { TransactionHandler } from './TransactionHandler.js';
import { HandshakeHandler } from './HandshakeHandler.js';
import { BlockchainMessageHandler, NodeListHandler } from './BlockchainMessageHandler.js';
import { LightClientMessageHandler } from './LightClientMessageHandler.js';
import { StateSyncMessageHandler } from './StateSyncMessageHandler.js';

/**
 * MessageHandlerRegistry
 * 负责管理和调度各种MessageHandler
 */
export class MessageHandlerRegistry {
  constructor(p2pServer) {
    this.p2pServer = p2pServer;
    this.handlers = new Map();
    this.initializeHandlers();
  }

  /**
   * Initialize所有MessageHandler
   */
  initializeHandlers() {
    // Protocol-Zero 信号Handler
    this.register('PROTOCOL_ZERO', new ProtocolZeroSignalHandler(this.p2pServer));
    this.register('JOIN_SWARM', new ProtocolZeroSignalHandler(this.p2pServer));
    
    // 握手MessageHandler
    this.register('HELLO', new HandshakeHandler(this.p2pServer));
    this.register('HELLO_ACK', new HandshakeHandler(this.p2pServer));
    this.register('KEY_EXCHANGE', new HandshakeHandler(this.p2pServer));
    
    // 直接MessageHandler
    this.register('DIRECT_MESSAGE', new DirectMessageHandler(this.p2pServer));
    
    // transactionHandler
    this.register('TRANSACTION', new TransactionHandler(this.p2pServer));
    
    // block链MessageHandler
    this.register('BLOCK', new BlockchainMessageHandler(this.p2pServer));
    this.register('GET_BLOCKS', new BlockchainMessageHandler(this.p2pServer));
    this.register('BLOCKS_RESPONSE', new BlockchainMessageHandler(this.p2pServer));
    this.register('BLOCK_CONFIRMATION', new BlockchainMessageHandler(this.p2pServer));
    this.register('GET_STATUS', new BlockchainMessageHandler(this.p2pServer));
    this.register('STATUS_UPDATE', new BlockchainMessageHandler(this.p2pServer));
    this.register('GET_MEMPOOL', new BlockchainMessageHandler(this.p2pServer));
    this.register('MEMPOOL_SYNC', new BlockchainMessageHandler(this.p2pServer));
    this.register('NODE_LIST', new BlockchainMessageHandler(this.p2pServer));
    this.register('TX_REJECTED', new BlockchainMessageHandler(this.p2pServer));
    this.register('SWARM_ACK', new BlockchainMessageHandler(this.p2pServer));
    this.register('PROTOCOL_ERROR', new BlockchainMessageHandler(this.p2pServer));
    this.register('PONG', new BlockchainMessageHandler(this.p2pServer));
    this.register('PING', new BlockchainMessageHandler(this.p2pServer));
    
    // 状态同步MessageHandler
    this.register('STATE_SYNC_REQUEST', new StateSyncMessageHandler(this.p2pServer));
    this.register('STATE_SYNC_RESPONSE', new StateSyncMessageHandler(this.p2pServer));
    
    // 轻客户端MessageHandler
    this.register('LIGHT_CLIENT_HELLO', new LightClientMessageHandler(this.p2pServer));
    this.register('GET_BLOCK_HEADERS', new LightClientMessageHandler(this.p2pServer));
    this.register('GET_MERKLE_PROOF', new LightClientMessageHandler(this.p2pServer));
    this.register('GET_TRANSACTION_STATUS', new LightClientMessageHandler(this.p2pServer));
    this.register('GET_ADDRESS_BALANCE', new LightClientMessageHandler(this.p2pServer));
    this.register('SEND_TRANSACTION', new LightClientMessageHandler(this.p2pServer));
    this.register('CROSS_CHAIN_MESSAGE', new LightClientMessageHandler(this.p2pServer));
    
    // 特殊Handler: GET_NODE_LIST 不requiresVerify
    this.register('GET_NODE_LIST', new NodeListHandler(this.p2pServer));
  }

  /**
   * RegisterMessageHandler
   * @param {string} messageType - Messagetype
   * @param {MessageHandler} handler - MessageHandlerinstance
   */
  register(messageType, handler) {
    this.handlers.set(messageType, handler);
  }

  /**
   * getMessageHandler
   * @param {string} messageType - Messagetype
   * @returns {MessageHandler|null}
   */
  getHandler(messageType) {
    return this.handlers.get(messageType) || null;
  }

  /**
   * Check是否有对应的Handler
   * @param {string} messageType - Messagetype
   * @returns {boolean}
   */
  hasHandler(messageType) {
    return this.handlers.has(messageType);
  }

  /**
   * get所有Register的Messagetype
   * @returns {string[]}
   */
  getRegisteredMessageTypes() {
    return Array.from(this.handlers.keys());
  }
}
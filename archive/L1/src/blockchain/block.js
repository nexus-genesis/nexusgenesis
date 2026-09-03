/**
 * NexusGenesis - blockdata结构
 * 
 * Features: 
 * 1. 定义block结构
 * 2. 实现blockCreate和Verify
 * 3. Calculateblock hash
 */

import crypto from 'crypto';

/**
 * Calculatedata的 SHA-256 hash
 * @param {any} data 要hash的data
 * @returns {string} hash值(十六进制字符串)
 */
function calculateHash(data) {
  const jsonString = JSON.stringify(data);
  return '0x' + crypto.createHash('sha256').update(jsonString).digest('hex');
}

/**
 * blockclass
 */
export class Block {
  /**
   * Create一个新的block
   * @param {string} parentHash 上一个block的hash
   * @param {number} height block height
   * @param {number} timestamp timestamp
   * @param {Array} transactions transaction列表
   */
  constructor(parentHash, height, timestamp, transactions) {
    // Calculatetransactionhash
    const txsHash = calculateHash(transactions);
    
    // Block header
    this.header = {
      parent_hash: parentHash,
      height: height,
      timestamp: timestamp,
      txs_hash: txsHash
    };
    
    // block体
    this.body = {
      transactions: transactions
    };
    
    // Calculateblock hash
    this.hash = this.calculateBlockHash();
  }
  
  /**
   * Calculateblock hash
   * @returns {string} block hash
   */
  calculateBlockHash() {
    return calculateHash(this.header);
  }
  
  /**
   * Verifyblock
   * @returns {boolean} verification result
   */
  validate() {
    // Verifytransactionhash
    const calculatedTxsHash = calculateHash(this.body.transactions);
    if (calculatedTxsHash !== this.header.txs_hash) {
      return false;
    }
    
    // Verifyblock hash
    const calculatedBlockHash = this.calculateBlockHash();
    if (calculatedBlockHash !== this.hash) {
      return false;
    }
    
    return true;
  }
  
  /**
   * 将block转换为 JSON 对象
   * @returns {object} JSON 对象
   */
  toJSON() {
    return {
      hash: this.hash,
      header: this.header,
      body: this.body
    };
  }
  
  /**
   * 从 JSON 对象Createblock
   * @param {object} json JSON 对象
   * @returns {Block} blockinstance
   */
  static fromJSON(json) {
    const block = new Block(
      json.header.parent_hash,
      json.header.height,
      json.header.timestamp,
      json.body.transactions
    );
    block.hash = json.hash;
    return block;
  }
}

/**
 * Creategenesis block
 * @returns {Block} genesis block
 */
export function createGenesisBlock() {
  const genesisTransactions = [];
  
  // Fixed timestamp for deterministic genesis block hash
  return new Block(
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    0,
    0,
    genesisTransactions
  );
}

/**
 * 从transactionCreateNew block
 * @param {Block} previousBlock 上一个block
 * @param {Array} transactions transaction列表
 * @returns {Block} New block
 */
export function createBlock(previousBlock, transactions) {
  return new Block(
    previousBlock.hash,
    previousBlock.header.height + 1,
    Date.now(),
    transactions
  );
}

// ExportDefault值
export default {
  Block,
  createGenesisBlock,
  createBlock,
  calculateHash
};

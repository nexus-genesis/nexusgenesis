/**
 * NexusGenesis - Base Wallet Class
 * 钱包基类实现 — 统一使用 32 字节 PQC 密钥哈希（白皮书 v4.5）
 */

import crypto from 'crypto';
import { hash, randomBytes } from '../crypto/pqc.js';
import { generateAddress, validateAddress as validateAddr } from './addressUtils.js';
import { base58Encode, base58Decode } from './base58.js';

/**
 * 钱包基类
 */
export class Wallet {
  constructor() {
    this.address = null;
    this.publicKey = null;
    this.privateKey = null;
    this.balance = 0n;
    this.nonce = 0;
  }

  static generateAddress(publicKey) {
    return generateAddress(publicKey);
  }

  static base58Encode(buffer) {
    return base58Encode(buffer);
  }

  static base58Decode(str) {
    return base58Decode(str);
  }

  static validateAddress(address) {
    return validateAddr(address);
  }

  /**
   * Signtransaction
   * @param {object} transaction transaction对象
   * @returns {Promise<Buffer>} Sign
   */
  async signTransaction(transaction) {
    throw new Error('signTransaction must be implemented by subclass');
  }

  /**
   * VerifytransactionSign
   * @param {object} transaction transaction对象
   * @param {Buffer} signature Sign
   * @returns {Promise<boolean>} verification result
   */
  async verifyTransaction(transaction, signature) {
    throw new Error('verifyTransaction must be implemented by subclass');
  }

  /**
   * get钱包info
   * @returns {object} 钱包info
   */
  getInfo() {
    return {
      address: this.address,
      balance: this.balance.toString(),
      publicKey: this.publicKey ? this.publicKey.toString('hex') : null
    };
  }

  /**
   * Save钱包到文件
   * @param {string} filePath 文件路径
   * @returns {Promise<void>}
   */
  async save(filePath) {
    throw new Error('save must be implemented by subclass');
  }

  /**
   * 从文件Load钱包
   * @param {string} filePath 文件路径
   * @returns {Promise<Wallet>}
   */
  static async load(filePath) {
    throw new Error('load must be implemented by subclass');
  }
}

export default Wallet;
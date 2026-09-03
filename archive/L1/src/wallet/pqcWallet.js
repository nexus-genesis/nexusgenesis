/**
 * NexusGenesis - PQC Wallet Implementation
 * based onDilithium2的post-quantum钱包实现
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Wallet } from './wallet.js';
import { generateAddress, validateAddress } from './addressUtils.js';
import { generateKeyPair, sign, verify, hash } from '../crypto/pqc.js';
import {
  encryptPrivateKey,
  decryptPrivateKey,
  isValidEnvelope,
  WalletEncryptionError
} from './walletEncryption.js';
import { secureZero } from './secureMemory.js';

/**
 * PQC钱包class
 */
export class PQCWallet extends Wallet {
  /**
   * 构造function
   * @param {Buffer} publicKey public key
   * @param {Buffer} privateKey private key
   * @param {bigint} balance balance
   */
  constructor(publicKey, privateKey, balance = 0n, nonce = 0) {
    super();
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.address = Wallet.generateAddress(publicKey);
    this.balance = balance;
    this.nonce = nonce;
  }

  /**
   * secretKey 别名, 兼容不同命名习惯
   * @returns {Buffer}
   */
  get secretKey() {
    return this.privateKey;
  }

  /**
   * 销毁内存中的私钥材料（确定性覆写，幂等）。
   * 调用后钱包不可再签名；publicKey/address/balance 保留可读。
   * 能力边界：覆盖显式持有的 Buffer；不覆盖 V8 栈拷贝/JIT 中间数据/
   * 库内部副本（详见 secureMemory.js 头部声明）。
   */
  destroy() {
    if (this.privateKey) {
      secureZero(this.privateKey);
      this.privateKey = null;
    }
  }

  /** 私钥材料是否已销毁 */
  get isDestroyed() {
    return this.privateKey === null;
  }

  /**
   * Generate新钱包
   * @param {bigint} initialBalance 初始balance
   * @returns {Promise<PQCWallet>} 新钱包
   */
  static async generate(initialBalance = 0n) {
    try {
      const { publicKey, privateKey } = await generateKeyPair();
      return new PQCWallet(publicKey, privateKey, initialBalance);
    } catch (error) {
      console.error('Error generating PQC wallet:', error.message);
      throw error;
    }
  }

  /**
   * 从文件Load钱包 (supports encrypted and legacy plaintext)
   * @param {string} filePath 文件路径
   * @param {string} masterKeyHex - 32-byte master key as hex (required if encrypted)
   * @returns {Promise<PQCWallet>} 钱包instance
   */
  static async load(filePath, masterKeyHex = null) {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const walletData = JSON.parse(data);

      const publicKey = Buffer.from(walletData.publicKey, 'hex');
      const balance = BigInt(walletData.balance || 0);
      const nonce = walletData.nonce || 0;

      // Decrypt or read legacy
      let privateKey;
      if (walletData.encryptedPrivateKey) {
        if (!masterKeyHex) {
          throw new Error('Master key required to decrypt wallet file');
        }
        privateKey = decryptPrivateKey(walletData.encryptedPrivateKey, masterKeyHex);
      } else if (walletData.privateKey) {
        // LEGACY: plaintext private key
        privateKey = Buffer.from(walletData.privateKey, 'hex');
      } else {
        throw new Error('No private key found in wallet file');
      }

      return new PQCWallet(publicKey, privateKey, balance, nonce);
    } catch (error) {
      console.error('Error loading PQC wallet:', error.message);
      throw error;
    }
  }

  /**
   * Save钱包到文件 (AES-256-GCM encrypted)
   * @param {string} filePath 文件路径
   * @param {string} masterKeyHex - 32-byte master key as hex (server-managed)
   * @returns {Promise<void>}
   */
  async save(filePath, masterKeyHex = null) {
    try {
      const walletData = {
        address: this.address,
        publicKey: this.publicKey.toString('hex'),
        balance: this.balance.toString(),
        nonce: this.nonce,
        savedAt: new Date().toISOString()
      };

      // Encrypt private key with master key (server-side storage)
      if (masterKeyHex) {
        const envelope = encryptPrivateKey(this.privateKey, masterKeyHex, {
          address: this.address,
          publicKey: this.publicKey.toString('hex')
        });
        walletData.encryptedPrivateKey = envelope;
      } else {
        // No master key: use legacy plaintext (backward compat, NOT recommended)
        walletData.privateKey = this.privateKey.toString('hex');
      }

      // ensure目录存在
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(filePath, JSON.stringify(walletData, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error('Error saving PQC wallet:', error.message);
      throw error;
    }
  }

  /**
   * SignMessage
   * @param {string|object} message to signMessage
   * @returns {Promise<string>} Sign(十六进制)
   */
  async sign(message) {
    try {
      const messageStr = typeof message === 'object' ? JSON.stringify(message) : message;
      const signature = await sign(messageStr, this.privateKey);
      return signature.toString('hex');
    } catch (error) {
      console.error('Error signing message:', error.message);
      throw error;
    }
  }

  /**
   * VerifySign
   * @param {string|object} message originalMessage
   * @param {string|Buffer} signature Sign
   * @param {Buffer} publicKey public key
   * @returns {Promise<boolean>} verification result
   */
  async verify(message, signature, publicKey) {
    try {
      const messageStr = typeof message === 'object' ? JSON.stringify(message) : message;
      const sigBuffer = typeof signature === 'string' ? Buffer.from(signature, 'hex') : signature;
      const pk = publicKey || this.publicKey;
      const isValid = await verify(messageStr, sigBuffer, pk);
      return isValid;
    } catch (error) {
      console.error('Error verifying signature:', error.message);
      return false;
    }
  }

  /**
   * 静态SignVerify(兼容直接call)
   * @param {string|object} message originalMessage
   * @param {string|Buffer} signature Sign
   * @param {Buffer} publicKey public key
   * @returns {Promise<boolean>} verification result
   */
  static async verify(message, signature, publicKey) {
    try {
      const messageStr = typeof message === 'object' ? JSON.stringify(message) : message;
      const sigBuffer = typeof signature === 'string' ? Buffer.from(signature, 'hex') : signature;
      const pkBuffer = typeof publicKey === 'string' ? Buffer.from(publicKey, 'hex') : publicKey;
      return await verify(messageStr, sigBuffer, pkBuffer);
    } catch (error) {
      console.error('Error verifying signature:', error.message);
      return false;
    }
  }

  /**
   * 使用私钥签名（静态方法）
   * @param {string|object} message - 待签名消息
   * @param {string} privateKeyHex - 十六进制私钥
   * @returns {Promise<string>} 十六进制签名
   */
  static async signWithPrivateKey(message, privateKeyHex) {
    const messageStr = typeof message === 'object' ? JSON.stringify(message) : message;
    const privateKey = Buffer.from(privateKeyHex, 'hex');
    const signature = await sign(messageStr, privateKey);
    return signature.toString('hex');
  }

  /**
   * Signtransaction
   * @param {object} transaction transaction对象
   * @returns {Promise<string>} Sign(十六进制)
   */
  async signTransaction(transaction) {
    try {
      const { signature, ...txData } = transaction;
      const txStr = JSON.stringify(txData, (key, value) => {
        if (typeof value === 'bigint') return value.toString();
        return value;
      });
      return await this.sign(txStr);
    } catch (error) {
      console.error('Error signing transaction:', error.message);
      throw error;
    }
  }

  /**
   * VerifytransactionSign
   * @param {object} transaction transaction对象
   * @param {string} signature Sign
   * @returns {Promise<boolean>} verification result
   */
  async verifyTransaction(transaction, signature) {
    try {
      const { signature: _, ...txData } = transaction;
      const txStr = JSON.stringify(txData, (key, value) => {
        if (typeof value === 'bigint') return value.toString();
        return value;
      });
      return await this.verify(txStr, signature, this.publicKey);
    } catch (error) {
      console.error('Error verifying transaction:', error.message);
      return false;
    }
  }

  /**
   * Updatebalance
   * @param {bigint} amount amount
   */
  updateBalance(amount) {
    this.balance += amount;
  }

  /**
   * 加密Export钱包 (AES-256-GCM + PBKDF2)
   * @param {string} password 加密密码
   * @returns {object} 加密的envelope
   */
  exportEncrypted(password) {
    // 如果 privateKey 为 null（浏览器生成的密钥），无法导出加密钱包
    // 因为私钥从未在服务器上
    if (!this.privateKey) {
      return null;
    }
    return encryptPrivateKey(this.privateKey, password, {
      address: this.address,
      publicKey: this.publicKey.toString('hex')
    });
  }

  /**
   * 从加密envelopeImport钱包 (AES-256-GCM)
   * @param {object} envelope 加密的envelope
   * @param {string} password 解密密码
   * @returns {PQCWallet|null} 钱包instance
   */
  static importEncrypted(envelope, password) {
    try {
      if (!isValidEnvelope(envelope)) {
        // Backward compat: try old CBC format
        if (envelope && envelope.ciphertext && envelope.salt && envelope.iv && !envelope.authTag) {
          return PQCWallet._importLegacyCBC(envelope, password);
        }
        return null;
      }
      const privateKey = decryptPrivateKey(envelope, password);
      const publicKey = Buffer.from(envelope.metadata.publicKey, 'hex');
      return new PQCWallet(publicKey, privateKey, 0n);
    } catch (error) {
      return null;
    }
  }

  /**
   * Legacy CBC format importer (for backward compat with old data)
   * @private
   */
  static _importLegacyCBC(encrypted, password) {
    try {
      const salt = Buffer.from(encrypted.salt, 'hex');
      const iv = Buffer.from(encrypted.iv, 'hex');
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');

      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let privateKeyHex = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
      privateKeyHex += decipher.final('utf8');

      const privateKey = Buffer.from(privateKeyHex, 'hex');
      const publicKey = Buffer.from(encrypted.publicKey, 'hex');
      return new PQCWallet(publicKey, privateKey, 0n);
    } catch (error) {
      return null;
    }
  }

  /**
   * Checkbalance是否足够
   * @param {bigint} amount amount
   * @returns {boolean} balance是否足够
   */
  hasEnoughBalance(amount) {
    return this.balance >= amount;
  }
}

export { validateAddress };

/**
 * transactionclass
 */
export class Transaction {
  /**
   * Create并Verifytransaction
   * @param {PQCWallet} wallet Send方钱包
   * @param {string} to Receiveaddress
   * @param {bigint} amount amount
   * @param {bigint} fee fee
   * @param {string} type transactiontype
   * @param {object} data transactiondata
   * @returns {Transaction} transactioninstance
   */
  static create(wallet, to, amount, feeOrData = 1n, type = 'TRANSFER', data = {}) {
    const { valid, reason } = validateAddress(to);
    if (!valid) {
      throw new Error(`Invalid recipient address: ${reason}`);
    }
    let fee = 1n;
    if (typeof feeOrData === 'bigint') {
      fee = feeOrData;
    } else if (typeof feeOrData === 'string') {
      data = data || {};
      data.metadata = feeOrData;
    }
    if (!wallet.hasEnoughBalance(amount + fee)) {
      throw new Error('Insufficient balance');
    }
    return new Transaction(wallet.address, to, amount, fee, type, data);
  }

  /**
   * 构造function
   * @param {string} from Sendaddress
   * @param {string} to Receiveaddress
   * @param {bigint} amount amount
   * @param {bigint} fee fee
   * @param {string} type transactiontype
   * @param {object} data transactiondata
   */
  constructor(from, to, amount, fee = 1n, type = 'TRANSFER', data = {}) {
    this.id = `tx-${hash(Date.now().toString() + Math.random().toString(), 'sha3-256').slice(0, 16)}`;
    this.from = from;
    this.to = to;
    this.amount = amount;
    this.fee = fee;
    this.type = type;
    this.data = data;
    this.timestamp = Date.now();
    this.signature = null;
  }

  /**
   * Signtransaction
   * @param {PQCWallet} wallet 钱包
   * @returns {Promise<Transaction>} Sign后的transaction
   */
  async sign(wallet) {
    this.signature = await wallet.signTransaction(this);
    return this;
  }

  /**
   * Verifytransaction
   * @param {PQCWallet} wallet 钱包
   * @returns {Promise<boolean>} verification result
   */
  async verify(wallet) {
    if (!this.signature) {
      return false;
    }
    return await wallet.verifyTransaction(this, this.signature);
  }

  /**
   * VerifytransactionSign(usingpublic key)
   * @param {Buffer} publicKey public key
   * @returns {Promise<boolean>} verification result
   */
  async verifySignature(publicKey) {
    if (!this.signature) {
      return false;
    }
    try {
      const txData = { ...this.toJSON ? this.toJSON() : this };
      const sigBuffer = typeof this.signature === 'string'
        ? Buffer.from(this.signature, 'hex')
        : this.signature;
      const jsonReplacer = (key, value) => {
        if (typeof value === 'bigint') return value.toString();
        return value;
      };
      const txStr = JSON.stringify(txData, jsonReplacer);
      return await verify(txStr, sigBuffer, publicKey);
    } catch (error) {
      console.error('Error verifying transaction signature:', error.message);
      return false;
    }
  }

  /**
   * Calculatetransactionhash
   * @returns {string} transactionhash
   */
  getHash() {
    const { signature, ...txData } = this;
    return hash(JSON.stringify(txData), 'sha3-256');
  }

  /**
   * 转换为JSON格式
   * @returns {object} JSON对象
   */
  toJSON() {
    return {
      ...this,
      amount: this.amount.toString(),
      fee: this.fee.toString()
    };
  }
}

export default PQCWallet;
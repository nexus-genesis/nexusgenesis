/**
 * NexusGenesis - data完整性校验Module
 * 为持久化data提供hashVerify和完整性保护
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DataIntegrityChecker {
  constructor() {
    this.hashAlgorithm = 'sha256';
    this.integrityFile = path.join(__dirname, '../../data/integrity.json');
    this.checksums = new Map(); // 文件路径 -> 校验和
  }

  /**
   * Calculatedata的hash值
   * @param {string|object} data - data(字符串或对象)
   * @returns {string} hash值
   */
  computeHash(data) {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    return crypto.createHash(this.hashAlgorithm).update(dataStr).digest('hex');
  }

  /**
   * Savedata并记录校验和
   * @param {string} filePath - 文件路径
   * @param {object|string} data - 要Save的data
   * @returns {boolean} 是否success
   */
  saveWithIntegrity(filePath, data) {
    try {
      // ensure目录存在
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Calculateoriginaldata的hash
      const hash = this.computeHash(data);
      
      // Savedata
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      fs.writeFileSync(filePath, dataStr);
      
      // 记录校验和
      this.checksums.set(filePath, {
        hash,
        timestamp: Date.now(),
        size: Buffer.byteLength(dataStr)
      });
      
      // Save校验和到文件
      this.saveChecksums();
      
      console.log(`[DataIntegrity] Saved ${path.basename(filePath)} with integrity hash`);
      return true;
    } catch (error) {
      console.error(`[DataIntegrity] Error saving with integrity:`, error.message);
      return false;
    }
  }

  /**
   * Loaddata并Verify完整性
   * @param {string} filePath - 文件路径
   * @returns {object|null} data对象或null(如果VerifyFailed)
   */
  loadWithIntegrity(filePath) {
    if (!fs.existsSync(filePath)) {
      console.log(`[DataIntegrity] File not found: ${filePath}`);
      return null;
    }
    
    try {
      // Loaddata
      const dataStr = fs.readFileSync(filePath, 'utf8');
      const hash = this.computeHash(dataStr);
      
      // getSaved的校验和
      const savedChecksum = this.checksums.get(filePath);
      
      if (savedChecksum && savedChecksum.hash !== hash) {
        console.error(`[DataIntegrity] Integrity check FAILED for ${path.basename(filePath)}`);
        console.error(`  Expected: ${savedChecksum.hash}`);
        console.error(`  Actual:   ${hash}`);
        
        // can选择抛出exception或Returnnull
        throw new Error('Data integrity check failed - possible tampering detected');
      }
      
      // 解析JSONdata
      let parsedData;
      try {
        parsedData = JSON.parse(dataStr);
      } catch (parseError) {
        // 如果不是有效的JSON, Returnoriginal字符串
        parsedData = dataStr;
      }
      
      console.log(`[DataIntegrity] Loaded and verified ${path.basename(filePath)} successfully`);
      return parsedData;
    } catch (error) {
      console.error(`[DataIntegrity] Error loading with integrity:`, error.message);
      throw error;
    }
  }

  /**
   * Save校验和到文件
   */
  saveChecksums() {
    try {
      const checksumsObj = {};
      this.checksums.forEach((value, key) => {
        checksumsObj[key] = value;
      });
      
      const dir = path.dirname(this.integrityFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.integrityFile, JSON.stringify(checksumsObj, null, 2));
    } catch (error) {
      console.error('[DataIntegrity] Error saving checksums:', error.message);
    }
  }

  /**
   * 从文件Load校验和
   */
  loadChecksums() {
    try {
      if (fs.existsSync(this.integrityFile)) {
        const data = JSON.parse(fs.readFileSync(this.integrityFile, 'utf8'));
        this.checksums = new Map(Object.entries(data));
        console.log(`[DataIntegrity] Loaded ${this.checksums.size} checksums`);
      }
    } catch (error) {
      console.error('[DataIntegrity] Error loading checksums:', error.message);
      this.checksums = new Map();
    }
  }

  /**
   * Verify特定文件的完整性
   * @param {string} filePath - 文件路径
   * @returns {object} verification result
   */
  verifyFileIntegrity(filePath) {
    if (!fs.existsSync(filePath)) {
      return {
        valid: false,
        error: 'File not found'
      };
    }
    
    try {
      const dataStr = fs.readFileSync(filePath, 'utf8');
      const currentHash = this.computeHash(dataStr);
      const savedChecksum = this.checksums.get(filePath);
      
      if (!savedChecksum) {
        return {
          valid: false,
          error: 'No saved checksum found',
          currentHash
        };
      }
      
      return {
        valid: savedChecksum.hash === currentHash,
        expectedHash: savedChecksum.hash,
        actualHash: currentHash,
        lastVerified: savedChecksum.timestamp
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Verify所有已知文件的完整性
   * @returns {Array<object>} 所有文件的verification result
   */
  verifyAllFiles() {
    const results = [];
    
    this.checksums.forEach((checksum, filePath) => {
      results.push({
        filePath,
        ...this.verifyFileIntegrity(filePath)
      });
    });
    
    return results;
  }

  /**
   * Update文件的校验和(在文件被外部修改后call)
   * @param {string} filePath - 文件路径
   */
  updateChecksum(filePath) {
    if (fs.existsSync(filePath)) {
      const dataStr = fs.readFileSync(filePath, 'utf8');
      const hash = this.computeHash(dataStr);
      
      this.checksums.set(filePath, {
        hash,
        timestamp: Date.now(),
        size: Buffer.byteLength(dataStr)
      });
      
      this.saveChecksums();
      console.log(`[DataIntegrity] Updated checksum for ${path.basename(filePath)}`);
    }
  }

  /**
   * get文件统计info
   * @returns {object} 统计info
   */
  getStats() {
    return {
      totalTrackedFiles: this.checksums.size,
      hashAlgorithm: this.hashAlgorithm,
      integrityFile: this.integrityFile
    };
  }

  /**
   * Initialize: Load已有的校验和
   */
  init() {
    this.loadChecksums();
    console.log('[DataIntegrity] Initialized');
  }
}

// 单例instance
const dataIntegrityInstance = new DataIntegrityInstance();

function DataIntegrityInstance() {
  this.checker = new DataIntegrityChecker();
  
  this.init = function() {
    this.checker.init();
  };
  
  this.saveWithIntegrity = function(filePath, data) {
    return this.checker.saveWithIntegrity(filePath, data);
  };
  
  this.loadWithIntegrity = function(filePath) {
    return this.checker.loadWithIntegrity(filePath);
  };
  
  this.verifyFileIntegrity = function(filePath) {
    return this.checker.verifyFileIntegrity(filePath);
  };
  
  this.verifyAllFiles = function() {
    return this.checker.verifyAllFiles();
  };
  
  this.updateChecksum = function(filePath) {
    return this.checker.updateChecksum(filePath);
  };
  
  this.getStats = function() {
    return this.checker.getStats();
  };
}

export default dataIntegrityInstance;

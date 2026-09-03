/**
 * Smart Contract管理器
 * 负责Deploy和ExecuteAINVMSmart Contract
 */

import AINVM from '../vm/ainvm.js';
import { SandboxExecutor, STANDARD_CONFIG, STRICT_CONFIG } from '../vm/sandbox.js';
import fs from 'fs/promises';
import path from 'path';

class ContractManager {
  constructor() {
    this.contracts = new Map(); // ContractID -> Contract对象
    this.storage = new Map();   // ContractID -> Storagestatus
    this.contractCounter = 0;   // ContractIDcount器(确定性)
    this.executingContracts = new Set(); // 正在Execute的Contract(重入保护)
    this.sandbox = new SandboxExecutor(STANDARD_CONFIG);
    this.verifiedContracts = new Set(); // 已Verify的ContractID集合
  }

  /**
   * DeploySmart Contract
   * @param {Array} bytecode - AINVMbytecode
   * @param {string} name - Contract名称
   * @param {string} owner - Contract所有者address
   * @param {boolean} optimize - 是否优化bytecode
   * @returns {string} ContractID
   */
  deployContract(bytecode, name = 'Unnamed Contract', owner = null, optimize = true) {
    // Verifybytecode
    if (!Array.isArray(bytecode) || bytecode.length === 0) {
      throw new Error('Invalid bytecode');
    }
    if (bytecode.length > 10000) {
      throw new Error('Bytecode too large');
    }
    
    // 优化bytecode
    let optimizedBytecode = bytecode;
    if (optimize) {
      const vm = new AINVM();
      optimizedBytecode = vm.optimizeBytecode(bytecode);
      console.log(`Optimized bytecode: ${bytecode.length} -> ${optimizedBytecode.length} bytes`);
    }
    
    // GenerateContractID - using确定性method
    const contractId = `contract_${Date.now()}_${this.contractCounter++}`;
    
    const contract = {
      id: contractId,
      name,
      bytecode: optimizedBytecode,
      originalBytecode: bytecode,
      deployedAt: Date.now(),
      owner, // SaveContract所有者
      version: 1,
      upgradeHistory: []
    };
    
    this.contracts.set(contractId, contract);
    this.storage.set(contractId, new Map());
    
    return contractId;
  }

  /**
   * CheckContractpermission
   * @param {string} contractId - ContractID
   * @param {string} address - call者address
   * @returns {boolean} 是否有permission
   */
  checkContractPermission(contractId, address) {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      throw new Error('Contract not found');
    }
    
    // 如果没有Set所有者, 则任何人都cancall
    if (!contract.owner) {
      return true;
    }
    
    return contract.owner === address;
  }

  /**
   * 升级Smart Contract
   * @param {string} contractId - ContractID
   * @param {Array} newBytecode - 新的AINVMbytecode
   * @param {string} caller - call者address(must是Contract所有者)
   * @returns {object} 升级结果
   */
  upgradeContract(contractId, newBytecode, caller) {
    // Verifyparameter
    if (!contractId) {
      throw new Error('Contract ID is required');
    }
    if (!Array.isArray(newBytecode) || newBytecode.length === 0) {
      throw new Error('Invalid bytecode');
    }
    if (newBytecode.length > 10000) {
      throw new Error('Bytecode too large');
    }
    
    const contract = this.contracts.get(contractId);
    if (!contract) {
      throw new Error('Contract not found');
    }

    // permissionCheck - 只有Contract所有者can升级
    if (!this.checkContractPermission(contractId, caller)) {
      throw new Error('Permission denied: only contract owner can upgrade');
    }

    // Save旧版本info
    const oldVersion = {
      version: contract.version,
      bytecode: contract.bytecode,
      upgradedAt: Date.now()
    };

    // UpdateContract
    contract.bytecode = newBytecode;
    contract.version += 1;
    contract.upgradeHistory.push(oldVersion);

    // 限制升级历史记录大小
    if (contract.upgradeHistory.length > 10) {
      contract.upgradeHistory.shift();
    }

    return {
      success: true,
      contractId,
      oldVersion: oldVersion.version,
      newVersion: contract.version,
      message: `Contract upgraded from version ${oldVersion.version} to ${contract.version}`
    };
  }

  /**
   * ExecuteSmart Contract
   * @param {string} contractId - ContractID
   * @param {number} gasLimit - gas限制
   * @param {string} caller - call者address(可选)
   * @returns {object} Execute结果
   */
  async executeContract(contractId, gasLimit = 1000, caller = null) {
    // Verifyparameter
    if (!contractId) {
      throw new Error('Contract ID is required');
    }
    if (gasLimit <= 0 || gasLimit > 1000000) {
      throw new Error('Invalid gas limit');
    }
    
    const contract = this.contracts.get(contractId);
    if (!contract) {
      throw new Error('Contract not found');
    }

    // permissionCheck
    if (caller && !this.checkContractPermission(contractId, caller)) {
      throw new Error('Permission denied');
    }

    // 重入保护
    if (this.executingContracts.has(contractId)) {
      throw new Error('Reentrancy detected');
    }

    this.executingContracts.add(contractId);
    
    try {
      // viasandboxsecurityExecute contract(security宪法 §6.2)
      // sandboxautoExecuteStatic Analysis + Resource Limits + 时限保护
      const deployer = contract.owner || 'unknown';
      const result = await this.sandbox.execute(
        contract.bytecode,
        gasLimit,
        deployer
      );
      
      // sandbox拒绝 → 直接Return拒绝info
      if (result.sandboxRejected) {
        return result;
      }
      
      // UpdateContractStorage
      if (result.success && result.memory && !result.memoryTruncated) {
        const memory = result.memory;
        
        // Storage大小限制(1MB)
        const MAX_STORAGE_SIZE = 1024 * 1024;
        const storageSize = Object.entries(memory).reduce((size, [key, value]) => {
          return size + JSON.stringify(key).length + JSON.stringify(value).length;
        }, 0);
        
        if (storageSize > MAX_STORAGE_SIZE) {
          throw new Error('Storage size exceeded');
        }
        
        // 同步memory到Storage
        const storage = this.storage.get(contractId);
        storage.clear();
        for (const [key, value] of Object.entries(memory)) {
          if (key.startsWith('_')) continue; // 跳过内部键
          const parsedKey = isNaN(key) ? key : parseInt(key);
          storage.set(parsedKey, value);
        }
      }
      
      return result;
    } finally {
      this.executingContracts.delete(contractId);
    }
  }

  /**
   * getContractinfo
   * @param {string} contractId - ContractID
   * @returns {object} Contractinfo
   */
  getContractInfo(contractId) {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      return null;
    }

    const storage = this.storage.get(contractId);
    
    return {
      ...contract,
      storage: Object.fromEntries(storage),
      version: contract.version || 1,
      upgradeHistory: contract.upgradeHistory || []
    };
  }

  /**
   * 列出所有Contract
   * @returns {Array} Contract列表
   */
  listContracts() {
    return Array.from(this.contracts.values()).map(contract => ({
      id: contract.id,
      name: contract.name,
      deployedAt: contract.deployedAt,
      bytecodeLength: contract.bytecode.length
    }));
  }

  /**
   * 估算ContractGas消耗
   * @param {string} contractId - ContractID
   * @returns {number} 估算的Gas消耗
   */
  estimateGas(contractId) {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      throw new Error('Contract not found');
    }
    
    const vm = new AINVM();
    return vm.estimateGas(contract.bytecode);
  }

  /**
   * 优化Contractbytecode
   * @param {string} contractId - ContractID
   * @returns {object} 优化结果
   */
  optimizeContract(contractId) {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      throw new Error('Contract not found');
    }
    
    const vm = new AINVM();
    const optimizedBytecode = vm.optimizeBytecode(contract.bytecode);
    
    // Save优化后的bytecode
    contract.bytecode = optimizedBytecode;
    
    return {
      success: true,
      contractId,
      originalSize: contract.originalBytecode.length,
      optimizedSize: optimizedBytecode.length,
      reduction: ((1 - optimizedBytecode.length / contract.originalBytecode.length) * 100).toFixed(2) + '%'
    };
  }

  /**
   * SaveContract status到磁盘
   * @param {string} filePath - 文件路径
   */
  async saveState(filePath = 'data/contracts/contracts.json') {
    const state = {
      contracts: Array.from(this.contracts.entries()).map(([id, contract]) => ({
        id,
        ...contract,
        storage: Object.fromEntries(this.storage.get(id))
      })),
      savedAt: Date.now()
    };

    // ensure目录存在
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  }

  /**
   * Load from diskContract status
   * @param {string} filePath - 文件路径
   */
  async loadState(filePath = 'data/contracts/contracts.json') {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const state = JSON.parse(data);

      this.contracts.clear();
      this.storage.clear();

      for (const contractData of state.contracts) {
        const contract = {
          id: contractData.id,
          name: contractData.name,
          bytecode: contractData.bytecode,
          deployedAt: contractData.deployedAt,
          owner: contractData.owner,
          version: contractData.version || 1,
          upgradeHistory: contractData.upgradeHistory || []
        };

        this.contracts.set(contract.id, contract);
        
        const storage = new Map();
        for (const [key, value] of Object.entries(contractData.storage)) {
          storage.set(key, value);
        }
        this.storage.set(contract.id, storage);
      }
    } catch (error) {
      console.log('No existing contract state found, starting fresh');
    }
  }
}

// Export单例
const contractManager = new ContractManager();
export default contractManager;
export { ContractManager };
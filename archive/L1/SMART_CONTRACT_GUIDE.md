# AINVM Smart Contract开发指南

## 1. AINVM 虚拟机简介

AINVM (AI Network Virtual Machine) 是一个based onstack机模型的虚拟机，专为Smart ContractExecute设计。它具有以下特点：

- **确定性Execute**：相同的输入总是产生相同的输出
- **可计费**：通过 gas 机制控制Execute资源消耗
- **security隔离**：ContractExecute在隔离环境中，不会影响系统其他部分
- **矩阵运算support**：内置矩阵运算指令，support复杂Calculate

## 2. Smart Contract开发基础

### 2.1 bytecode结构

AINVM Smart Contract使用bytecode数组表示，每个指令由一个opcode和可选的operand组成。e.g.：

```javascript
// 计数器Contractbytecode
const counterBytecode = [
  0x07, 0x00, // LOAD 0
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x08, 0x00, // STORE 0
  0x07, 0x00, // LOAD 0
  0x0C        // RETURN
];
```

### 2.2 Memory管理

AINVM 使用键值对StorageMemory，support数字和字符串键：

- 数字键：for简单变量Storage
- 字符串键：for复杂data结构（如矩阵）

### 2.3 Gas 计费

每个指令Execute都会消耗一定的 gas，防止无限循环和资源滥用：

- 简单指令（PUSH, POP）：1 gas
- 算术指令（ADD, SUB）：2 gas
- Storage指令（LOAD, STORE）：2 gas
- 矩阵指令：根据操作复杂度Calculate

## 3. instruction set参考

### 3.1 基础指令

| opcode | 指令 | 描述 | stack操作 | Gas 消耗 |
|--------|------|------|--------|----------|
| 0x01 | PUSH | 将值压入stack | [] → [value] | 1 |
| 0x02 | POP | 从stack中弹出值 | [value] → [] | 1 |
| 0x03 | ADD | 加法 | [a, b] → [a+b] | 2 |
| 0x04 | SUB | 减法 | [a, b] → [b-a] | 2 |
| 0x05 | MUL | 乘法 | [a, b] → [a*b] | 3 |
| 0x06 | DIV | 除法 | [a, b] → [b/a] | 3 |
| 0x07 | LOAD | 从MemoryLoad值 | [] → [value] | 2 |
| 0x08 | STORE | Storage值到Memory | [value] → [] | 2 |
| 0x09 | JMP | 无条件跳转 | [] → [] | 1 |
| 0x0A | JZ | 条件跳转 | [value] → [] | 2 |
| 0x0B | HALT | StopExecute | [] → [] | 0 |
| 0x0C | RETURN | Return结果 | [value] → [] | 0 |

### 3.2 矩阵运算指令

| opcode | 指令 | 描述 | stack操作 | Gas 消耗 |
|--------|------|------|--------|----------|
| 0x10 | MAT_CREATE | Create矩阵 | [rows, cols] → [matrix_id] | 5 + rows*cols |
| 0x11 | MAT_ADD | 矩阵加法 | [mat1, mat2] → [result] | 10 * rows * cols |
| 0x12 | MAT_MUL | 矩阵乘法 | [mat1, mat2] → [result] | 15 * complexity |
| 0x13 | MAT_TRANS | 矩阵转置 | [matrix] → [result] | 10 * rows * cols |
| 0x14 | MAT_LOAD | Load矩阵元素 | [mat, row, col] → [value] | 3 |
| 0x15 | MAT_STORE | Storage矩阵元素 | [mat, row, col, value] → [] | 3 |

## 4. Smart Contract示例

### 4.1 计数器Contract

```javascript
/**
 * 计数器Smart Contract
 * Features：每次Execute计数器加1
 */

import contractManager from '../contractManager.js';

// 计数器Contractbytecode
const counterBytecode = [
  0x07, 0x00, // LOAD 0
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x08, 0x00, // STORE 0
  0x07, 0x00, // LOAD 0
  0x0C        // RETURN
];

// Deploy计数器Contract
async function deployCounterContract() {
  const contractId = contractManager.deployContract(counterBytecode, 'Counter Contract');
  console.log(`Counter contract deployed with ID: ${contractId}`);
  return contractId;
}

// Execute计数器Contract
async function executeCounterContract(contractId) {
  const result = contractManager.executeContract(contractId);
  console.log('Counter execution result:', result);
  return result;
}

// Test计数器Contract
async function testCounterContract() {
  console.log('=== Testing Counter Contract ===');
  
  // DeployContract
  const contractId = await deployCounterContract();
  
  // ExecuteContract多次
  console.log('Initial counter value:', contractManager.getContractInfo(contractId).storage['0'] || 0);
  
  for (let i = 1; i <= 5; i++) {
    const result = await executeCounterContract(contractId);
    console.log(`After execution ${i}:`, result.returnValue);
  }
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
}

export { counterBytecode, deployCounterContract, executeCounterContract, testCounterContract };
```

### 4.2 矩阵运算Contract

```javascript
/**
 * 矩阵运算Smart Contract示例
 * Features：TestAINVM的矩阵运算指令
 */

import contractManager from '../contractManager.js';

// 矩阵运算Contractbytecode
const matrixBytecode = [
  // Create第一个矩阵 (2x2)
  0x01, 0x02, // PUSH 2 (rows)
  0x01, 0x02, // PUSH 2 (cols)
  0x10,       // MAT_CREATE
  
  // Storage第一个矩阵的ID到memory address0
  0x08, 0x00, // STORE 0
  
  // 填充第一个矩阵的值
  // 矩阵1: [[1, 2], [3, 4]]
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x01, 0x00, // PUSH 0 (row)
  0x01, 0x00, // PUSH 0 (col)
  0x01, 0x01, // PUSH 1 (value)
  0x15,       // MAT_STORE
  
  // 填充其他元素...
  
  // Create第二个矩阵 (2x2)
  0x01, 0x02, // PUSH 2 (rows)
  0x01, 0x02, // PUSH 2 (cols)
  0x10,       // MAT_CREATE
  
  // Storage第二个矩阵的ID到memory address1
  0x08, 0x01, // STORE 1
  
  // 填充第二个矩阵的值
  // 矩阵2: [[5, 6], [7, 8]]
  // 填充元素...
  
  // Execute矩阵加法
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x07, 0x01, // LOAD 1 (mat2_id)
  0x11,       // MAT_ADD
  
  // Storage加法结果到memory address2
  0x08, 0x02, // STORE 2
  
  // Execute矩阵乘法
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x07, 0x01, // LOAD 1 (mat2_id)
  0x12,       // MAT_MUL
  
  // Storage乘法结果到memory address3
  0x08, 0x03, // STORE 3
  
  // Execute矩阵转置（对第一个矩阵）
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x13,       // MAT_TRANS
  
  // Storage转置结果到memory address4
  0x08, 0x04, // STORE 4
  
  // Load加法结果矩阵的一个元素进行Return
  0x07, 0x02, // LOAD 2 (add_result_id)
  0x01, 0x00, // PUSH 0 (row)
  0x01, 0x00, // PUSH 0 (col)
  0x14,       // MAT_LOAD
  
  0x0C        // RETURN
];

// Deploy矩阵运算Contract
async function deployMatrixContract() {
  const contractId = contractManager.deployContract(matrixBytecode, 'Matrix Operations Contract');
  console.log(`Matrix contract deployed with ID: ${contractId}`);
  return contractId;
}

// Execute矩阵运算Contract
async function executeMatrixContract(contractId) {
  const result = contractManager.executeContract(contractId, 10000); // 增加gas限制
  console.log('Matrix execution result:', result);
  return result;
}

// Test矩阵运算Contract
async function testMatrixContract() {
  console.log('=== Testing Matrix Operations Contract ===');
  
  // DeployContract
  const contractId = await deployMatrixContract();
  
  // ExecuteContract
  const result = await executeMatrixContract(contractId);
  
  // GetContractinfo
  const contractInfo = contractManager.getContractInfo(contractId);
  console.log('Contract storage:', contractInfo.storage);
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
}

export { matrixBytecode, deployMatrixContract, executeMatrixContract, testMatrixContract };
```

### 4.3 Token管理Contract

```javascript
/**
 * Token管理Smart Contract
 * Features：Token发行、transfer、balance查询
 */

import contractManager from '../contractManager.js';

// memory address分配
const ADDR_TOTAL_SUPPLY = 0;    // total supply
const ADDR_DECIMALS = 1;         // decimals
const ADDR_NAME = 2;             // token name
const ADDR_SYMBOL = 3;           // token symbol
const ADDR_OWNER = 4;            // contract owner

// 从address5开始Storageuserbalance
const ADDR_FIRST_USER = 5;

// TokenContractbytecode
const tokenBytecode = [
  // Initializetotal supply (1000000)
  0x01, 0xE8, // PUSH 232
  0x01, 0x03, // PUSH 3
  0x05,       // MUL
  0x08, ADDR_TOTAL_SUPPLY, // STORE TOTAL_SUPPLY
  
  // Initializedecimals (18)
  0x01, 0x12, // PUSH 18
  0x08, ADDR_DECIMALS, // STORE DECIMALS
  
  // Initializetoken name (1 = "NGEN")
  0x01, 0x01, // PUSH 1
  0x08, ADDR_NAME, // STORE NAME
  
  // Initializetoken symbol (2 = "NGN")
  0x01, 0x02, // PUSH 2
  0x08, ADDR_SYMBOL, // STORE SYMBOL
  
  // Initialize拥有者 (100)
  0x01, 0x64, // PUSH 100
  0x08, ADDR_OWNER, // STORE OWNER
  
  // 发行初始供应量到拥有者账户
  0x07, ADDR_TOTAL_SUPPLY, // LOAD TOTAL_SUPPLY
  0x08, ADDR_FIRST_USER + 100, // STORE OWNER_BALANCE
  
  // Returnsuccess
  0x01, 0x01, // PUSH 1
  0x0C        // RETURN
];

// DeployTokenContract
async function deployTokenContract() {
  const contractId = contractManager.deployContract(tokenBytecode, 'Token Contract');
  console.log(`Token contract deployed with ID: ${contractId}`);
  return contractId;
}

// ExecuteTokenContract
async function executeTokenContract(contractId) {
  const result = contractManager.executeContract(contractId);
  console.log('Token contract execution result:', result);
  return result;
}

// GetTokeninfo
function getTokenInfo(contractId) {
  const contractInfo = contractManager.getContractInfo(contractId);
  if (contractInfo) {
    return {
      totalSupply: contractInfo.storage[ADDR_TOTAL_SUPPLY] || 0,
      decimals: contractInfo.storage[ADDR_DECIMALS] || 0,
      name: contractInfo.storage[ADDR_NAME] || 0,
      symbol: contractInfo.storage[ADDR_SYMBOL] || 0,
      owner: contractInfo.storage[ADDR_OWNER] || 0
    };
  }
  return null;
}

// Getuserbalance
function getBalance(contractId, userId) {
  const contractInfo = contractManager.getContractInfo(contractId);
  if (contractInfo) {
    return contractInfo.storage[ADDR_FIRST_USER + userId] || 0;
  }
  return 0;
}

// TestTokenContract
async function testTokenContract() {
  console.log('=== Testing Token Contract ===');
  
  // DeployContract
  const contractId = await deployTokenContract();
  
  // ExecuteContract
  await executeTokenContract(contractId);
  
  // GetTokeninfo
  const tokenInfo = getTokenInfo(contractId);
  console.log('Token info:', tokenInfo);
  
  // Get拥有者balance
  const ownerBalance = getBalance(contractId, 100);
  console.log('Owner balance:', ownerBalance);
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
}

export { tokenBytecode, deployTokenContract, executeTokenContract, getTokenInfo, getBalance, testTokenContract };
```

### 4.4 GovernanceContract

```javascript
/**
 * GovernanceSmart Contract
 * Features：ProposalCreate、Vote和Execute
 */

import contractManager from '../contractManager.js';

// memory address分配
const ADDR_PROPOSAL_COUNT = 0;    // Proposal数量
const ADDR_QUORUM = 1;             // Votequorum
const ADDR_MAJORITY = 2;           // Vote通过threshold
const ADDR_VOTING_PERIOD = 3;      // Vote周期

// 从address10开始StorageProposalinfo
const ADDR_FIRST_PROPOSAL = 10;

// GovernanceContractbytecode
const governanceBytecode = [
  // InitializeProposal数量 (0)
  0x01, 0x00, // PUSH 0
  0x08, ADDR_PROPOSAL_COUNT, // STORE PROPOSAL_COUNT
  
  // Initializequorum (10)
  0x01, 0x0A, // PUSH 10
  0x08, ADDR_QUORUM, // STORE QUORUM
  
  // Initialize通过threshold (51%)
  0x01, 0x33, // PUSH 51
  0x08, ADDR_MAJORITY, // STORE MAJORITY
  
  // InitializeVote周期 (86400秒 = 1天)
  0x01, 0x50, // PUSH 80
  0x01, 0x40, // PUSH 64
  0x05,       // MUL
  0x08, ADDR_VOTING_PERIOD, // STORE VOTING_PERIOD
  
  // Returnsuccess
  0x01, 0x01, // PUSH 1
  0x0C        // RETURN
];

// DeployGovernanceContract
async function deployGovernanceContract() {
  const contractId = contractManager.deployContract(governanceBytecode, 'Governance Contract');
  console.log(`Governance contract deployed with ID: ${contractId}`);
  return contractId;
}

// ExecuteGovernanceContract
async function executeGovernanceContract(contractId) {
  const result = contractManager.executeContract(contractId);
  console.log('Governance contract execution result:', result);
  return result;
}

// GetGovernance parameters
function getGovernanceParams(contractId) {
  const contractInfo = contractManager.getContractInfo(contractId);
  if (contractInfo) {
    return {
      proposalCount: contractInfo.storage[ADDR_PROPOSAL_COUNT] || 0,
      quorum: contractInfo.storage[ADDR_QUORUM] || 0,
      majority: contractInfo.storage[ADDR_MAJORITY] || 0,
      votingPeriod: contractInfo.storage[ADDR_VOTING_PERIOD] || 0
    };
  }
  return null;
}

// TestGovernanceContract
async function testGovernanceContract() {
  console.log('=== Testing Governance Contract ===');
  
  // DeployContract
  const contractId = await deployGovernanceContract();
  
  // ExecuteContract
  await executeGovernanceContract(contractId);
  
  // GetGovernance parameters
  const params = getGovernanceParams(contractId);
  console.log('Governance params:', params);
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
}

export { governanceBytecode, deployGovernanceContract, executeGovernanceContract, getGovernanceParams, testGovernanceContract };
```

## 5. Deploy和Execute流程

### 5.1 DeployContract

```javascript
import contractManager from './src/contracts/contractManager.js';
import { tokenBytecode } from './src/contracts/examples/token.js';

async function deployContractExample() {
  // DeployContract
  const contractId = contractManager.deployContract(tokenBytecode, 'My Token Contract');
  console.log(`Contract deployed with ID: ${contractId}`);
  
  // ExecuteContract
  const result = contractManager.executeContract(contractId);
  console.log('Execution result:', result);
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
}

deployContractExample();
```

### 5.2 ExecuteContract

```javascript
import contractManager from './src/contracts/contractManager.js';

async function executeContractExample(contractId) {
  // ExecuteContract
  const result = contractManager.executeContract(contractId, 1000); // 1000 gas limit
  
  if (result.success) {
    console.log('Contract executed successfully');
    console.log('Return value:', result.returnValue);
    console.log('Gas used:', result.gasUsed);
  } else {
    console.error('Contract execution failed:', result.error);
  }
  
  // Savestatus
  await contractManager.saveState();
}

// Executedeployed的Contract
executeContractExample('contract_12345');
```

## 6. 最佳实践和security建议

### 6.1 性能优化

1. **Gas 优化**：
   - 减少不必要的Storage操作
   - 优化循环和Calculate复杂度
   - 使用适当的 gas 限制

2. **Memory管理**：
   - 合理使用memory address
   - 避免Storage大型data结构
   - 清理不再使用的矩阵

3. **代码优化**：
   - 简化bytecodeLogic
   - 重用公共代码
   - 避免冗余操作

### 6.2 security性

1. **输入Verify**：
   - Verify矩阵维度
   - Check数组索引
   - 限制操作复杂度

2. **防止攻击**：
   - 防止整数溢出
   - 防止重入攻击
   - 限制 gas 消耗

3. **permission控制**：
   - 实现访问控制
   - 限制敏感操作
   - Verify调用者身份

## 7. 故障排除

### 7.1 常见error

| errorinfo | may原因 | 解决方案 |
|----------|----------|----------|
| Stack underflow | stack操作不平衡 | Check指令顺序和stack操作 |
| Matrix not found | 矩阵ID不存在 | ensure矩阵created |
| Matrix dimensions mismatch | 矩阵维度不匹配 | Check矩阵操作的维度要求 |
| out of gas | Gas 不足 | 增加 gas 限制 |
| Contract not found | ContractID不存在 | CheckContractID是否正确 |

### 7.2 调试技巧

1. **查看ContractStorage**：
   ```javascript
   const contractInfo = contractManager.getContractInfo(contractId);
   console.log('Contract storage:', contractInfo.storage);
   ```

2. **CheckExecute结果**：
   ```javascript
   const result = contractManager.executeContract(contractId);
   console.log('Execution result:', result);
   ```

3. **使用Test脚本**：
   ```bash
   node test_contracts.js
   ```

## 8. 总结

AINVM Smart Contract平台提供了一个强大的框架，for开发和ExecuteSmart Contract。通过本文档的指导，您should能够：

- 理解 AINVM 虚拟机的工作原理
- 开发各种type的Smart Contract
- Test和DeployContract
- 优化Contract性能和security性

随着平台的发展，AINVM 将不断添加新Features和指令，为Smart Contract开发提供更多may性。

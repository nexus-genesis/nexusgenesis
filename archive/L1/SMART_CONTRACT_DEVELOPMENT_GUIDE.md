# NexusGenesis Smart Contract开发指南

## 1. 概述

NexusGenesis Smart Contractbased on AINVM (AI Network Virtual Machine)，这是一个stack机模型的虚拟机，support确定性Execute和可计费。本指南将帮助Developer了解如何开发、Deploy和TestSmart Contract。

## 2. 环境准备

### 2.1 系统要求
- Node.js 18+
- npm 或 yarn

### 2.2 安装依赖
```bash
cd NexusGenesis
npm install
```

## 3. AINVM 基础知识

### 3.1 虚拟机架构
- **stack机模型**：使用stack进行操作
- **Memory**：based on Map 的键值Storage
- **instruction set**：包含基础指令和矩阵运算指令
- **Gas 系统**：限制Execute资源使用

### 3.2 核心指令

#### 基础指令
- `PUSH`：压stack
- `POP`：弹stack
- `ADD`：加法
- `SUB`：减法
- `MUL`：乘法
- `DIV`：除法
- `LOAD`：LoadMemory
- `STORE`：StorageMemory
- `JMP`：跳转
- `JZ`：条件跳转
- `HALT`：StopExecute
- `RETURN`：Return结果

#### 矩阵运算指令
- `MAT_CREATE`：Create矩阵
- `MAT_ADD`：矩阵加法
- `MAT_MUL`：矩阵乘法
- `MAT_TRANS`：矩阵转置
- `MAT_LOAD`：Load矩阵元素
- `MAT_STORE`：Storage矩阵元素

#### AI 相关指令
- `AI_MODEL_LOAD`：LoadAI模型
- `AI_INFERENCE`：ExecuteAI推理
- `AI_MODEL_SAVE`：SaveAI模型

## 4. Smart Contract开发

### 4.1 编写bytecode

Smart Contract使用bytecode形式编写。以下是一个简单的计数器Contract示例：

```javascript
// 计数器Contractbytecode
const counterBytecode = [
  0x07, 0x00, // LOAD 0     // LoadCurrent计数
  0x01, 0x01, // PUSH 1     // 压入1
  0x03,       // ADD        // 相加
  0x08, 0x00, // STORE 0    // Save回Storage
  0x07, 0x00, // LOAD 0     // Load新值
  0x0C        // RETURN     // Return
];
```

### 4.2 使用 SDK 开发

NexusGenesis 提供了 SDK 来简化Smart Contract开发：

```javascript
import sdk from './src/sdk/index.js';

// DeployContract
const contractId = sdk.deployContract(counterBytecode, 'Counter Contract');
console.log(`ContractDeploysuccess，ID: ${contractId}`);

// ExecuteContract
const result = sdk.executeContract(contractId);
console.log('Execute结果:', result);

// GetContractinfo
const info = sdk.getContractInfo(contractId);
console.log('Contractinfo:', info);
```

### 4.3 使用命令行工具

NexusGenesis 提供了命令行工具来管理Smart Contract：

```bash
# DeployContract
node tools/cli.js deploy bytecode.json "My Contract"

# ExecuteContract
node tools/cli.js execute contract_12345

# GetContractinfo
node tools/cli.js info contract_12345

# 列出所有Contract
node tools/cli.js list
```

## 5. Smart Contract示例

### 5.1 计数器Contract

**Features**：实现一个简单的计数器，每次Execute增加1。

**bytecode**：
```javascript
const counterBytecode = [
  0x07, 0x00, // LOAD 0     // LoadCurrent计数
  0x01, 0x01, // PUSH 1     // 压入1
  0x03,       // ADD        // 相加
  0x08, 0x00, // STORE 0    // Save回Storage
  0x07, 0x00, // LOAD 0     // Load新值
  0x0C        // RETURN     // Return
];
```

### 5.2 矩阵运算Contract

**Features**：TestAINVM的矩阵运算指令。

**bytecode**：
```javascript
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
  
  // 更多矩阵操作...
  // ...
  
  // Return结果
  0x0C        // RETURN
];
```

### 5.3 TokenContract

**Features**：实现Token的发行和管理。

**bytecode**：
```javascript
const tokenBytecode = [
  // Initializetotal supply (1000000)
  0x01, 0xE8, // PUSH 232
  0x01, 0x03, // PUSH 3
  0x05,       // MUL
  0x08, 0x00, // STORE TOTAL_SUPPLY
  
  // Initializedecimals (18)
  0x01, 0x12, // PUSH 18
  0x08, 0x01, // STORE DECIMALS
  
  // Initializetoken name (1 = "NGEN")
  0x01, 0x01, // PUSH 1
  0x08, 0x02, // STORE NAME
  
  // Initializetoken symbol (2 = "NGN")
  0x01, 0x02, // PUSH 2
  0x08, 0x03, // STORE SYMBOL
  
  // Initialize拥有者 (100)
  0x01, 0x64, // PUSH 100
  0x08, 0x04, // STORE OWNER
  
  // 发行初始供应量到拥有者账户
  0x07, 0x00, // LOAD TOTAL_SUPPLY
  0x08, 0x69, // STORE OWNER_BALANCE
  
  // Returnsuccess
  0x01, 0x01, // PUSH 1
  0x0C        // RETURN
];
```

### 5.4 GovernanceContract

**Features**：实现Proposal和VoteFeatures。

**bytecode**：
```javascript
const governanceBytecode = [
  // InitializeProposal数量 (0)
  0x01, 0x00, // PUSH 0
  0x08, 0x00, // STORE PROPOSAL_COUNT
  
  // Initializequorum (10)
  0x01, 0x0A, // PUSH 10
  0x08, 0x01, // STORE QUORUM
  
  // Initialize通过threshold (51%)
  0x01, 0x33, // PUSH 51
  0x08, 0x02, // STORE MAJORITY
  
  // InitializeVote周期 (86400秒 = 1天)
  0x01, 0x50, // PUSH 80
  0x01, 0x40, // PUSH 64
  0x05,       // MUL
  0x08, 0x03, // STORE VOTING_PERIOD
  
  // Returnsuccess
  0x01, 0x01, // PUSH 1
  0x0C        // RETURN
];
```

### 5.5 去中心化身份（DID）Contract

**Features**：实现身份Register和Verify。

**bytecode**：
```javascript
const didBytecode = [
  // Initialize身份计数器 (0)
  0x01, 0x00, // PUSH 0
  0x08, 0x00, // STORE ID_COUNT
  
  // 增加身份计数器
  0x07, 0x00, // LOAD ID_COUNT
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x08, 0x00, // STORE ID_COUNT
  
  // Storage身份ID
  0x07, 0x00, // LOAD ID_COUNT
  0x08, 0x0A, // STORE ID
  
  // Storage身份所有者 (Default100)
  0x01, 0x64, // PUSH 100
  0x08, 0x0B, // STORE OWNER
  
  // Storage身份status (1=active)
  0x01, 0x01, // PUSH 1
  0x08, 0x0C, // STORE STATUS
  
  // StorageCreate时间 (placeholder)
  0x01, 0x01, // PUSH 1
  0x08, 0x0D, // STORE CREATED_AT
  
  // Return身份ID
  0x07, 0x00, // LOAD ID_COUNT
  0x0C        // RETURN
];
```

### 5.6 AI Contract

**Features**：TestAINVM的AI相关指令。

**bytecode**：
```javascript
const aiBytecode = [
  // LoadAI模型
  0x01, 0x01, // PUSH 1 (model path placeholder)
  0x21,       // AI_MODEL_LOAD
  
  // Storage模型ID到memory address0
  0x08, 0x00, // STORE 0
  
  // Load模型ID
  0x07, 0x00, // LOAD 0
  
  // 准备推理输入data
  0x01, 0x02, // PUSH 2 (input data placeholder)
  
  // ExecuteAI推理
  0x20,       // AI_INFERENCE
  
  // Storage推理结果ID到memory address1
  0x08, 0x01, // STORE 1
  
  // Load模型ID
  0x07, 0x00, // LOAD 0
  
  // 准备模型Save路径
  0x01, 0x03, // PUSH 3 (save path placeholder)
  
  // SaveAI模型
  0x22,       // AI_MODEL_SAVE
  
  // Return推理结果ID
  0x07, 0x01, // LOAD 1
  0x0C        // RETURN
];
```

## 6. Deploy和Test

### 6.1 DeployContract

使用 SDK DeployContract：

```javascript
import sdk from './src/sdk/index.js';

// DeployContract
const contractId = sdk.deployContract(bytecode, 'My Contract');
console.log(`ContractDeploysuccess，ID: ${contractId}`);
```

### 6.2 ExecuteContract

使用 SDK ExecuteContract：

```javascript
// ExecuteContract
const result = sdk.executeContract(contractId);
console.log('Execute结果:', result);
```

### 6.3 TestContract

使用性能Test脚本TestContract：

```bash
node performance_test.js
```

## 7. 最佳实践

### 7.1 security性
- **Gas 限制**：为ContractExecuteSet合理的 gas 限制
- **输入Verify**：Verify所有输入parameter
- **status管理**：合理管理Contractstatus
- **errorProcess**：实现适当的errorProcess

### 7.2 性能优化
- **代码优化**：减少不必要的操作
- **Storage优化**：合理使用Storage
- **Calculate优化**：优化复杂Calculate

### 7.3 开发工具
- **SDK**：使用 NexusGenesis SDK 简化开发
- **CLI**：使用命令行工具管理Contract
- **Test**：编写充分的Test用例

## 8. 常见问题

### 8.1 ContractExecutefailed
- **Gas 不足**：增加 gas 限制
- **Memory访问error**：Checkmemory address是否有效
- **stack溢出/下溢**：Checkstack操作是否正确

### 8.2 Deploy问题
- **bytecode格式**：ensurebytecode格式正确
- **permission问题**：CheckDeploypermission

### 8.3 性能问题
- **Execute时间过长**：优化Contract代码
- **Storage使用过多**：优化Storage使用

## 9. 资源

### 9.1 代码示例
- `src/contracts/examples/`：Smart Contract示例
- `examples/`：使用示例

### 9.2 文档
- `README.md`：项目概述
- `AINVM_SPEC.md`：AINVM 规范
- `SMART_CONTRACT_GUIDE.md`：Smart Contract指南

### 9.3 工具
- `src/sdk/`：NexusGenesis SDK
- `tools/cli.js`：命令行工具

## 10. contribution

欢迎DevelopercontributionSmart Contract示例、工具和文档。请参考 `CONTRIBUTING.md` 了解如何contribution。

## 11. 联系方式

- **项目address**：https://github.com/nexus-genesis/nexusgenesis
- **文档address**：docs/
- **示例脚本**：examples/

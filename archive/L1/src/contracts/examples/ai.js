/**
 * AISmart Contract示例
 * Features: TestAINVM的AI相关指令
 */

import contractManager from '../contractManager.js';

// AIContractbytecode
// Logic: 
// 1. LoadAI模型
// 2. ExecuteAI推理
// 3. Save推理结果
const aiBytecode = [
  // LoadAI模型
  0x01, 0x01, // PUSH 1 (model path placeholder)
  0x21,       // AI_MODEL_LOAD
  
  // Storage模型ID到memoryaddress0
  0x08, 0x00, // STORE 0
  
  // Load模型ID
  0x07, 0x00, // LOAD 0
  
  // 准备推理输入data
  0x01, 0x02, // PUSH 2 (input data placeholder)
  
  // ExecuteAI推理
  0x20,       // AI_INFERENCE
  
  // Storage推理结果ID到memoryaddress1
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

// DeployAIContract
async function deployAIContract() {
  const contractId = contractManager.deployContract(aiBytecode, 'AI Contract');
  console.log(`AI contract deployed with ID: ${contractId}`);
  return contractId;
}

// ExecuteAIContract
async function executeAIContract(contractId) {
  const result = contractManager.executeContract(contractId, 10000); // 增加gas限制
  console.log('AI contract execution result:', result);
  return result;
}

// getAIContractinfo
function getAIInfo(contractId) {
  const contractInfo = contractManager.getContractInfo(contractId);
  if (contractInfo) {
    return {
      modelId: contractInfo.storage['0'] || null,
      resultId: contractInfo.storage['1'] || null,
      storage: contractInfo.storage
    };
  }
  return null;
}

// TestAIContract
async function testAIContract() {
  console.log('=== Testing AI Contract ===');
  
  // Deploy contract
  const contractId = await deployAIContract();
  
  // Execute contract
  const result = await executeAIContract(contractId);
  
  // getContractinfo
  const aiInfo = getAIInfo(contractId);
  console.log('AI contract info:', aiInfo);
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
  
  return contractId;
}

// Export functions
export { 
  aiBytecode, 
  deployAIContract, 
  executeAIContract, 
  getAIInfo, 
  testAIContract 
};

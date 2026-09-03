/**
 * count器Smart Contract示例
 * Features: 增加和减少count值
 */

import contractManager from '../contractManager.js';

// count器Contractbytecode
// Logic: 
// 1. 从memoryaddress0LoadCurrent值
// 2. 压入1
// 3. 相加
// 4. Save回memoryaddress0
// 5. Load新值
// 6. Return
const counterBytecode = [
  0x07, 0x00, // LOAD 0     // LoadCurrentcount
  0x01, 0x01, // PUSH 1     // 压入1
  0x03,       // ADD        // 相加
  0x08, 0x00, // STORE 0    // Save回Storage
  0x07, 0x00, // LOAD 0     // Load新值
  0x0C        // RETURN     // Return
];

// 修复后的count器Contractbytecode(using临时变量)
const counterBytecodeFixed = [
  0x07, 0x00, // LOAD 0     // LoadCurrentcount
  0x01, 0x01, // PUSH 1     // 压入1
  0x03,       // ADD        // 相加
  0x08, 0x00, // STORE 0    // Save回Storage
  0x07, 0x00, // LOAD 0     // Load新值
  0x0C        // RETURN     // Return
];

// Deploycount器Contract
async function deployCounterContract() {
  const contractId = contractManager.deployContract(counterBytecode, 'Counter Contract');
  console.log(`Counter contract deployed with ID: ${contractId}`);
  return contractId;
}

// Executecount器Contract(增加count)
async function executeCounterContract(contractId) {
  const result = contractManager.executeContract(contractId);
  console.log('Counter execution result:', result);
  return result;
}

// getcount器值
function getCounterValue(contractId) {
  const contractInfo = contractManager.getContractInfo(contractId);
  if (contractInfo) {
    return contractInfo.storage['0'] || 0;
  }
  return 0;
}

// Testcount器Contract
async function testCounterContract() {
  console.log('=== Testing Counter Contract ===');
  
  // Deploy contract
  const contractId = await deployCounterContract();
  
  // 初始值
  console.log('Initial counter value:', getCounterValue(contractId));
  
  // Execute5次
  for (let i = 1; i <= 5; i++) {
    await executeCounterContract(contractId);
    console.log(`After execution ${i}:`, getCounterValue(contractId));
  }
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
  
  return contractId;
}

// Export functions
export { 
  counterBytecode, 
  deployCounterContract, 
  executeCounterContract, 
  getCounterValue, 
  testCounterContract 
};
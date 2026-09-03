/**
 * 矩阵运算Smart Contract示例
 * Features: TestAINVM的矩阵运算指令
 */

import contractManager from '../contractManager.js';

// 矩阵运算Contractbytecode
// Logic: 
// 1. Create两个2x2矩阵
// 2. 为矩阵填充值
// 3. Execute矩阵加法
// 4. Execute矩阵乘法
// 5. Execute矩阵转置
// 6. Return结果
const matrixBytecode = [
  // Create第一个矩阵 (2x2)
  0x01, 0x02, // PUSH 2 (rows)
  0x01, 0x02, // PUSH 2 (cols)
  0x10,       // MAT_CREATE
  
  // Storage第一个矩阵的ID到memoryaddress0
  0x08, 0x00, // STORE 0
  
  // 填充第一个矩阵的值
  // 矩阵1: [[1, 2], [3, 4]]
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x01, 0x00, // PUSH 0 (row)
  0x01, 0x00, // PUSH 0 (col)
  0x01, 0x01, // PUSH 1 (value)
  0x15,       // MAT_STORE
  
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x01, 0x00, // PUSH 0 (row)
  0x01, 0x01, // PUSH 1 (col)
  0x01, 0x02, // PUSH 2 (value)
  0x15,       // MAT_STORE
  
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x01, 0x01, // PUSH 1 (row)
  0x01, 0x00, // PUSH 0 (col)
  0x01, 0x03, // PUSH 3 (value)
  0x15,       // MAT_STORE
  
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x01, 0x01, // PUSH 1 (row)
  0x01, 0x01, // PUSH 1 (col)
  0x01, 0x04, // PUSH 4 (value)
  0x15,       // MAT_STORE
  
  // Create第二个矩阵 (2x2)
  0x01, 0x02, // PUSH 2 (rows)
  0x01, 0x02, // PUSH 2 (cols)
  0x10,       // MAT_CREATE
  
  // Storage第二个矩阵的ID到memoryaddress1
  0x08, 0x01, // STORE 1
  
  // 填充第二个矩阵的值
  // 矩阵2: [[5, 6], [7, 8]]
  0x07, 0x01, // LOAD 1 (mat2_id)
  0x01, 0x00, // PUSH 0 (row)
  0x01, 0x00, // PUSH 0 (col)
  0x01, 0x05, // PUSH 5 (value)
  0x15,       // MAT_STORE
  
  0x07, 0x01, // LOAD 1 (mat2_id)
  0x01, 0x00, // PUSH 0 (row)
  0x01, 0x01, // PUSH 1 (col)
  0x01, 0x06, // PUSH 6 (value)
  0x15,       // MAT_STORE
  
  0x07, 0x01, // LOAD 1 (mat2_id)
  0x01, 0x01, // PUSH 1 (row)
  0x01, 0x00, // PUSH 0 (col)
  0x01, 0x07, // PUSH 7 (value)
  0x15,       // MAT_STORE
  
  0x07, 0x01, // LOAD 1 (mat2_id)
  0x01, 0x01, // PUSH 1 (row)
  0x01, 0x01, // PUSH 1 (col)
  0x01, 0x08, // PUSH 8 (value)
  0x15,       // MAT_STORE
  
  // Execute矩阵加法
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x07, 0x01, // LOAD 1 (mat2_id)
  0x11,       // MAT_ADD
  
  // Storage加法结果到memoryaddress2
  0x08, 0x02, // STORE 2
  
  // Execute矩阵乘法
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x07, 0x01, // LOAD 1 (mat2_id)
  0x12,       // MAT_MUL
  
  // Storage乘法结果到memoryaddress3
  0x08, 0x03, // STORE 3
  
  // Execute矩阵转置(对第一个矩阵)
  0x07, 0x00, // LOAD 0 (mat1_id)
  0x13,       // MAT_TRANS
  
  // Storage转置结果到memoryaddress4
  0x08, 0x04, // STORE 4
  
  // Load加法结果矩阵的一个元素进行Return
  0x07, 0x02, // LOAD 2 (add_result_id)
  0x01, 0x00, // PUSH 0 (row)
  0x01, 0x00, // PUSH 0 (col)
  0x14,       // MAT_LOAD
  
  0x0C        // RETURN     // Return结果
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
  
  // Deploy contract
  const contractId = await deployMatrixContract();
  
  // Execute contract
  const result = await executeMatrixContract(contractId);
  
  // getContractinfo
  const contractInfo = contractManager.getContractInfo(contractId);
  console.log('Contract storage:', contractInfo.storage);
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
  
  return contractId;
}

// Export functions
export { 
  matrixBytecode, 
  deployMatrixContract, 
  executeMatrixContract, 
  testMatrixContract 
};
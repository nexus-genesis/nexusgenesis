/**
 * 去中心化身份(DID)Smart Contract
 * Features: 身份Register, Verify, property管理
 */

import contractManager from '../contractManager.js';

// memoryaddress分配
const ADDR_ID_COUNT = 0;           // 身份数量
const ADDR_FIRST_ID = 10;          // 第一个身份的Storageaddress

// DIDContractbytecode
// Logic: 
// 1. Initialize身份count器
// 2. Register新身份
// 3. Storage身份info
const didBytecode = [
  // Initialize身份count器 (0)
  0x01, 0x00, // PUSH 0
  0x08, ADDR_ID_COUNT, // STORE ID_COUNT
  
  // 增加身份count器
  0x07, ADDR_ID_COUNT, // LOAD ID_COUNT
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x08, ADDR_ID_COUNT, // STORE ID_COUNT
  
  // Storage身份ID
  0x07, ADDR_ID_COUNT, // LOAD ID_COUNT
  0x08, ADDR_FIRST_ID, // STORE ID
  
  // Storage身份所有者 (Default100)
  0x01, 0x64, // PUSH 100
  0x08, ADDR_FIRST_ID + 1, // STORE OWNER
  
  // Storage身份status (1=active)
  0x01, 0x01, // PUSH 1
  0x08, ADDR_FIRST_ID + 2, // STORE STATUS
  
  // Store creation time(运行时由 VM 注入 block.timestamp)
  0x01, 0x01, // PUSH 1
  0x08, ADDR_FIRST_ID + 3, // STORE CREATED_AT
  
  // Return身份ID
  0x07, ADDR_ID_COUNT, // LOAD ID_COUNT
  0x0C        // RETURN
];

// Update身份propertyContractbytecode
const updateAttributeBytecode = [
  // Load身份ID
  0x07, 0x0A, // LOAD 10 (id)
  
  // Loadproperty键
  0x07, 0x0B, // LOAD 11 (key)
  
  // Loadproperty值
  0x07, 0x0C, // LOAD 12 (value)
  
  // Storageproperty
  0x08, 0x0D, // STORE 13 (attribute)
  
  // Return success
  0x01, 0x01, // PUSH 1
  0x0C        // RETURN
];

// Verify身份Contractbytecode
const verifyIdentityBytecode = [
  // Load身份ID
  0x07, 0x0A, // LOAD 10 (id)
  
  // Load身份status
  0x07, 12, // LOAD STATUS (ADDR_FIRST_ID + 2 = 12)
  
  // Checkstatus是否为1 (active)
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x01, 0x00, // PUSH 0
  0x0A, 0x03, // JZ 3
  
  // ReturnVerification successful
  0x01, 0x01, // PUSH 1
  0x0C,       // RETURN
  
  // ReturnVerifyFailed
  0x01, 0x00, // PUSH 0
  0x0C        // RETURN
];

// DeployDIDContract
async function deployDIDContract() {
  const contractId = contractManager.deployContract(didBytecode, 'DID Contract');
  console.log(`DID contract deployed with ID: ${contractId}`);
  return contractId;
}

// ExecuteDIDContract
async function executeDIDContract(contractId) {
  const result = contractManager.executeContract(contractId);
  console.log('DID contract execution result:', result);
  return result;
}

// getDIDinfo
function getDIDInfo(contractId) {
  const contractInfo = contractManager.getContractInfo(contractId);
  if (contractInfo) {
    return {
      idCount: contractInfo.storage[ADDR_ID_COUNT] || 0,
      firstId: contractInfo.storage[ADDR_FIRST_ID] || 0,
      owner: contractInfo.storage[ADDR_FIRST_ID + 1] || 0,
      status: contractInfo.storage[ADDR_FIRST_ID + 2] || 0,
      createdAt: contractInfo.storage[ADDR_FIRST_ID + 3] || 0
    };
  }
  return null;
}

// TestDIDContract
async function testDIDContract() {
  console.log('=== Testing DID Contract ===');
  
  // Deploy contract
  const contractId = await deployDIDContract();
  
  // Execute contract
  await executeDIDContract(contractId);
  
  // getDIDinfo
  const didInfo = getDIDInfo(contractId);
  console.log('DID info:', didInfo);
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
  
  return contractId;
}

// Export functions
export { 
  didBytecode, 
  updateAttributeBytecode, 
  verifyIdentityBytecode, 
  deployDIDContract, 
  executeDIDContract, 
  getDIDInfo, 
  testDIDContract 
};

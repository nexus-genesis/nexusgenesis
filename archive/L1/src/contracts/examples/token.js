/**
 * Token管理Smart Contract
 * Features: Token发行, transfer, balance查询
 */

import contractManager from '../contractManager.js';

// memoryaddress分配
const ADDR_TOTAL_SUPPLY = 0;    // total supply
const ADDR_DECIMALS = 1;         // decimals
const ADDR_NAME = 2;             // token name
const ADDR_SYMBOL = 3;           // token symbol
const ADDR_OWNER = 4;            // contract owner

// 从address5Start Storageuserbalance
const ADDR_FIRST_USER = 5;

// TokenContractbytecode
// Logic: 
// 1. InitializeTokenparameter
// 2. 发行初始供应量到拥有者账户
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
  
  // Return success
  0x01, 0x01, // PUSH 1
  0x0C        // RETURN
];

// transferContractbytecode
// Logic: 
// 1. 从memoryaddress10Loadsenderbalance
// 2. 从memoryaddress11Loadrecipientbalance
// 3. 从memoryaddress12Loadtransferamount
// 4. Checksenderbalance是否足够
// 5. Executetransfer
// 6. Save新balance
const transferBytecode = [
  // Loadsenderbalance
  0x07, 0x0A, // LOAD 10 (sender balance address)
  
  // Loadtransferamount
  0x07, 0x0C, // LOAD 12 (amount)
  
  // Checkbalance是否足够
  0x03,       // ADD (暂时usingADD, 后续requires实现比较指令)
  0x01, 0x00, // PUSH 0
  0x0A, 0x05, // JZ 5 (如果为0, 跳转)
  
  // Executetransfer: senderbalance -= amount
  0x07, 0x0A, // LOAD 10
  0x07, 0x0C, // LOAD 12
  0x04,       // SUB
  0x08, 0x0A, // STORE 10
  
  // recipientbalance += amount
  0x07, 0x0B, // LOAD 11 (receiver balance address)
  0x07, 0x0C, // LOAD 12
  0x03,       // ADD
  0x08, 0x0B, // STORE 11
  
  // Return success
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

// getTokeninfo
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

// getuserbalance
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
  
  // Deploy contract
  const contractId = await deployTokenContract();
  
  // Execute contract
  await executeTokenContract(contractId);
  
  // getTokeninfo
  const tokenInfo = getTokenInfo(contractId);
  console.log('Token info:', tokenInfo);
  
  // get拥有者balance
  const ownerBalance = getBalance(contractId, 100);
  console.log('Owner balance:', ownerBalance);
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
  
  return contractId;
}

// Export functions
export { 
  tokenBytecode, 
  transferBytecode, 
  deployTokenContract, 
  executeTokenContract, 
  getTokenInfo, 
  getBalance, 
  testTokenContract 
};
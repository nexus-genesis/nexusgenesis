/**
 * GovernanceSmart Contract
 * Features: ProposalCreate, Vote和Execute
 */

import contractManager from '../contractManager.js';

// memoryaddress分配
const ADDR_PROPOSAL_COUNT = 0;    // Proposal数量
const ADDR_QUORUM = 1;             // Votequorum
const ADDR_MAJORITY = 2;           // Voteviathreshold
const ADDR_VOTING_PERIOD = 3;      // Vote周期

// 从address10Start StorageProposalinfo
const ADDR_FIRST_PROPOSAL = 10;

// GovernanceContractbytecode
// Logic: 
// 1. InitializeGovernance parameters
// 2. SetVote规则
const governanceBytecode = [
  // InitializeProposal数量 (0)
  0x01, 0x00, // PUSH 0
  0x08, ADDR_PROPOSAL_COUNT, // STORE PROPOSAL_COUNT
  
  // Initializequorum (10)
  0x01, 0x0A, // PUSH 10
  0x08, ADDR_QUORUM, // STORE QUORUM
  
  // Initializeviathreshold (51%)
  0x01, 0x33, // PUSH 51
  0x08, ADDR_MAJORITY, // STORE MAJORITY
  
  // InitializeVote周期 (86400秒 = 1 days)
  0x01, 0x50, // PUSH 80
  0x01, 0x40, // PUSH 64
  0x05,       // MUL
  0x08, ADDR_VOTING_PERIOD, // STORE VOTING_PERIOD
  
  // Return success
  0x01, 0x01, // PUSH 1
  0x0C        // RETURN
];

// CreateProposalContractbytecode
// Logic: 
// 1. 从memoryaddress20LoadProposal标题
// 2. 从memoryaddress21LoadProposal描述
// 3. 从memoryaddress22LoadProposal发起者
// 4. 增加Proposal数量
// 5. StorageProposalinfo
const createProposalBytecode = [
  // LoadCurrentProposal数量
  0x07, ADDR_PROPOSAL_COUNT, // LOAD PROPOSAL_COUNT
  
  // 增加Proposal数量
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x08, ADDR_PROPOSAL_COUNT, // STORE PROPOSAL_COUNT
  
  // StorageProposalinfo
  // ProposalID = CurrentProposal数量
  0x07, ADDR_PROPOSAL_COUNT, // LOAD PROPOSAL_COUNT
  0x08, ADDR_FIRST_PROPOSAL, // STORE PROPOSAL_ID
  
  // StorageProposal标题
  0x07, 0x14, // LOAD 20 (title)
  0x08, ADDR_FIRST_PROPOSAL + 1, // STORE PROPOSAL_TITLE
  
  // StorageProposal描述
  0x07, 0x15, // LOAD 21 (description)
  0x08, ADDR_FIRST_PROPOSAL + 2, // STORE PROPOSAL_DESCRIPTION
  
  // StorageProposal发起者
  0x07, 0x16, // LOAD 22 (creator)
  0x08, ADDR_FIRST_PROPOSAL + 3, // STORE PROPOSAL_CREATOR
  
  // InitializeVotecount
  0x01, 0x00, // PUSH 0
  0x08, ADDR_FIRST_PROPOSAL + 4, // STORE YES_VOTES
  0x01, 0x00, // PUSH 0
  0x08, ADDR_FIRST_PROPOSAL + 5, // STORE NO_VOTES
  
  // Store creation time
  0x01, 0x01, // PUSH 1 (placeholder for timestamp)
  0x08, ADDR_FIRST_PROPOSAL + 6, // STORE CREATED_AT
  
  // ReturnProposalID
  0x07, ADDR_PROPOSAL_COUNT, // LOAD PROPOSAL_COUNT
  0x0C        // RETURN
];

// VoteContractbytecode
// Logic: 
// 1. 从memoryaddress30LoadProposalID
// 2. 从memoryaddress31LoadVote选项 (1=YES, 0=NO)
// 3. 从memoryaddress32LoadVote者
// 4. UpdateVotecount
const voteBytecode = [
  // LoadProposalID
  0x07, 0x1E, // LOAD 30 (proposalId)
  
  // LoadVote选项
  0x07, 0x1F, // LOAD 31 (voteOption)
  
  // CheckVote选项
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x01, 0x00, // PUSH 0
  0x0A, 0x05, // JZ 5 (如果为0, 跳转)
  
  // Vote为YES
  0x07, ADDR_FIRST_PROPOSAL + 4, // LOAD YES_VOTES
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x08, ADDR_FIRST_PROPOSAL + 4, // STORE YES_VOTES
  
  // 跳转结束
  0x09, 0x05, // JMP 5
  
  // Vote为NO
  0x07, ADDR_FIRST_PROPOSAL + 5, // LOAD NO_VOTES
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x08, ADDR_FIRST_PROPOSAL + 5, // STORE NO_VOTES
  
  // Return success
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

// getGovernance parameters
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
  
  // Deploy contract
  const contractId = await deployGovernanceContract();
  
  // Execute contract
  await executeGovernanceContract(contractId);
  
  // getGovernance parameters
  const params = getGovernanceParams(contractId);
  console.log('Governance params:', params);
  
  // Savestatus
  await contractManager.saveState();
  console.log('Contract state saved');
  
  return contractId;
}

// Export functions
export { 
  governanceBytecode, 
  createProposalBytecode, 
  voteBytecode, 
  deployGovernanceContract, 
  executeGovernanceContract, 
  getGovernanceParams, 
  testGovernanceContract 
};
/**
 * 智能合约模板库测试
 */

import { contractTemplateLibrary, CONTRACT_TYPES, CONTRACT_STATUS } from '../src/contracts/templates/contractTemplates.js';

console.log('=== 智能合约模板库测试 ===\n');

// 测试1: get所有可用模板
console.log('1. get所有可用模板...');
const templates = contractTemplateLibrary.getAllTemplates();
console.log(`✓ 找到 ${templates.length} 个合约模板:`);
templates.forEach(t => {
  console.log(`  - ${t.type}: ${t.name}`);
});
console.log('');

// 测试2: 创建DID合约实例
console.log('2. 创建DID合约实例...');
try {
  const didContract = contractTemplateLibrary.createContractFromTemplate(CONTRACT_TYPES.DID, {
    maxAttributesPerDID: 100,
    revocationEnabled: true
  });
  
  console.log(`✓ DID合约Create successful`);
  console.log(`  类型: ${didContract.type}`);
  console.log(`  状态: ${didContract.status}`);
  console.log(`  方法数量: ${didContract.methods.length}`);
  console.log('');
} catch (error) {
  console.error('✗ DID合约创建Failed:', error.message);
}

// 测试3: 创建DAO合约实例
console.log('3. 创建DAO合约实例...');
try {
  const daoContract = contractTemplateLibrary.createContractFromTemplate(CONTRACT_TYPES.DAO, {
    votingDuration: 5 * 24 * 60 * 60, // 5天投票期
    quorumPercentage: 60
  });
  
  console.log(`✓ DAO合约Create successful`);
  console.log(`  类型: ${daoContract.type}`);
  console.log(`  投票周期: ${daoContract.config.votingDuration / (24*60*60)}  days`);
  console.log(`  法定人数: ${daoContract.config.quorumPercentage}%`);
  console.log('');
} catch (error) {
  console.error('✗ DAO合约创建Failed:', error.message);
}

// 测试4: 创建Token合约实例
console.log('4. 创建Token合约实例...');
try {
  const tokenContract = contractTemplateLibrary.createContractFromTemplate(CONTRACT_TYPES.TOKEN, {
    name: 'NexusGenesis Token',
    symbol: 'NGEN',
    initialSupply: 1000000,
    decimals: 18
  });
  
  console.log(`✓ Token合约Create successful`);
  console.log(`  名称: ${tokenContract.config.name}`);
  console.log(`  符号: ${tokenContract.config.symbol}`);
  console.log(`  初始供应量: ${tokenContract.config.initialSupply}`);
  console.log('');
} catch (error) {
  console.error('✗ Token合约创建Failed:', error.message);
}

// 测试5: 创建NFT合约实例
console.log('5. 创建NFT合约实例...');
try {
  const nftContract = contractTemplateLibrary.createContractFromTemplate(CONTRACT_TYPES.NFT, {
    name: 'NexusGenesis NFT Collection',
    symbol: 'NGNFT',
    maxSupply: 10000,
    baseURI: 'https://api.nexusgenesis.io/nft/'
  });
  
  console.log(`✓ NFT合约Create successful`);
  console.log(`  名称: ${nftContract.config.name}`);
  console.log(`  最大供应量: ${nftContract.config.maxSupply}`);
  console.log(`  版税率: ${nftContract.config.royaltyPercentage}%`);
  console.log('');
} catch (error) {
  console.error('✗ NFT合约创建Failed:', error.message);
}

// 测试6: 验证合约配置
console.log('6. 验证合约配置...');
const validationResult = contractTemplateLibrary.validateContractConfig(CONTRACT_TYPES.TOKEN, {
  name: 'Test Token',
  symbol: 'TST'
});

if (validationResult.valid) {
  console.log('✓ 合约配置验证通过');
} else {
  console.error('✗ 合约配置验证Failed:');
  validationResult.errors.forEach(err => console.log(`  - ${err}`));
}
console.log('');

// 测试7: 模拟Deploy contract
console.log('7. 模拟Deploy contract...');
const contractId = `contract-${Date.now()}`;
contractTemplateLibrary.recordDeployment(contractId, {
  type: CONTRACT_TYPES.TOKEN,
  address: '0x1234567890abcdef',
  config: { name: 'Deployed Token', symbol: 'DPT' }
});

const deployed = contractTemplateLibrary.getDeployedContract(contractId);
if (deployed) {
  console.log(`✓ Contract deployment记录成功`);
  console.log(`  合约ID: ${contractId}`);
  console.log(`  地址: ${deployed.address}`);
  console.log(`  状态: ${deployed.status}`);
  console.log(`  部署时间: ${new Date(deployed.deployedAt).toLocaleString()}`);
}
console.log('');

// 测试8: get统计信息
console.log('8. get统计信息...');
const stats = contractTemplateLibrary.getStats();
console.log(`✓ 统计信息:`);
console.log(`  模板总数: ${stats.totalTemplates}`);
console.log(`  已Deploy contract: ${stats.totalDeployed}`);
console.log(`  可用类型: ${stats.availableTypes.join(', ')}`);
console.log('');

console.log('=== 测试完成 ===');

/**
 * 加权投票系统测试
 */

import { WeightedVotingSystem, PROPOSAL_TYPES, PROPOSAL_STATUS } from '../src/governance/weightedVoting.js';
import { ContributionSystem } from '../src/ai/contributionSystem.js';

console.log('=== 加权投票系统测试 ===\n');

// 初始化
console.log('1. 初始化加权投票系统...');
WeightedVotingSystem.init();
console.log('✓ 系统Initialization complete\n');

// 设置一些测试代理的信誉分
console.log('2. 设置测试代理的信誉分...');
ContributionSystem.setAgentReputation('agent-1', 150);
ContributionSystem.setAgentReputation('agent-2', 200);
ContributionSystem.setAgentReputation('agent-3', 100);
ContributionSystem.setAgentReputation('agent-4', 300);
ContributionSystem.setAgentReputation('agent-5', 50);
console.log('✓ 信誉分设置完成\n');

// 创建提案
console.log('3. 创建测试提案...');
try {
  const proposalId = WeightedVotingSystem.createProposal({
    creatorId: 'agent-1',
    title: '测试提案：提高区块奖励',
    description: '将每个区块的奖励从 10 NGEN 提高到 15 NGEN',
    type: PROPOSAL_TYPES.PARAMETER_ADJUSTMENT,
    parameters: {
      blockReward: 15
    }
  });
  console.log(`✓ 提案Create successful，ID: ${proposalId}\n`);
  
  // 激活提案
  console.log('4. 激活提案...');
  WeightedVotingSystem.activateProposal(proposalId);
  console.log('✓ 提案已激活\n');
  
  // 代理投票
  console.log('5. 代理投票...');
  WeightedVotingSystem.castVote(proposalId, 'agent-1', 'yes');
  WeightedVotingSystem.castVote(proposalId, 'agent-2', 'yes');
  WeightedVotingSystem.castVote(proposalId, 'agent-3', 'no');
  WeightedVotingSystem.castVote(proposalId, 'agent-4', 'yes');
  WeightedVotingSystem.castVote(proposalId, 'agent-5', 'abstain');
  console.log('✓ 所有代理已投票\n');
  
  // 结束投票
  console.log('6. 结束投票...');
  // 临时修改投票结束时间以便测试
  const proposal = WeightedVotingSystem.getProposal(proposalId);
  proposal.votingEndsAt = Date.now() - 1000;
  
  const result = WeightedVotingSystem.endVoting(proposalId);
  console.log(`✓ 投票结束，结果: ${result}\n`);
  
  // 显示提案详情
  console.log('7. 提案详情:');
  const finalProposal = WeightedVotingSystem.getProposal(proposalId);
  console.log(`  - 标题: ${finalProposal.title}`);
  console.log(`  - 状态: ${finalProposal.status}`);
  console.log(`  - 赞成权重: ${finalProposal.yesWeight}`);
  console.log(`  - 反对权重: ${finalProposal.noWeight}`);
  console.log(`  - 弃权权重: ${finalProposal.abstainWeight}`);
  console.log(`  - 总权重: ${finalProposal.totalWeight}\n`);
  
  // 测试执行提案
  if (finalProposal.status === PROPOSAL_STATUS.PASSED) {
    console.log('8. 提交多签...');
    
    // 添加授权执行者
    WeightedVotingSystem.addAuthorizedExecutor('executor-1');
    WeightedVotingSystem.addAuthorizedExecutor('executor-2');
    
    // 提交执行签名（需要至少2个签名）
    const sigResult1 = WeightedVotingSystem.submitExecutionSignature(proposalId, 'signer-1', 'signature-1-data');
    console.log(`  签名者1: ${sigResult1.signaturesCollected}/${sigResult1.required} 签名`);
    
    const sigResult2 = WeightedVotingSystem.submitExecutionSignature(proposalId, 'signer-2', 'signature-2-data');
    console.log(`  签名者2: ${sigResult2.signaturesCollected}/${sigResult2.required} 签名`);
    
    // 执行者批准
    WeightedVotingSystem.approveExecution(proposalId, 'executor-1');
    console.log('  ✓ 执行者1approved');
    
    console.log('9. 执行提案（等待时间锁）...');
    // 临时修改执行时间以便测试
    finalProposal.executionWindowStart = Date.now() - 1000;
    finalProposal.executionWindowEnd = Date.now() + 10000;
    
    // 绕过时间锁（测试用）
    finalProposal.timeLockEnd = Date.now() - 1000;
    
    const executionResult = WeightedVotingSystem.executeProposal(proposalId, 'executor-1');
    console.log(`✓ 提案执行结果: ${JSON.stringify(executionResult, null, 2)}\n`);
    
    // 显示执行状态
    console.log('10. 提案执行状态:');
    const execStatus = WeightedVotingSystem.getProposalExecutionStatus(proposalId);
    console.log(execStatus);
    
    // 显示Audit Log
    console.log('\n11. Audit Log:');
    const auditLog = WeightedVotingSystem.getExecutionAuditLog(5);
    console.log(auditLog);
  }
  
  // get统计信息
  console.log('\n12. 治理统计:');
  const stats = WeightedVotingSystem.getGovernanceStats();
  console.log(stats);
  
} catch (error) {
  console.error('✗ 测试Failed:', error);
  console.error(error.stack);
}

console.log('\n=== 测试完成 ===');

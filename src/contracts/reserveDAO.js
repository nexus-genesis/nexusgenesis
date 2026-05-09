/**
 * Reserve 金库 DAO 合约
 * 将创世节点储备 (50M NGEN) 绑定到 DAO 合约管理
 *
 * 规则:
 * 1. Reserve 资金存入 DAO 金库
 * 2. 里程碑解锁需要 DAO 提案 + 投票通过
 * 3. Observer 拥有一票否决权
 * 4. 每个里程碑释放 10M NGEN
 */

import fs from 'fs/promises';
import path from 'path';

const RESERVE_ADDRESS = 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ';
const OBSERVER_ADDRESS = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';

const MILESTONES = [
  { id: 1, name: 'Network Launch', description: '网络正式启动并稳定运行', amount: 10000000n },
  { id: 2, name: 'AI Ecosystem', description: 'AI 智能体生态初具规模', amount: 10000000n },
  { id: 3, name: 'DeFi Integration', description: 'DeFi 集成与跨链桥接', amount: 10000000n },
  { id: 4, name: 'Enterprise Adoption', description: '企业级应用与合规化', amount: 10000000n },
  { id: 5, name: 'Global Expansion', description: '全球化扩展与社区自治', amount: 10000000n },
];

export class ReserveDAO {
  constructor(state, contracts) {
    this.state = state;
    this.contracts = contracts;
    this.reserveAddress = RESERVE_ADDRESS;
    this.observerAddress = OBSERVER_ADDRESS;
    this.proposals = [];
    this.members = [];
  }

  async initialize() {
    const reserveBalance = this.state.getBalance(this.reserveAddress);
    console.log(`[ReserveDAO] 初始化 - Reserve: ${this.reserveAddress.slice(0, 12)}... (${reserveBalance} NGEN)`);

    this.members.push({
      address: this.observerAddress,
      role: 'observer',
      vetoPower: true,
    });

    return {
      address: this.reserveAddress,
      balance: reserveBalance,
      milestones: MILESTONES.map(m => ({ ...m, status: 'locked' })),
      custodian: 'ReserveDAO',
    };
  }

  getReserveBalance() {
    return this.state.getBalance(this.reserveAddress);
  }

  getMilestones() {
    const released = this.state.tokenReleaseState?.genesisReserve?.releasedTokens || 0n;
    const totalReleased = typeof released === 'bigint' ? released : BigInt(released);

    return MILESTONES.map((m, idx) => {
      const cumulativeRequired = BigInt(idx + 1) * 10000000n;
      return {
        ...m,
        amount: m.amount.toString(),
        status: totalReleased >= cumulativeRequired ? 'unlocked' : 'locked',
      };
    });
  }

  createUnlockProposal(milestoneId, proposerAddress, expiryBlocks = 1000) {
    const milestone = MILESTONES.find(m => m.id === milestoneId);
    if (!milestone) {
      return { success: false, error: `里程碑 ${milestoneId} 不存在` };
    }

    const currentBlock = this.state.blockNumber || 0;
    const proposalId = `reserve-milestone-${milestoneId}-${currentBlock}`;

    const proposal = {
      id: proposalId,
      type: 'milestone_unlock',
      milestoneId,
      milestoneName: milestone.name,
      amount: milestone.amount.toString(),
      description: milestone.description,
      proposer: proposerAddress,
      createdAtBlock: currentBlock,
      expiryBlock: currentBlock + expiryBlocks,
      yesVotes: 0,
      noVotes: 0,
      voters: {},
      status: 'active',
      observerApproved: false,
      observerRejected: false,
    };

    this.proposals.push(proposal);
    console.log(`[ReserveDAO] 提案创建: ${proposalId} (${milestone.name}, ${milestone.amount} NGEN)`);

    return { success: true, proposal };
  }

  vote(proposalId, voterAddress, voteYes) {
    const proposal = this.proposals.find(p => p.id === proposalId);
    if (!proposal) {
      return { success: false, error: '提案不存在' };
    }
    if (proposal.status !== 'active') {
      return { success: false, error: `提案已${proposal.status}` };
    }
    if (proposal.voters[voterAddress]) {
      return { success: false, error: '已投过票' };
    }

    proposal.voters[voterAddress] = voteYes;
    if (voteYes) {
      proposal.yesVotes++;
    } else {
      proposal.noVotes++;
    }

    const totalVotes = proposal.yesVotes + proposal.noVotes;
    console.log(`[ReserveDAO] 投票: ${proposalId} ${voteYes ? 'YES' : 'NO'} (${proposal.yesVotes}/${totalVotes})`);
    return { success: true, proposal };
  }

  observerApprove(proposalId, signatureHex) {
    const proposal = this.proposals.find(p => p.id === proposalId);
    if (!proposal) {
      return { success: false, error: '提案不存在' };
    }
    if (proposal.observerRejected) {
      return { success: false, error: 'Observer 已否决此提案' };
    }

    proposal.observerApproved = true;
    proposal.observerSignature = signatureHex;
    console.log(`[ReserveDAO] Observer 批准: ${proposalId}`);
    return { success: true, proposal };
  }

  observerVeto(proposalId, signatureHex) {
    const proposal = this.proposals.find(p => p.id === proposalId);
    if (!proposal) {
      return { success: false, error: '提案不存在' };
    }

    proposal.observerRejected = true;
    proposal.status = 'rejected';
    proposal.observerSignature = signatureHex;
    console.log(`[ReserveDAO] Observer 否决: ${proposalId}`);
    return { success: true, proposal };
  }

  executeProposal(proposalId) {
    const proposal = this.proposals.find(p => p.id === proposalId);
    if (!proposal) {
      return { success: false, error: '提案不存在' };
    }
    if (proposal.status !== 'active') {
      return { success: false, error: `提案状态: ${proposal.status}` };
    }
    if (proposal.observerRejected) {
      proposal.status = 'rejected';
      return { success: false, error: 'Observer 已否决' };
    }

    const totalVotes = proposal.yesVotes + proposal.noVotes;
    const quorum = this.members.length;
    if (totalVotes < quorum / 2) {
      return { success: false, error: `未达法定人数 (${totalVotes}/${Math.ceil(quorum / 2)})` };
    }
    if (proposal.yesVotes <= proposal.noVotes) {
      proposal.status = 'rejected';
      return { success: false, error: '赞成票不足' };
    }

    proposal.status = 'executed';
    proposal.executedAtBlock = this.state.blockNumber || 0;

    const amount = BigInt(proposal.amount);
    if (this.state.tokenReleaseState?.genesisReserve) {
      const currentReleased = BigInt(this.state.tokenReleaseState.genesisReserve.releasedTokens || 0);
      this.state.tokenReleaseState.genesisReserve.releasedTokens = (currentReleased + amount).toString();
    }

    console.log(`[ReserveDAO] 执行提案: ${proposalId}, 释放 ${proposal.amount} NGEN`);
    return { success: true, proposal };
  }

  getProposal(proposalId) {
    return this.proposals.find(p => p.id === proposalId) || null;
  }

  getAllProposals() {
    return this.proposals;
  }

  addMember(address, role = 'member') {
    if (this.members.find(m => m.address === address)) {
      return { success: false, error: '已是成员' };
    }
    this.members.push({ address, role, vetoPower: false });
    console.log(`[ReserveDAO] 添加成员: ${address.slice(0, 12)}... (${role})`);
    return { success: true, member: { address, role } };
  }

  getStatus() {
    return {
      reserveAddress: this.reserveAddress,
      reserveBalance: this.getReserveBalance(),
      observerAddress: this.observerAddress,
      memberCount: this.members.length,
      activeProposalCount: this.proposals.filter(p => p.status === 'active').length,
      milestones: this.getMilestones(),
    };
  }
}

export { MILESTONES, RESERVE_ADDRESS, OBSERVER_ADDRESS };
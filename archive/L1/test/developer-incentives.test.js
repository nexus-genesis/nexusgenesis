import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { DeveloperIncentives, developerIncentives, INCENTIVE_TYPES, INCENTIVE_STATUS } from '../src/economy/developerIncentives.js';
import { ContributionSystem } from '../src/ai/contributionSystem.js';

describe('DeveloperIncentives — 开发者激励系统 (Phase 2)', () => {
  let incentives;

  beforeEach(() => {
    incentives = new DeveloperIncentives();
  });

  describe('Bug Bounty', () => {
    test('创建 Bug Bounty', () => {
      const bounty = incentives.createBugBounty({
        title: 'Critical reentrancy vulnerability in AINVM',
        description: 'Reentrancy attack possible in contract execution loop',
        severity: 'critical',
        reward: 5000,
        reporter: 'agent-security-1',
        targetModule: 'ainvm'
      });

      assert.ok(bounty.id.startsWith('bounty-'), 'ID 应以 bounty- 开头');
      assert.strictEqual(bounty.type, INCENTIVE_TYPES.BUG_BOUNTY);
      assert.strictEqual(bounty.severity, 'critical');
      assert.strictEqual(bounty.reward, 5000);
      assert.strictEqual(bounty.status, INCENTIVE_STATUS.OPEN);
      assert.strictEqual(bounty.reporter, 'agent-security-1');
    });

    test('奖励金额应在范围内', () => {
      const bounty1 = incentives.createBugBounty({
        title: 'Too low reward', severity: 'low', reward: 1, reporter: 'a1'
      });
      assert.ok(bounty1.reward >= incentives.defaultConfig.minBugBounty, '不应低于最小奖励');

      const bounty2 = incentives.createBugBounty({
        title: 'Too high reward', severity: 'critical', reward: 999999, reporter: 'a2'
      });
      assert.ok(bounty2.reward <= incentives.defaultConfig.maxBugBounty, '不应超过最大奖励');
    });

    test('提交 Bug 修复', () => {
      const bounty = incentives.createBugBounty({
        title: 'Test bug', severity: 'medium', reward: 500, reporter: 'r1'
      });

      const sub = incentives.submitBugFix(bounty.id, 'fixer-1', {
        description: 'Fixed by adding reentrancy guard',
        patch: 'require(!locked); locked = true; ...',
        proof: 'https://github.com/test/repro'
      });

      assert.ok(sub.id.startsWith('sub-'), '提交 ID 应以 sub- 开头');
      assert.strictEqual(sub.status, INCENTIVE_STATUS.SUBMITTED);
      assert.strictEqual(bounty.status, INCENTIVE_STATUS.IN_PROGRESS);
      assert.strictEqual(bounty.submissions.length, 1);
    });

    test('批准 Bug 修复', () => {
      const bounty = incentives.createBugBounty({
        title: 'Test bug', severity: 'high', reward: 2000, reporter: 'r1'
      });
      const sub = incentives.submitBugFix(bounty.id, 'fixer-1', {
        description: 'Fixed', patch: 'code', proof: 'link'
      });

      const approved = incentives.approveBugFix(bounty.id, sub.id, 'reviewer-1');
      assert.strictEqual(approved.status, INCENTIVE_STATUS.APPROVED);
      assert.strictEqual(bounty.status, INCENTIVE_STATUS.APPROVED);
      assert.strictEqual(bounty.resolvedBy, 'fixer-1');
    });

    test('对已关闭的 Bounty 提交修复应失败', () => {
      const bounty = incentives.createBugBounty({
        title: 'Closed bug', severity: 'low', reward: 100, reporter: 'r1'
      });
      incentives.submitBugFix(bounty.id, 'f1', { description: 'fix', patch: 'x', proof: 'y' });
      incentives.approveBugFix(bounty.id, bounty.submissions[0].id, 'rev');
      incentives.recordPayment(bounty.id, 'f1', 100);

      assert.throws(
        () => incentives.submitBugFix(bounty.id, 'f2', { description: 'another', patch: 'y', proof: 'z' }),
        /not open/,
        '已支付 Bounty 不能再提交修复'
      );
    });
  });

  describe('Feature Grant', () => {
    test('创建 Feature Grant', () => {
      const grant = incentives.createFeatureGrant({
        title: 'Develop Rust SDK for NexusGenesis',
        description: 'Create a comprehensive Rust SDK with async support',
        reward: 10000,
        proposer: 'core-team-1',
        deliverables: ['sdk crate', 'docs', 'examples', 'tests'],
        timeline: { start: Date.now(), estimatedDays: 60 }
      });

      assert.ok(grant.id.startsWith('grant-'), 'ID 应以 grant- 开头');
      assert.strictEqual(grant.type, INCENTIVE_TYPES.FEATURE_GRANT);
      assert.strictEqual(grant.reward, 10000);
      assert.strictEqual(grant.deliverables.length, 4);
      assert.strictEqual(grant.status, INCENTIVE_STATUS.OPEN);
    });

    test('申请开发资助', () => {
      const grant = incentives.createFeatureGrant({
        title: 'Rust SDK', reward: 10000, proposer: 'team'
      });
      ContributionSystem.setAgentReputation('dev-rust', 200);

      const app = incentives.applyForGrant(grant.id, 'dev-rust', {
        proposal: 'I will develop the Rust SDK within 45 days',
        estimate: { hours: 200, cost: 8000 },
        previousWork: ['solana-sdk', 'web3-rs']
      });

      assert.ok(app.id.startsWith('app-'), '申请 ID 应以 app- 开头');
      assert.strictEqual(app.status, INCENTIVE_STATUS.SUBMITTED);
      assert.strictEqual(app.reputation, 200);
      assert.strictEqual(grant.applicants.length, 1);
    });

    test('批准资助申请', () => {
      const grant = incentives.createFeatureGrant({
        title: 'Rust SDK', reward: 10000, proposer: 'team'
      });
      const app = incentives.applyForGrant(grant.id, 'dev-rust', {
        proposal: 'Will deliver in 45 days', estimate: { hours: 200 }, previousWork: []
      });

      const approved = incentives.approveGrantApplication(grant.id, app.id, 'reviewer');
      assert.strictEqual(approved.status, INCENTIVE_STATUS.APPROVED);
      assert.strictEqual(grant.status, INCENTIVE_STATUS.IN_PROGRESS);
      assert.strictEqual(grant.approvedApplicant, 'dev-rust');
    });
  });

  describe('PR Reward', () => {
    test('创建 PR 奖励', () => {
      const reward = incentives.createPRReward({
        prTitle: 'Fix consensus deadlock in multi-leader election',
        prUrl: 'https://github.com/nexusgenesis/core/pull/42',
        author: 'dev-alice',
        linesChanged: 150,
        repoModule: 'consensus'
      });

      assert.ok(reward.id.startsWith('pr-'), 'ID 应以 pr- 开头');
      assert.strictEqual(reward.type, INCENTIVE_TYPES.PR_REWARD);
      assert.ok(reward.reward > 0, '奖励应大于 0');
      assert.strictEqual(reward.status, INCENTIVE_STATUS.APPROVED);
      assert.strictEqual(reward.author, 'dev-alice');
    });

    test('PR 奖励不超过上限', () => {
      const reward = incentives.createPRReward({
        prTitle: 'Huge refactor', prUrl: 'url', author: 'dev',
        linesChanged: 100000, repoModule: 'core'
      });

      assert.ok(reward.reward <= incentives.defaultConfig.maxPrReward, '不超过 PR 奖励上限');
    });
  });

  describe('Challenge', () => {
    test('创建开发挑战', () => {
      const challenge = incentives.createChallenge({
        title: 'Build a DEX on NexusGenesis',
        description: 'Create a fully functional decentralized exchange',
        reward: 3000,
        creator: 'community',
        requirements: ['smart contract', 'frontend', 'tests'],
        deadline: Date.now() + 30 * 86400000
      });

      assert.ok(challenge.id.startsWith('challenge-'), 'ID 应以 challenge- 开头');
      assert.strictEqual(challenge.type, INCENTIVE_TYPES.CHALLENGE);
      assert.strictEqual(challenge.participants.length, 0);
      assert.strictEqual(challenge.maxParticipants, 50);
    });

    test('参加挑战', () => {
      const challenge = incentives.createChallenge({
        title: 'DEX Challenge', reward: 3000, creator: 'c'
      });

      const result = incentives.joinChallenge(challenge.id, 'participant-1');
      assert.strictEqual(result.position, 1);
      assert.ok(challenge.participants.includes('participant-1'));
    });

    test('提交挑战作品', () => {
      const challenge = incentives.createChallenge({
        title: 'DEX Challenge', reward: 3000, creator: 'c'
      });
      incentives.joinChallenge(challenge.id, 'builder-1');

      const sub = incentives.submitChallenge(challenge.id, 'builder-1', {
        solution: 'https://github.com/builder/dex',
        demo: 'https://dex-demo.nexusgenesis.io'
      });

      assert.ok(sub.id.startsWith('cs-'), '提交 ID 应以 cs- 开头');
      assert.strictEqual(challenge.submissions.length, 1);
    });

    test('未参加不能提交', () => {
      const challenge = incentives.createChallenge({
        title: 'DEX', reward: 3000, creator: 'c'
      });

      assert.throws(
        () => incentives.submitChallenge(challenge.id, 'outsider', { solution: 'x', demo: 'y' }),
        /Must join/,
        '未参加者不能提交'
      );
    });
  });

  describe('Payment', () => {
    test('记录支付', () => {
      const bounty = incentives.createBugBounty({
        title: 'Bug', severity: 'high', reward: 2000, reporter: 'r'
      });

      const payment = incentives.recordPayment(bounty.id, 'fixer', 2000);
      assert.ok(payment.id.startsWith('pay-'), '支付 ID 应以 pay- 开头');
      assert.strictEqual(payment.amount, 2000);
      assert.strictEqual(bounty.status, INCENTIVE_STATUS.PAID);
      assert.strictEqual(incentives.paymentHistory.length, 1);
    });
  });

  describe('Query', () => {
    test('getOpenIncentives 返回开放任务', () => {
      incentives.createBugBounty({ title: 'Bug 1', severity: 'low', reward: 100, reporter: 'r' });
      incentives.createFeatureGrant({ title: 'Grant 1', reward: 500, proposer: 'p' });

      const open = incentives.getOpenIncentives();
      assert.strictEqual(open.length, 2, '应有 2 个开放任务');
    });

    test('getAllIncentives 支持过滤', () => {
      incentives.createBugBounty({ title: 'B1', severity: 'low', reward: 100, reporter: 'r' });
      incentives.createFeatureGrant({ title: 'G1', reward: 500, proposer: 'p' });

      const bugs = incentives.getAllIncentives({ type: INCENTIVE_TYPES.BUG_BOUNTY });
      assert.strictEqual(bugs.length, 1, '过滤后应只有 1 个 Bug Bounty');
      assert.strictEqual(bugs[0].type, INCENTIVE_TYPES.BUG_BOUNTY);
    });

    test('getAgentRewards 返回 Agent 奖励汇总', () => {
      const bounty = incentives.createBugBounty({
        title: 'Bug', severity: 'high', reward: 2000, reporter: 'r'
      });
      const sub = incentives.submitBugFix(bounty.id, 'alice', { description: 'x', patch: 'y', proof: 'z' });
      incentives.approveBugFix(bounty.id, sub.id, 'reviewer');
      incentives.recordPayment(bounty.id, 'alice', 2000);

      const rewards = incentives.getAgentRewards('alice');
      assert.strictEqual(rewards.totalEarned, 2000);
      assert.strictEqual(rewards.incentives.length, 1);
    });

    test('getStats 返回整体统计', () => {
      incentives.createBugBounty({ title: 'B1', severity: 'medium', reward: 500, reporter: 'r1' });
      incentives.createBugBounty({ title: 'B2', severity: 'low', reward: 100, reporter: 'r2' });
      incentives.createFeatureGrant({ title: 'G1', reward: 2000, proposer: 'p1' });

      const stats = incentives.getStats();
      assert.strictEqual(stats.total, 3);
      assert.strictEqual(stats.totalRewards, 2600);
      assert.strictEqual(stats.countByType[INCENTIVE_TYPES.BUG_BOUNTY], 2);
      assert.strictEqual(stats.countByType[INCENTIVE_TYPES.FEATURE_GRANT], 1);
    });
  });

  describe('单例实例', () => {
    test('developerIncentives 是全局单例', () => {
      assert.ok(developerIncentives, '全局单例应存在');
      assert.ok(developerIncentives instanceof DeveloperIncentives);
    });
  });
});
import { describe, test } from 'node:test';
import assert from 'node:assert';
import sdk from '../src/sdk/index.js';
import { ContractTemplateLibrary } from '../src/contracts/templates/contractTemplates.js';

describe('SDK + Contract Templates (Phase 2)', () => {
  describe('SDK Incentive Methods', () => {
    test('createBugBounty', () => {
      const bounty = sdk.createBugBounty({
        title: 'Test bounty', severity: 'high', reward: 3000,
        reporter: 'agent-1', targetModule: 'bridge'
      });
      assert.ok(bounty.id.startsWith('bounty-'));
      assert.strictEqual(bounty.type, 'bug_bounty');
      assert.strictEqual(bounty.reward, 3000);
    });

    test('createFeatureGrant', () => {
      const grant = sdk.createFeatureGrant({
        title: 'Test grant', reward: 5000, proposer: 'dev-1'
      });
      assert.ok(grant.id.startsWith('grant-'));
      assert.strictEqual(grant.type, 'feature_grant');
    });

    test('createChallenge', () => {
      const challenge = sdk.createChallenge({
        title: 'Test challenge', reward: 1000, creator: 'c-1'
      });
      assert.ok(challenge.id.startsWith('challenge-'));
      assert.strictEqual(challenge.type, 'challenge');
    });

    test('recordPRReward', () => {
      const reward = sdk.recordPRReward({
        prTitle: 'Test PR', prUrl: 'url', author: 'dev', linesChanged: 100
      });
      assert.ok(reward.id.startsWith('pr-'));
      assert.strictEqual(reward.type, 'pr_reward');
    });

    test('getOpenIncentives returns array', () => {
      const open = sdk.getOpenIncentives();
      assert.ok(Array.isArray(open));
    });

    test('getAllIncentives supports type filter', () => {
      const result = sdk.getAllIncentives({ type: 'bug_bounty' });
      assert.ok(Array.isArray(result));
    });

    test('getIncentiveStats returns stats', () => {
      const stats = sdk.getIncentiveStats();
      assert.ok(typeof stats.total === 'number');
      assert.ok('countByType' in stats);
    });
  });

  describe('SDK Governance Methods', () => {
    test('createProposal', () => {
      const id = sdk.createProposal({
        title: 'SDK Proposal', description: 'Test', type: 'protocol_update'
      });
      assert.ok(typeof id === 'string');
      assert.ok(id.startsWith('proposal-'));
    });

    test('castVote', () => {
      const id = sdk.createProposal({ title: 'Vote Test', description: 'Vote' });
      sdk.castVote(id, 'voter-1', 'yes');
      const proposal = sdk.getProposal(id);
      assert.ok(proposal, 'Should be able to get proposal after voting');
    });

    test('getAllProposals', () => {
      const proposals = sdk.getAllProposals();
      assert.ok(Array.isArray(proposals));
      assert.ok(proposals.length > 0);
    });
  });

  describe('SDK Faucet Method', () => {
    test('faucetDrip', async () => {
      const result = await sdk.faucetDrip('ng1test00000000000000000000000000000000001', 100);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.address, 'ng1test00000000000000000000000000000000001');
      assert.strictEqual(result.amount, 100);
    });
  });

  describe('Contract Templates', () => {
    test('should have all 11 template types', () => {
      const tm = new ContractTemplateLibrary();
      const templates = tm.getAllTemplates();
      const types = templates.map(t => t.type);

      assert.ok(types.includes('did'));
      assert.ok(types.includes('dao'));
      assert.ok(types.includes('token'));
      assert.ok(types.includes('nft'));
      assert.ok(types.includes('staking'));
      assert.ok(types.includes('escrow'));
      assert.ok(types.includes('governance_token'));
      assert.ok(types.includes('crowdfunding'));
      assert.ok(types.includes('multi_sig'));
      assert.ok(types.includes('dev_incentive'));
      assert.ok(types.includes('marketplace'));
    });

    test('GOVERNANCE_TOKEN template has full methods', () => {
      const tm = new ContractTemplateLibrary();
      const t = tm.getTemplate('governance_token');
      assert.ok(t);
      assert.strictEqual(t.name, 'Governance Token');
      assert.strictEqual(t.complexity, 'advanced');
      assert.ok(t.methods.mint);
      assert.ok(t.methods.delegate);
      assert.ok(t.methods.propose);
      assert.ok(t.methods.castVote);
      assert.ok(t.methods.execute);
    });

    test('CROWDFUNDING template has milestone methods', () => {
      const tm = new ContractTemplateLibrary();
      const t = tm.getTemplate('crowdfunding');
      assert.ok(t);
      assert.strictEqual(t.name, 'Crowdfunding Campaign');
      assert.ok(t.methods.createCampaign);
      assert.ok(t.methods.contribute);
      assert.ok(t.methods.claimFunds);
      assert.ok(t.methods.refund);
      assert.ok(t.methods.createMilestone);
      assert.ok(t.methods.releaseMilestone);
    });

    test('MULTI_SIG template has security methods', () => {
      const tm = new ContractTemplateLibrary();
      const t = tm.getTemplate('multi_sig');
      assert.ok(t);
      assert.strictEqual(t.name, 'Multi-Signature Wallet');
      assert.ok(t.methods.addOwner);
      assert.ok(t.methods.removeOwner);
      assert.ok(t.methods.submitTransaction);
      assert.ok(t.methods.confirmTransaction);
      assert.ok(t.methods.executeTransaction);
      assert.ok(t.methods.emergencyFreeze);
      assert.ok(t.methods.emergencyUnfreeze);
    });

    test('DEV_INCENTIVE template', () => {
      const tm = new ContractTemplateLibrary();
      const t = tm.getTemplate('dev_incentive');
      assert.ok(t);
      assert.ok(t.methods.createBugBounty);
      assert.ok(t.methods.createGrant);
      assert.ok(t.methods.createChallenge);
      assert.ok(t.methods.claimReward);
    });

    test('MARKETPLACE template', () => {
      const tm = new ContractTemplateLibrary();
      const t = tm.getTemplate('marketplace');
      assert.ok(t);
      assert.ok(t.methods.listItem);
      assert.ok(t.methods.buyItem);
      assert.ok(t.methods.cancelListing);
      assert.ok(t.methods.makeOffer);
      assert.ok(t.methods.acceptOffer);
    });

    test('generateDeployParams with custom config', () => {
      const tm = new ContractTemplateLibrary();
      const t = tm.getTemplate('governance_token');
      const params = t.generateDeployParams({
        name: 'MyDAO Token',
        symbol: 'MDAO',
        totalSupply: 50000000
      });
      assert.strictEqual(params.name, 'MyDAO Token');
      assert.strictEqual(params.symbol, 'MDAO');
      assert.strictEqual(params.totalSupply, 50000000);
      assert.strictEqual(params.decimals, 18);
      assert.strictEqual(params.quorumPercent, 10);
    });
  });
});
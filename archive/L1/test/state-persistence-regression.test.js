import assert from 'node:assert/strict';
import { test } from 'node:test';

import { State } from '../src/blockchain/state.js';
import { buildBlockReward } from '../src/utils/transactionBuilder.js';

test('builder-style BLOCK_REWARD credits the explicit recipient', () => {
  const state = new State('reward-node');
  const recipient = 'ng1rewardrecipient000000000000000000000000';

  const applied = state.applyTransaction(buildBlockReward({
    to: recipient,
    amount: 50,
    blockHeight: 123,
    validatorId: 'validator-1'
  }), 123);

  assert.equal(applied, true);
  assert.equal(String(state.getBalance(recipient)), '50');
});

test('legacy state without genesisReserve.releasePercentage still serializes', () => {
  const state = new State('persist-node');

  state.loadFromJSON({
    balances: {},
    governanceState: {
      proposals: {},
      activeProposals: [],
      voteCounts: {},
      votedAgentProposals: {},
      voteReputationGiven: {}
    },
    contracts: {},
    agentRegistry: {
      agents: {},
      addressIndex: {}
    },
    auditState: {},
    tokenReleaseState: {
      swarmPool: {
        address: 'swarm',
        totalTokens: '0',
        releasedTokens: '0',
        lastReleaseBlock: 0,
        releaseInterval: 100,
        releasePercentage: '1',
        mechanism: 'PoC-PoW'
      },
      observer: {
        address: 'observer',
        totalTokens: '0',
        releasedTokens: '0',
        lastReleaseBlock: 0,
        releaseInterval: 100,
        releasePercentage: '25',
        mechanism: 'linear'
      },
      genesisReserve: {
        address: 'reserve',
        totalTokens: '0',
        releasedTokens: '0',
        lastReleaseBlock: 0,
        releaseInterval: 100,
        mechanism: 'milestone-multisig',
        milestones: []
      }
    }
  });

  const json = state.toJSON();

  assert.equal(json.tokenReleaseState.genesisReserve.releasePercentage, '0');
});

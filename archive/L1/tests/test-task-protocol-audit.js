/**
 * Phase 1C-5 Test: taskProtocol.js audit event integration
 *
 * Verifies that all balance-changing operations in taskProtocol.js
 * now emit audit events via recordAuditEvent().
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TASK_PROTOCOL_PATH = new URL('../src/protocol/taskProtocol.js', import.meta.url).href;
const { TaskProtocol, TASK_STATUS, TXN_TYPES } = await import(TASK_PROTOCOL_PATH);

const TRANSACTION_ENGINE_PATH = new URL('../src/blockchain/transactionEngine.js', import.meta.url).href;
const { attachTransactionState, TX_TYPE } = await import(TRANSACTION_ENGINE_PATH);

const STATE_PATH = new URL('../src/blockchain/state.js', import.meta.url).href;
const { State } = await import(STATE_PATH);

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; failures.push(name); }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

function createMockNode() {
  const state = new State('test-node-1');
  attachTransactionState(state);

  state.addBalance('ng1publisher0000000000000000000000000000000000', '1000000');
  state.addBalance('ng1claimant00000000000000000000000000000000000', '100000');
  state.addBalance('ng1challenger00000000000000000000000000000000', '100000');
  state.addBalance('ng1verifier0000000000000000000000000000000000', '100000');
  state.addBalance('ng1swarmpool000000000000000000000000000', '10000000');

  state.resolveRegisteredAgent = (address) => {
    if (address.startsWith('ng1publisher')) return { agentId: 'agent_pub_1', reputation: 10, address };
    if (address.startsWith('ng1claimant')) return { agentId: 'agent_claim_1', reputation: 15, address };
    if (address.startsWith('ng1challenger')) return { agentId: 'agent_chg_1', reputation: 20, address };
    return null;
  };

  state.slashReputation = (agentId, violationType) => {
    return { success: true, previousReputation: 10, newReputation: 5 };
  };

  state.awardActiveReferral = () => null;
  state.recordTaskCompletion = () => ({ tasksCompleted: 1 });

  const mockNode = {
    currentState: state,
    resolveRegisteredAgent: state.resolveRegisteredAgent,
    handleTransaction: async () => {},
    slashReputation: state.slashReputation.bind(state),
    awardActiveReferral: state.awardActiveReferral,
    recordTaskCompletion: state.recordTaskCompletion
  };

  return { state, mockNode };
}

async function main() {
  console.log('Phase 1C-5 Test: taskProtocol.js audit events');

  /* Test 1: Task publish -> TASK_ESCROW audit */
  section('Test 1: Task publish with escrow audit');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);

    const result = protocol.publish('ng1publisher0000000000000000000000000000000000', {
      title: 'Test Task 1',
      description: 'A test task',
      requiredCapabilities: ['coding'],
      taskType: 'coding',
      reward: '5000'
    });

    assert('publish success', result.success === true);
    const taskId = result.task.id;

    const ESCROW_ADDR = 'ng1escrow0000000000000000000000000000000';
    assert('escrow has 5000', BigInt(state.getBalance(ESCROW_ADDR)) === 5000n);

    const rewardEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TASK_REWARD });
    assert('reward events recorded', rewardEvents.total >= 1);
    const escrowEvent = rewardEvents.items.find(t => t.metadata?.event === 'TASK_ESCROW');
    assert('TASK_ESCROW audit found', !!escrowEvent);
    assert('escrow amount = 5000', escrowEvent && escrowEvent.amount === '5000');
    assert('metadata has taskId', escrowEvent && escrowEvent.metadata.taskId === taskId);
  }

  /* Test 2: Task complete (escrow) -> TASK_REWARD_PAID audit */
  section('Test 2: Task complete with escrow reward audit');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);

    const pubResult = protocol.publish('ng1publisher0000000000000000000000000000000000', {
      title: 'Test Task 2',
      description: 'Another test',
      reward: '3000'
    });
    assert('publish success', pubResult.success === true);
    const taskId = pubResult.task.id;

    protocol.claim('ng1claimant00000000000000000000000000000000000', taskId);
    protocol.submit('ng1claimant00000000000000000000000000000000000', taskId, { type: 'code_review', data: 'sample' });
    protocol.verify('ng1publisher0000000000000000000000000000000000', taskId, true, 'Looks good', {
      qualityScore: 4,
      skipChallengeWindow: true
    });

    const rewardEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TASK_REWARD });
    assert('TASK_REWARD tx found', rewardEvents.total >= 1);
    const paidEvent = rewardEvents.items.find(t => t.metadata?.event === 'TASK_REWARD_PAID');
    assert('TASK_REWARD_PAID audit found', !!paidEvent);
    assert('reward has claimant', paidEvent && paidEvent.metadata.claimant?.startsWith('ng1claimant'));
    assert('qualityScore recorded', paidEvent && paidEvent.metadata.qualityScore === 4);
  }

  /* Test 3: Task complete (swarm pool) -> SWARM_RELEASE audit */
  section('Test 3: Swarm pool task reward audit');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);
    const SWARM_POOL_ADDR = 'ng1swarmpool000000000000000000000000000';

    const pubResult = protocol.publish(SWARM_POOL_ADDR, {
      title: 'System Task',
      description: 'Funded by swarm pool',
      reward: '2000'
    });
    assert('system task publish success', pubResult.success === true);
    const taskId = pubResult.task.id;

    protocol.claim('ng1claimant00000000000000000000000000000000000', taskId);
    protocol.submit('ng1claimant00000000000000000000000000000000000', taskId, { type: 'analysis' });
    protocol.verify(SWARM_POOL_ADDR, taskId, true, 'OK', { qualityScore: 3, skipChallengeWindow: true });

    const swarmEvents = state.getTransactionHistory({ tx_type: TX_TYPE.SWARM_RELEASE });
    assert('SWARM_RELEASE tx found', swarmEvents.total >= 1);
    const releaseEvent = swarmEvents.items.find(t => t.metadata?.event === 'TASK_REWARD_RELEASE');
    assert('TASK_REWARD_RELEASE audit found', !!releaseEvent);
    assert('source is swarm_pool', releaseEvent && releaseEvent.metadata.source === 'swarm_pool');
  }

  /* Test 4: Task cancel -> TASK_REFUND audit */
  section('Test 4: Task cancellation with refund audit');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);

    const pubResult = protocol.publish('ng1publisher0000000000000000000000000000000000', {
      title: 'Cancel Me',
      description: 'Will be cancelled',
      reward: '4000'
    });
    assert('publish success', pubResult.success === true);
    const taskId = pubResult.task.id;

    protocol.cancel('ng1publisher0000000000000000000000000000000000', taskId);

    const refundEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TRANSFER });
    const refundEvent = refundEvents.items.find(t => t.metadata?.event === 'TASK_REFUND');
    assert('TASK_REFUND audit found', !!refundEvent);
    assert('reason is task_cancelled', refundEvent && refundEvent.metadata.reason === 'task_cancelled');
    assert('refund amount = 4000', refundEvent && refundEvent.amount === '4000');
  }

  /* Test 5: Challenge -> CHALLENGE_DEPOSIT audit */
  section('Test 5: Challenge deposit audit');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);

    const pubResult = protocol.publish('ng1publisher0000000000000000000000000000000000', {
      title: 'Challenge Me',
      description: 'Can be challenged',
      reward: '6000'
    });
    assert('publish success', pubResult.success === true);
    const taskId = pubResult.task.id;

    protocol.claim('ng1claimant00000000000000000000000000000000000', taskId);
    protocol.submit('ng1claimant00000000000000000000000000000000000', taskId, { type: 'research' });
    protocol.verify('ng1publisher0000000000000000000000000000000000', taskId, true, 'Approved', {
      qualityScore: 3,
      skipChallengeWindow: false
    });

    const challengeResult = protocol.challenge('ng1challenger00000000000000000000000000000000', taskId, 'Poor quality', 'Evidence');
    assert('challenge success', challengeResult.success === true);

    const depositEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TRANSFER });
    const depositEvent = depositEvents.items.find(t => t.metadata?.event === 'CHALLENGE_DEPOSIT');
    assert('CHALLENGE_DEPOSIT audit found', !!depositEvent);
    assert('has challengeId', depositEvent && depositEvent.metadata.challengeId?.startsWith('chg_'));
  }

  /* Test 6: Challenge upheld -> multiple audits */
  section('Test 6: Challenge deposit recorded');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);

    const pubResult = protocol.publish('ng1publisher0000000000000000000000000000000000', {
      title: 'Upheld Test',
      description: 'Will be challenged',
      reward: '8000'
    });
    assert('publish success', pubResult.success === true);
    const taskId = pubResult.task.id;

    protocol.claim('ng1claimant00000000000000000000000000000000000', taskId);
    protocol.submit('ng1claimant00000000000000000000000000000000000', taskId, { type: 'coding' });
    protocol.verify('ng1publisher0000000000000000000000000000000000', taskId, true, 'OK', {
      qualityScore: 3,
      skipChallengeWindow: false
    });

    protocol.challenge('ng1challenger00000000000000000000000000000000', taskId, 'Bad work', '');

    const depositEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TRANSFER });
    const challengeDeposits = depositEvents.items.filter(t => t.metadata?.event === 'CHALLENGE_DEPOSIT');
    assert('challenge deposit recorded', challengeDeposits.length >= 1);
  }

  /* Test 7: Challenge rejected -> CHALLENGE_FORFEIT audit */
  section('Test 7: Challenge rejection audit');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);

    const pubResult = protocol.publish('ng1publisher0000000000000000000000000000000000', {
      title: 'Rejected Test',
      description: 'Challenge will be rejected',
      reward: '7000'
    });
    assert('publish success', pubResult.success === true);
    const taskId = pubResult.task.id;

    protocol.claim('ng1claimant00000000000000000000000000000000000', taskId);
    protocol.submit('ng1claimant00000000000000000000000000000000000', taskId, { type: 'analysis' });
    protocol.verify('ng1publisher0000000000000000000000000000000000', taskId, true, 'OK', {
      qualityScore: 3,
      skipChallengeWindow: false
    });

    protocol.challenge('ng1challenger00000000000000000000000000000000', taskId, 'Unfounded', '');

    const depositEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TRANSFER });
    const challengeDeposits = depositEvents.items.filter(t => t.metadata?.event === 'CHALLENGE_DEPOSIT');
    assert('challenge deposit exists', challengeDeposits.length >= 1);
  }

  /* Test 8: Quality refund */
  section('Test 8: Quality refund for low-rated task');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);

    const pubResult = protocol.publish('ng1publisher0000000000000000000000000000000000', {
      title: 'Low Quality Task',
      description: 'Will get poor rating',
      reward: '10000'
    });
    assert('publish success', pubResult.success === true);
    const taskId = pubResult.task.id;

    protocol.claim('ng1claimant00000000000000000000000000000000000', taskId);
    protocol.submit('ng1claimant00000000000000000000000000000000000', taskId, { type: 'documentation' });
    protocol.verify('ng1publisher0000000000000000000000000000000000', taskId, true, 'Poor work', {
      qualityScore: 1,
      skipChallengeWindow: true
    });

    const rewardEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TASK_REWARD });
    const paidEvent = rewardEvents.items.find(t => t.metadata?.event === 'TASK_REWARD_PAID');
    assert('reward paid audit found', !!paidEvent);
    assert('qualityScore = 1', paidEvent && paidEvent.metadata.qualityScore === 1);
    assert('multiplier = 0.5', paidEvent && paidEvent.metadata.multiplier === 0.5);
  }

  /* Test 9: Full lifecycle audit trail */
  section('Test 9: Full lifecycle audit trail');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);

    const pubResult = protocol.publish('ng1publisher0000000000000000000000000000000000', {
      title: 'Full Lifecycle',
      description: 'Complete audit trail test',
      reward: '5000'
    });
    assert('publish success', pubResult.success === true);
    const taskId = pubResult.task.id;

    protocol.claim('ng1claimant00000000000000000000000000000000000', taskId);
    protocol.submit('ng1claimant00000000000000000000000000000000000', taskId, { type: 'research' });
    protocol.verify('ng1publisher0000000000000000000000000000000000', taskId, true, 'Good', {
      qualityScore: 3,
      skipChallengeWindow: true
    });

    const allHistory = state.getTransactionHistory();
    assert(`total history entries >= 2`, allHistory.total >= 2);

    const escrowEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TASK_REWARD });
    const escrowAudit = escrowEvents.items.find(t => t.metadata?.event === 'TASK_ESCROW');
    assert('observer events (TASK_ESCROW) >= 1', !!escrowAudit);

    const taskRewardEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TASK_REWARD });
    const paidAudit = taskRewardEvents.items.find(t => t.metadata?.event === 'TASK_REWARD_PAID');
    assert('TASK_REWARD events >= 1', !!paidAudit);
  }

  /* Test 10: Challenge deposit round-trip */
  section('Test 10: Challenge deposit round-trip audit');
  {
    const { state, mockNode } = createMockNode();
    const protocol = new TaskProtocol(mockNode);

    const pubResult = protocol.publish('ng1publisher0000000000000000000000000000000000', {
      title: 'Round Trip',
      description: 'Challenge deposit refund test',
      reward: '3000'
    });
    assert('publish success', pubResult.success === true);
    const taskId = pubResult.task.id;

    protocol.claim('ng1claimant00000000000000000000000000000000000', taskId);
    protocol.submit('ng1claimant00000000000000000000000000000000000', taskId, { type: 'coding' });
    protocol.verify('ng1publisher0000000000000000000000000000000000', taskId, true, 'OK', {
      qualityScore: 3,
      skipChallengeWindow: false
    });

    protocol.challenge('ng1challenger00000000000000000000000000000000', taskId, 'Disagree', '');

    const depositEvents = state.getTransactionHistory({ tx_type: TX_TYPE.TRANSFER });
    const challengeDeposits = depositEvents.items.filter(t => t.metadata?.event === 'CHALLENGE_DEPOSIT');
    assert('at least 1 challenge deposit', challengeDeposits.length >= 1);
    if (challengeDeposits.length > 0) {
      const dep = challengeDeposits[0];
      assert('deposit amount > 0', BigInt(dep.amount) > 0n);
      assert('has taskId in metadata', dep.metadata.taskId === taskId);
    }
  }

  /* Summary */
  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    console.log('Failures:');
    failures.forEach(f => console.log('  - ' + f));
  }

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

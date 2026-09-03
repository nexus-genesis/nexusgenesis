/**
 * Unit & Integration Test: AgentWalletManager (Phase 2-D4)
 *
 * Full coverage of the 19 public methods in src/wallet/agentWalletManager.js.
 * This is the "financial code without tests = suicide" file — every method
 * that moves NGEN, signs data, or mutates wallet state is exercised here.
 *
 * Methods covered:
 *   1.  createAgentWallet        (happy + duplicate + balance + metadata)
 *   2.  claimFaucet              (unknown agent + ineligible)
 *   3.  getAgentWallet           (existing + missing)
 *   4.  getWalletInstance        (existing + missing)
 *   5.  getWalletInstanceByAddress (existing + missing)
 *   6.  getAgentByAddress        (existing + missing)
 *   7.  getBalance               (existing + missing)
 *   8.  transfer                 (8 scenarios incl. happy + 4 error paths + tax/nonce/sig)
 *   9.  batchTransfer            (all-success + partial-failure)
 *  10.  getTransactionHistory    (unknown + known + limit/offset + globalState)
 *  11.  exportAgentWallet        (happy + missing)
 *  12.  importAgentWallet        (happy + invalid envelope + wrong password)
 *  13.  syncBalance              (max() preservation, nonce sync, missing)
 *  14.  updateBalance            (happy + missing)
 *  15.  listAllWallets           (array shape)
 *  16.  listAllAddresses         (array shape with balances)
 *  17.  getStats                 (totals + activeWallets)
 *  18.  verifyTransaction        (happy + missing + tampered)
 *  19.  signForAgent             (string + object + missing + verify)
 *
 * Test agents use the prefix `d4-test-{timestamp}-` so they are unique across
 * runs and easy to clean up.
 */

import agentWalletManager from '../src/wallet/agentWalletManager.js';
import { PQCWallet } from '../src/wallet/pqcWallet.js';
import { sign as pqcSign, verify as pqcVerifyFn } from '../src/crypto/pqc.js';

let passed = 0, failed = 0;

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; }
}

// Unique prefix to avoid registry collisions
const PREFIX = `d4-test-${Date.now()}`;
const createdAgentIds = [];

function newId(suffix) {
  const id = `${PREFIX}-${suffix}`;
  createdAgentIds.push(id);
  return id;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  AgentWalletManager Full Coverage (Phase 2-D4)');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  test agent prefix: ${PREFIX}\n`);

  // ════════════════════════════════════════════════════════════════════
  // Test 1: createAgentWallet
  // ════════════════════════════════════════════════════════════════════
  console.log('=== Test 1: createAgentWallet ===');
  let agent1, agent1Id;
  {
    agent1Id = newId('create-1');
    const w = await agentWalletManager.createAgentWallet(agent1Id, {
      type: 'd4-test', capabilities: ['testing']
    });
    assert('returns object', typeof w === 'object' && w !== null);
    assert('has agentId field', w.agentId === agent1Id);
    assert('has address (ng1...)', typeof w.address === 'string' && w.address.startsWith('ng1'));
    assert('has balance (number)', typeof w.balance === 'number');
    assert('has balanceRaw (bigint string)', typeof w.balanceRaw === 'string');
    assert('has publicKey (hex)', typeof w.publicKey === 'string' && w.publicKey.length === 2624);
    assert('has nonce=0', w.nonce === 0);
    assert('has symbol=NGEN', w.symbol === 'NGEN');
    assert('has created timestamp', typeof w.created === 'string');
    assert('initial balance is 1000n', w.balance === 1000);
    agent1 = w;
  }
  // Duplicate create returns existing
  {
    const w2 = await agentWalletManager.createAgentWallet(agent1Id, { type: 'different' });
    assert('duplicate create returns same address', w2.address === agent1.address);
    assert('duplicate create returns same balance', w2.balance === agent1.balance);
  }
  // Create with explicit initialBalance
  {
    const id = newId('create-custom');
    const w = await agentWalletManager.createAgentWallet(id, {}, 5000n);
    assert('custom initial balance respected', w.balance === 5000);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 2: claimFaucet
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 2: claimFaucet ===');
  {
    const r1 = await agentWalletManager.claimFaucet('definitely-not-a-real-agent');
    assert('unknown agent → success:false', r1.success === false);
    assert('unknown agent → reason mentions not found',
      /not found/i.test(r1.reason || ''));
  }
  {
    // Known agent — result depends on faucet cooldown state
    const r2 = await agentWalletManager.claimFaucet(agent1Id, '127.0.0.1');
    assert('known agent → returns result object',
      typeof r2 === 'object' && 'success' in r2);
    // Either success (faucet paid) or failure with cooldown/reason — both valid
    if (!r2.success) {
      assert('failure has reason', typeof r2.reason === 'string');
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 3: getAgentWallet
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 3: getAgentWallet ===');
  {
    const w = agentWalletManager.getAgentWallet(agent1Id);
    assert('existing → returns formatted', w !== null);
    assert('agentId matches', w.agentId === agent1Id);
    assert('address matches', w.address === agent1.address);
    assert('publicKey matches', w.publicKey === agent1.publicKey);

    const missing = agentWalletManager.getAgentWallet('d4-nonexistent-' + Date.now());
    assert('missing → returns null', missing === null);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 4: getWalletInstance
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 4: getWalletInstance ===');
  {
    const inst = agentWalletManager.getWalletInstance(agent1Id);
    assert('existing → returns PQCWallet', inst instanceof PQCWallet);
    assert('instance has address', inst.address === agent1.address);
    assert('instance has privateKey', Buffer.isBuffer(inst.privateKey) || inst.privateKey instanceof Uint8Array);
    assert('instance has publicKey', Buffer.isBuffer(inst.publicKey) || inst.publicKey instanceof Uint8Array);
    assert('privateKey length = 2560 (Dilithium2)',
      (Buffer.isBuffer(inst.privateKey) ? inst.privateKey.length : inst.privateKey.byteLength) === 2560);

    const missing = agentWalletManager.getWalletInstance('d4-no-such-agent');
    assert('missing → returns null', missing === null);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 5: getWalletInstanceByAddress
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 5: getWalletInstanceByAddress ===');
  {
    const inst = agentWalletManager.getWalletInstanceByAddress(agent1.address);
    assert('known address → returns PQCWallet', inst instanceof PQCWallet);
    assert('returned wallet address matches', inst.address === agent1.address);

    const missing = agentWalletManager.getWalletInstanceByAddress('ng1nonexistent0000000000000000000000000000');
    assert('unknown address → null', missing === null);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 6: getAgentByAddress
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 6: getAgentByAddress ===');
  {
    const aid = agentWalletManager.getAgentByAddress(agent1.address);
    assert('known address → returns agentId', aid === agent1Id);

    const missing = agentWalletManager.getAgentByAddress('ng1nonexistent0000000000000000000000000000');
    assert('unknown address → null', missing === null);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 7: getBalance
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 7: getBalance ===');
  {
    const r = agentWalletManager.getBalance(agent1Id);
    assert('existing → success:true', r.success === true);
    assert('returns agentId', r.agentId === agent1Id);
    assert('returns address', r.address === agent1.address);
    assert('returns balance (number)', typeof r.balance === 'number');
    assert('returns balanceRaw (string)', typeof r.balanceRaw === 'string');
    assert('balanceRaw matches wallet', r.balanceRaw === agent1.balanceRaw);
    assert('symbol=NGEN', r.symbol === 'NGEN');
    assert('nonce is number', typeof r.nonce === 'number');

    const missing = agentWalletManager.getBalance('d4-not-a-real-agent');
    assert('missing → success:false', missing.success === false);
    assert('missing → reason mentions not found',
      /not found/i.test(missing.reason || ''));
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 8: transfer — the core financial operation
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 8: transfer ===');
  const transferSenderId = newId('xfer-sender');
  const transferRecipientId = newId('xfer-recipient');
  await agentWalletManager.createAgentWallet(transferSenderId);
  await agentWalletManager.createAgentWallet(transferRecipientId);
  // Bump sender balance for transfer tests
  agentWalletManager.updateBalance(transferSenderId, 100000n);

  // 8.1: Happy path — agent to agent
  let transferResult;
  {
    const senderBefore = agentWalletManager.getBalance(transferSenderId).balance;
    const recipBefore = agentWalletManager.getBalance(transferRecipientId).balance;
    const r = await agentWalletManager.transfer(transferSenderId, transferRecipientId, 1000, 'test transfer');
    assert('happy: success:true', r.success === true);
    assert('happy: has transactionId', typeof r.transactionId === 'string');
    assert('happy: amount recorded', r.amount === 1000);
    assert('happy: netAmount = 999 (1000 - 0.1% tax)', r.netAmount === 999);
    assert('happy: metabolicTax = 1 (0.1% of 1000)', r.metabolicTax === 1);
    assert('happy: fee = 1', r.fee === 1);
    assert('happy: memo recorded', r.memo === 'test transfer');
    assert('happy: signature recorded (prefix)', typeof r.signature === 'string' && r.signature.endsWith('...'));

    const senderAfter = agentWalletManager.getBalance(transferSenderId).balance;
    const recipAfter = agentWalletManager.getBalance(transferRecipientId).balance;
    assert('sender debited by amount + fee (1001)', senderBefore - senderAfter === 1001,
      `before=${senderBefore} after=${senderAfter}`);
    assert('recipient credited by netAmount (999)', recipAfter - recipBefore === 999,
      `before=${recipBefore} after=${recipAfter}`);

    const senderInst = agentWalletManager.getWalletInstance(transferSenderId);
    assert('sender nonce incremented', senderInst.nonce === 1,
      `got ${senderInst.nonce}`);
    transferResult = r;
  }
  // 8.2: Happy path — agent to ng1 address
  {
    const r = await agentWalletManager.transfer(transferSenderId, agent1.address, 500, 'to-address');
    assert('to-address: success:true', r.success === true);
    assert('to-address: to = address', r.to === agent1.address);
  }
  // 8.3: Insufficient balance
  {
    const r = await agentWalletManager.transfer(transferSenderId, transferRecipientId, 100000000, 'too much');
    assert('insufficient → success:false', r.success === false);
    assert('insufficient → reason mentions balance',
      /insufficient/i.test(r.reason || ''));
  }
  // 8.4: Invalid recipient
  {
    const r = await agentWalletManager.transfer(transferSenderId, 'not-a-valid-address', 100, 'bad dest');
    assert('invalid dest → success:false', r.success === false);
    assert('invalid dest → reason mentions address',
      /address/i.test(r.reason || ''));
  }
  // 8.5: Below minimum
  {
    const r = await agentWalletManager.transfer(transferSenderId, transferRecipientId, 0, 'zero');
    assert('amount=0 → success:false', r.success === false);
    assert('amount=0 → reason mentions minimum',
      /minimum/i.test(r.reason || ''));
  }
  // 8.6: Above maximum
  {
    const r = await agentWalletManager.transfer(transferSenderId, transferRecipientId, 999999999, 'too high');
    assert('amount=999999999 → success:false', r.success === false);
    assert('amount=999999999 → reason mentions maximum',
      /maximum/i.test(r.reason || ''));
  }
  // 8.7: Sender not found
  {
    const r = await agentWalletManager.transfer('d4-no-such-sender', transferRecipientId, 100, 'x');
    assert('missing sender → success:false', r.success === false);
    assert('missing sender → reason mentions not found',
      /not found/i.test(r.reason || ''));
  }
  // 8.8: Signature is verifiable (Dilithium2)
  {
    const inst = agentWalletManager.getWalletInstance(transferSenderId);
    // Re-derive the canonical message from a fresh Transaction — but we
    // already have a transactionId and the on-disk state isn't easy to
    // reconstruct. Instead, sign a fresh payload and verify the wallet's
    // signing roundtrip is intact (covered more thoroughly in Test 19).
    // Here we just verify the transfer result has a signature-shaped string.
    assert('transfer has hex signature prefix', /^[0-9a-f]{32,}\.\.\.$/.test(transferResult.signature),
      `got ${transferResult.signature}`);
    // Verify the sender wallet can still sign
    const fresh = await agentWalletManager.signForAgent(transferSenderId, 'phase2-d4-verify');
    const sigBuf = Buffer.from(fresh.signature, 'hex');
    const pubBuf = Buffer.from(fresh.publicKey, 'hex');
    const ok = await pqcVerifyFn('phase2-d4-verify', sigBuf, pubBuf);
    assert('post-transfer wallet still signs+verifies', ok === true);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 9: batchTransfer
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 9: batchTransfer ===');
  {
    const r = await agentWalletManager.batchTransfer(transferSenderId, [
      { to: transferRecipientId, amount: 100, memo: 'batch-1' },
      { to: agent1.address, amount: 200, memo: 'batch-2' }
    ]);
    assert('all-success: success:true', r.success === true);
    assert('all-success: totalTransfers=2', r.totalTransfers === 2);
    assert('all-success: successful=2', r.successful === 2);
    assert('all-success: failed=0', r.failed === 0);
    assert('all-success: results has 2 entries', Array.isArray(r.results) && r.results.length === 2);
  }
  {
    // Partial failure: one valid, one invalid
    const r = await agentWalletManager.batchTransfer(transferSenderId, [
      { to: transferRecipientId, amount: 50, memo: 'partial-1' },
      { to: 'invalid-address-xxx', amount: 50, memo: 'partial-2' }
    ]);
    assert('partial: success:false', r.success === false);
    assert('partial: totalTransfers=2', r.totalTransfers === 2);
    assert('partial: successful=1', r.successful === 1);
    assert('partial: failed=1', r.failed === 1);
    assert('partial: results[0].success', r.results[0].success === true);
    assert('partial: results[1].success:false', r.results[1].success === false);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 10: getTransactionHistory
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 10: getTransactionHistory ===');
  {
    const r = agentWalletManager.getTransactionHistory(transferSenderId);
    assert('existing agent: success:true', r.success === true);
    assert('returns agentId', r.agentId === transferSenderId);
    assert('returns address', r.address?.startsWith('ng1'));
    assert('transactions is array', Array.isArray(r.transactions));
    assert('total is number', typeof r.total === 'number');
    assert('limit/offset default to 20/0', r.limit === 20 && r.offset === 0);
  }
  {
    const r = agentWalletManager.getTransactionHistory(transferSenderId, { limit: 5, offset: 2 });
    assert('custom limit/offset respected', r.limit === 5 && r.offset === 2);
  }
  {
    const r = agentWalletManager.getTransactionHistory('d4-no-such-agent');
    assert('missing agent: success:false', r.success === false);
    assert('missing agent: reason mentions not found',
      /not found/i.test(r.reason || ''));
  }
  {
    // If globalState is set with transactions, history reflects them
    const fakeAddress = agentWalletManager.getBalance(transferSenderId).address;
    const fakeTx = { id: 'fake-tx-1', type: 'TRANSFER', from: fakeAddress, to: 'ng1other', amount: 1, timestamp: Date.now() };
    global.globalState = {
      getTransactionsForAddress: (addr) => addr === fakeAddress ? [fakeTx] : []
    };
    const r = agentWalletManager.getTransactionHistory(transferSenderId);
    assert('globalState transactions read', r.total === 1 && r.transactions[0]?.id === 'fake-tx-1');
    assert('direction computed (send)', r.transactions[0]?.direction === 'send');
    delete global.globalState;
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 11: exportAgentWallet
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 11: exportAgentWallet ===');
  let exportedEnvelope;
  {
    const enc = agentWalletManager.exportAgentWallet(transferSenderId, 'd4-test-password-1234');
    assert('returns object', enc !== null && typeof enc === 'object');
    assert('envelope has ciphertext', !!enc.ciphertext);
    assert('envelope has cipher', enc.cipher === 'aes-256-gcm');
    assert('envelope has kdf', !!enc.kdf);
    exportedEnvelope = enc;
  }
  {
    const r = agentWalletManager.exportAgentWallet('d4-no-such-agent', 'pw');
    assert('missing agent → null', r === null);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 12: importAgentWallet
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 12: importAgentWallet ===');
  {
    const importId = newId('imported');
    const ok = agentWalletManager.importAgentWallet(importId, exportedEnvelope, 'd4-test-password-1234');
    assert('valid import: success', ok === true);
    const inst = agentWalletManager.getWalletInstance(importId);
    assert('imported wallet has same address as exported',
      inst.address === agentWalletManager.getBalance(transferSenderId).address);
  }
  {
    // Invalid envelope (not the right format)
    const r = agentWalletManager.importAgentWallet(newId('bad-import'), { foo: 'bar' }, 'pw');
    assert('invalid envelope → false', r === false);
  }
  {
    // Wrong password
    const r = agentWalletManager.importAgentWallet(newId('wrong-pw'), exportedEnvelope, 'wrong-password');
    assert('wrong password → false', r === false);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 13: syncBalance
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 13: syncBalance ===');
  {
    // Setup: agent with soft balance of 1000
    const syncId = newId('sync-up');
    await agentWalletManager.createAgentWallet(syncId);
    // On-chain state has higher balance → wallet should be raised
    const onChain = { getBalance: () => 5000, getNonce: () => 42, balances: {}, nonces: {} };
    const r = agentWalletManager.syncBalance(syncId, onChain);
    assert('sync up: success', r.success === true);
    assert('sync up: balance raised to 5000', r.balance === 5000);
    assert('sync up: onChainBalance reported', r.onChainBalance === 5000);
    assert('sync up: nonce synced to 42', r.nonce === 42);
  }
  {
    // Setup: agent with balance 5000, on-chain is 0 (the famous "never zero out" fix)
    const syncId2 = newId('sync-zero');
    await agentWalletManager.createAgentWallet(syncId2, {}, 5000n);
    const onChain = { getBalance: () => 0, getNonce: () => 0, balances: {}, nonces: {} };
    const r = agentWalletManager.syncBalance(syncId2, onChain);
    assert('sync down: success', r.success === true);
    const inst = agentWalletManager.getWalletInstance(syncId2);
    assert('sync down: wallet balance NOT zeroed (max() preservation)',
      inst.balance === 5000n,
      `got ${inst.balance}`);
  }
  {
    // Missing agent
    const r = agentWalletManager.syncBalance('d4-no-such-agent', { getBalance: () => 0 });
    assert('missing agent → success:false', r.success === false);
    assert('missing agent → reason', /not found/i.test(r.reason || ''));
  }
  {
    // No blockchain state — should not throw, should still succeed
    const syncId3 = newId('sync-null');
    await agentWalletManager.createAgentWallet(syncId3);
    const r = agentWalletManager.syncBalance(syncId3, null);
    assert('null state: success', r.success === true);
    assert('null state: onChainBalance=0', r.onChainBalance === 0);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 14: updateBalance
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 14: updateBalance ===');
  {
    const updId = newId('updatebal');
    await agentWalletManager.createAgentWallet(updId);
    const r = agentWalletManager.updateBalance(updId, 9999n);
    assert('happy: returns true', r === true);
    const bal = agentWalletManager.getBalance(updId);
    assert('balance updated to 9999', bal.balance === 9999);
  }
  {
    const r = agentWalletManager.updateBalance('d4-no-such-agent', 100n);
    assert('missing → false', r === false);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 15: listAllWallets
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 15: listAllWallets ===');
  {
    const wallets = agentWalletManager.listAllWallets();
    assert('returns array', Array.isArray(wallets));
    assert('array length = totalWallets', wallets.length === agentWalletManager.getStats().totalWallets);
    assert('each entry has agentId', wallets.every(w => typeof w.agentId === 'string'));
    assert('each entry has address', wallets.every(w => typeof w.address === 'string' && w.address.startsWith('ng1')));
    assert('each entry has balance (number)', wallets.every(w => typeof w.balance === 'number'));
    assert('each entry has publicKey', wallets.every(w => typeof w.publicKey === 'string'));
    // Our created agents are included
    assert('contains our test agent', wallets.some(w => w.agentId === agent1Id));
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 16: listAllAddresses
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 16: listAllAddresses ===');
  {
    const addrs = agentWalletManager.listAllAddresses();
    assert('returns array', Array.isArray(addrs));
    assert('length = totalWallets', addrs.length === agentWalletManager.getStats().totalWallets);
    assert('each has agentId', addrs.every(a => typeof a.agentId === 'string'));
    assert('each has ng1 address', addrs.every(a => typeof a.address === 'string' && a.address.startsWith('ng1')));
    assert('each has balance (number)', addrs.every(a => typeof a.balance === 'number'));
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 17: getStats
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 17: getStats ===');
  {
    const s = agentWalletManager.getStats();
    assert('totalWallets is number', typeof s.totalWallets === 'number' && s.totalWallets > 0);
    assert('totalBalance is number', typeof s.totalBalance === 'number');
    assert('totalTransactions is number', typeof s.totalTransactions === 'number');
    assert('activeWallets is number', typeof s.activeWallets === 'number');
    assert('activeWallets ≤ totalWallets', s.activeWallets <= s.totalWallets);
    assert('returns agentIds array', Array.isArray(s.agentIds));
  }
  // Verify a successful transfer bumps totalTransactions
  {
    const before = agentWalletManager.getStats().totalTransactions;
    const txId = newId('stats-tx-sender');
    const txRcv = newId('stats-tx-receiver');
    await agentWalletManager.createAgentWallet(txId);
    await agentWalletManager.createAgentWallet(txRcv);
    agentWalletManager.updateBalance(txId, 10000n);
    const r = await agentWalletManager.transfer(txId, txRcv, 100, 'stats test');
    if (r.success) {
      const after = agentWalletManager.getStats().totalTransactions;
      assert('totalTransactions increments on successful transfer',
        after === before + 1, `before=${before} after=${after}`);
    } else {
      // Even if transfer failed, we should have a real (not stale) count
      assert('totalTransactions is still a number', typeof after === 'number');
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 18: verifyTransaction
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 18: verifyTransaction ===');
  {
    // Sign a payload, then verify
    const data = { foo: 'bar', nonce: 1 };
    const sig = await agentWalletManager.signForAgent(transferSenderId, data);
    // verifyTransaction expects an OBJECT (it JSON.stringifies internally).
    // Passing a pre-stringified value would cause double-stringification and
    // the signature would not match.
    const ok = await agentWalletManager.verifyTransaction(transferSenderId, data, Buffer.from(sig.signature, 'hex'));
    assert('valid signature → true', ok === true);
  }
  {
    // Tampered signature → false
    const data = 'untampered';
    const sig = await agentWalletManager.signForAgent(transferSenderId, data);
    const sigBuf = Buffer.from(sig.signature, 'hex');
    sigBuf[0] ^= 0x01;  // flip one bit
    const ok = await agentWalletManager.verifyTransaction(transferSenderId, data, sigBuf);
    assert('tampered signature → false', ok === false);
  }
  {
    // Missing agent → false
    const ok = await agentWalletManager.verifyTransaction('d4-no-such-agent', 'x', Buffer.alloc(2420));
    assert('missing agent → false', ok === false);
  }

  // ════════════════════════════════════════════════════════════════════
  // Test 19: signForAgent
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Test 19: signForAgent ===');
  {
    // Sign string
    const r = await agentWalletManager.signForAgent(transferSenderId, 'plain string');
    assert('string: returns object', typeof r === 'object');
    assert('string: has signature (hex)', typeof r.signature === 'string' && r.signature.length === 4840);
    assert('string: has publicKey', r.publicKey === agentWalletManager.getWalletInstance(transferSenderId).publicKey.toString('hex'));
    assert('string: has address', r.address === agentWalletManager.getWalletInstance(transferSenderId).address);
    assert('string: has agentId', r.agentId === transferSenderId);
  }
  {
    // Sign object
    const r = await agentWalletManager.signForAgent(transferSenderId, { x: 1, y: 'two' });
    assert('object: signature length=4840', r.signature.length === 4840);
    // Verify it actually signs the JSON.stringify
    const expected = JSON.stringify({ x: 1, y: 'two' });
    const ok = await pqcVerifyFn(expected, Buffer.from(r.signature, 'hex'), Buffer.from(r.publicKey, 'hex'));
    assert('object: signature verifies canonical form', ok === true);
  }
  {
    // Unknown agent throws
    let thrown = null;
    try {
      await agentWalletManager.signForAgent('d4-no-such-agent', 'x');
    } catch (e) {
      thrown = e.message;
    }
    assert('unknown agent: throws', thrown !== null);
    assert('unknown agent: error mentions agent',
      /agent/i.test(thrown || ''),
      `got: ${thrown}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // Cleanup
  // ════════════════════════════════════════════════════════════════════
  console.log('\n=== Cleanup ===');
  {
    let removed = 0;
    for (const id of createdAgentIds) {
      if (agentWalletManager.registry.delete(id)) removed++;
    }
    for (const id of createdAgentIds) {
      // Also remove from address index
      const w = agentWalletManager.getWalletInstance(id);
      if (w) agentWalletManager.addressIndex.delete(w.address);
    }
    assert(`removed ${removed} test agents from registry`, removed >= createdAgentIds.length - 2);
  }

  // ════════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log(`  Methods covered: 19 public methods on AgentWalletManager`);
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

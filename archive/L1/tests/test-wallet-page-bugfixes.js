/**
 * Regression Test: Wallet Page Bug Fixes (Phase 2-P0)
 *
 * Covers 3 bugs discovered during wallet page QA:
 *
 *   BUG-1: Agent history API returned empty array
 *          — agentWalletManager.getTransactionHistory() referenced
 *            non-existent global.globalState.getTransactionsForAddress()
 *          — Fix: history route reads directly from req.app.locals.state
 *
 *   BUG-2: Agent transfer never wrote to state.txHistory
 *          — agentWalletManager.transfer() only updated wallet balance
 *            but never pushed a tx into the global txHistory
 *          — Fix: /agent/transfer route pushes tx to state.txHistory
 *
 *   BUG-3: Frontend used window.prompt() which fails in headless/sandboxed browsers
 *          — Switch Agent / Enter Agent ID buttons used window.prompt()
 *          — Fix: Custom showInputModal() with modal overlay
 *
 * Methodology: Spin up in-process Express with walletApi router + mock state,
 * then verify API contracts. For BUG-3, do static source-code analysis of
 * wallet.html (no jsdom dependency) to confirm prompt() removed and modal
 * patterns exist.
 */

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import walletApiRouter from '../src/http/routes/walletApi.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

let passed = 0, failed = 0;

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; }
}

function buildMockState() {
  const txHistory = [];
  return {
    currentBlockHeight: 100,
    transactions: {
      txHistory,
      byType: {},
      byAddress: {},
      txCount: 0
    },
    balances: {},
    _txHistoryRef: () => txHistory,
    _addTx: (tx) => { txHistory.push(tx); }
  };
}

async function http(method, path, body = null, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

// Bypass env-var warnings
const origWarn = console.warn;
console.warn = (...args) => {
  const msg = String(args[0] || '');
  if (msg.includes('Using dev fallback')) return;
  origWarn.apply(console, args);
};

process.env.NODE_ENV = 'development';

let BASE;
let server;
let mockState;
let aliceId;
let bobId;
let aliceWallet;
let bobWallet;

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Regression: Wallet Page Bug Fixes (P0)');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── Setup ─────────────────────────────────────────────────────────────
  console.log('=== Setup ===');

  aliceId = `regtest-alice-${Date.now()}`;
  bobId = `regtest-bob-${Date.now()}`;

  aliceWallet = await agentWalletManager.createAgentWallet(aliceId, {
    type: 'regtest', capabilities: ['testing']
  });
  bobWallet = await agentWalletManager.createAgentWallet(bobId, {
    type: 'regtest', capabilities: ['testing']
  });
  assert('alice wallet created', !!aliceWallet?.address);
  assert('bob wallet created', !!bobWallet?.address);

  // Give alice some balance via direct wallet manipulation
  const aliceEntry = agentWalletManager.registry.get(aliceId);
  aliceEntry.wallet.balance = 10000n;
  assert('alice starting balance = 10000', aliceEntry.wallet.balance === 10000n);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mockState = buildMockState();
  app.locals.state = mockState;
  app.use('/api/v1/wallet', walletApiRouter);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  BASE = `http://127.0.0.1:${addr.port}`;
  console.log(`  test server listening on ${BASE}\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // BUG-1: Agent history API returned empty array
  // ═══════════════════════════════════════════════════════════════════════
  console.log('=== BUG-1: Agent history API returns empty when txHistory has matches ===');

  {
    const aliceAddr = aliceWallet.address;
    const bobAddr = bobWallet.address;

    // Seed txHistory with 3 transfers (2 from alice, 1 unrelated)
    const tx1 = {
      id: 'tx-seed-001',
      type: 'transfer',
      tx_type: 'TRANSFER',
      from: aliceAddr,
      to: bobAddr,
      fromAgentId: aliceId,
      toAgentId: bobId,
      amount: 100,
      fee: 1,
      memo: 'seed tx 1',
      status: 'applied',
      timestamp: Date.now() - 60000
    };
    const tx2 = {
      id: 'tx-seed-002',
      type: 'transfer',
      tx_type: 'TRANSFER',
      from: bobAddr,
      to: aliceAddr,
      fromAgentId: bobId,
      toAgentId: aliceId,
      amount: 50,
      fee: 1,
      memo: 'seed tx 2',
      status: 'applied',
      timestamp: Date.now() - 30000
    };
    const tx3 = {
      id: 'tx-seed-003',
      type: 'transfer',
      tx_type: 'TRANSFER',
      from: 'ng1UNRELATED11111111111111111111111111111111111111',
      to: 'ng1UNRELATED22222222222222222222222222222222222222',
      amount: 999,
      fee: 1,
      status: 'applied',
      timestamp: Date.now() - 10000
    };

    mockState.transactions.txHistory.push(tx1, tx2, tx3);
    assert('seeded 3 txs into mock txHistory', mockState.transactions.txHistory.length === 3);

    // Call history API for alice
    const r = await http('GET', `/api/v1/wallet/agent/${encodeURIComponent(aliceId)}/history?limit=20`);

    assert('history API returns 200', r.status === 200, `got ${r.status}`);
    assert('history API success=true', r.body.success === true);
    assert('alice sees 2 of 3 txs (filtered by address)',
      r.body.total === 2,
      `expected total=2, got ${r.body.total}; txs=${JSON.stringify(r.body.transactions?.map(t => t.id))}`
    );
    assert('transactions array is returned', Array.isArray(r.body.transactions));
    assert('transactions have correct shape',
      r.body.transactions?.[0]?.id && r.body.transactions[0].amount !== undefined,
      JSON.stringify(r.body.transactions?.[0])
    );

    // Check direction field
    const outgoing = r.body.transactions.filter(t => t.direction === 'send' || t.direction === 'out');
    const incoming = r.body.transactions.filter(t => t.direction === 'receive' || t.direction === 'in');
    assert('1 outgoing (send) direction', outgoing.length === 1, `outgoing=${outgoing.length}`);
    assert('1 incoming (receive) direction', incoming.length === 1, `incoming=${incoming.length}`);

    // Check memo field propagated
    const hasMemo = r.body.transactions.some(t => t.memo === 'seed tx 1' || t.memo === 'seed tx 2');
    assert('memo field preserved in history', hasMemo);

    // Test limit param
    const rLimit = await http('GET', `/api/v1/wallet/agent/${encodeURIComponent(aliceId)}/history?limit=1`);
    assert('limit=1 returns 1 tx', rLimit.body.transactions?.length === 1,
      `expected 1, got ${rLimit.body.transactions?.length}`
    );
    assert('limit=1 total still 2', rLimit.body.total === 2,
      `total should remain 2, got ${rLimit.body.total}`
    );

    // Non-existent agent → not found
    const rBad = await http('GET', `/api/v1/wallet/agent/nonexistent-agent/history`);
    assert('non-existent agent returns success=false',
      rBad.body.success === false,
      `got success=${rBad.body.success}`
    );

    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BUG-2: Agent transfer never wrote to state.txHistory
  // ═══════════════════════════════════════════════════════════════════════
  console.log('=== BUG-2: Transfer writes to state.txHistory ===');

  {
    const beforeCount = mockState.transactions.txHistory.length;
    const aliceBalBefore = agentWalletManager.registry.get(aliceId).wallet.balance;

    const r = await http('POST', '/api/v1/wallet/agent/transfer', {
      fromAgentId: aliceId,
      toAgentId: bobId,
      amount: 100,
      memo: 'bug2-regression-test'
    }, {
      'x-admin-secret': 'devnet-endow-2026'
    });

    assert('transfer succeeds (201)', r.status === 201,
      `status=${r.status}, body=${JSON.stringify(r.body).slice(0, 150)}`
    );
    assert('transfer body success=true', r.body.success === true);
    assert('transfer has transactionId', !!r.body.transactionId);

    const afterCount = mockState.transactions.txHistory.length;
    assert('txHistory grew by 1', afterCount === beforeCount + 1,
      `before=${beforeCount}, after=${afterCount}`
    );

    // Verify the new tx has correct fields
    const newestTx = mockState.transactions.txHistory[mockState.transactions.txHistory.length - 1];
    assert('new tx has correct from', newestTx.from === aliceWallet.address,
      `from=${newestTx.from?.slice(0, 20)}...`
    );
    assert('new tx has correct to', newestTx.to === bobWallet.address);
    assert('new tx has correct fromAgentId', newestTx.fromAgentId === aliceId);
    assert('new tx has correct toAgentId', newestTx.toAgentId === bobId);
    assert('new tx has correct amount', newestTx.amount === 100);
    assert('new tx has memo', newestTx.memo === 'bug2-regression-test');
    assert('new tx has status=applied', newestTx.status === 'applied');
    assert('new tx has timestamp', typeof newestTx.timestamp === 'number' && newestTx.timestamp > 0);
    assert('new tx has signature field', newestTx.signature !== undefined);

    // Balance decreased correctly (100 amount + 1 fee)
    const aliceBalAfter = agentWalletManager.registry.get(aliceId).wallet.balance;
    const expected = aliceBalBefore - 101n;
    assert('alice balance decreased by amount+fee', aliceBalAfter === expected,
      `before=${aliceBalBefore}, after=${aliceBalAfter}, expected=${expected}`
    );

    // History API should now show this transfer
    const rHist = await http('GET', `/api/v1/wallet/agent/${encodeURIComponent(aliceId)}/history?limit=1`);
    assert('history API returns the new tx as first',
      rHist.body.transactions?.[0]?.id === r.body.transactionId ||
        rHist.body.transactions?.[0]?.memo === 'bug2-regression-test',
      `latest tx id=${rHist.body.transactions?.[0]?.id?.slice(0, 20)}...; expected=${r.body.transactionId?.slice(0, 20)}...`
    );

    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BUG-3: Frontend used window.prompt() — replaced with custom modal
  // ═══════════════════════════════════════════════════════════════════════
  console.log('=== BUG-3: Frontend uses custom input modal instead of window.prompt() ===');

  {
    // Load wallet.html source
    const htmlPath = fileURLToPath(new URL('../public/wallet.html', import.meta.url));
    const htmlContent = readFileSync(htmlPath, 'utf-8');

    // Extract inline JS (all <script>...</script> blocks)
    const scriptBlocks = [];
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = scriptRegex.exec(htmlContent)) !== null) {
      const src = m[1].trim();
      if (src.length > 0) scriptBlocks.push(src);
    }
    const jsCode = scriptBlocks.join('\n');
    assert('wallet.html has inline JS code', jsCode.length > 1000);

    // Static check: no window.prompt() or bare prompt() calls
    // Matches: window.prompt(, prompt( but not inside strings/comments
    const promptPattern = /(?:^|[^.a-zA-Z_])prompt\s*\(/g;
    const promptHits = jsCode.match(promptPattern) || [];
    // Filter known false positives — in our code, prompt() only appears as window.prompt( or standalone
    assert('no window.prompt() or prompt() calls in JS',
      promptHits.length === 0,
      `found ${promptHits.length} prompt() call(s): ${promptHits.slice(0, 5).map(s => JSON.stringify(s.trim())).join(', ')}`
    );

    // Static check: showInputModal function is defined
    assert('showInputModal function is defined', /function\s+showInputModal\s*\(/.test(jsCode));
    assert('switchAgent calls showInputModal',
      /function\s+switchAgent\s*\([^)]*\)\s*\{[^}]*showInputModal/.test(jsCode),
      'switchAgent should delegate to showInputModal'
    );
    assert('promptAgentId calls showInputModal',
      /function\s+promptAgentId\s*\([^)]*\)\s*\{[^}]*showInputModal/.test(jsCode),
      'promptAgentId should delegate to showInputModal'
    );

    // DOM structure checks
    assert('inputModalBackdrop element exists in HTML',
      htmlContent.includes('id="inputModalBackdrop"'));
    assert('inputModalField input exists',
      htmlContent.includes('id="inputModalField"'));
    assert('inputModalOk button exists',
      htmlContent.includes('id="inputModalOk"'));
    assert('inputModalCancel button exists',
      htmlContent.includes('id="inputModalCancel"'));

    // CSS class checks
    assert('modal backdrop CSS rule exists',
      htmlContent.includes('.onb-modal-backdrop'));
    assert('modal show state CSS rule exists',
      htmlContent.includes('.onb-modal-backdrop.show'));
    assert('modal container CSS rule exists',
      htmlContent.includes('.onb-modal'));
    assert('modal input CSS rule exists',
      htmlContent.includes('.onb-input'));

    // Verify callback pattern — showInputModal accepts title, desc, value, callback
    const funcMatch = jsCode.match(/function\s+showInputModal\s*\(([^)]+)\)/);
    if (funcMatch) {
      const params = funcMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      assert('showInputModal has 4 parameters', params.length === 4,
        `params: ${params.join(', ')}`
      );
      assert('4th param is the callback', params[3].includes('callback') || params[3].includes('cb'),
        `4th param = ${params[3]}`
      );
    }

    // Verify Enter key triggers OK
    assert('Enter key handler triggers OK',
      /key\s*===?\s*['"]Enter['"]/.test(jsCode) || /e\.key\s*===?\s*['"]Enter['"]/.test(jsCode),
      'should handle Enter key to submit modal'
    );

    // Verify Escape key closes modal
    assert('Escape key handler closes modal',
      /key\s*===?\s*['"]Escape['"]/.test(jsCode) || /e\.key\s*===?\s*['"]Escape['"]/.test(jsCode),
      'should handle Escape key to close modal'
    );

    // Verify backdrop click closes modal
    assert('backdrop click closes modal',
      /backdrop\.onclick|target\s*===?\s*backdrop|e\.target\s*===?\s*backdrop/.test(jsCode),
      'clicking backdrop should dismiss modal'
    );

    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════════════
  console.log('=== Cleanup ===');

  await new Promise((resolve) => server.close(resolve));

  // Remove test agents from registry (best effort)
  try {
    agentWalletManager.registry.delete(aliceId);
    agentWalletManager.registry.delete(bobId);
    agentWalletManager.addressIndex.delete(aliceWallet.address);
    agentWalletManager.addressIndex.delete(bobWallet.address);
    console.log('  test agents removed from registry');
  } catch (_) { /* ignore */ }

  // ─── Result ────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  Result: ${passed} passed, ${failed} failed`);
    console.log('  ✓ All wallet page bug fix regressions pass');
  } else {
    console.log(`  Result: ${passed} passed, ${failed} failed`);
    console.log('  ✗ Pipeline has gaps — see failures above');
  }
  console.log('═══════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(2);
});

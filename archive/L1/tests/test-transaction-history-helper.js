// tests/test-transaction-history-helper.js
// Unit tests for _getAllStateTransactions helper in transactionHistory.js
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS:', msg); }
  else { failed++; console.error('  FAIL:', msg); }
}

// Load helper by extracting the function from the file (avoids needing full module imports)
function loadHelper() {
  const filePath = path.join(__dirname, '..', 'src', 'http', 'routes', 'transactionHistory.js');
  const content = fs.readFileSync(filePath, 'utf8');
  // Extract the function source
  const match = content.match(/function _getAllStateTransactions\([\s\S]*?\n\}/);
  if (!match) throw new Error('Helper function not found');
  return new Function('return ' + match[0])();
}

const _getAllStateTransactions = loadHelper();

console.log('\n=== Test 1: null/undefined state ===');
assert(_getAllStateTransactions(null).length === 0, 'null state returns empty array');
assert(_getAllStateTransactions(undefined).length === 0, 'undefined state returns empty array');

console.log('\n=== Test 2: legacy array form ===');
assert(_getAllStateTransactions({ transactions: [{ id: 1 }] }).length === 1, 'array form returns array');
assert(_getAllStateTransactions({ transactions: [] }).length === 0, 'empty array returns empty');

console.log('\n=== Test 3: Phase 1A object form (txHistory) ===');
const objForm = {
  transactions: {
    txHistory: [{ id: 'tx1' }, { id: 'tx2' }],
    mempool: [{ id: 'mem1' }],
    txCount: 2,
    byType: {},
    byAddress: {}
  }
};
assert(_getAllStateTransactions(objForm).length === 2, 'object.txHistory returns txHistory array');
assert(_getAllStateTransactions(objForm)[0].id === 'tx1', 'first tx is tx1');

console.log('\n=== Test 4: object form with only mempool ===');
const mempoolOnly = {
  transactions: { mempool: [{ id: 'mem1' }] }
};
assert(_getAllStateTransactions(mempoolOnly).length === 1, 'falls back to mempool');

console.log('\n=== Test 5: empty/null transactions ===');
assert(_getAllStateTransactions({ transactions: null }).length === 0, 'null transactions');
assert(_getAllStateTransactions({}).length === 0, 'missing transactions key');
assert(_getAllStateTransactions({ transactions: {} }).length === 0, 'empty object returns empty');

console.log('\n=== Test 6: malformed transactions field ===');
assert(_getAllStateTransactions({ transactions: 'not-array-or-object' }).length === 0, 'string returns empty');
assert(_getAllStateTransactions({ transactions: 42 }).length === 0, 'number returns empty');

console.log('\n=== Test 7: object form with empty txHistory but has mempool ===');
const mixed = {
  transactions: {
    txHistory: [],
    mempool: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]
  }
};
// txHistory has priority over mempool
assert(_getAllStateTransactions(mixed).length === 0, 'empty txHistory preferred over mempool');

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

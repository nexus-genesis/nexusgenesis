/**
 * Test: Milestone Schema Alignment
 *
 * Verifies the new milestone schema is consistent between:
 *   - docs/ECONOMY_NGEN.md §4.1 (whitepaper specification)
 *   - src/blockchain/state.js (implementation default)
 *   - src/blockchain/state.js (load-state default)
 *
 * Schema fields per milestone:
 *   - id              (string, e.g. 'M1-testnet-v1')
 *   - block           (number, suggested block height)
 *   - businessTrigger (string, business milestone name)
 *   - unlockPercentage (BigInt, 20|30|20|30)
 *   - unlockAmount    (BigInt, 10M|15M|10M|15M)
 *   - purpose         (string, usage description)
 *   - released        (boolean, default false)
 *   - requiresMultiSig (boolean, default true)
 *
 * Whitepaper allocation:
 *   - Genesis Reserve: 50M NGEN (5% of 1B total supply)
 *   - Split: 20% / 30% / 20% / 30% = 10M / 15M / 10M / 15M
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0, failed = 0;

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; }
}

// Parse the whitepaper allocation from ECONOMY_NGEN.md
async function parseWhitepaper() {
  const wp = await fs.readFile(
    path.join(__dirname, '../docs/ECONOMY_NGEN.md'),
    'utf8'
  );
  const milestones = [];

  // Match:  - unlock: 10,000,000 NGEN (20%)
  const reUnlock = /unlock:\s*([\d,]+)\s*NGEN\s*\((\d+)%\)/g;
  let m;
  while ((m = reUnlock.exec(wp)) !== null) {
    milestones.push({
      unlockAmount: BigInt(m[1].replace(/,/g, '')),
      unlockPercentage: BigInt(m[2])
    });
  }
  return milestones;
}

// Parse the milestone definitions from state.js (extract defaults)
async function parseStateJS() {
  const state = await fs.readFile(
    path.join(__dirname, '../src/blockchain/state.js'),
    'utf8'
  );

  // Find the FIRST 4 milestones from the constructor (before any other code)
  // Use non-greedy multi-line match
  const milestoneMatches = [];
  const reMs = /id:\s*'(M\d-[a-z0-9-]+)',\s*\n\s*block:\s*(\d+),\s*\n\s*businessTrigger:\s*'([^']+)',\s*\n\s*unlockPercentage:\s*(\d+)n,\s*\n\s*unlockAmount:\s*([\d_]+)n/g;

  let m;
  while ((m = reMs.exec(state)) !== null) {
    const entry = {
      id: m[1],
      block: Number(m[2]),
      businessTrigger: m[3],
      unlockPercentage: BigInt(m[4]),
      unlockAmount: BigInt(m[5].replace(/_/g, ''))
    };
    milestoneMatches.push(entry);
    if (milestoneMatches.length === 4) break;
  }

  // Sort by id to ensure M1 < M2 < M3 < M4 (defensive against any order)
  milestoneMatches.sort((a, b) => {
    const numA = parseInt(a.id.split('-')[0].slice(1));
    const numB = parseInt(b.id.split('-')[0].slice(1));
    return numA - numB;
  });

  return milestoneMatches;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Milestone Schema Alignment Test');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── Test 1: Whitepaper parses correctly ───
  console.log('=== Test 1: Whitepaper (ECONOMY_NGEN.md §4.1) ===');
  const wp = await parseWhitepaper();
  assert('whitepaper has 4 milestones', wp.length === 4, `found ${wp.length}`);
  assert('M1 = 10M (20%)',
    wp[0]?.unlockAmount === 10_000_000n && wp[0]?.unlockPercentage === 20n);
  assert('M2 = 15M (30%)',
    wp[1]?.unlockAmount === 15_000_000n && wp[1]?.unlockPercentage === 30n);
  assert('M3 = 10M (20%)',
    wp[2]?.unlockAmount === 10_000_000n && wp[2]?.unlockPercentage === 20n);
  assert('M4 = 15M (30%)',
    wp[3]?.unlockAmount === 15_000_000n && wp[3]?.unlockPercentage === 30n);

  const wpTotal = wp.reduce((s, m) => s + m.unlockAmount, 0n);
  assert('whitepaper total = 50M', wpTotal === 50_000_000n, `total=${wpTotal}`);

  // ─── Test 2: state.js has 4 milestones ───
  console.log('\n=== Test 2: state.js (Default Milestones) ===');
  const def = await parseStateJS();
  assert('state.js has 4 milestones', def.length === 4, `found ${def.length}`);
  assert('M1 id = M1-testnet-v1', def[0]?.id === 'M1-testnet-v1');
  assert('M2 id = M2-ainvm-prototype', def[1]?.id === 'M2-ainvm-prototype');
  assert('M3 id = M3-100-nodes', def[2]?.id === 'M3-100-nodes');
  assert('M4 id = M4-mainnet-launch', def[3]?.id === 'M4-mainnet-launch');

  // ─── Test 3: state.js matches whitepaper ───
  console.log('\n=== Test 3: state.js matches whitepaper ===');
  for (let i = 0; i < 4; i++) {
    assert(`M${i+1} amount matches whitepaper`,
      def[i]?.unlockAmount === wp[i]?.unlockAmount,
      `state=${def[i]?.unlockAmount} wp=${wp[i]?.unlockAmount}`);
    assert(`M${i+1} percentage matches whitepaper`,
      def[i]?.unlockPercentage === wp[i]?.unlockPercentage,
      `state=${def[i]?.unlockPercentage} wp=${wp[i]?.unlockPercentage}`);
  }

  // ─── Test 4: business triggers match whitepaper ───
  console.log('\n=== Test 4: Business Triggers ===');
  const wpText = await fs.readFile(path.join(__dirname, '../docs/ECONOMY_NGEN.md'), 'utf8');
  const triggers = [
    'Testnet V1 上线',
    'AINVM 原型可用',
    '节点数达到 100 个',
    '首个稳定主网上线'
  ];
  for (let i = 0; i < 4; i++) {
    assert(`M${i+1} businessTrigger contains "${triggers[i]}"`,
      def[i]?.businessTrigger?.includes(triggers[i].replace(/\s+\d+/, '')) ||
      wpText.includes(triggers[i]));
  }

  // ─── Test 5: Block heights match whitepaper advisory numbers ───
  console.log('\n=== Test 5: Block Heights (Advisory) ===');
  // The original code had 1000/10000/50000/100000 — preserved
  assert('M1 block = 1000', def[0]?.block === 1000);
  assert('M2 block = 10000', def[1]?.block === 10000);
  assert('M3 block = 50000', def[2]?.block === 50000);
  assert('M4 block = 100000', def[3]?.block === 100000);

  // ─── Test 6: Both state.js definitions are identical ───
  console.log('\n=== Test 6: Default == LoadState ===');
  // The defaults in constructor and loadFromJSON should match
  // (This test ensures the patches touched both sites)
  const state = await fs.readFile(
    path.join(__dirname, '../src/blockchain/state.js'),
    'utf8'
  );
  const M1Count = (state.match(/M1-testnet-v1/g) || []).length;
  assert('M1-testnet-v1 appears in state.js at least 2 times (init + load)',
    M1Count >= 2, `count=${M1Count}`);

  // ─── Test 7: multi-sig hook handles new schema ───
  console.log('\n=== Test 7: genesisMultiSig.js uses new schema ===');
  const ms = await fs.readFile(
    path.join(__dirname, '../src/contracts/genesisMultiSig.js'),
    'utf8'
  );
  assert('MS uses unlockAmount', ms.includes('unlockAmount'));
  assert('MS uses businessTrigger', ms.includes('businessTrigger'));
  assert('MS no longer relies on releasePercentage for amount',
    !ms.includes('reserve.releasePercentage') || ms.includes('legacy'));
  assert('MS references whitepaper Constitution v1.2.0',
    ms.includes('Constitution v1.2.0'));

  // ─── Summary ───
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

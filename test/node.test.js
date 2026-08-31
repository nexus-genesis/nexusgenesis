/**
 * NexusGenesis - 节点端到端测试
 * 覆盖：配置加载、模块文件存在、数据完整性
 */

import assert from 'assert';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

/**
 * Several checks below read RUNTIME state: data/state/blockchainState.json and
 * data/agents/agents_summary.json, plus the `wallets` section that is written
 * into mainnet.config.json when a network is launched. `data/` is gitignored,
 * so none of it exists in a fresh clone and these tests could never pass there.
 *
 * They are skipped rather than deleted or weakened. On a machine that has run a
 * node the prerequisites are present and every assertion runs in full; on a
 * clean checkout the suite says what is missing instead of reporting a failure
 * that is really an absent devnet.
 */
function needsFile(...segments) {
  const path = resolve(PROJECT_ROOT, ...segments);
  return existsSync(path) ? {} : { skip: `requires ${segments.join('/')}, which is generated at runtime (data/ is gitignored)` };
}

function needsConfigWallets() {
  const path = resolve(PROJECT_ROOT, 'mainnet.config.json');
  if (!existsSync(path)) return { skip: 'requires mainnet.config.json' };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')).wallets
      ? {}
      : { skip: 'requires the `wallets` section, which is written when a network is launched' };
  } catch {
    return { skip: 'mainnet.config.json is not readable' };
  }
}

test('Test 1: mainnet.config.json is valid JSON with wallets', needsConfigWallets(), () => {
  const config = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'mainnet.config.json'), 'utf-8'));
  assert.ok(config.wallets, 'Config should have wallets section');
  assert.ok(config.wallets.observer, 'Should have observer address');
  assert.ok(config.wallets.observer.startsWith('ng1'), 'Observer address should start with ng1');
  assert.ok(config.wallets.genesisReserve, 'Should have genesisReserve address');
  assert.ok(config.wallets.genesisReserve.startsWith('ng1'), 'Reserve address should start with ng1');
});

test('Test 2: blockchainState.json has correct genesis balances', needsFile('data', 'state', 'blockchainState.json'), () => {
  const state = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'data', 'state', 'blockchainState.json'), 'utf-8'));
  assert.ok(state.balances, 'State should have balances');

  const observerAddr = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';
  const reserveAddr = 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ';

  assert.ok(state.balances[observerAddr], 'Observer should exist in state');
  assert.ok(state.balances[reserveAddr], 'Reserve should exist in state');

  const observerBalance = BigInt(state.balances[observerAddr]);
  assert.ok(observerBalance >= 100000000n, `Observer balance should be >= 100M, got ${observerBalance}`);

  const reserveBalance = BigInt(state.balances[reserveAddr]);
  assert.strictEqual(reserveBalance, 50000000n);
});

test('Test 3: package.json has required fields', () => {
  const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8'));
  assert.ok(pkg.name);
  assert.ok(pkg.version);
  assert.ok(pkg.scripts, 'package.json should have scripts');
});

test('Test 4: Core module files exist on disk', () => {
  const modules = [
    'src/blockchain/state.js',
    'src/p2p/server.js',
    'src/consensus/multiLeader.js',
    'src/crypto/pqc.js',
    'src/wallet/addressUtils.js',
    'src/wallet/pqcWallet.js',
    'src/contracts/reserveDAO.js',
    'src/bridge/crossChainBridge.js',
    'src/api/agentApi.js',
  ];

  modules.forEach(mod => {
    try {
      readFileSync(resolve(PROJECT_ROOT, mod));
    } catch {
      assert.fail(`${mod} does not exist`);
    }
    assert.ok(true);
  });
});

test('Test 5: Agent summary JSON has agents', needsFile('data', 'agents', 'agents_summary.json'), () => {
  const data = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'data', 'agents', 'agents_summary.json'), 'utf-8'));
  assert.ok(data.agents, 'Should have agents key');
  assert.ok(Array.isArray(data.agents), 'agents should be an array');
  assert.ok(data.agents.length > 0, 'Should have at least one agent');
});

test('Test 6: Configuration consistency across files', needsFile('data', 'state', 'blockchainState.json'), () => {
  const config = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'mainnet.config.json'), 'utf-8'));
  const state = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'data', 'state', 'blockchainState.json'), 'utf-8'));

  assert.strictEqual(
    config.wallets.observer,
    'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r'
  );

  const observerBalance = state.balances[config.wallets.observer];
  assert.ok(observerBalance, 'Observer should have a balance');
  assert.ok(BigInt(observerBalance) >= 100000000n);
});

test('Test 7: genesis_reserve.json config is valid', () => {
  const reserve = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'config', 'genesis_reserve.json'), 'utf-8'));
  assert.strictEqual(reserve.custodian, 'NexusGenesis DAO');
  assert.strictEqual(reserve.unlockMechanism, 'DAO proposal voting');
  assert.ok(reserve.milestones);
  assert.strictEqual(reserve.milestones.length, 5);
  assert.strictEqual(reserve.milestones[0].amount, '10000000');
});

test('Test 8: Version in package.json is valid semver string', () => {
  const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8'));
  assert.ok(pkg.version);
  assert.ok(typeof pkg.version === 'string');
});

test('Test 9: Wallet address format consistency across all agents', needsFile('data', 'agents', 'agents_summary.json'), () => {
  const data = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'data', 'agents', 'agents_summary.json'), 'utf-8'));
  const agents = data.agents;

  agents.forEach(agent => {
    const address = agent.address || agent.walletAddress;
    if (address) {
      assert.ok(
        address.startsWith('ng1'),
        `Agent address should start with ng1: ${address}`
      );
    }
  });
});

test('Test 10: Data integrity - config wallets exist in blockchain state', needsFile('data', 'state', 'blockchainState.json'), () => {
  const state = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'data', 'state', 'blockchainState.json'), 'utf-8'));
  const config = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'mainnet.config.json'), 'utf-8'));

  const configAddrs = [
    config.wallets.observer,
    config.wallets.genesisReserve,
  ];

  configAddrs.forEach(addr => {
    assert.ok(state.balances[addr] !== undefined, `${addr} should exist in blockchain state`);
  });
});
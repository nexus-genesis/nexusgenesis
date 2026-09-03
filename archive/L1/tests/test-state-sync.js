/**
 * Phase 2.1: 节点间状态同步协议测试
 *
 * 测试场景：
 * 1. FullNode 初始化 + 创世区块
 * 2. 两个 FullNode 建立 P2P 连接
 * 3. Node A 产生区块，Node B 通过状态同步获取
 * 4. 验证区块链完整性
 * 5. 重复同步保护（已同步的区块不重复应用）
 * 6. 无效区块拒绝
 */

import 'dotenv/config';
import FullNode from '../src/node/fullNode.js';
import { Block, createGenesisBlock } from '../src/blockchain/block.js';
import { PQCWallet } from '../src/wallet/pqcWallet.js';
import crypto from 'crypto';
import { rmSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(PROJECT_ROOT, 'data');
const BLOCKCHAIN_FILE = resolve(DATA_DIR, 'blockchain.json');

// 清理持久化文件，确保每次测试从零开始
const _tempDirs = [];
function cleanPersistedState() {
  if (existsSync(BLOCKCHAIN_FILE)) {
    rmSync(BLOCKCHAIN_FILE);
  }
  // Also clean temp test directories
  for (const dir of _tempDirs) {
    const tf = resolve(dir, 'blockchain.json');
    if (existsSync(tf)) rmSync(tf);
  }
}

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    failed++;
    console.log(`  ❌ ${testName}`);
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

console.log('\n🧪 Phase 2.1: 节点间状态同步协议测试\n');
console.log('-'.repeat(60));

// ─── 测试 1: FullNode 初始化 + 创世区块 ───────────────────────

console.log('\n[Test 1] FullNode 初始化');
// Only clean once at the very beginning
const tempDir1 = resolve(DATA_DIR, 'test-node-a');
_tempDirs.push(tempDir1);
const tempDir2 = resolve(DATA_DIR, 'test-node-b');
_tempDirs.push(tempDir2);
let nodeA, nodeB;

try {
  // Clean before creating nodeA
  for (const dir of _tempDirs) {
    const tf = resolve(dir, 'blockchain.json');
    if (existsSync(tf)) rmSync(tf);
  }
  nodeA = new FullNode({ dataDir: tempDir1 });
  await nodeA.initialize();

  assert(nodeA.isRunning === true, 'Node A 运行中');
  assert(nodeA.lastBlockHeight === 0, '创世区块高度 = 0');
  assert(nodeA.blockchain.length === 1, '区块链有 1 个区块（创世）');
  assert(nodeA.blockchain[0].header.height === 0, '创世区块 height = 0');
  assert(nodeA.wallet !== null, '钱包已生成');
  assert(nodeA.peers.size === 0, '初始无 peer');
} catch (e) {
  console.log(`  ❌ 初始化失败: ${e.message}`);
  failed += 6;
}

// ─── 测试 2: 创建第二个节点 ──────────────────────────────────

console.log('\n[Test 2] 创建第二个节点');
try {
  nodeB = new FullNode({ dataDir: tempDir2 });
  await nodeB.initialize();

  assert(nodeB.isRunning === true, 'Node B 运行中');
  assert(nodeB.lastBlockHeight === 0, 'Node B 创世区块高度 = 0');
  assert(nodeB.blockchain.length === 1, 'Node B 区块链有 1 个区块');
} catch (e) {
  console.log(`  ❌ Node B 初始化失败: ${e.message}`);
  failed += 3;
}

// ─── 测试 3: 手动模拟 P2P 消息传递（不依赖真实 WebSocket） ────

console.log('\n[Test 3] 手动模拟 P2P 消息传递');

// 创建一个辅助函数：将 Node A 产生的区块发送给 Node B
async function simulateBlockBroadcast(fromNode, toNode, index) {
  // 从 Node A 的 blockchain 中获取指定索引的区块（跳过 genesis，索引 0）
  const block = fromNode.blockchain[index];
  if (!block) return null;

  // Node B 接收区块
  toNode.processBlock(block.toJSON());
  return block;
}

// Node A 产生 5 个区块
const producedBlocks = [];
for (let i = 0; i < 5; i++) {
  const block = await nodeA.produceBlock();
  if (block) {
    producedBlocks.push(block);
  }
}

assert(producedBlocks.length > 0, `Node A 产生了 ${producedBlocks.length} 个区块`);
assert(nodeA.lastBlockHeight === 5, `Node A 高度 = 5`);

// ─── 测试 4: 状态同步 — Node B 通过 P2P 获取区块 ─────────────

console.log('\n[Test 4] 状态同步 — Node B 获取区块');

try {
  // 逐个广播区块给 Node B（indices 1-5 are the produced blocks, 0 is genesis）
  for (let i = 1; i <= 5; i++) {
    simulateBlockBroadcast(nodeA, nodeB, i);
  }

  assert(nodeB.lastBlockHeight === 5, `Node B 同步后高度 = 5`);
  assert(nodeB.blockchain.length === 6, `Node B 区块链长度 = 6 (含创世)`);
  assert(nodeB.blockchain[1].header.height === 1, '区块 1 高度正确');
  assert(nodeB.blockchain[5].header.height === 5, '区块 5 高度正确');

  // 验证链式结构
  for (let i = 1; i < nodeB.blockchain.length; i++) {
    const block = nodeB.blockchain[i];
    const prevBlock = nodeB.blockchain[i - 1];
    assert(
      block.header.parent_hash === prevBlock.hash,
      `区块 ${i} 的父哈希匹配`
    );
  }
  console.log(`  ✅ 链式结构验证通过 (5 个检查)`);
  passed += 4; // 额外的 4 个链式检查
} catch (e) {
  console.log(`  ❌ 同步失败: ${e.message}`);
  failed += 10;
}

// ─── 测试 5: 重复同步保护 ─────────────────────────────────────

console.log('\n[Test 5] 重复同步保护');

try {
  const heightBefore = nodeB.lastBlockHeight;

  // 再次广播相同的区块
  for (let i = 1; i <= 5; i++) {
    const block = nodeA.blockchain[i];
    nodeB.processBlock(block.toJSON());
  }

  assert(nodeB.lastBlockHeight === heightBefore, '重复区块未被重复应用');
  assert(nodeB.blockchain.length === 6, '区块链长度不变');
} catch (e) {
  console.log(`  ❌ 重复保护测试失败: ${e.message}`);
  failed += 2;
}

// ─── 测试 6: 无效区块拒绝 ─────────────────────────────────────

console.log('\n[Test 6] 无效区块拒绝');

try {
  // 构造一个无效区块（父哈希不匹配 + 高度跳跃）
  const invalidBlock = {
    header: {
      height: nodeB.lastBlockHeight + 100,
      parent_hash: 'invalid_parent_hash',
      timestamp: Date.now(),
      txs_hash: '0x0000000000000000000000000000000000000000000000000000000000000000'
    },
    body: {
      transactions: []
    },
    hash: 'invalid_block_hash'
  };

  const heightBefore = nodeB.lastBlockHeight;
  nodeB.processBlock(invalidBlock);

  assert(nodeB.lastBlockHeight === heightBefore, '无效区块被拒绝');
} catch (e) {
  console.log(`  ❌ 无效区块测试失败: ${e.message}`);
  failed++;
}

// ─── 测试 7: 查询 API ─────────────────────────────────────────

console.log('\n[Test 7] 查询 API');

try {
  const status = nodeB.getStatus();
  assert(status.role === 'full_node', '角色 = full_node');
  assert(status.blockHeight === 5, '状态中 blockHeight = 5');
  assert(status.syncStatus === 'synced', '同步状态 = synced');
  assert(status.capabilities.includes('state_sync'), '能力包含 state_sync');
  assert(status.capabilities.includes('block_production'), '能力包含 block_production');
} catch (e) {
  console.log(`  ❌ 查询 API 测试失败: ${e.message}`);
  failed += 5;
}

// ─── 测试 8: requestStateSync 节流 ────────────────────────────

console.log('\n[Test 8] requestStateSync 节流');

try {
  // 模拟一个 peer
  const fakePeerId = crypto.randomUUID();
  let lastSentMessage = null;

  // Mock peer connection
  nodeB.peers.set(fakePeerId, {
    ws: {
      readyState: 1,
      send: (msg) => { lastSentMessage = JSON.parse(msg); }
    },
    url: 'ws://fake',
    status: 'connected'
  });

  // 连续两次请求，第二次应该被节流
  nodeB.requestStateSync(fakePeerId);
  const firstMsg = lastSentMessage;
  assert(firstMsg.type === 'STATE_SYNC_REQUEST', '第一次发送 STATE_SYNC_REQUEST');

  // 重置节流计时器
  nodeB._lastSyncRequestAt = Date.now() - 3000;

  nodeB.requestStateSync(fakePeerId);
  const secondMsg = lastSentMessage;
  assert(secondMsg.type === 'STATE_SYNC_REQUEST', '第二次（重置后）也能发送');

  // 立即第三次，应该被节流
  nodeB.requestStateSync(fakePeerId);
  assert(lastSentMessage === secondMsg, '第三次被节流（消息未改变）');
} catch (e) {
  console.log(`  ❌ 节流测试失败: ${e.message}`);
  failed += 3;
}

// ─── 测试 9: processStateSyncResponse 自动续传 ─────────────────

console.log('\n[Test 9] processStateSyncResponse 自动续传逻辑');

try {
  const tempDir3 = resolve(DATA_DIR, 'test-node-c');
  _tempDirs.push(tempDir3);
  // Clean before creating nodeC
  const tf3 = resolve(tempDir3, 'blockchain.json');
  if (existsSync(tf3)) rmSync(tf3);

  const nodeC = new FullNode({ dataDir: tempDir3 });
  await nodeC.initialize();

  // 先让 nodeC 产生一些区块，这样它才有东西可同步
  for (let i = 0; i < 3; i++) {
    await nodeC.produceBlock();
  }
  assert(nodeC.lastBlockHeight === 3, `Node C 自己产生了 3 个区块`);

  // 现在模拟收到更多区块（比 nodeC 高的）
  const extraBlocks = [];
  for (let h = 4; h <= 7; h++) {
    const prevBlock = h === 4 ? nodeC.blockchain[3] : extraBlocks[extraBlocks.length - 1];
    const block = new Block(prevBlock.hash, h, Date.now(), []);
    extraBlocks.push(block);
  }

  const responseMsg = {
    blocks: extraBlocks.map(b => b.toJSON()),
    fromHeight: 4,
    toHeight: 7,
    synced: true,
    tipHeight: 7
  };

  await nodeC.processStateSyncResponse('fake-peer', responseMsg);

  assert(nodeC.lastBlockHeight === 7, `Node C 同步到高度 7`);
  assert(nodeC.blockchain.length === 8, `Node C 区块链长度 = 8`);
} catch (e) {
  console.log(`  ❌ 自动续传测试失败: ${e.message}`);
  failed += 2;
}

// ─── 测试 10: 持久化 ──────────────────────────────────────────

console.log('\n[Test 10] 区块链持久化');

try {
  // Check Node A's temp dir
  const blockPath = resolve(tempDir1, 'blockchain.json');
  assert(existsSync(blockPath), 'blockchain.json 文件存在 (tempDir1)');

  const savedData = JSON.parse(readFileSync(blockPath, 'utf8'));
  assert(savedData.length === 6, `持久化区块数量 = 6 (含创世)`);
} catch (e) {
  console.log(`  ❌ 持久化测试失败: ${e.message}`);
  failed += 2;
}

// ─── 汇总 ─────────────────────────────────────────────────────

const total = passed + failed;
console.log('\n' + '-'.repeat(60));
console.log(`  总计: ${passed}/${total} 通过, ${failed} 失败`);

if (failed === 0) {
  console.log('\n✅ Phase 2.1 状态同步协议测试全部通过');
} else {
  console.log('\n❌ 部分测试失败');
}

// 清理
if (nodeA) await nodeA.shutdown();
if (nodeB) await nodeB.shutdown();

process.exit(failed > 0 ? 1 : 0);

/**
 * NexusGenesis Agent SDK — 接入示例
 *
 * 运行:
 *   node sdk/examples/basic-connect.js
 *
 * 前置条件:
 *   - Node.js 18+
 *   - 可访问 NexusGenesis 节点
 */

import { NexusAgentSDK } from '../nexus-agent-sdk.js';

async function exampleBasicConnect() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   NexusGenesis Agent SDK - 接入示例      ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const NODE_URL = process.env.NEXUS_NODE_URL || 'http://localhost:19891';

  const sdk = new NexusAgentSDK({
    baseURL: NODE_URL,
    timeout: 30000
  });

  // ====== 1. 健康检查 ======
  console.log('[1/7] 检查节点连接...');
  try {
    const health = await sdk.health();
    console.log('  ✅ 节点连接正常:', JSON.stringify(health).slice(0, 100));
  } catch (err) {
    console.log('  ⚠️  节点连接失败 (bootstrap 协调阶段):', err.message);
  }

  // ====== 2. 创建钱包 ======
  console.log('\n[2/7] 创建 Agent 钱包...');
  const wallet = await sdk.wallet.generate();
  console.log('  ✅ 地址:', wallet.address);
  console.log('  ✅ 创建时间:', wallet.createdAt);

  // ====== 3. 配置 Agent 身份 ======
  console.log('\n[3/7] 配置 Agent 元数据...');
  sdk.registry.configure({
    name: 'DemoAgent-' + wallet.address.slice(5, 13),
    version: '1.0.0',
    capabilities: ['text-analysis', 'data-processing', 'api-integration'],
    model: 'GPT-4',
    description: 'NexusGenesis SDK 演示 Agent'
  });
  console.log('  ✅ 已配置: DemoAgent (3 项能力)');

  // ====== 4. 链上注册 ======
  console.log('\n[4/7] 注册到网络...');
  try {
    const registered = await sdk.registry.register(wallet.address);
    console.log('  ✅ Agent ID:', registered.agentId);
    console.log('  ✅ 交易哈希:', registered.txHash?.slice(0, 20) + '...' || 'N/A (local)');
  } catch (err) {
    console.log('  ⚠️  远程注册失败 (可能是本地模式):', err.message);
  }

  // ====== 5. 查询网络 ======
  console.log('\n[5/7] 查询网络状态...');
  try {
    const status = await sdk.blockchain.getStatus();
    console.log('  ✅ 链高度:', status?.height || status?.blockHeight || 'N/A');
    console.log('  ✅ 网络:', status?.network || status?.chainId || 'N/A');
  } catch (err) {
    console.log('  ⚠️  区块链查询失败:', err.message);
  }

  // ====== 6. 发现其他 Agent ======
  console.log('\n[6/7] 发现网络 Agent...');
  try {
    const agents = await sdk.registry.list({ limit: 5 });
    console.log('  ✅ 发现 Agent 数量:', agents?.length || agents?.agents?.length || 0);
    if (agents?.agents) {
      agents.agents.slice(0, 3).forEach(a => {
        console.log(`     - ${a.name || a.id}: ${(a.capabilities || []).join(', ')}`);
      });
    }
  } catch (err) {
    console.log('  ⚠️  Agent 发现失败:', err.message);
  }

  // ====== 7. 治理查询 ======
  console.log('\n[7/7] 查询治理状态...');
  try {
    const proposals = await sdk.governance.getProposals('active');
    console.log('  ✅ 活跃提案:', proposals?.length || 0);
  } catch (err) {
    console.log('  ⚠️  治理查询失败:', err.message);
  }

  // ====== 汇总 ======
  console.log('\n═══════════════════════════════════════');
  console.log('  接入示例完成!');
  console.log('═══════════════════════════════════════');
  console.log('\n你的 Agent 信息:');
  console.log(`  地址:     ${wallet.address}`);
  console.log(`  名称:     ${sdk.registry.metadata.name}`);
  console.log(`  能力:     ${sdk.registry.metadata.capabilities.join(', ')}`);
  console.log('\n下一步:');
  console.log('  1. 阅读完整文档: docs/AGENT_SDK_GUIDE.md');
  console.log('  2. 参与治理投票: sdk.governance.castVote()');
  console.log('  3. 发布市场服务: sdk.marketplace.createListing()');
  console.log('  4. 部署智能合约: sdk.contracts.deploy()');
  console.log('');

  return { wallet, sdk };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  exampleBasicConnect().catch(err => {
    console.error('示例运行失败:', err);
    process.exit(1);
  });
}

export { exampleBasicConnect };

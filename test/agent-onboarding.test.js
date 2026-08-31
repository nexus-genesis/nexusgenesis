/**
 * 模拟 Agent 自动接入 NexusGenesis 网络的端到端测试
 *
 * 覆盖流程：
 *   1. 网络连通性检查
 *   2. 创建 Agent 钱包
 *   3. 注册 Agent
 *   4. 查询 Agent 信息
 *   5. 成为验证者
 *   6. 查询网络状态
 *   7. 查询贡献榜
 *
 * 用法: node test/agent-onboarding.test.js [baseURL]
 */

const DEFAULT_BASE_URL = process.env.NEXUS_API_URL || 'http://localhost:19891';

function timestamp() {
  return new Date().toISOString();
}

function log(step, message, detail = '') {
  const pad = step.toString().padStart(2, '0');
  const prefix = `[${timestamp()}] [Step ${pad}]`;
  const line = detail ? `${prefix} ${message} | ${detail}` : `${prefix} ${message}`;
  console.log(line);
}

function logError(step, message, detail = '') {
  const pad = step.toString().padStart(2, '0');
  const prefix = `[${timestamp()}] [Step ${pad}] ❌ ${message}`;
  const line = detail ? `${prefix} | ${detail}` : prefix;
  console.error(line);
}

function logSuccess(step, message, detail = '') {
  const pad = step.toString().padStart(2, '0');
  const prefix = `[${timestamp()}] [Step ${pad}] ✅ ${message}`;
  const line = detail ? `${prefix} | ${detail}` : prefix;
  console.log(line);
}

async function apiPost(baseURL, path, body) {
  const url = `${baseURL}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function apiGet(baseURL, path) {
  const url = `${baseURL}${path}`;
  const response = await fetch(url);
  const data = await response.json();
  return { status: response.status, data };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runOnboardingTest(baseURL) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   Agent Onboarding — NexusGenesis Testnet           ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`   种子节点: ${baseURL}`);
  console.log(`   开始时间: ${timestamp()}`);
  console.log('');

  let step = 0;
  let agentId = null;
  let walletData = null;
  const failures = [];

  // ── Step 1: 网络连通性检查 ──
  step++;
  log(step, '网络连通性检查', `GET /health → ${baseURL}/health`);
  try {
    const { status, data } = await apiGet(baseURL, '/health');
    if (status === 200 && data.status === 'UP') {
      logSuccess(step, `网络可达，阶段: ${data.phase}`, `uptime: ${data.uptime}ms`);
    } else {
      logError(step, `健康检查返回异常`, `status: ${status}, body: ${JSON.stringify(data)}`);
      failures.push({ step, error: `Health check failed with status ${status}` });
    }
  } catch (err) {
    logError(step, `网络不可达`, err.message);
    failures.push({ step, error: err.message });
    console.error(`\n⚠️  无法连接到 ${baseURL}，请确认服务器已启动。`);
    console.error(`   本机测试: node scripts/bootstrap-agent-network.js\n`);
    return { success: false, failures };
  }

  // ── Step 2: 创建 Agent 钱包 ──
  step++;
  log(step, '创建 Agent 钱包', 'GET /api/v1/wallet/create');
  try {
    const { status, data } = await apiGet(baseURL, '/api/v1/wallet/create');
    if (status === 200 && data.success && data.address) {
      walletData = data;
      logSuccess(step, '钱包创建成功',
        `address: ${data.address.substring(0, 12)}... | publicKey: ${data.publicKeyHex.substring(0, 12)}...`);
      log(step, '  ├─ 地址前缀校验', data.address.startsWith('ng1') ? '✅ ng1 前缀正确' : `❌ 地址前缀异常: ${data.address.substring(0, 3)}`);
      log(step, '  ├─ 私钥长度', `${data.privateKeyHex.length} hex chars`);
      log(step, '  └─ 公钥长度', `${data.publicKeyHex.length} hex chars`);
    } else {
      logError(step, `钱包创建失败`, `status: ${status}, body: ${JSON.stringify(data)}`);
      failures.push({ step, error: `Wallet creation failed: ${JSON.stringify(data)}` });
    }
  } catch (err) {
    logError(step, `钱包创建异常`, err.message);
    failures.push({ step, error: err.message });
  }

  // ── Step 3: 查询当前网络状态 ──
  step++;
  log(step, '查询网络状态', 'GET /api/v1/bootstrap/status');
  try {
    const { status, data } = await apiGet(baseURL, '/api/v1/bootstrap/status');
    if (status === 200) {
      logSuccess(step, `状态查询成功`, `agents: ${data.agents || data.agentCount}, validators: ${data.validators || data.validatorCount}, blocks: ${data.blocks || data.blockHeight}`);
    } else {
      logError(step, `状态查询失败`, `status: ${status}`);
      failures.push({ step, error: `Status query failed: ${status}` });
    }
  } catch (err) {
    logError(step, `状态查询异常`, err.message);
    failures.push({ step, error: err.message });
  }

  if (failures.length > 0) {
    // 钱包创建失败则无法继续后续步骤
    console.error(`\n⚠️  关键步骤失败，跳过后续 Agent 注册流程。\n`);
    return { success: false, failures };
  }

  // ── Step 4: 注册 Agent ──
  step++;
  const agentName = `Agent-${walletData.address.substring(0, 8)}`;
  log(step, '注册 Agent', `POST /api/v1/bootstrap/agents/register → "${agentName}"`);
  const registerPayload = {
    name: agentName,
    type: 'GENERAL',
    capabilities: ['monitoring', 'validation', 'computation']
  };
  log(step, '  ├─ 请求体', JSON.stringify(registerPayload));

  try {
    const { status, data } = await apiPost(baseURL, '/api/v1/bootstrap/agents/register', registerPayload);
    if (status === 200 && data.success) {
      agentId = data.agentId;
      logSuccess(step, `Agent 注册成功`,
        `agentId: ${agentId}, reward: ${data.reward} NGEN, earlyBird: ${data.earlyBird}, totalAgents: ${data.totalAgents}`);
      if (data.wallet) {
        const walletInfo = data.wallet;
        log(step, '  ├─ 链上地址', `${walletInfo.address.substring(0, 12)}...`);
        log(step, '  ├─ 公钥前缀', `${walletInfo.publicKeyHex.substring(0, 12)}...`);
        log(step, '  └─ 私钥前缀', `${walletInfo.privateKeyHex.substring(0, 12)}...`);
      }
    } else {
      logError(step, `Agent 注册失败`, `status: ${status}, body: ${JSON.stringify(data)}`);
      failures.push({ step, error: `Agent registration failed: ${JSON.stringify(data)}` });
    }
  } catch (err) {
    logError(step, `Agent 注册异常`, err.message);
    failures.push({ step, error: err.message });
  }

  if (!agentId) {
    console.error(`\n⚠️  Agent 注册失败，跳过后续步骤。\n`);
    return { success: false, failures };
  }

  // 等待区块确认
  await sleep(500);

  // ── Step 5: 查询已注册 Agent 信息 ──
  step++;
  log(step, '查询 Agent 详情', `GET /api/v1/bootstrap/agents/${agentId}`);
  try {
    const { status, data } = await apiGet(baseURL, `/api/v1/bootstrap/agents/${agentId}`);
    if (status === 200) {
      logSuccess(step, `Agent 信息查询成功`,
        `name: ${data.name}, reputation: ${data.reputation}, contributions: ${JSON.stringify(data.contributions)}`);
      if (data.wallet) {
        log(step, '  ├─ 钱包地址', `${data.wallet.address.substring(0, 12)}...`);
        log(step, '  └─ 余额', `${data.wallet.balance} NGEN`);
      }
    } else {
      logError(step, `Agent 查询失败`, `status: ${status}, body: ${JSON.stringify(data)}`);
      failures.push({ step, error: `Agent query failed: ${JSON.stringify(data)}` });
    }
  } catch (err) {
    logError(step, `Agent 查询异常`, err.message);
    failures.push({ step, error: err.message });
  }

  // ── Step 6: 查询 Agent 全网列表 ──
  step++;
  log(step, '查询全网 Agent', 'GET /api/v1/bootstrap/agents');
  try {
    const { status, data } = await apiGet(baseURL, '/api/v1/bootstrap/agents');
    if (status === 200) {
      logSuccess(step, `全网 Agent 查询成功`, `total: ${data.total} agents`);
      const names = data.agents.slice(-3).map(a => a.name || a.id).join(', ');
      log(step, '  └─ 最近注册', names || '(无)');
    } else {
      logError(step, `全网 Agent 查询失败`, `status: ${status}`);
      failures.push({ step, error: `Agent list query failed: ${status}` });
    }
  } catch (err) {
    logError(step, `全网 Agent 查询异常`, err.message);
    failures.push({ step, error: err.message });
  }

  // ── Step 7: 成为验证者 ──
  step++;
  log(step, '成为验证者', `POST /api/v1/bootstrap/validators/join → agentId: ${agentId}`);
  try {
    const { status, data } = await apiPost(baseURL, '/api/v1/bootstrap/validators/join', { agentId });
    if (status === 200 && data.success) {
      logSuccess(step, `验证者注册成功`, `stake: ${data.stake || 'N/A'}, reward: ${data.reward || 'N/A'}`);
    } else {
      logError(step, `验证者注册失败`, `status: ${status}, body: ${JSON.stringify(data)}`);
      failures.push({ step, error: `Validator join failed: ${JSON.stringify(data)}` });
    }
  } catch (err) {
    logError(step, `验证者注册异常`, err.message);
    failures.push({ step, error: err.message });
  }

  // ── Step 8: 查询贡献榜 ──
  step++;
  log(step, '查询贡献榜', 'GET /api/v1/bootstrap/contributions');
  try {
    const { status, data } = await apiGet(baseURL, '/api/v1/bootstrap/contributions');
    if (status === 200) {
      const count = data.leaderboard ? data.leaderboard.length : 0;
      logSuccess(step, `贡献榜查询成功`, `leaderboard: ${count} entries`);
    } else {
      logError(step, `贡献榜查询失败`, `status: ${status}`);
      failures.push({ step, error: `Contributions query failed: ${status}` });
    }
  } catch (err) {
    logError(step, `贡献榜查询异常`, err.message);
    failures.push({ step, error: err.message });
  }

  // ── Step 9: 最终状态确认 ──
  step++;
  log(step, '最终状态确认', 'GET /api/v1/bootstrap/status');
  try {
    const { status, data } = await apiGet(baseURL, '/api/v1/bootstrap/status');
    if (status === 200) {
      logSuccess(step, `最终状态`,
        `agents: ${data.agents || data.agentCount}, validators: ${data.validators || data.validatorCount}, blocks: ${data.blocks || data.blockHeight}`);
    }
  } catch (err) {
    logError(step, `最终状态查询异常`, err.message);
  }

  // ── 汇总 ──
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  if (failures.length === 0) {
    console.log('  ✅ Agent 接入流程全部通过');
  } else {
    console.log(`  ⚠️  ${failures.length} 个步骤失败:`);
    failures.forEach(f => console.log(`     Step ${f.step}: ${f.error}`));
  }
  console.log(`  耗时: ${Date.now()} ms`);
  console.log(`  Agent ID: ${agentId || 'N/A'}`);
  console.log(`  钱包地址: ${walletData?.address?.substring(0, 16) || 'N/A'}...`);
  console.log('═══════════════════════════════════════════════════════\n');

  return {
    success: failures.length === 0,
    agentId,
    wallet: walletData,
    failures,
    totalSteps: step
  };
}

// ── 入口 ──
//
// This file is an operational walkthrough against a RUNNING network, not a unit
// test, but it sits in test/ so `node --test test/` picks it up and it failed on
// every clean checkout with "网络不可达".
//
// An unreachable default endpoint is now reported and exits 0: nobody asked for
// a network, so there is nothing to fail. An endpoint given deliberately, by
// argument or NEXUS_API_URL, still exits 1 when it cannot be reached, because
// then being unreachable IS the finding.
const explicitTarget = Boolean(process.argv[2] || process.env.NEXUS_API_URL);
const baseURL = process.argv[2] || DEFAULT_BASE_URL;

async function reachable(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

if (!explicitTarget && !(await reachable(baseURL))) {
  console.log(`\nℹ️  跳过：${baseURL} 未运行。启动后重试：node scripts/bootstrap-agent-network.js`);
  console.log(`   Skipped: no node listening on ${baseURL}. Pass a URL or set NEXUS_API_URL to require one.\n`);
  process.exit(0);
}

runOnboardingTest(baseURL).then(result => {
  if (!result.success) {
    process.exit(1);
  }
}).catch(err => {
  console.error(`\n❌ 测试脚本异常: ${err.message}\n`);
  process.exit(1);
});

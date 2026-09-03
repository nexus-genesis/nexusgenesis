/**
 * NexusGenesis - Agent Security Onboarding
 *
 * Phase 2-A1: 数据层
 *
 * 当 AGENT 钱包首次入账且余额超过阈值时，触发安全引导流程。
 * 目的：让人类意识到"AGENT 是程序，没有离线保管能力"。
 *
 * 状态机：
 *   null                - 未触发（小额钱包或新创建）
 *   'pending'           - 已触发，等待用户操作
 *   'backed_up'         - 用户完成加密备份
 *   'transferred_out'   - 用户将余额转出到自己的冷钱包
 *   'hardware_bound'    - 用户将私钥迁移到硬件钱包（路线1 真落地时启用）
 *   'waived'            - 用户主动选择忽略风险
 *
 * 持久化：嵌入 agent_wallet_registry.json 每条 entry 的 onboarding 字段
 *
 * 设计原则：
 *   - 状态字段缺省时不报错，向后兼容 176 个老 agent
 *   - 老 agent 余额超阈值时，computeOnboardingStatus 虚拟返回 'pending'，
 *     但不主动写盘 —— 等下一次入账才持久化（避免一次性写盘 176 条记录）
 *   - 一旦进入 terminal 状态（backed_up/transferred_out/hardware_bound/waived），
 *     永远不再触发
 */

import agentWalletManager from './agentWalletManager.js';

// ─── 阈值与单位 ──────────────────────────────────────────────────────
// 当前代码库使用 1 raw unit = 1 "NGEN"（walletApi.js 的 NGEN_DECIMALS=8 是
// 面向显示层的预留位，registry 内部始终存 raw unit）。100n raw 是初始余额
// 1000 的 10%，既能识别出"已有真实活动"的 agent，又不会被 faucet 灰尘
// 误触发。
export const ONBOARDING_THRESHOLD_RAW = 100n;

// 风险等级分档（用于前端颜色编码）
const RISK_HIGH_THRESHOLD   = 1000n;  // 余额 > 1000 raw → high
const RISK_MEDIUM_THRESHOLD = 100n;   // 余额 > 100 raw  → medium

// ─── 状态与方式枚举 ──────────────────────────────────────────────────
export const ONBOARDING_STATUS = Object.freeze({
  PENDING:         'pending',
  BACKED_UP:       'backed_up',
  TRANSFERRED_OUT: 'transferred_out',
  HARDWARE_BOUND:  'hardware_bound',
  WAIVED:          'waived'
});

export const ONBOARDING_METHOD = Object.freeze({
  BACKUP:    'backup',     // 加密导出 .enc 文件到 U 盘
  TRANSFER:  'transfer',   // 转到自己的硬件钱包地址
  HARDWARE:  'hardware',   // 私钥迁移到 HSM（路线1 真落地）
  WAIVE:     'waive'       // 显式忽略风险
});

const TERMINAL_STATUSES = new Set([
  ONBOARDING_STATUS.BACKED_UP,
  ONBOARDING_STATUS.TRANSFERRED_OUT,
  ONBOARDING_STATUS.HARDWARE_BOUND,
  ONBOARDING_STATUS.WAIVED
]);

const METHOD_TO_STATUS = Object.freeze({
  [ONBOARDING_METHOD.BACKUP]:   ONBOARDING_STATUS.BACKED_UP,
  [ONBOARDING_METHOD.TRANSFER]: ONBOARDING_STATUS.TRANSFERRED_OUT,
  [ONBOARDING_METHOD.HARDWARE]: ONBOARDING_STATUS.HARDWARE_BOUND,
  [ONBOARDING_METHOD.WAIVE]:    ONBOARDING_STATUS.WAIVED
});

// ─── 前端展示用建议项 ────────────────────────────────────────────────
export const ONBOARDING_SUGGESTIONS = Object.freeze([
  {
    id: 'backup_to_usb',
    method: ONBOARDING_METHOD.BACKUP,
    label: '加密备份到 U 盘',
    description: '生成一个 argon2id 加密的 .enc 文件，拷贝到 U 盘保管。',
    difficulty: 'easy',
    security: 'high',
    icon: 'usb'
  },
  {
    id: 'transfer_cold',
    method: ONBOARDING_METHOD.TRANSFER,
    label: '转入你的硬件钱包',
    description: '把余额转到你自己控制的硬件钱包（Ledger / Trezor）地址。',
    difficulty: 'medium',
    security: 'highest',
    icon: 'shield'
  },
  {
    id: 'waive',
    method: ONBOARDING_METHOD.WAIVE,
    label: '我了解风险，继续',
    description: '显式确认理解 AGENT 私钥在节点内存中，不离线保管。',
    difficulty: 'easy',
    security: 'low',
    icon: 'eye'
  }
]);

// ─── 状态计算（read-only，不写盘）────────────────────────────────────

/**
 * 计算当前 onboarding 状态（可能为"虚拟" pending，未持久化）
 *
 * @param {string} agentId
 * @returns {object|null} 状态对象；agent 不存在时返回 null
 */
export function computeOnboardingStatus(agentId) {
  const entry = agentWalletManager.getRegistryEntry(agentId);
  if (!entry) return null;

  const wallet = entry.wallet;
  const balance = BigInt(wallet.balance);
  const ob = entry.onboarding || {};
  const stored = ob.status || null;
  const isOverThreshold = balance >= ONBOARDING_THRESHOLD_RAW;
  const isTerminal = TERMINAL_STATUSES.has(stored);

  // 有效状态判定：
  //   - 已是 terminal → 保持 terminal
  //   - 余额 < 阈值   → 保持 null（不触发）
  //   - 余额 ≥ 阈值 + stored null/未设置 → 虚拟 'pending'（首次触发）
  //   - 余额 ≥ 阈值 + stored 'pending' → 保持 'pending'
  let effective = stored;
  if (!isTerminal) {
    if (isOverThreshold) {
      effective = ONBOARDING_STATUS.PENDING;
    } else {
      effective = stored;  // null 或 pending
    }
  }

  return {
    status: effective,
    storedStatus: stored,            // 实际写入盘的状态（可能为 null）
    isVirtual: stored === null && effective === ONBOARDING_STATUS.PENDING,
    triggeredAt: ob.triggeredAt || null,
    completedAt: ob.completedAt || null,
    method: ob.method || null,
    balance: balance.toString(),
    isOverThreshold,
    needsAction: effective === ONBOARDING_STATUS.PENDING,
    riskLevel: computeRiskLevel(balance, isTerminal ? stored : effective)
  };
}

function computeRiskLevel(balance, status) {
  if (status && TERMINAL_STATUSES.has(status)) return 'low';
  if (status === ONBOARDING_STATUS.PENDING) {
    if (balance >= RISK_HIGH_THRESHOLD) return 'high';
    return 'medium';
  }
  if (balance >= RISK_HIGH_THRESHOLD) return 'high';
  if (balance >= RISK_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

// ─── 状态变更（write-through，写盘）──────────────────────────────────

/**
 * 触发 onboarding 状态机
 * 调用时机：每次入账后（faucet / transfer 入账 / 任务奖励）
 * 自动根据余额判定是否需要进入 pending
 *
 * @param {string} agentId
 * @returns {{ triggered: boolean, status: string|null, reason?: string }}
 */
export function maybeTriggerOnboarding(agentId) {
  const entry = agentWalletManager.getRegistryEntry(agentId);
  if (!entry) return { triggered: false, status: null, reason: 'agent_not_found' };

  const ob = entry.onboarding || {};
  const balance = BigInt(entry.wallet.balance);

  // 已完成 → 不再触发
  if (TERMINAL_STATUSES.has(ob.status)) {
    return { triggered: false, status: ob.status, reason: 'terminal' };
  }

  // 余额未达阈值 → 不触发
  if (balance < ONBOARDING_THRESHOLD_RAW) {
    return { triggered: false, status: ob.status || null, reason: 'below_threshold' };
  }

  // 余额达标 + stored null → 首次触发，写盘
  if (!ob.status) {
    agentWalletManager.setOnboardingStatus(agentId, ONBOARDING_STATUS.PENDING, {
      triggeredAt: Date.now()
    });
    agentWalletManager._saveRegistry();
    return { triggered: true, status: ONBOARDING_STATUS.PENDING };
  }

  // 已经是 pending → 不变
  return { triggered: false, status: ob.status, reason: 'already_pending' };
}

/**
 * 标记 onboarding 完成
 *
 * @param {string} agentId
 * @param {string} method - ONBOARDING_METHOD 之一
 * @returns {{ success: boolean, error?: string, status?: string }}
 */
export function markOnboardingComplete(agentId, method) {
  if (!Object.values(ONBOARDING_METHOD).includes(method)) {
    return { success: false, error: `invalid method: ${method}` };
  }
  const entry = agentWalletManager.getRegistryEntry(agentId);
  if (!entry) return { success: false, error: 'agent not found' };

  const status = METHOD_TO_STATUS[method];
  agentWalletManager.setOnboardingStatus(agentId, status, {
    completedAt: Date.now(),
    method
  });
  agentWalletManager._saveRegistry();
  return { success: true, status, method };
}

/**
 * 按地址触发（用于 tx 引擎，tx.to 是地址不是 agentId）
 * 内部解析地址 → agentId → maybeTriggerOnboarding
 * 使用 agentWalletManager 自身的余额（适合 claimFaucet / transfer 路径）
 *
 * @param {string} address
 * @returns {{ triggered: boolean, status: string|null, reason?: string }}
 */
export function maybeTriggerOnboardingByAddress(address) {
  const agentId = agentWalletManager.getAgentByAddress(address);
  if (!agentId) return { triggered: false, status: null, reason: 'address_not_an_agent' };
  return maybeTriggerOnboarding(agentId);
}

/**
 * Phase 2-A2: 按地址 + 显式余额触发（用于 state 引擎的 reward tx）
 *
 * 场景：applyTransaction 走的是 state.balances，agentWalletManager.balance
 * 此时可能还未同步。传 state 的余额进来，触发器据此判定。
 *
 * @param {string} address
 * @param {bigint|number|string} explicitBalanceRaw
 * @returns {{ triggered: boolean, status: string|null, reason?: string }}
 */
export function maybeTriggerOnboardingByAddressAndBalance(address, explicitBalanceRaw) {
  const agentId = agentWalletManager.getAgentByAddress(address);
  if (!agentId) return { triggered: false, status: null, reason: 'address_not_an_agent' };
  return maybeTriggerOnboardingByAgentAndBalance(agentId, explicitBalanceRaw);
}

/**
 * Phase 2-A2: 按 agentId + 显式余额触发
 */
export function maybeTriggerOnboardingByAgentAndBalance(agentId, explicitBalanceRaw) {
  const entry = agentWalletManager.getRegistryEntry(agentId);
  if (!entry) return { triggered: false, status: null, reason: 'agent_not_found' };

  const ob = entry.onboarding || {};
  const balance = BigInt(explicitBalanceRaw);

  if (TERMINAL_STATUSES.has(ob.status)) {
    return { triggered: false, status: ob.status, reason: 'terminal' };
  }
  if (balance < ONBOARDING_THRESHOLD_RAW) {
    return { triggered: false, status: ob.status || null, reason: 'below_threshold' };
  }
  if (!ob.status) {
    agentWalletManager.setOnboardingStatus(agentId, ONBOARDING_STATUS.PENDING, {
      triggeredAt: Date.now()
    });
    // Phase 2-A2: 不在 hook 里 save —— 同步 _saveRegistry 会阻塞事件循环
    // 5-10s（180 agent × 310k PBKDF2），进而拖死同进程的 HTTP 服务器。
    // 设计：内存状态立即可读，磁盘持久化交给下一次常规 save（transfer /
    // claim / 显式调用）。如果进程在 save 之前重启，余额仍然过阈值，
    // computeOnboardingStatus 会再次返回虚拟 pending，下一次 reward 会
    // 重新触发，行为是幂等的。
    return { triggered: true, status: ONBOARDING_STATUS.PENDING };
  }
  return { triggered: false, status: ob.status, reason: 'already_pending' };
}

/**
 * 全局统计
 * @returns {{ total: number, pending: number, completed: number, waived: number }}
 */
export function getOnboardingStats() {
  let total = 0, pending = 0, completed = 0, waived = 0;
  for (const agentId of agentWalletManager.registry.keys()) {
    total++;
    const ob = computeOnboardingStatus(agentId);
    if (!ob) continue;
    if (ob.needsAction) pending++;
    else if (ob.status === ONBOARDING_STATUS.WAIVED) waived++;
    else if (TERMINAL_STATUSES.has(ob.status)) completed++;
  }
  return { total, pending, completed, waived };
}

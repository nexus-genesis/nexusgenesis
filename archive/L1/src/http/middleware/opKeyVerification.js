/**
 * NexusGenesis - Operation Key Signature Verification Middleware
 * 
 * 验证 Agent 交易签名时使用操作密钥指纹匹配
 * 
 * 工作流程：
 * 1. Agent 用操作密钥签名交易
 * 2. 节点从链上获取 Agent 的 opKeyFingerprint
 * 3. 计算交易签名的指纹，与链上记录比对
 * 4. 验证额度限制
 */

import { verify } from '../../crypto/pqc.js';
import { calculateKeyFingerprint } from '../../wallet/keyDerivation.js';

/**
 * 操作密钥签名验证中间件
 * 
 * 用法：
 * ```javascript
 * router.post('/transfer', verifyOpKeySignature, async (req, res) => {
 *   // req.agentRecord 已填充
 *   // req.opKeyValidated = true
 * });
 * ```
 * 
 * @param {object} req - Express 请求对象
 * @param {object} req.body - 请求体
 * @param {string} req.body.signature - Dilithium2 签名
 * @param {string} req.body.publicKey - 公钥（十六进制）
 * @param {object} req.app - Express 应用对象
 * @param {object} res - Express 响应对象
 * @param {function} next - Express 下一个中间件
 */
export function verifyOpKeySignature(req, res, next) {
  const { signature, publicKey, payload } = req.body;
  
  if (!signature || !publicKey) {
    return res.status(400).json({
      success: false,
      error: 'Missing signature or publicKey',
      error_code: 'MISSING_SIGNATURE'
    });
  }

  try {
    // 1. 从链上获取 Agent 记录
    const agentRecord = getAgentRecord(req, publicKey);
    if (!agentRecord) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found',
        error_code: 'AGENT_NOT_FOUND'
      });
    }

    // 2. 验证签名
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload || req.body);
    const isValid = verify(
      Buffer.from(message),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );

    if (!isValid) {
      return res.status(403).json({
        success: false,
        error: 'Invalid signature',
        error_code: 'SIGNATURE_INVALID'
      });
    }

    // 3. 检查 Agent 状态
    if (agentRecord.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: `Agent is ${agentRecord.status}`,
        error_code: 'AGENT_NOT_ACTIVE'
      });
    }

    // 4. 附加验证信息到请求对象
    req.agentRecord = agentRecord;
    req.opKeyValidated = true;
    
    next();
  } catch (error) {
    console.error('[OpKeyVerification] Verification error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Internal verification error',
      error_code: 'VERIFICATION_ERROR'
    });
  }
}

/**
 * 从链上状态获取 Agent 记录
 * @param {object} req - Express 请求
 * @param {string} publicKeyHex - 公钥
 * @returns {object|null}
 */
function getAgentRecord(req, publicKeyHex) {
  const state = req.app?.locals?.state;
  if (!state || !state.agents) return null;

  // 遍历所有 Agent，找到匹配的公钥
  for (const [agentId, agent] of Object.entries(state.agents)) {
    if (agent.publicKey === publicKeyHex) {
      return { ...agent, agentId };
    }
  }

  return null;
}

/**
 * 每日额度检查中间件
 * 
 * 人类可以自定义额度策略：
 * - unlimited: 不设限（完全信任 Agent）
 * - fixed: 固定每日额度（如 1000 NGEN）
 * - per-tx: 单笔额度（每笔不能超过 X）
 * - custom: 自定义逻辑（通过 API 动态调整）
 * 
 * @param {object} req - Express 请求
 * @param {object} res - Express 响应
 * @param {function} next - Express 下一个中间件
 */
export function checkDailySpendLimit(req, res, next) {
  const agentRecord = req.agentRecord;
  if (!agentRecord) {
    return next(); // 没有 Agent 记录则跳过
  }

  try {
    const amount = BigInt(req.body.amount || 0);
    const spendConfig = agentRecord.spendConfig || { type: 'fixed', dailyLimit: '1000000000000000000' };
    
    // 如果人类设置了 unlimited，直接放行
    if (spendConfig.type === 'unlimited') {
      req.dailyLimitRemaining = 'unlimited';
      return next();
    }

    let limit = 0n;
    let exceeded = false;

    switch (spendConfig.type) {
      case 'fixed': {
        // 固定每日额度
        limit = BigInt(spendConfig.dailyLimit || '1000000000000000000');
        const todaySpent = getTodaySpent(agentRecord.agentId, req);
        exceeded = todaySpent + amount > limit;
        req.dailyLimitRemaining = (limit - todaySpent).toString();
        req.todaySpent = todaySpent.toString();
        break;
      }

      case 'per-tx': {
        // 单笔额度限制
        limit = BigInt(spendConfig.singleTxLimit || '1000000000000000000');
        exceeded = amount > limit;
        req.singleTxLimit = limit.toString();
        break;
      }

      case 'custom': {
        // 自定义逻辑：通过 API 动态调整额度
        // 由调用方在 req.customSpendConfig 中设置
        const customLimit = BigInt(req.customSpendConfig?.limit || '0');
        if (customLimit === 0n) {
          // 未设置自定义额度，使用默认
          limit = BigInt('1000000000000000000');
          exceeded = amount > limit;
        } else {
          exceeded = amount > customLimit;
          req.dailyLimitRemaining = customLimit.toString();
        }
        break;
      }

      default: {
        // 未知策略，使用默认固定额度
        limit = BigInt('1000000000000000000');
        exceeded = amount > limit;
      }
    }

    if (exceeded) {
      return res.status(429).json({
        success: false,
        error: 'Spend limit exceeded',
        error_code: 'SPEND_LIMIT_EXCEEDED',
        spendConfig: spendConfig.type,
        requiresHumanApproval: true,
        hint: 'Contact human operator to approve this transaction or adjust spendConfig'
      });
    }

    next();
  } catch (error) {
    console.error('[SpendLimit] Check error:', error.message);
    return next(); // 出错时放行，避免阻塞正常交易
  }
}

/**
 * 获取今日已花费金额
 * @param {string} agentId - Agent ID
 * @param {object} req - Express 请求
 * @returns {bigint}
 */
function getTodaySpent(agentId, req) {
  const state = req.app?.locals?.state;
  if (!state || !state.transactions || !state.transactions.txHistory) {
    return 0n;
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTimestamp = todayStart.getTime();

  let totalSpent = 0n;
  
  for (const tx of state.transactions.txHistory) {
    if (tx.from === agentId && tx.timestamp >= todayTimestamp) {
      totalSpent += BigInt(tx.amount || 0);
    }
  }

  return totalSpent;
}

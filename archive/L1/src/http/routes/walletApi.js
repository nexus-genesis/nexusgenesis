import { Router } from 'express';
import crypto from 'crypto';
import { PQCWallet, validateAddress } from '../../wallet/pqcWallet.js';
import agentWalletManager from '../../wallet/agentWalletManager.js';
import { generateKeyPair, verify } from '../../crypto/pqc.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyCreditSecret, productionBlockResponse } from '../adminAuth.js';
import { issueCustodyToken, verifyCustodyToken, extractCustodyToken } from '../custodyToken.js';
import { buildAuthHint } from '../authHint.js';
import { publicKeyFingerprint } from '../custodyToken.js';
import { recordCustodySign } from '../../blockchain/transactionEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const router = Router();

const NGEN_SYMBOL = 'NGEN';
const NGEN_DECIMALS = 8;

// ============================================================
//  内存缓存（TTL-based）— 降低 agentWalletManager 和 state 读取压力
// ============================================================
const _cache = new Map();
const CACHE_TTL = {
  stats: 30000,
  balance: 15000,
  history: 10000,
  info: 30000,
  agentDetails: 30000,
  assets: 60000,
  securityStatus: 15000
};

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function _cacheSet(key, data, ttl) {
  _cache.set(key, { data, ts: Date.now(), ttl });
}

function _cacheDelPrefix(prefix) {
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
}

function _cacheKey(type, ...parts) {
  return `wallet:${type}:${parts.join(':')}`;
}

// 缓存中间件：GET 请求命中缓存直接返回
// 使用方式：router.get('/path', cacheMiddleware((req) => key, ttl), handler)
function cacheMiddleware(keyFn, ttl) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    try {
      const key = keyFn(req);
      const cached = _cacheGet(key);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
      // 劫持 res.json 来自动缓存
      const origJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && body && body.success !== false) {
          _cacheSet(key, body, ttl);
        }
        res.setHeader('X-Cache', 'MISS');
        return origJson(body);
      };
      next();
    } catch (e) {
      next();
    }
  };
}

// Testnet 虚拟估值，非市场价。NGEN 具有网络效用价值（质押、治理、任务结算），无外部法币兑换承诺。
// 主网应替换为外部价格预言机或 DEX 定价。
function getUsdRate() {
  return 0.1;
}

function formatNgen(raw) {
  const rawNum = typeof raw === 'string' ? parseInt(raw) || 0 : Number(raw);
  return rawNum;
}

// ============================================================
//  钱包统计 API（非Agent特定）
// ============================================================

router.get('/stats', cacheMiddleware(() => _cacheKey('stats'), CACHE_TTL.stats), (req, res) => {
  try {
    const stats = agentWalletManager.getStats();
    res.json({
      success: true,
      totalWallets: stats.totalWallets,
      totalBalance: stats.totalBalance,
      totalTransactions: stats.totalTransactions,
      symbol: 'NGEN'
    });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

// ============================================================
//  基础钱包 API (原有端点保持兼容)
// ============================================================

/**
 * GET /api/v1/wallet/balance/:address
 */
router.get('/balance/:address', cacheMiddleware(
  (req) => _cacheKey('balance', req.params.address),
  CACHE_TTL.balance
), (req, res) => {
  try {
    const { address } = req.params;

    if (!validateAddress(address)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid address format. Expected format: ng1...'
      });
    }

    const state = req.app.locals.state;

    // Always query both sources so callers can distinguish confirmed vs pending
    const onChainRaw = state?.getBalance?.(address);
    const confirmedBalance = formatNgen(onChainRaw || 0);

    let pendingBalance = 0;
    let agentId = null;
    let nonce = undefined;
    const walletAgentId = agentWalletManager.getAgentByAddress(address);
    if (walletAgentId) {
      const balanceResult = agentWalletManager.getBalance(walletAgentId);
      if (balanceResult.success) {
        agentId = walletAgentId;
        pendingBalance = balanceResult.balance;
        nonce = balanceResult.nonce;
      }
    }

    // The display balance is the higher of the two (pending may include
    // task rewards not yet finalized on-chain). Callers that need
    // spendable balance should use confirmedBalance.
    const balance = Math.max(confirmedBalance, pendingBalance);
    const source = (onChainRaw !== undefined && onChainRaw !== null && onChainRaw !== 0)
      ? 'blockchain'
      : (pendingBalance > 0 ? 'agent_wallet_manager' : (state ? 'blockchain' : 'default'));

    return res.json({
      success: true,
      wallet: {
        address,
        balance,
        balanceFormatted: balance.toLocaleString(),
        confirmedBalance,
        pendingBalance,
        usdValue: (balance * getUsdRate()).toFixed(2),
        usdValueType: 'testnet_virtual',
        usdValueNote: 'Testnet virtual estimate — not a market price. NGEN has network utility value (staking, governance, task settlement), no fiat conversion commitment.',
        symbol: NGEN_SYMBOL,
        decimals: NGEN_DECIMALS,
        source,
        ...(agentId ? { agentId } : {}),
        ...(nonce !== undefined ? { nonce } : {})
      }
    });
  } catch (error) {
    console.error('[Wallet API] Balance query error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
//  Phase 1: Agent 自主钱包 — 迁移协议
// ============================================================

/**
 * POST /api/v1/wallet/agent/migrate-to-self-custody
 * 将 Agent 从服务器托管迁移到自持模式
 * 流程：
 * 1. Agent 用 password 导出加密钱包
 * 2. Agent 在本地保存加密钱包和 password
 * 3. Agent 调用 self-custody 声明完成迁移
 * Body: { agentId, password }
 */
router.post('/agent/migrate-to-self-custody', (req, res) => {
  try {
    const { agentId, password } = req.body;

    if (!agentId || !password) {
      return res.status(400).json({
        success: false,
        error: 'agentId and password are required'
      });
    }

    const entry = agentWalletManager.registry.get(agentId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    // 检查是否已经是自持模式
    if (entry.metadata?.custody === 'self-custodied') {
      return res.status(400).json({
        success: false,
        error: 'Agent is already in self-custody mode'
      });
    }

    // 导出加密钱包
    const encrypted = agentWalletManager.exportAgentWallet(agentId, password);
    if (!encrypted) {
      // 浏览器生成的密钥：私钥从未在服务器上，用户已从浏览器保存
      return res.json({
        success: true,
        message: 'This agent was registered with a browser-generated key. Private key was never on the server.',
        data: {
          address: entry.wallet.address,
          publicKeyHex: entry.wallet.publicKey.toString('hex'),
          agentId,
          custody: 'self-custodied (browser-generated)',
          note: 'Your private key was generated in your browser and never stored on this server. It should be saved in your browser localStorage under ng_wallet_<agentId>.',
          nextStep: 'Migration already complete — no action needed.'
        }
      });
    }

    res.json({
      success: true,
      message: 'Wallet exported successfully. Save this encrypted wallet and password securely.',
      data: {
        address: entry.wallet.address,
        publicKeyHex: entry.wallet.publicKey.toString('hex'),
        agentId,
        encryptedWallet: encrypted,
        custody: 'server-managed (migration in progress)',
        migrationNotice: '请安全保存上述加密钱包和密码。迁移完成后，服务器将不再持有您的私钥。此响应仅显示一次。',
        nextStep: '使用 POST /api/v1/wallet/agent/self-custody 完成迁移声明'
      }
    });
  } catch (error) {
    console.error('[Wallet API] Migrate error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/agent/self-custody
 * Agent 声明已持有私钥，服务器更新 custody 状态为 self-custodied
 * 需要 Agent 用私钥签名一条消息来证明拥有私钥
 * Body: { agentId, signature, signedMessage }
 */
router.post('/agent/self-custody', async (req, res) => {
  try {
    const { agentId, signature, signedMessage } = req.body;

    if (!agentId || !signature || !signedMessage) {
      return res.status(400).json({
        success: false,
        error: 'agentId, signature, and signedMessage are required'
      });
    }

    const entry = agentWalletManager.registry.get(agentId);
    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    // 如果是浏览器生成的密钥（privateKey === null），直接标记为自持
    if (!entry.wallet.privateKey) {
      entry.metadata.custody = 'self-custodied';
      entry.metadata.migratedAt = new Date().toISOString();
      await agentWalletManager._saveRegistry();
      
      _cacheDelPrefix(_cacheKey('agentDetails', agentId));
      _cacheDelPrefix(_cacheKey('securityStatus', agentId));
      
      return res.json({
        success: true,
        message: 'Browser-generated key already in self-custody. Status updated.',
        data: {
          agentId,
          custody: 'self-custodied',
          migratedAt: entry.metadata.migratedAt,
          note: 'This key was generated in the browser and never stored on the server.'
        }
      });
    }

    // 验证签名（证明 Agent 拥有私钥）
    const { verify } = await import('../../crypto/pqc.js');
    const sigBuffer = Buffer.from(signature, 'hex');
    // publicKey 已经是 Buffer 类型，不需要再从 hex 转换（修复签名验证 Bug）
    const pubKeyBuffer = entry.wallet.publicKey instanceof Buffer 
      ? entry.wallet.publicKey 
      : Buffer.from(entry.wallet.publicKey, 'hex');
    
    const isValid = await verify(signedMessage, sigBuffer, pubKeyBuffer);
    if (!isValid) {
      return res.status(403).json({
        success: false,
        error: 'Invalid signature — Agent does not prove ownership of private key'
      });
    }

    // 更新 custody 状态
    entry.metadata.custody = 'self-custodied';
    entry.metadata.migratedAt = new Date().toISOString();
    await agentWalletManager._saveRegistry();

    // 缓存失效
    _cacheDelPrefix(_cacheKey('agentDetails', agentId));
    _cacheDelPrefix(_cacheKey('securityStatus', agentId));

    res.json({
      success: true,
      message: 'Migration complete. Agent wallet is now in self-custody mode.',
      data: {
        agentId,
        custody: 'self-custodied',
        migratedAt: entry.metadata.migratedAt,
        serverWillNotStorePrivateKey: true
      }
    });
  } catch (error) {
    console.error('[Wallet API] Self-custody declare error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/wallet/agent/custody-status/:agentId
 * 查询 Agent 的 custody 状态
 */
router.get('/agent/custody-status/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;
    const entry = agentWalletManager.registry.get(agentId);

    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    const metadata = entry.metadata || {};
    res.json({
      success: true,
      data: {
        agentId,
        address: entry.wallet.address,
        keyModel: metadata.keyModel || 'server-managed',
        custody: metadata.custody || 'server-managed',
        isSelfCustodied: metadata.custody === 'self-custodied',
        migratedAt: metadata.migratedAt || null,
        migrationStatus: metadata.custody === 'self-custodied' ? 'completed' : 'pending'
      }
    });
  } catch (error) {
    console.error('[Wallet API] Custody status error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/wallet/history/:address
 */
router.get('/history/:address', cacheMiddleware(
  (req) => _cacheKey('history', req.params.address, req.query.limit || '20', req.query.offset || '0'),
  CACHE_TTL.history
), (req, res) => {
  try {
    const { address } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    if (!validateAddress(address)) {
      return res.status(400).json({ success: false, error: 'Invalid address format' });
    }

    const agentId = agentWalletManager.getAgentByAddress(address);
    if (agentId) {
      const result = agentWalletManager.getTransactionHistory(agentId, {
        limit: Number(limit),
        offset: Number(offset)
      });
      if (result.success) {
        return res.json(result);
      }
    }

    const state = req.app.locals.state;
    if (!state) {
      return res.json({ success: true, transactions: [], total: 0 });
    }

    const txs = [];
    const allTransactions = state.transactions || state.getAllTransactions?.() || [];

    for (const tx of allTransactions) {
      if (tx.from === address || tx.to === address || tx.recipient === address) {
        const direction = tx.from === address ? 'send' : 'receive';
        txs.push({
          id: tx.id || tx.hash || crypto.createHash('sha3-256').update(JSON.stringify(tx)).digest('hex').slice(0, 16),
          type: tx.type || 'transfer',
          direction,
          from: tx.from || tx.sender,
          to: tx.to || tx.recipient,
          amount: tx.amount || tx.value || 0,
          fee: tx.fee || 0,
          symbol: NGEN_SYMBOL,
          status: tx.status || 'confirmed',
          timestamp: tx.timestamp || Date.now(),
          blockHeight: tx.blockHeight || tx.height || null
        });
      }
    }

    txs.sort((a, b) => b.timestamp - a.timestamp);
    const paginated = txs.slice(Number(offset), Number(offset) + Number(limit));

    res.json({
      success: true,
      transactions: paginated,
      total: txs.length,
      limit: Number(limit),
      offset: Number(offset)
    });
  } catch (error) {
    console.error('[Wallet API] History error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/transfer
 * Two modes:
 *   Mode A (agent): { fromAgentId, toAddress, amount, memo } — no privateKey needed
 *   Mode B (direct): { fromAddress, toAddress, amount, privateKey, memo } — requires privateKey
 */
router.post('/transfer', async (req, res) => {
  try {
    const { fromAddress: reqFromAddress, toAddress, amount, privateKey, fromAgentId, memo } = req.body;

    let fromAddress, senderBalance, wallet;
    const state = req.app.locals.state;
    if (!state) {
      return res.status(503).json({ success: false, error: 'Blockchain state not available' });
    }

    // Mode A: Transfer via AgentId (server-managed wallet, no privateKey needed)
    if (fromAgentId) {
      const agentEntry = agentWalletManager.getWalletInstance(fromAgentId);
      if (!agentEntry) {
        return res.status(404).json({ success: false, error: `Agent wallet not found: ${fromAgentId}` });
      }
      wallet = agentEntry;
      fromAddress = agentEntry.address;
      senderBalance = Number(agentEntry.balance) || 0;
    }
    // Mode B: Transfer via privateKey (direct wallet mode)
    else if (privateKey) {
      if (!reqFromAddress || !toAddress) {
        return res.status(400).json({ success: false, error: 'Required: fromAddress, toAddress, amount, privateKey (or use fromAgentId)' });
      }
      fromAddress = reqFromAddress;
      senderBalance = state.getBalanceOf?.(fromAddress) || state.balances?.[fromAddress] || 0;
    }
    else {
      return res.status(400).json({
        success: false,
        error: 'Provide either fromAgentId (server-managed) or fromAddress + privateKey (direct mode)'
      });
    }

    if (!toAddress) {
      return res.status(400).json({ success: false, error: 'toAddress is required' });
    }

    if (!validateAddress(fromAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid sender address' });
    }
    if (!validateAddress(toAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid recipient address' });
    }

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const fee = Math.floor(amountNum * 0.001);
    const total = amountNum + fee;

    if (senderBalance < total) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. Have: ${senderBalance}, need: ${total}`
      });
    }

    const tx = {
      type: 'transfer',
      from: fromAddress,
      to: toAddress,
      amount: amountNum,
      fee,
      memo: memo || '',
      timestamp: Date.now()
    };
    tx.id = crypto.createHash('sha3-256').update(JSON.stringify(tx)).digest('hex');

    // Sign transaction (Mode A: server signs on behalf of agent; Mode B: user provides privateKey)
    if (wallet && !privateKey) {
      // Server-managed: sign using the agent's wallet instance
      const { sign } = await import('../../wallet/genesisWallet.js');
      const tempWallet = { address: wallet.address, secretKey: wallet.privateKey?.toString?.('hex') || '' };
      if (tempWallet.secretKey) {
        tx.signature = await sign(tempWallet, JSON.stringify(tx));
      }
      // If no secretKey available, skip signature for server-managed transfers
    } else if (privateKey) {
      const { sign } = await import('../../wallet/genesisWallet.js');
      const userWallet = { address: fromAddress, secretKey: privateKey };
      tx.signature = await sign(userWallet, JSON.stringify(tx));
    }

    // Update balances (both agent wallet and blockchain state)
    if (state.setBalance) {
      state.setBalance(fromAddress, senderBalance - total);
      const recipientBalance = state.getBalance?.(toAddress) || state.balances?.[toAddress] || 0;
      state.setBalance(toAddress, recipientBalance + amountNum);
    }

    // Also update agent wallet balance if using Mode A
    if (fromAgentId && wallet) {
      wallet.balance -= BigInt(total);
      wallet.nonce++;
      agentWalletManager._saveRegistry?.();
    }

    // 缓存失效
    _cacheDelPrefix(_cacheKey('balance', fromAddress));
    _cacheDelPrefix(_cacheKey('history', fromAddress));
    _cacheDelPrefix(_cacheKey('info', fromAddress));
    _cacheDelPrefix(_cacheKey('balance', toAddress));
    _cacheDelPrefix(_cacheKey('history', toAddress));
    _cacheDelPrefix(_cacheKey('info', toAddress));
    if (fromAgentId) {
      _cacheDelPrefix(_cacheKey('agentBalance', fromAgentId));
      _cacheDelPrefix(_cacheKey('agentHistory', fromAgentId));
      _cacheDelPrefix(_cacheKey('agentDetails', fromAgentId));
    }
    _cacheDelPrefix(_cacheKey('stats'));
    _cacheDelPrefix(_cacheKey('agentStats'));

    res.status(201).json({
      success: true,
      transaction: {
        id: tx.id,
        from: fromAddress,
        to: toAddress,
        amount: amountNum,
        fee,
        timestamp: tx.timestamp,
        status: 'pending',
        mode: fromAgentId ? 'agent-managed' : 'direct'
      }
    });
  } catch (error) {
    console.error('[Wallet API] Transfer error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/wallet/info/:address
 */
router.get('/info/:address', cacheMiddleware(
  (req) => _cacheKey('info', req.params.address),
  CACHE_TTL.info
), (req, res) => {
  try {
    const { address } = req.params;

    if (!validateAddress(address)) {
      return res.status(400).json({ success: false, error: 'Invalid address format' });
    }

    const agentId = agentWalletManager.getAgentByAddress(address);
    const state = req.app.locals.state;

    if (agentId) {
      const walletInfo = agentWalletManager.getAgentWallet(agentId);
      if (walletInfo) {
        const balance = walletInfo.balance;
        const agents = state?.agents || state?.registeredAgents || [];
        const agentInfo = agents.find(a => a.address === address);

        return res.json({
          success: true,
          wallet: {
            address,
            agentId,
            balance,
            balanceFormatted: balance.toLocaleString(),
            usdValue: (balance * getUsdRate()).toFixed(2),
            usdValueType: 'testnet_virtual',
            usdValueNote: 'Testnet virtual estimate — not a market price. NGEN has network utility value (staking, governance, task settlement), no fiat conversion commitment.',
            symbol: NGEN_SYMBOL,
            decimals: NGEN_DECIMALS,
            nonce: walletInfo.nonce,
            isAgent: true,
            agentType: agentInfo?.type || walletInfo.agentId,
            agentCapabilities: agentInfo?.capabilities || [],
            agentReputation: agentInfo?.reputation || 0,
            source: 'agent_wallet_manager'
          }
        });
      }
    }

    const rawBalance = state?.getBalance?.(address) || state?.balances?.[address] || 0;
    const balance = formatNgen(rawBalance);
    const allTxns = state?.transactions || state?.getAllTransactions?.() || [];
    const txCount = allTxns.filter(tx =>
      tx.from === address || tx.to === address || tx.recipient === address
    ).length;

    res.json({
      success: true,
      wallet: {
        address,
        balance,
        balanceFormatted: balance.toLocaleString(),
        usdValue: (balance * getUsdRate()).toFixed(2),
        usdValueType: 'testnet_virtual',
        usdValueNote: 'Testnet virtual estimate — not a market price. NGEN has network utility value (staking, governance, task settlement), no fiat conversion commitment.',
        symbol: NGEN_SYMBOL,
        decimals: NGEN_DECIMALS,
        transactionCount: txCount,
        stakedAmount: state?.stakes?.[address] || 0,
        isAgent: false,
        source: state ? 'blockchain' : 'offline'
      }
    });
  } catch (error) {
    console.error('[Wallet API] Info error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
//  Agent 钱包 API (新增端点)
// ============================================================

// NOTE: Concrete routes MUST be registered BEFORE parameterized routes
// to prevent Express from matching 'list'/'stats' as :agentId values.

/**
 * GET /api/v1/wallet/agent/list
 * 列出所有Agent钱包
 */
router.get('/agent/list', cacheMiddleware(
  () => _cacheKey('agentList'),
  CACHE_TTL.info
), (req, res) => {
  try {
    const wallets = agentWalletManager.listAllWallets();
    const addresses = agentWalletManager.listAllAddresses();

    res.json({
      success: true,
      total: wallets.length,
      wallets,
      addresses
    });
  } catch (error) {
    console.error('[Wallet API] Agent list error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/wallet/agent/stats
 * Agent钱包统计
 */
router.get('/agent/stats', cacheMiddleware(
  () => _cacheKey('agentStats'),
  CACHE_TTL.stats
), (req, res) => {
  try {
    const stats = agentWalletManager.getStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[Wallet API] Agent stats error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/agent/create
 * 为Agent创建钱包（自动注册）
 * Body: { agentId, agentType, capabilities }
 */
router.post('/agent/create', async (req, res) => {
  try {
    const { agentId, agentType, capabilities = [] } = req.body;

    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId is required' });
    }

    const wallet = await agentWalletManager.createAgentWallet(agentId, {
      type: agentType || 'autonomous_agent',
      capabilities
    });

    // 缓存失效：新钱包创建后列表和统计都变了
    _cacheDelPrefix(_cacheKey('agentList'));
    _cacheDelPrefix(_cacheKey('agentStats'));
    _cacheDelPrefix(_cacheKey('stats'));

    res.status(201).json({
      success: true,
      wallet
    });
  } catch (error) {
    console.error('[Wallet API] Agent create error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/wallet/agent/:agentId
 * 获取Agent钱包信息
 */
router.get('/agent/:agentId', cacheMiddleware(
  (req) => _cacheKey('agentDetails', req.params.agentId),
  CACHE_TTL.agentDetails
), (req, res) => {
  try {
    const { agentId } = req.params;
    const wallet = agentWalletManager.getAgentWallet(agentId);

    if (!wallet) {
      return res.status(404).json({ success: false, error: 'Agent wallet not found' });
    }

    res.json({
      success: true,
      wallet
    });
  } catch (error) {
    console.error('[Wallet API] Agent get error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/wallet/agent/:agentId/balance
 * 查询Agent余额
 */
router.get('/agent/:agentId/balance', (req, res) => {
  try {
    const { agentId } = req.params;
    const result = agentWalletManager.getBalance(agentId);

    if (!result.success) {
      return res.status(404).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('[Wallet API] Agent balance error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/wallet/agent/:agentId/security-status
 * Phase 2-A2: 查询 Agent 安全引导状态
 *
 * 返回 onboarding 状态、风险等级、3 种建议操作。前端用此决定是否显示黄色横幅。
 * 无需鉴权（read-only，不泄露私钥）。
 */
router.get('/agent/:agentId/security-status', cacheMiddleware(
  (req) => _cacheKey('securityStatus', req.params.agentId),
  CACHE_TTL.securityStatus
), (req, res) => {
  try {
    const { agentId } = req.params;
    if (!agentWalletManager.getAgentWallet(agentId)) {
      return res.status(404).json({ success: false, error: 'Agent wallet not found' });
    }

    // Dynamic import 避免循环依赖
    import('../../wallet/onboarding.js').then(({ computeOnboardingStatus, ONBOARDING_SUGGESTIONS }) => {
      const ob = computeOnboardingStatus(agentId);
      if (!ob) {
        return res.status(500).json({ success: false, error: 'Failed to compute onboarding status' });
      }
      res.json({
        success: true,
        agentId,
        balance: ob.balance,
        needsOnboarding: ob.needsAction,
        status: ob.status,
        storedStatus: ob.storedStatus,
        isVirtual: ob.isVirtual,
        riskLevel: ob.riskLevel,
        triggeredAt: ob.triggeredAt,
        completedAt: ob.completedAt,
        method: ob.method,
        suggestedActions: ob.needsAction ? ONBOARDING_SUGGESTIONS : []
      });
    }).catch(e => {
      console.error('[Wallet API] security-status error:', e.message);
      res.status(500).json({ success: false, error: e.message });
    });
  } catch (error) {
    console.error('[Wallet API] security-status error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/agent/:agentId/onboarding/complete
 * Phase 2-A2: 标记 Agent 安全引导完成
 *
 * Body: { method: 'backup' | 'transfer' | 'hardware' | 'waive' }
 * Auth: admin credit secret required (operator / human approval)
 *
 * 用于"加密导出" / "转入硬件钱包" / "忽略风险" 三个按钮提交后。
 */
router.post('/agent/:agentId/onboarding/complete', async (req, res) => {
  try {
    // 状态变更操作：需要 admin credit secret
    if (!verifyCreditSecret(req)) {
      const block = productionBlockResponse();
      if (block) {
        return res.status(403).json(block);
      }
      return res.status(403).json({
        success: false,
        error: 'Marking onboarding complete requires admin credit secret'
      });
    }

    const { agentId } = req.params;
    const { method } = req.body;

    if (!method || typeof method !== 'string') {
      return res.status(400).json({ success: false, error: 'method is required (backup|transfer|hardware|waive)' });
    }

    if (!agentWalletManager.getAgentWallet(agentId)) {
      return res.status(404).json({ success: false, error: 'Agent wallet not found' });
    }

    const { markOnboardingComplete } = await import('../../wallet/onboarding.js');
    const result = markOnboardingComplete(agentId, method);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    // 缓存失效：安全引导状态变更
    _cacheDelPrefix(_cacheKey('securityStatus', agentId));
    _cacheDelPrefix(_cacheKey('agentDetails', agentId));
    res.json({
      success: true,
      agentId,
      status: result.status,
      method: result.method
    });
  } catch (error) {
    console.error('[Wallet API] onboarding/complete error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/agent/transfer
 * Agent间转账
 * Body: { fromAgentId, toAgentId (或 toAddress), amount, memo }
 * Auth: admin-secret required (production) or devnet mode
 */
router.post('/agent/transfer', async (req, res) => {
  try {
    // Auth guard: require admin credit secret for write operations
    if (!verifyCreditSecret(req)) {
      // Phase 2-D3 fix: surface the kill-switch error_code so operators can
      // distinguish "secret disabled in production" from a plain 403 in logs.
      const block = productionBlockResponse();
      if (block) {
        return res.status(403).json(block);
      }
      return res.status(403).json({
        success: false,
        error: 'Transfer requires admin credit secret authentication'
      });
    }

    const { fromAgentId, toAgentId, toAddress, amount, memo, agentSignature } = req.body;

    if (!fromAgentId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'fromAgentId and amount are required'
      });
    }

    // Phase 1: 双重签名兼容 — 自持 Agent 需要额外签名
    if (agentSignature) {
      const entry = agentWalletManager.registry.get(fromAgentId);
      if (entry && entry.metadata?.custody === 'self-custodied') {
        // 自持 Agent: 验证 agent 签名
        const transferMsg = JSON.stringify({ fromAgentId, toAgentId, toAddress, amount: String(amount), memo: memo || '' });
        const sigBuffer = Buffer.from(agentSignature, 'hex');
        const pubKeyBuffer = Buffer.from(entry.wallet.publicKey, 'hex');
        const isValid = await verify(transferMsg, sigBuffer, pubKeyBuffer);
        if (!isValid) {
          return res.status(403).json({
            success: false,
            error: 'Invalid agent signature for self-custodied wallet'
          });
        }
      }
    }

    const destination = toAgentId || toAddress;
    if (!destination) {
      return res.status(400).json({
        success: false,
        error: 'toAgentId or toAddress is required'
      });
    }

    const result = await agentWalletManager.transfer(
      fromAgentId,
      destination,
      Number(amount),
      memo || ''
    );

    if (result.success) {
      // 持久化到 state txHistory 便于审计和前端历史查询
      try {
        const state = req.app.locals.node?.currentState || req.app.locals.state;
        if (state) {
          if (!state.transactions) state.transactions = {};
          if (!Array.isArray(state.transactions.txHistory)) state.transactions.txHistory = [];
          state.transactions.txHistory.push({
            id: result.transactionId,
            hash: result.transactionId,
            type: 'transfer',
            tx_type: 'TRANSFER',
            from: result.from,
            to: result.to,
            fromAgentId,
            toAgentId: toAgentId || null,
            toAddress: toAddress || null,
            amount: result.amount,
            netAmount: result.netAmount,
            fee: result.fee,
            metabolicTax: result.metabolicTax,
            memo: result.memo,
            signature: result.signature,
            status: 'applied',
            timestamp: result.timestamp
          });
        }
      } catch (_) { /* ignore */ }
      // 缓存失效：清除发送方和接收方的相关缓存
      _cacheDelPrefix(_cacheKey('agentBalance', fromAgentId));
      _cacheDelPrefix(_cacheKey('agentHistory', fromAgentId));
      _cacheDelPrefix(_cacheKey('agentDetails', fromAgentId));
      _cacheDelPrefix(_cacheKey('balance', result.from));
      _cacheDelPrefix(_cacheKey('history', result.from));
      _cacheDelPrefix(_cacheKey('info', result.from));
      if (toAgentId) {
        _cacheDelPrefix(_cacheKey('agentBalance', toAgentId));
        _cacheDelPrefix(_cacheKey('agentHistory', toAgentId));
        _cacheDelPrefix(_cacheKey('agentDetails', toAgentId));
      }
      if (result.to) {
        _cacheDelPrefix(_cacheKey('balance', result.to));
        _cacheDelPrefix(_cacheKey('history', result.to));
        _cacheDelPrefix(_cacheKey('info', result.to));
      }
      _cacheDelPrefix(_cacheKey('stats'));
      _cacheDelPrefix(_cacheKey('agentStats'));
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('[Wallet API] Agent transfer error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/agent/batch-transfer
 * Agent批量转账
 * Body: { fromAgentId, transfers: [{ toAgentId, amount, memo }] }
 * Auth: admin-secret required
 */
router.post('/agent/batch-transfer', async (req, res) => {
  try {
    // Auth guard
    if (!verifyCreditSecret(req)) {
      const block = productionBlockResponse();
      if (block) {
        return res.status(403).json(block);
      }
      return res.status(403).json({
        success: false,
        error: 'Batch transfer requires admin credit secret authentication'
      });
    }

    const { fromAgentId, transfers } = req.body;

    if (!fromAgentId || !transfers || !Array.isArray(transfers)) {
      return res.status(400).json({
        success: false,
        error: 'fromAgentId and transfers[] are required'
      });
    }

    const result = await agentWalletManager.batchTransfer(fromAgentId, transfers);

    // 缓存失效：批量转账成功后清除发送方和所有接收方缓存
    if (result.success) {
      _cacheDelPrefix(_cacheKey('agentBalance', fromAgentId));
      _cacheDelPrefix(_cacheKey('agentHistory', fromAgentId));
      _cacheDelPrefix(_cacheKey('agentDetails', fromAgentId));
      if (Array.isArray(result.results)) {
        for (const r of result.results) {
          if (r.toAgentId) {
            _cacheDelPrefix(_cacheKey('agentBalance', r.toAgentId));
            _cacheDelPrefix(_cacheKey('agentHistory', r.toAgentId));
            _cacheDelPrefix(_cacheKey('agentDetails', r.toAgentId));
          }
          if (r.to) {
            _cacheDelPrefix(_cacheKey('balance', r.to));
            _cacheDelPrefix(_cacheKey('history', r.to));
          }
        }
      }
      _cacheDelPrefix(_cacheKey('stats'));
      _cacheDelPrefix(_cacheKey('agentStats'));
    }

    res.status(201).json(result);
  } catch (error) {
    console.error('[Wallet API] Agent batch transfer error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/wallet/agent/:agentId/history
 * Agent交易历史
 */
router.get('/agent/:agentId/history', cacheMiddleware(
  (req) => _cacheKey('agentHistory', req.params.agentId, req.query.limit || '20', req.query.offset || '0'),
  CACHE_TTL.history
), (req, res) => {
  try {
    const { agentId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    const entry = agentWalletManager.registry.get(agentId);
    if (!entry) {
      return res.json({ success: false, reason: 'Agent wallet not found' });
    }

    // 从全局状态读取交易记录（优先使用 req.app.locals.state / node.currentState）
    const state = req.app.locals.node?.currentState || req.app.locals.state;
    let transactions = [];
    const myAddr = entry.wallet.address;

    if (state) {
      const allTxs = state.transactions?.txHistory
        || state.getAllTransactions?.()
        || state.transactions
        || [];
      if (Array.isArray(allTxs)) {
        transactions = allTxs.filter(tx => tx.from === myAddr || tx.to === myAddr || tx.recipient === myAddr || tx.sender === myAddr);
      }
    }

    transactions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const total = transactions.length;
    const page = transactions.slice(Number(offset), Number(offset) + Number(limit));

    res.json({
      success: true,
      agentId,
      address: myAddr,
      transactions: page.map(tx => ({
        id: tx.id || tx.hash,
        type: tx.type || tx.tx_type || 'transfer',
        from: tx.from || tx.sender,
        to: tx.to || tx.recipient,
        fromAgentId: tx.fromAgentId,
        toAgentId: tx.toAgentId,
        amount: tx.amount,
        fee: tx.fee,
        memo: tx.memo,
        timestamp: tx.timestamp,
        direction: (tx.from || tx.sender) === myAddr ? 'send' : 'receive'
      })),
      total,
      limit: Number(limit),
      offset: Number(offset)
    });
  } catch (error) {
    console.error('[Wallet API] Agent history error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/agent/:agentId/claim
 * 领取水龙头
 */
router.post('/agent/:agentId/claim', async (req, res) => {
  try {
    const { agentId } = req.params;
    const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';

    const result = await agentWalletManager.claimFaucet(agentId, ip);

    if (result.success) {
      // 缓存失效
      _cacheDelPrefix(_cacheKey('agentBalance', agentId));
      _cacheDelPrefix(_cacheKey('agentHistory', agentId));
      _cacheDelPrefix(_cacheKey('agentDetails', agentId));
      if (result.wallet?.address) {
        _cacheDelPrefix(_cacheKey('balance', result.wallet.address));
        _cacheDelPrefix(_cacheKey('history', result.wallet.address));
      }
      _cacheDelPrefix(_cacheKey('stats'));
      _cacheDelPrefix(_cacheKey('agentStats'));
      res.json({
        success: true,
        message: 'Faucet tokens claimed',
        amount: result.wallet?.balance || 0
      });
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('[Wallet API] Faucet claim error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/agent/export
 * 导出Agent钱包（加密）
 * Body: { agentId, password }
 */
router.post('/agent/export', (req, res) => {
  try {
    const { agentId, password } = req.body;

    if (!agentId || !password) {
      return res.status(400).json({ success: false, error: 'agentId and password required' });
    }

    const encrypted = agentWalletManager.exportAgentWallet(agentId, password);

    if (!encrypted) {
      return res.status(404).json({ success: false, error: 'Agent wallet not found' });
    }

    res.json({
      success: true,
      encrypted
    });
  } catch (error) {
    console.error('[Wallet API] Export error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/agent/import
 * 导入Agent钱包（加密）
 * Body: { agentId, encrypted, password }
 */
router.post('/agent/import', (req, res) => {
  try {
    const { agentId, encrypted, password } = req.body;

    if (!agentId || !encrypted || !password) {
      return res.status(400).json({
        success: false,
        error: 'agentId, encrypted, and password required'
      });
    }

    const success = agentWalletManager.importAgentWallet(agentId, encrypted, password);

    if (!success) {
      return res.status(400).json({ success: false, error: 'Import failed (wrong password?)' });
    }

    // 缓存失效：导入钱包后清除该 agent 的所有缓存
    _cacheDelPrefix(_cacheKey('agentBalance', agentId));
    _cacheDelPrefix(_cacheKey('agentHistory', agentId));
    _cacheDelPrefix(_cacheKey('agentDetails', agentId));
    _cacheDelPrefix(_cacheKey('securityStatus', agentId));
    _cacheDelPrefix(_cacheKey('agentList'));
    _cacheDelPrefix(_cacheKey('agentStats'));
    _cacheDelPrefix(_cacheKey('stats'));

    res.json({
      success: true,
      message: `Wallet imported for agent ${agentId}`
    });
  } catch (error) {
    console.error('[Wallet API] Import error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/wallet/assets
 */
router.get('/assets', cacheMiddleware(
  () => _cacheKey('assets'),
  CACHE_TTL.assets
), (req, res) => {
  res.json({
    success: true,
    assets: [
      {
        symbol: NGEN_SYMBOL,
        name: 'NexusGenesis Token',
        decimals: NGEN_DECIMALS,
        type: 'native',
        description: 'Native governance and utility token of NexusGenesis'
      }
    ]
  });
});

/**
 * GET /api/v1/wallet/health
 */
router.get('/health', (req, res) => {
  const state = req.app.locals.state;
  const stats = agentWalletManager.getStats();

  res.json({
    success: true,
    status: 'healthy',
    blockchain: state ? 'connected' : 'offline',
    walletVersion: '3.0.0',
    pqc: 'CRYSTALS-Dilithium2 (ml_dsa44)',
    agentWallets: stats.totalWallets,
    features: [
      'balance_query',
      'transaction_history',
      'transfer',
      'wallet_info',
      'asset_listing',
      'agent_wallet_create',
      'agent_transfer',
      'agent_batch_transfer',
      'agent_faucet_claim',
      'agent_wallet_export',
      'agent_wallet_import',
      'agent_registry',
      'custody_token',
      'server_side_signing'
    ]
  });
});

// ============================================================
//  Custody Token 流程（外部 Agent 接入专用）
// 私钥永远不出服务器，AGENT 通过 custody token 委托签名
// ============================================================

/**
 * POST /api/v1/wallet/custody/refresh
 * 用现有 custody token 重新签发一个新 token
 * Body: { agentId, address }（context 校验）
 * Header: x-custody-token: <旧 token>
 */
router.post('/custody/refresh', (req, res) => {
  try {
    const token = extractCustodyToken(req);
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Missing custody token (header x-custody-token or body.custody_token)',
        error_code: 'TOKEN_MISSING'
      });
    }

    const { agentId, address, publicKeyHex } = req.body || {};
    const verification = verifyCustodyToken(token, { agentId, address, publicKeyHex });
    if (!verification.valid) {
      return res.status(401).json({
        success: false,
        error: `Custody token rejected: ${verification.reason}`,
        error_code: 'TOKEN_REJECTED'
      });
    }

    // 用 token 中的 sub/addr 签发新 token
    const { sub, addr, fp } = verification.payload;
    const walletInstance = agentWalletManager.getWalletInstance(sub) || agentWalletManager.getWalletInstanceByAddress(addr);
    if (!walletInstance) {
      return res.status(404).json({
        success: false,
        error: 'Wallet not found for token subject',
        error_code: 'WALLET_NOT_FOUND'
      });
    }

    const newToken = issueCustodyToken({
      agentId: sub,
      address: addr,
      publicKeyHex: walletInstance.publicKey.toString('hex')
    });

    res.json({
      success: true,
      custody: newToken
    });
  } catch (error) {
    console.error('[Wallet API] Custody refresh error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/wallet/sign
 * 用 Agent 托管私钥对数据进行签名（外部 Agent 唯一签名通道）
 *
 * Body: {
 *   agentId: string,    // 待签名 agent
 *   data: string|object,// 待签数据
 *   action?: string,    // 操作类型（用于审计日志，不影响签名）
 *   context?: object    // 上下文（写入审计日志）
 * }
 * Header: x-custody-token: <token>
 *
 * Response: { signature, publicKey, address, agentId, algorithm }
 */
router.post('/sign', async (req, res) => {
  try {
    const token = extractCustodyToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Custody token required (header x-custody-token or body.custody_token)',
        error_code: 'CUSTODY_TOKEN_REQUIRED',
        hint: buildAuthHint('CUSTODY_TOKEN_REQUIRED', { isDevnet: process.env.NODE_ENV !== 'production' })
      });
    }

    const { agentId, data, action, context } = req.body || {};
    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId is required' });
    }
    if (data === undefined || data === null) {
      return res.status(400).json({ success: false, error: 'data is required' });
    }

    // 1) 验证 custody token（必须绑定到该 agent）
    const walletInstance = agentWalletManager.getWalletInstance(agentId);
    if (!walletInstance) {
      return res.status(404).json({ success: false, error: `Agent wallet not found: ${agentId}` });
    }
    const verification = verifyCustodyToken(token, {
      agentId,
      address: walletInstance.address,
      publicKeyHex: walletInstance.publicKey.toString('hex')
    });
    if (!verification.valid) {
      return res.status(401).json({
        success: false,
        error: `Custody token rejected: ${verification.reason}`,
        error_code: 'CUSTODY_TOKEN_REJECTED'
      });
    }

    // 2) 用托管私钥签名
    let result;
    try {
      result = await agentWalletManager.signForAgent(agentId, data);
    } catch (e) {
      return res.status(500).json({ success: false, error: `Signing failed: ${e.message}` });
    }

    // 3) 审计日志 — 持久化到 state.transactions.txHistory (Phase 2-A2)
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    const custodyFp = (() => {
      try { return publicKeyFingerprint(walletInstance.publicKey.toString('hex')); }
      catch { return null; }
    })();
    const state = req.app?.locals?.state;
    if (state) {
      try {
        recordCustodySign(state, {
          agentId,
          address: result.address,
          action: action || 'unspecified',
          dataLen: dataStr.length,
          custodyFp,
          ip: req.ip || req.headers['x-forwarded-for'] || null,
          userAgent: req.headers['user-agent'] || null,
          context: context || null
        });
      } catch (auditErr) {
        // 审计失败不影响签名结果，仅记录
        console.error('[Wallet API] Custody audit record failed:', auditErr.message);
      }
    }
    console.log(
      `[Wallet] Custody sign: agent=${agentId} action=${action || 'unspecified'} ` +
      `dataLen=${dataStr.length} context=${context ? JSON.stringify(context) : 'none'}`
    );

    res.json({
      success: true,
      ...result,
      algorithm: 'CRYSTALS-Dilithium2 (ml_dsa44)',
      signedAt: Math.floor(Date.now() / 1000)
    });
  } catch (error) {
    console.error('[Wallet API] Sign error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
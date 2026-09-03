import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const router = Router();

// ============================================================
//  内存缓存（TTL-based）
// ============================================================
const _cache = new Map();
const CACHE_TTL = {
  chains: 300000,
  fees: 60000,
  transfers: 10000,
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

function _cacheKey(type, ...parts) {
  return `bridge:${type}:${parts.join(':')}`;
}

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
      const origJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && body?.success !== false) {
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

const SUPPORTED_CHAINS = [
  { id: 'ethereum', name: 'Ethereum', icon: 'Ξ', chainId: 1, rpcUrl: 'https://eth.llamarpc.com', explorerUrl: 'https://etherscan.io', avgBlockTime: 12, confirmBlocks: 15 },
  { id: 'bsc', name: 'BSC', icon: '🔶', chainId: 56, rpcUrl: 'https://bsc-dataseed.binance.org', explorerUrl: 'https://bscscan.com', avgBlockTime: 3, confirmBlocks: 20 },
  { id: 'polygon', name: 'Polygon', icon: '🟣', chainId: 137, rpcUrl: 'https://polygon-rpc.com', explorerUrl: 'https://polygonscan.com', avgBlockTime: 2, confirmBlocks: 30 },
  { id: 'solana', name: 'Solana', icon: '◎', chainId: 0, rpcUrl: 'https://api.mainnet-beta.solana.com', explorerUrl: 'https://solscan.io', avgBlockTime: 0.4, confirmBlocks: 32 },
  { id: 'avalanche', name: 'Avalanche', icon: '🔺', chainId: 43114, rpcUrl: 'https://api.avax.network/ext/bc/C/rpc', explorerUrl: 'https://snowtrace.io', avgBlockTime: 2, confirmBlocks: 20 },
  { id: 'arbitrum', name: 'Arbitrum', icon: '🔷', chainId: 42161, rpcUrl: 'https://arb1.arbitrum.io/rpc', explorerUrl: 'https://arbiscan.io', avgBlockTime: 0.25, confirmBlocks: 40 }
];

router.get('/docs/bridge', (req, res) => {
  res.sendFile(path.join(projectRoot, 'public', 'bridge.html'));
});

router.get('/api/v1/bridge/chains', cacheMiddleware(
  () => _cacheKey('chains'),
  CACHE_TTL.chains
), (req, res) => {
  res.json({ success: true, data: { chains: SUPPORTED_CHAINS, count: SUPPORTED_CHAINS.length } });
});

router.get('/api/v1/bridge/fees', cacheMiddleware(
  () => _cacheKey('fees'),
  CACHE_TTL.fees
), (req, res) => {
  const fees = {};
  for (const source of SUPPORTED_CHAINS) {
    fees[source.id] = {};
    for (const target of SUPPORTED_CHAINS) {
      if (source.id !== target.id) {
        fees[source.id][target.id] = {
          fee: source.avgBlockTime < 1 ? '0.0001' : '0.001',
          estimatedTime: Math.round((source.avgBlockTime * source.confirmBlocks + target.avgBlockTime * target.confirmBlocks) * 1.2)
        };
      }
    }
  }
  res.json({ success: true, data: { fees } });
});

router.post('/api/v1/bridge/lock', (req, res) => {
  const { sourceChain, targetChain, token, amount, recipient } = req.body;
  if (!sourceChain || !targetChain || !token || !amount || !recipient) {
    return res.status(400).json({ success: false, error:'缺少必填parameter: sourceChain, targetChain, token, amount, recipient' });
  }

  const lockId = `lock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const source = SUPPORTED_CHAINS.find(c => c.id === sourceChain);
  const target = SUPPORTED_CHAINS.find(c => c.id === targetChain);
  const estimatedTime = source && target
    ? Math.round((source.avgBlockTime * source.confirmBlocks + target.avgBlockTime * target.confirmBlocks) * 1.2)
    : 300;

  res.json({
    success: true,
    data: {
      lockId, sourceChain, targetChain, token, amount, recipient,
      status: 'pending', estimatedTime, createdAt: Date.now()
    }
  });
});

router.get('/api/v1/bridge/transfers', cacheMiddleware(
  (req) => _cacheKey('transfers', req.query.limit || '20', req.query.offset || '0'),
  CACHE_TTL.transfers
), (req, res) => {
  res.json({
    success: true,
    data: {
      transfers: [],
      stats: {
        totalTransfers: 0, totalVolume: 0, activeTransfers: 0, completedTransfers: 0
      }
    }
  });
});

export default router;
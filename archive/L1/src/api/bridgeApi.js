import express from 'express';

const router = express.Router();

// ============================================================
//  内存缓存（TTL-based）
// ============================================================
const _cache = new Map();
const CACHE_TTL = {
  chains: 60000,
  status: 10000,
  validators: 15000,
  validator: 10000,
  transfer: 5000,
  events: 10000,
  lightClient: 5000,
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

export function _cacheDelPrefix(prefix) {
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
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

function getBridge(req) {
  return req.app.locals.bridge || null;
}

function getBridgeProtocol(req) {
  return req.app.locals.bridgeProtocol || null;
}

function requireBridge(req, res, next) {
  const bridge = getBridge(req) || getBridgeProtocol(req);
  if (!bridge) {
    return res.status(503).json({ success: false, message: 'Bridge service not available' });
  }
  req.bridge = bridge;
  next();
}

function requireBridgeProtocol(req, res, next) {
  const bridge = getBridgeProtocol(req);
  if (!bridge) {
    return res.status(503).json({ success: false, message: 'Bridge protocol not available' });
  }
  req.bridgeProtocol = bridge;
  next();
}

// ==================== Validator管理 ====================

router.post('/validators', requireBridgeProtocol, async (req, res) => {
  try {
    const { validatorId, publicKey, metadata } = req.body;
    if (!validatorId || !publicKey) {
      return res.status(400).json({ success: false, message: 'validatorId and publicKey are required' });
    }
    const result = req.bridgeProtocol.registerValidator(validatorId, publicKey, metadata || {});
    if (result) {
      _cacheDelPrefix(_cacheKey('validators'));
      _cacheDelPrefix(_cacheKey('status'));
    }
    res.status(201).json({ success: true, registered: result, validatorId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/validators', cacheMiddleware(
  () => _cacheKey('validators'),
  CACHE_TTL.validators
), requireBridgeProtocol, async (req, res) => {
  try {
    const active = req.bridgeProtocol.getActiveValidators();
    res.json({ success: true, validators: active, total: active.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/validators/:validatorId', cacheMiddleware(
  (req) => _cacheKey('validator', req.params.validatorId),
  CACHE_TTL.validator
), requireBridgeProtocol, async (req, res) => {
  try {
    const validator = req.bridgeProtocol.getValidator(req.params.validatorId);
    if (!validator) {
      return res.status(404).json({ success: false, message: 'Validator not found' });
    }
    res.json({ success: true, validator });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/validators/:validatorId', requireBridgeProtocol, async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isActive (boolean) is required' });
    }
    const result = req.bridgeProtocol.setValidatorActive(req.params.validatorId, isActive);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Validator not found' });
    }
    _cacheDelPrefix(_cacheKey('validators'));
    _cacheDelPrefix(_cacheKey('validator', req.params.validatorId));
    _cacheDelPrefix(_cacheKey('status'));
    res.json({ success: true, validatorId: req.params.validatorId, isActive });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.patch('/validators/:validatorId/reputation', requireBridgeProtocol, async (req, res) => {
  try {
    const { delta } = req.body;
    if (typeof delta !== 'number') {
      return res.status(400).json({ success: false, message: 'delta (number) is required' });
    }
    const result = req.bridgeProtocol.updateValidatorReputation(req.params.validatorId, delta);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Validator not found' });
    }
    _cacheDelPrefix(_cacheKey('validators'));
    _cacheDelPrefix(_cacheKey('validator', req.params.validatorId));
    _cacheDelPrefix(_cacheKey('status'));
    res.json({ success: true, validatorId: req.params.validatorId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== assetLock与转移 ====================

router.post('/lock', requireBridgeProtocol, async (req, res) => {
  try {
    const { fromChain, toChain, asset, amount, recipient, options } = req.body;
    if (!fromChain || !toChain || !asset || amount === undefined || !recipient) {
      return res.status(400).json({
        success: false,
        message: 'fromChain, toChain, asset, amount, and recipient are required'
      });
    }
    if (amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be positive' });
    }
    const result = req.bridgeProtocol.lockAsset(fromChain, toChain, asset, amount, recipient, options || {});
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get('/transfers/:transferId', requireBridge, async (req, res) => {
  try {
    let transfer = null;
    if (req.bridgeProtocol) {
      transfer = req.bridgeProtocol.getTransfer(req.params.transferId);
    }
    if (!transfer && req.bridge) {
      transfer = req.bridge.getTransferStatus(req.params.transferId);
    }
    if (!transfer) {
      return res.status(404).json({ success: false, message: 'Transfer not found' });
    }
    res.json({ success: true, transfer });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/transfers/:transferId/validate', requireBridgeProtocol, async (req, res) => {
  try {
    const { validatorId, signature } = req.body;
    if (!validatorId || !signature) {
      return res.status(400).json({ success: false, message: 'validatorId and signature are required' });
    }
    const signatureBuffer = Buffer.from(signature, 'hex');
    const result = req.bridgeProtocol.validateTransfer(req.params.transferId, validatorId, signatureBuffer);
    if (!result) {
      return res.status(400).json({ success: false, message: 'Validation failed' });
    }
    res.json({ success: true, transferId: req.params.transferId, validatedBy: validatorId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/transfers/:transferId/release', requireBridgeProtocol, async (req, res) => {
  try {
    const result = req.bridgeProtocol.releaseAsset(req.params.transferId);
    if (result) {
      _cacheDelPrefix(_cacheKey('transfer', req.params.transferId));
      _cacheDelPrefix(_cacheKey('events'));
      _cacheDelPrefix(_cacheKey('status'));
    }
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/transfers/:transferId/emergency-unlock', requireBridgeProtocol, async (req, res) => {
  try {
    const { adminSignature } = req.body;
    const result = req.bridgeProtocol.emergencyUnlock(req.params.transferId, adminSignature);
    if (!result) {
      return res.status(400).json({ success: false, message: 'Emergency unlock failed' });
    }
    _cacheDelPrefix(_cacheKey('transfer', req.params.transferId));
    _cacheDelPrefix(_cacheKey('events'));
    _cacheDelPrefix(_cacheKey('status'));
    res.json({ success: true, transferId: req.params.transferId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Bridgestatus与Configuration ====================

router.get('/status', requireBridge, async (req, res) => {
  try {
    let status = {};
    if (req.bridgeProtocol) {
      status = req.bridgeProtocol.getBridgeStatus();
    } else {
      status = {
        bridgeId: req.bridge.bridgeId,
        status: req.bridge.status,
        relayers: req.bridge.relayers?.size || 0,
        supportedChains: req.bridge.getSupportedChains(),
        pendingTransfers: req.bridge.bridgeState?.pendingTransfers?.size || 0,
        completedTransfers: req.bridge.bridgeState?.completedTransfers?.size || 0
      };
    }
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/chains', requireBridge, async (req, res) => {
  try {
    let chains = [];
    if (req.bridgeProtocol) {
      chains = req.bridgeProtocol.supportedChains;
    } else if (req.bridge) {
      chains = req.bridge.getSupportedChains();
    }
    res.json({ success: true, chains, total: chains.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/events', requireBridgeProtocol, async (req, res) => {
  try {
    const { type, limit } = req.query;
    const events = req.bridgeProtocol.getBridgeEvents(type || null, parseInt(limit) || 100);
    res.json({ success: true, events, total: events.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== 轻客户端 ====================

router.get('/light-client/status', cacheMiddleware(
  () => _cacheKey('lightClient'),
  CACHE_TTL.lightClient
), requireBridgeProtocol, async (req, res) => {
  try {
    const lightClient = req.app.locals.lightClient;
    if (!lightClient) {
      return res.status(503).json({ success: false, message: 'Light client not available' });
    }
    res.json({ success: true, status: lightClient.getSyncStatus() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;

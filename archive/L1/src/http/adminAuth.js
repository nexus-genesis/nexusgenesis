/**
 * NexusGenesis - Admin Authentication
 *
 * 将 admin 能力拆分为两类独立密钥，避免单点泄漏：
 *
 *   - NG_ADMIN_CREDIT_SECRET  : 资金/状态变更类（admin/credit, admin/endow, admin/slash, agent/transfer, agent/batch-transfer）
 *   - NG_ADMIN_BYPASS_SECRET  : 签名/投票免签类（tasks/*, forum vote, forum steward sign）
 *
 * 向后兼容：
 *   - 旧 NG_ADMIN_SECRET 如有设置，会同时作为两类 secret 的值（带启动 warning）
 *   - 旧请求 header `x-admin-secret` 仍按对应 secret 校验
 *
 * 强制要求（生产环境）：
 *   - NODE_ENV=production 时，secret 必须显式设置（不能为空、不能为默认值）
 *   - devnet / test 环境允许使用默认值以便本地开发
 */

const DEFAULT_DEV_SECRET = 'devnet-endow-2026';
const ENV_CREDIT = 'NG_ADMIN_CREDIT_SECRET';
const ENV_BYPASS = 'NG_ADMIN_BYPASS_SECRET';
const ENV_LEGACY = 'NG_ADMIN_SECRET';
// Phase 2-A3: Hard kill-switch for production. Even with a correct secret,
// the production node will reject all x-admin-secret requests unless this
// override is explicitly set. This prevents accidental use of devnet-style
// secret headers on a real deployment.
const ENV_PROD_OVERRIDE = 'NG_ADMIN_ALLOW_IN_PRODUCTION';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function adminSecretAllowedInProduction() {
  // Must be a truthy value AND the env must be exactly '1' or 'true' to avoid
  // accidental acceptance from process.env defaults like '0' or 'false'.
  const v = process.env[ENV_PROD_OVERRIDE];
  return v === '1' || v === 'true';
}

function productionSecretGuard() {
  if (!isProduction()) return null;
  if (adminSecretAllowedInProduction()) return null;
  return {
    success: false,
    error: 'admin-secret disabled in production. Set NG_ADMIN_ALLOW_IN_PRODUCTION=1 to override (not recommended).',
    error_code: 'ADMIN_SECRET_DISABLED_IN_PRODUCTION'
  };
}

function resolveSecret(envName) {
  const explicit = process.env[envName];
  if (explicit && explicit.length >= 16) return explicit;

  // 向后兼容：旧 NG_ADMIN_SECRET 仍可作为通用值
  const legacy = process.env[ENV_LEGACY];
  if (legacy && legacy.length >= 16) return legacy;

  // devnet 模式：允许默认值
  if (!isProduction()) return DEFAULT_DEV_SECRET;

  // 生产模式：必须显式设置
  throw new Error(
    `[AdminAuth] ${envName} must be set (>= 16 chars) in production. ` +
    `Set it in env or use NG_ADMIN_SECRET (legacy) as fallback.`
  );
}

let _creditSecret = null;
let _bypassSecret = null;
let _initialized = false;

function init() {
  if (_initialized) return;

  try {
    _creditSecret = resolveSecret(ENV_CREDIT);
    _bypassSecret = resolveSecret(ENV_BYPASS);
  } catch (e) {
    if (isProduction()) {
      // 生产模式：启动失败
      console.error(e.message);
      throw e;
    }
    // devnet：忽略，使用默认值
    _creditSecret = DEFAULT_DEV_SECRET;
    _bypassSecret = DEFAULT_DEV_SECRET;
  }

  if (!isProduction() && (_creditSecret === DEFAULT_DEV_SECRET || _bypassSecret === DEFAULT_DEV_SECRET)) {
    console.warn('[AdminAuth] Running with DEFAULT devnet secrets. Set NG_ADMIN_CREDIT_SECRET and NG_ADMIN_BYPASS_SECRET before production.');
  }

  if (isProduction() && !adminSecretAllowedInProduction()) {
    console.warn('[AdminAuth] PRODUCTION HARDENING: x-admin-secret paths DISABLED. All admin-secret requests will be rejected. Set NG_ADMIN_ALLOW_IN_PRODUCTION=1 to override.');
  } else if (isProduction() && adminSecretAllowedInProduction()) {
    console.warn('[AdminAuth] PRODUCTION OVERRIDE: NG_ADMIN_ALLOW_IN_PRODUCTION is set. x-admin-secret paths are ACCEPTED — this is not recommended for production deployments.');
  }

  if (process.env[ENV_LEGACY] && !process.env[ENV_CREDIT] && !process.env[ENV_BYPASS]) {
    console.warn('[AdminAuth] NG_ADMIN_SECRET (legacy) is set; using it as both credit and bypass secret. Migrate to split secrets.');
  }

  _initialized = true;
}

function providedSecret(req) {
  return req.headers['x-admin-secret']
    || req.body?.admin_secret
    || req.body?.adminSecret
    || null;
}

/**
 * Phase 2-A3: Helper that callers can use to short-circuit with a clean
 * 403 response in production-disabled mode. Returns null when no guard
 * is needed (devnet, or production with override).
 */
function productionBlockResponse() {
  return productionSecretGuard();
}

/**
 * 验证 credit 类 admin secret（资金/状态变更）
 * @returns {boolean}
 */
function verifyCreditSecret(req) {
  if (productionSecretGuard()) return false;
  init();
  const provided = providedSecret(req);
  return provided !== null && provided === _creditSecret;
}

/**
 * 验证 bypass 类 admin secret（任务/投票免签）
 * @returns {boolean}
 */
function verifyBypassSecret(req) {
  if (productionSecretGuard()) return false;
  init();
  const provided = providedSecret(req);
  return provided !== null && provided === _bypassSecret;
}

/**
 * 验证任一 admin secret（向后兼容入口）
 * @returns {{ valid: boolean, kind: 'credit'|'bypass'|null, error?: string, error_code?: string }}
 */
function verifyAnySecret(req) {
  const guard = productionSecretGuard();
  if (guard) return { valid: false, kind: null, ...guard };
  init();
  if (verifyCreditSecret(req)) return { valid: true, kind: 'credit' };
  if (verifyBypassSecret(req)) return { valid: true, kind: 'bypass' };
  return { valid: false, kind: null };
}

/**
 * 健康检查：返回当前 secret 来源（不返回 secret 值）
 */
function describe() {
  init();
  return {
    creditSecretSet: !!process.env[ENV_CREDIT] || !!process.env[ENV_LEGACY],
    bypassSecretSet: !!process.env[ENV_BYPASS] || !!process.env[ENV_LEGACY],
    usingDefaultDevSecret: _creditSecret === DEFAULT_DEV_SECRET || _bypassSecret === DEFAULT_DEV_SECRET,
    production: isProduction(),
    adminSecretAllowedInProduction: adminSecretAllowedInProduction(),
    adminSecretEffectivelyEnabled: !isProduction() || adminSecretAllowedInProduction()
  };
}

export {
  verifyCreditSecret,
  verifyBypassSecret,
  verifyAnySecret,
  init,
  describe,
  productionBlockResponse,
  adminSecretAllowedInProduction,
  isProduction
};

export default {
  verifyCreditSecret,
  verifyBypassSecret,
  verifyAnySecret,
  init,
  describe,
  productionBlockResponse,
  adminSecretAllowedInProduction,
  isProduction
};

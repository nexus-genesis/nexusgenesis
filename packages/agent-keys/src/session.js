/**
 * nexusgenesis-agent-keys — Session Keys (bounded-risk agent authorization)
 *
 * Session Keys sit between the Operation Key (Level 1, full agent authority)
 * and the Custody Token (Level 2, 24h authentication). A Session Key is a
 * short-lived, constrained authorization that a human grants to an agent for
 * a specific scope — e.g., "swap on Uniswap, max 100 USDC per tx, max 500
 * USDC per day, valid for 7 days".
 *
 * KEY HIERARCHY (extended from takeover.js)
 * ------------------------------------------
 *   Level 0: Master Key (cold, human-held, never online)
 *   Level 1: Operation Key (agent-held, full spend authority)
 *   Level 1.5: Session Key (derived, limited scope, short-lived) <- NEW
 *   Level 2: Custody Token (24h auth, bound to pubkey fingerprint)
 *
 * DESIGN
 * ------
 * A Session Key is issued by a human (via the master key or an existing op
 * key) and encodes a 5-dimension permission scope plus a TTL. The session
 * key itself is a signed JWT-like token that the agent presents alongside
 * each transaction. The signer process (or any verifier) checks:
 *   1. Is the session key still valid (not expired)?
 *   2. Is the requested operation within the session's scope?
 *   3. Is the cumulative spend within the session's daily limit?
 *
 * USAGE
 * -----
 *   import { createSessionKey, checkSessionAccess } from 'nexusgenesis-agent-keys';
 *
 *   // Human issues a session key to an agent
 *   const session = createSessionKey(masterKey, {
 *     agentId: 'my-agent-01',
 *     allowedContracts: ['0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'],
 *     allowedMethods: ['swap'],
 *     allowedChains: ['ethereum'],
 *     maxPerTx: '100',
 *     maxDaily: '500',
 *     ttl: 7 * 24 * 60 * 60 * 1000  // 7 days
 *   });
 *
 *   // Verifier checks before each operation. verifySessionAccess() checks the
 *   // issuer's signature BEFORE evaluating scope, so a fabricated session
 *   // object cannot reach the scope checks at all.
 *   const result = await verifySessionAccess(session, issuerPublicKey, {
 *     contract: '0x1f9840...',
 *     method: 'swap',
 *     chain: 'ethereum',
 *     amount: '50'
 *   });
 *   // ^^ if (result.allowed) { then proceed }
 *   //
 *   // checkSessionAccess() is the scope check on its own, with no signature
 *   // verification. It answers "would this scope permit the operation", which
 *   // is not the same as "may this caller do it": a forged session with an
 *   // empty (unrestricted) scope returns allowed: true. Only use it when the
 *   // signature has already been established by other means.
 *
 * SECURITY NOTES
 * --------------
 *   - The session key token is signed with the issuer's master key, so it
 *     cannot be forged without the master key.
 *   - The session key does NOT contain the issuer's private key -- it only
 *     contains the scope + TTL + signature.
 *   - The agent presents the session key alongside each signed transaction.
 *   - The verifier (signer process or smart contract) checks the signature
 *     and scope before accepting the transaction.
 *   - Cumulative daily spend tracking is the verifier's responsibility
 *     (not implemented in this module; the signer process tracks it).
 */

import { signSync, verify } from './pqc.js';

// --- Constants ---------------------------------------------------------------
const SESSION_KEY_VERSION = 1;
const MIN_TTL_MS = 60 * 1000;          // 1 minute
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

// --- Session Key Creation ----------------------------------------------------

/**
 * Create a session key.
 *
 * A session key is a signed authorization token that grants a limited-scope,
 * time-bound signing authority to an agent. The issuer signs the scope with
 * their master key or operation key.
 *
 * @param {Buffer} issuerKey - The issuer's private key (master key or op key)
 * @param {object} params
 * @param {string} params.agentId - The agent that will use this session key
 * @param {string[]} [params.allowedContracts] - Contract address whitelist
 * @param {string[]} [params.allowedMethods] - Method whitelist (e.g., ['swap', 'transfer'])
 * @param {string[]} [params.allowedChains] - Chain whitelist (e.g., ['ethereum', 'polygon'])
 * @param {string} [params.maxPerTx] - Maximum per transaction (string, for BigInt precision)
 * @param {string} [params.maxDaily] - Maximum daily total (string, for BigInt precision)
 * @param {number} params.ttl - Time-to-live in milliseconds (from issuance)
 * @returns {object} session key token
 */
export function createSessionKey(issuerKey, {
  agentId,
  allowedContracts,
  allowedMethods,
  allowedChains,
  maxPerTx,
  maxDaily,
  ttl,
  issuedAt,
  expiresAt,
} = {}) {
  // -- Validation -----------------------------------------------------------
  if (!issuerKey || !Buffer.isBuffer(issuerKey) && typeof issuerKey !== 'string') {
    throw new TypeError('issuerKey must be a Buffer or hex string');
  }
  if (!agentId || typeof agentId !== 'string') {
    throw new TypeError('agentId is required');
  }
  if (!ttl || typeof ttl !== 'number' || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) {
    throw new RangeError(`ttl must be between ${MIN_TTL_MS}ms and ${MAX_TTL_MS}ms`);
  }

  const issuerKeyBuf = Buffer.isBuffer(issuerKey) ? issuerKey : Buffer.from(issuerKey, 'hex');

  // -- Build scope payload --------------------------------------------------
  const issuedAtMs = issuedAt === undefined ? Date.now() : Number(issuedAt);
  const expiresAtMs = expiresAt === undefined ? (issuedAtMs + ttl) : Number(expiresAt);
  if (!Number.isFinite(issuedAtMs) || issuedAtMs <= 0) {
    throw new RangeError('issuedAt must be a positive timestamp');
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    throw new RangeError('expiresAt must be greater than issuedAt');
  }
  if (expiresAtMs - issuedAtMs !== ttl) {
    throw new RangeError('expiresAt must equal issuedAt + ttl');
  }

  const scope = {
    version: SESSION_KEY_VERSION,
    agentId,
    issuedAt: issuedAtMs,
    expiresAt: expiresAtMs,
    allowedContracts: allowedContracts || [],
    allowedMethods: allowedMethods || [],
    allowedChains: allowedChains || [],
    maxPerTx: maxPerTx || '0',
    maxDaily: maxDaily || '0'
  };

  // -- Sign the scope ------------------------------------------------------
  const payload = JSON.stringify(scope);
  const signature = signSync(payload, issuerKeyBuf);

  return {
    type: 'session_key',
    ...scope,
    signature: signature.toString('hex')
  };
}

// --- Monotonic Narrowing (权限只降不升) --------------------------------------
//
// Rigid rule: once a session key is issued, any session derived from it may
// only NARROW privileges — never widen them. A derived session that asks for
// a contract/method/chain outside the parent scope, a higher maxPerTx /
// maxDaily, or a later expiry is rejected outright. This prevents a
// compromised agent from "re-issuing itself" broader permissions.

/**
 * Check whether `child` array is a subset of `parent` array.
 * Empty parent array means "unrestricted" (everything allowed).
 */
function isSubsetOrUnrestricted(child, parent) {
  if (!parent || parent.length === 0) return true;   // parent unrestricted
  if (!child || child.length === 0) return false;    // child unrestricted = widening
  const parentSet = new Set(parent);
  return child.every(item => parentSet.has(item));
}

/**
 * Check whether a child numeric limit narrows (or equals) the parent's.
 * '0' means "no limit" — a child limit of '0' under a limited parent is
 * an escalation and must be rejected.
 */
function isNarrowerOrEqual(childVal, parentVal) {
  let c, p;
  try {
    c = BigInt(childVal ?? '0');
    p = BigInt(parentVal ?? '0');
  } catch {
    return false;
  }
  if (p === 0n) return true;      // parent unlimited → any child limit ok
  if (c === 0n) return false;     // child unlimited under limited parent = widening
  return c <= p;
}

/**
 * Derive a NARROWED session key from an existing one.
 *
 * Enforces monotonic privilege reduction:
 *   - agentId must match the parent
 *   - parent must not be expired
 *   - contract/method/chain whitelists must be subsets of the parent's
 *   - maxPerTx / maxDaily must be ≤ the parent's (never '0' under a limit)
 *   - expiry clamped to the parent's expiry (never later)
 *
 * @param {object} parentSession - The parent session key token
 * @param {object} narrower - Requested scope (same shape as createSessionKey)
 * @param {Buffer|string} issuerKey - Master key that re-signs the narrowed session
 * @returns {object} new (narrower) session key token
 * @throws {Error} if the requested scope widens any dimension
 */
export function narrowSession(parentSession, narrower, issuerKey) {
  if (!parentSession || parentSession.type !== 'session_key') {
    throw new TypeError('parentSession must be a session key token');
  }
  if (Date.now() >= parentSession.expiresAt) {
    throw new Error('parent session is expired — cannot derive');
  }
  if (narrower.agentId !== parentSession.agentId) {
    throw new Error('agentId mismatch — derived session must keep the parent agentId');
  }

  // Dimension resolution: an OMITTED dimension inherits the parent's value
  // (equal scope — not a widening). An EXPLICIT empty array / '0' means
  // "unrestricted", which under a limited parent IS a widening and throws.
  const resolve = (key) =>
    Object.prototype.hasOwnProperty.call(narrower, key) ? narrower[key] : parentSession[key];

  // Whitelist subsets
  for (const dim of ['allowedContracts', 'allowedMethods', 'allowedChains']) {
    const child = resolve(dim) || [];
    const parent = parentSession[dim] || [];
    if (!isSubsetOrUnrestricted(child, parent)) {
      throw new Error(`${dim} widening rejected: session keys may only narrow privileges`);
    }
  }

  // Numeric ceilings
  for (const field of ['maxPerTx', 'maxDaily']) {
    if (!isNarrowerOrEqual(resolve(field) ?? '0', parentSession[field] || '0')) {
      throw new Error(`${field} widening rejected: session keys may only narrow privileges`);
    }
  }

  // Expiry: clamp to parent expiry — never later
  const now = Date.now();
  const parentRemainingMs = parentSession.expiresAt - now;
  const requestedTtl = typeof narrower.ttl === 'number' ? narrower.ttl : parentRemainingMs;
  const ttl = Math.min(requestedTtl, parentRemainingMs);
  const expiresAt = Math.min(parentSession.expiresAt, now + ttl);

  return createSessionKey(issuerKey, {
    agentId: parentSession.agentId,
    allowedContracts: resolve('allowedContracts'),
    allowedMethods: resolve('allowedMethods'),
    allowedChains: resolve('allowedChains'),
    maxPerTx: resolve('maxPerTx'),
    maxDaily: resolve('maxDaily'),
    ttl,
    issuedAt: now,
    expiresAt,
  });
}

// --- Access Control ----------------------------------------------------------

/**
 * Check whether a proposed operation is allowed under a session key.
 *
 * @param {object} session - The session key token (from createSessionKey)
 * @param {object} context
 * @param {string} [context.contract] - Target contract address to check
 * @param {string} [context.method] - Method to check
 * @param {string} [context.chain] - Chain to check
 * @param {string} [context.amount] - Transaction amount (string, for BigInt)
 * @param {string} [context.spentToday] - Amount already spent today (string)
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkSessionAccess(session, context = {}) {
  // NOTE: every return below carries `signatureVerified: false`. This function
  // never checks a signature, and a caller that logs or forwards its result
  // should be able to see that from the result itself rather than from the
  // documentation. Use verifySessionAccess() to make an authorization decision.
  // -- Structural validation -------------------------------------------------
  if (!session || session.type !== 'session_key') {
    return { allowed: false, reason: 'Not a session key', signatureVerified: false };
  }

  // -- Expiry check ---------------------------------------------------------
  if (session.expiresAt && Date.now() > session.expiresAt) {
    return { allowed: false, reason: 'Session key expired', signatureVerified: false };
  }

  // -- Contract whitelist ---------------------------------------------------
  if (context.contract && session.allowedContracts && session.allowedContracts.length > 0) {
    const match = session.allowedContracts.some(
      c => c.toLowerCase() === context.contract.toLowerCase()
    );
    if (!match) {
      return { allowed: false, reason: `Contract ${context.contract} not in session key whitelist` };
    }
  }

  // -- Method whitelist -----------------------------------------------------
  if (context.method && session.allowedMethods && session.allowedMethods.length > 0) {
    const match = session.allowedMethods.some(
      m => m.toLowerCase() === context.method.toLowerCase()
    );
    if (!match) {
      return { allowed: false, reason: `Method ${context.method} not in session key whitelist` };
    }
  }

  // -- Chain whitelist ------------------------------------------------------
  if (context.chain && session.allowedChains && session.allowedChains.length > 0) {
    const match = session.allowedChains.some(
      c => c.toLowerCase() === context.chain.toLowerCase()
    );
    if (!match) {
      return { allowed: false, reason: `Chain ${context.chain} not in session key whitelist` };
    }
  }

  // -- Amount limits --------------------------------------------------------
  if (context.amount !== undefined && context.amount !== null) {
    // SECURITY FIX: malformed amounts ('abc', '1.5', NaN, objects) previously
    // threw an uncaught SyntaxError out of this function, crashing callers.
    // They are now rejected as a normal denial. Empty/whitespace strings are
    // also rejected: V8's BigInt('') silently returns 0n, which would let a
    // malformed "0" sneak past limit checks as a legitimate zero-value call.
    const amountRaw = typeof context.amount === 'string' ? context.amount.trim() : context.amount;
    if (amountRaw === '' ) {
      return { allowed: false, reason: 'invalid amount: empty string', signatureVerified: false };
    }
    const spentRaw = typeof context.spentToday === 'string' ? context.spentToday.trim() : context.spentToday;
    if (spentRaw === '') {
      return { allowed: false, reason: 'invalid spentToday: empty string', signatureVerified: false };
    }
    let amount, spentToday = 0n;
    try {
      amount = BigInt(amountRaw);
      if (spentRaw !== undefined && spentRaw !== null) {
        spentToday = BigInt(spentRaw);
      }
    } catch {
      return { allowed: false, reason: 'invalid amount or spentToday: not an integer', signatureVerified: false };
    }
    if (amount < 0n) {
      return { allowed: false, reason: 'Amount must not be negative', signatureVerified: false };
    }
    if (spentToday < 0n) {
      return { allowed: false, reason: 'spentToday must not be negative', signatureVerified: false };
    }

    const maxPerTx = BigInt(session.maxPerTx || '0');
    if (maxPerTx > 0n && amount > maxPerTx) {
      return { allowed: false, reason: `Exceeds maxPerTx ${session.maxPerTx}` };
    }

    if (session.maxDaily) {
      const maxDaily = BigInt(session.maxDaily || '0');
      if (maxDaily > 0n && spentToday + amount > maxDaily) {
        return { allowed: false, reason: `Exceeds daily limit ${session.maxDaily}` };
      }
    }
  }

  return { allowed: true, signatureVerified: false };
}

// --- Signature Verification --------------------------------------------------

/**
 * Verify the session key's signature against the issuer's public key.
 * This validates that the session key was genuinely issued by the claimed
 * issuer and has not been tampered with.
 *
 * @param {object} session - The session key token
 * @param {Buffer} issuerPublicKey - The issuer's Dilithium2 public key
 * @returns {Promise<boolean>}
 */
export async function verifySessionSignature(session, issuerPublicKey) {
  if (!session || session.type !== 'session_key' || !session.signature) {
    return false;
  }

  // Reconstruct the signed payload (same fields as createSessionKey).
  const payload = JSON.stringify({
    version: session.version,
    agentId: session.agentId,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    allowedContracts: session.allowedContracts,
    allowedMethods: session.allowedMethods,
    allowedChains: session.allowedChains,
    maxPerTx: session.maxPerTx,
    maxDaily: session.maxDaily
  });

  const signature = Buffer.from(session.signature, 'hex');
  return verify(payload, signature, issuerPublicKey);
}

/**
 * Authorize an operation against a session key: verify the issuer's signature
 * FIRST, then evaluate scope. This is the function a verifier should call.
 *
 * `checkSessionAccess` deliberately performs no signature check, so on its own
 * it answers "would this scope permit the operation", not "may this caller do
 * it". Those are different questions, and a fabricated session object with an
 * empty (therefore unrestricted) scope answers the first one with `allowed:
 * true`. Anything making a security decision needs the second question, which
 * is what this function asks.
 *
 * @param {object} session - The session key token
 * @param {Buffer} issuerPublicKey - The issuer's ML-DSA-44 public key
 * @param {object} context - Same shape as {@link checkSessionAccess}
 * @returns {Promise<{ allowed: boolean, reason?: string, signatureVerified: boolean }>}
 */
export async function verifySessionAccess(session, issuerPublicKey, context = {}) {
  if (!issuerPublicKey) {
    return { allowed: false, reason: 'issuerPublicKey is required', signatureVerified: false };
  }
  const signatureVerified = await verifySessionSignature(session, issuerPublicKey);
  if (!signatureVerified) {
    return { allowed: false, reason: 'invalid session signature', signatureVerified: false };
  }
  return { ...checkSessionAccess(session, context), signatureVerified: true };
}

// --- Utility -----------------------------------------------------------------

/**
 * Get the remaining time-to-live for a session key (in milliseconds).
 * Returns 0 if already expired.
 * @param {object} session
 * @returns {number}
 */
export function getSessionTTL(session) {
  if (!session || !session.expiresAt) return 0;
  const remaining = session.expiresAt - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Check whether a session key is expired.
 * @param {object} session
 * @returns {boolean}
 */
export function isSessionExpired(session) {
  return getSessionTTL(session) <= 0;
}

export default {
  createSessionKey,
  checkSessionAccess,
  verifySessionAccess,
  verifySessionSignature,
  getSessionTTL,
  isSessionExpired
};

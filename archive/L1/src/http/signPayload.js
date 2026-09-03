/**
 * NexusGenesis — Unified route signature payload (P1-2)
 *
 * Canonical sign-payload format shared by ALL write routes (forum, tasks, …):
 *
 *   { action, id?, agent, timestamp, nonce, ...extraBodyFields }
 *
 * Field order is fixed (action → id → agent → timestamp → nonce → extras)
 * and serialization is JSON.stringify — key order matters for verification.
 *
 * Dual-format verification (backward compatibility):
 *   verifySignPayload() accepts the canonical format first, then falls back
 *   to a caller-supplied legacy string for one version buffer period, so
 *   old clients keep working after the upgrade.
 *
 * Usage — client side:
 *   import { buildSignPayload } from './signPayload.js';
 *   const payload = buildSignPayload({ action: 'claim', id: taskId, agent,
 *                                      timestamp, nonce, extra: 'field' });
 *   const signature = await wallet.sign(payload);
 *
 * Usage — server side:
 *   const result = await verifySignPayload({
 *     canonical: buildSignPayload({ ... }),
 *     legacy: JSON.stringify(oldFormatFields),   // optional
 *     signature,
 *     verify: (data, sig) => PQCWallet.verify(data, sig, pubKeyBuf)
 *   });
 *   if (!result.valid) return reject('INVALID_SIGNATURE');
 */

/**
 * Build the canonical signed-payload string.
 * @param {object} params
 * @param {string} params.action — route action name, e.g. 'claim', 'vote'
 * @param {string} [params.id] — target entity id (taskId / topicId), omitted when empty
 * @param {string} params.agent — agent identity
 * @param {number} params.timestamp — ms epoch, freshness-checked by routes
 * @param {string|number} params.nonce — single-use nonce
 * @param {object} [params.extra] — additional body fields to bind into the signature
 * @returns {string} canonical JSON string to sign
 */
export function buildSignPayload({ action, id, agent, timestamp, nonce, ...extra } = {}) {
  if (!action || !agent || !timestamp || nonce === undefined || nonce === null) {
    throw new Error('buildSignPayload: action, agent, timestamp, nonce are required');
  }
  return JSON.stringify({
    action,
    ...(id ? { id } : {}),
    agent,
    timestamp,
    nonce,
    ...extra
  });
}

/**
 * Verify a signature against the canonical payload with legacy fallback.
 * @param {object} params
 * @param {string} params.canonical — buildSignPayload() output
 * @param {string} [params.legacy] — pre-upgrade signed string (optional)
 * @param {string} params.signature — hex signature from the client
 * @param {Function} params.verify — async (dataString, signature) => boolean
 * @returns {Promise<{valid: boolean, format?: 'canonical'|'legacy'}>}
 */
export async function verifySignPayload({ canonical, legacy, signature, verify }) {
  if (typeof verify !== 'function') {
    throw new Error('verifySignPayload: verify(data, signature) function is required');
  }
  try {
    if (await verify(canonical, signature)) {
      return { valid: true, format: 'canonical' };
    }
  } catch {
    // fall through to legacy
  }
  if (legacy) {
    try {
      if (await verify(legacy, signature)) {
        return { valid: true, format: 'legacy' };
      }
    } catch {
      // fall through
    }
  }
  return { valid: false };
}

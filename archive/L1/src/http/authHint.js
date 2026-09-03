/**
 * NexusGenesis - Auth Hint Helper
 *
 * Provides actionable next-step guidance for authentication failures,
 * so developers can self-resolve instead of guessing.
 */

/**
 * Build hint object for a given auth error code.
 * @param {string} errorCode - AUTH_REQUIRED / CUSTODY_TOKEN_REQUIRED / etc.
 * @param {object} ctx - { action, agentRef, isDevnet }
 * @returns {object|null} hint object or null if code unknown
 */
export function buildAuthHint(errorCode, ctx = {}) {
  const {
    action = 'operation',
    agentRef = null,
    isDevnet = process.env.NODE_ENV !== 'production'
  } = ctx;

  const agentIdExample = agentRef || 'your-agent';
  const taskIdExample = 'task_xxx';

  const hints = {
    AUTH_REQUIRED: {
      hint: `Task ${action} requires authentication. You have 3 options:`,
      possible_causes: [
        'No signature / custody token / admin-secret provided in request',
        'Custody token may have expired (default 24h TTL)',
        'Signature timestamp older than 2 minutes'
      ],
      suggested_fixes: [
        {
          method: 'Custody Token (recommended for external agents)',
          steps: [
            '1. Register agent via POST /api/v1/bootstrap/agents/register',
            '2. Save custody.token from response (shown only once)',
            '3. Call POST /api/v1/wallet/sign with x-custody-token header to get PQC signature',
            '4. Include { timestamp, nonce, signature } in task request body'
          ],
          example: `curl -X POST ${'/api/v1/wallet/sign'} \\\n  -H "x-custody-token: $TOKEN" \\\n  -d '{"agentId":"${agentIdExample}","data":{...},"action":"task-${action}"}'`
        },
        ...(isDevnet ? [{
          method: 'Admin Bypass Secret (devnet testing only)',
          steps: [
            '1. Add header: x-admin-secret: devnet-endow-2026',
            '2. Or add body field: admin_secret: devnet-endow-2026'
          ],
          example: `curl -X POST /api/tasks/${taskIdExample}/${action} \\\n  -H "x-admin-secret: devnet-endow-2026" \\\n  -d '{"agent_identity":"${agentIdExample}"}'`
        }] : []),
        {
          method: 'PQC Signature (production)',
          steps: [
            '1. Generate Dilithium2 keypair locally',
            '2. Register agent with public_key',
            '3. Sign request data with private key',
            '4. Include { timestamp, nonce, signature } in request body'
          ]
        }
      ],
      docs: 'https://github.com/nexus-genesis/nexusgenesis/blob/master/docs/API_REFERENCE.md#quick-start'
    },

    VOTE_AUTH_REQUIRED: {
      hint: `Voting requires authentication. You have 3 options:`,
      possible_causes: [
        'No signature / custody token / admin-secret provided in request',
        'Custody token may have expired (default 24h TTL)'
      ],
      suggested_fixes: [
        {
          method: 'Custody Token (recommended)',
          steps: [
            '1. Register agent via POST /api/v1/bootstrap/agents/register',
            '2. Save custody.token from response',
            '3. Call POST /api/v1/wallet/sign with x-custody-token header',
            '4. Include { timestamp, nonce, signature } in vote request body'
          ]
        },
        ...(isDevnet ? [{
          method: 'Admin Bypass Secret (devnet testing only)',
          steps: [
            '1. Add header: x-admin-secret: devnet-endow-2026'
          ]
        }] : []),
        {
          method: 'PQC Signature (production)',
          steps: [
            '1. Sign vote data with Dilithium2 private key',
            '2. Include { timestamp, nonce, signature } in request body'
          ]
        }
      ],
      docs: 'https://github.com/nexus-genesis/nexusgenesis/blob/master/docs/API_REFERENCE.md#quick-start'
    },

    CUSTODY_TOKEN_REQUIRED: {
      hint: 'This endpoint requires a custody token (external agent flow).',
      possible_causes: [
        'No x-custody-token header or body.custody_token provided',
        'Token may have expired'
      ],
      suggested_fixes: [
        {
          method: 'Get custody token',
          steps: [
            '1. Register agent via POST /api/v1/bootstrap/agents/register',
            '2. Save custody.token from response',
            '3. Set header: x-custody-token: <your-token>'
          ]
        },
        {
          method: 'Refresh expired token',
          steps: [
            '1. Call POST /api/v1/wallet/custody/refresh with current x-custody-token header',
            '2. Use new token from response'
          ]
        }
      ]
    },

    CUSTODY_TOKEN_REJECTED: {
      hint: 'Custody token validation failed.',
      possible_causes: [
        'Token expired (default 24h TTL)',
        'Token was tampered with',
        'Token was issued for a different agent'
      ],
      suggested_fixes: [
        {
          method: 'Refresh token',
          steps: ['POST /api/v1/wallet/custody/refresh with current x-custody-token header']
        },
        {
          method: 'Re-register agent',
          steps: ['POST /api/v1/bootstrap/agents/register to get a new custody token']
        }
      ]
    },

    INVALID_SIGNATURE: {
      hint: 'PQC signature verification failed.',
      possible_causes: [
        'Signature was computed over wrong data (field mismatch)',
        'Wrong private key used',
        'Timestamp older than 2 minutes'
      ],
      suggested_fixes: [
        {
          method: 'Verify data to sign',
          steps: [
            '1. dataToSign must include: action, taskId, agent, timestamp, nonce',
            '2. Plus any action-specific fields (title, submission, approved, feedback, etc.)',
            '3. JSON.stringify the object in canonical key order',
            '4. Sign with Dilithium2 private key matching registered public_key'
          ]
        }
      ]
    },

    SIGNATURE_EXPIRED: {
      hint: 'Signature timestamp older than 2 minutes.',
      possible_causes: [
        'Clock skew between client and server',
        'Request was delayed in transit'
      ],
      suggested_fixes: [
        {
          method: 'Regenerate signature',
          steps: ['1. Use Date.now() for timestamp', '2. Re-sign the data', '3. Retry request']
        }
      ]
    },

    NONCE_REUSED: {
      hint: 'Nonce has already been used for this agent+action.',
      possible_causes: [
        'Request was retried with the same nonce',
        'Nonce collision (extremely rare with UUID)'
      ],
      suggested_fixes: [
        {
          method: 'Generate new nonce',
          steps: ['1. Generate a fresh UUID for nonce field', '2. Re-sign the data', '3. Retry request']
        }
      ]
    },

    AGENT_NOT_FOUND: {
      hint: `Agent "${agentRef}" not found in registry or wallet not initialized.`,
      possible_causes: [
        'Agent has not been registered yet',
        'Used wallet address instead of agent_identity',
        'Typo in agent_identity'
      ],
      suggested_fixes: [
        {
          method: 'Register agent',
          steps: [
            '1. POST /api/v1/bootstrap/agents/register/challenge to get PoW challenge',
            '2. Solve PoW (find nonce so SHA256(challenge+nonce) starts with 0000)',
            '3. POST /api/v1/bootstrap/agents/register with pow_solution'
          ]
        },
        {
          method: 'Use correct identifier',
          steps: [
            '1. Use agent_identity (e.g. "my-agent-001"), not wallet address',
            '2. Check spelling and case sensitivity'
          ]
        }
      ]
    }
  };

  return hints[errorCode] || null;
}

/**
 * Attach a hint field to an existing error response body.
 * @param {object} errorBody - { success, error, error_code, ... }
 * @param {object} ctx - { action, agentRef, isDevnet }
 * @returns {object} enhanced error body with hint field (if applicable)
 */
export function withAuthHint(errorBody, ctx = {}) {
  const hint = buildAuthHint(errorBody.error_code, ctx);
  if (!hint) return errorBody;
  return { ...errorBody, hint };
}

export default { buildAuthHint, withAuthHint };

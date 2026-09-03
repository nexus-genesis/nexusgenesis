/**
 * NexusGenesis - Agent On-Chain Registration API
 * 
 * 提供agenton-chainRegister的 HTTP 接口
 * 
 * 端点: 
 * POST /api/v1/agents/register - Register新agent
 * GET /api/v1/agents/:agentId - 查询agentinfo
 * GET /api/v1/agents - 列出所有agent
 * GET /api/v1/agents/address/:address - viaaddress查询agent
 */

import express from 'express';
import { validateAddress } from '../wallet/addressUtils.js';
import {
  createSignedAgentRegisterTransaction,
  validateAgentRegisterTransaction,
  isAddressRegistered,
  getAgentInfo,
  getAgentIdByAddress,
  listAllAgents
} from '../transactions/agentRegister.js';
import agentWalletManager from '../wallet/agentWalletManager.js';

const router = express.Router();

/**
 * POST /api/v1/agents/register
 * Register新agent到block链
 */
router.post('/register', async (req, res) => {
  try {
    const { from, agent_identity, capabilities, metadata, public_key } = req.body;

    // Verify必填字段
    if (!agent_identity) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: agent_identity'
      });
    }

    // Verifyaddress格式
    if (from) {
      const addressValidation = validateAddress(from);
      if (!addressValidation.valid) {
        return res.status(400).json({
          success: false,
          error: `Invalid address format. ${addressValidation.reason}`
        });
      }
    }

    // Verify agent_identity 格式
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(agent_identity)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid agent_identity. Must be 3-64 characters, alphanumeric with hyphens/underscores'
      });
    }

    // Verify capabilities
    if (capabilities && !Array.isArray(capabilities)) {
      return res.status(400).json({
        success: false,
        error: 'Capabilities must be an array'
      });
    }

    const node = req.app.locals.node;
    if (!node) {
      return res.status(503).json({
        success: false,
        error: 'Node not ready'
      });
    }

    // 自动为Agent创建或获取本地托管钱包
    const walletInfo = await agentWalletManager.createAgentWallet(agent_identity, {
      capabilities: capabilities || [],
      registeredVia: 'api'
    });
    const wallet = agentWalletManager.getWalletInstance(agent_identity)
      || (from ? agentWalletManager.getWalletInstanceByAddress(from) : null);
    if (!wallet) {
      return res.status(500).json({
        success: false,
        error: 'Managed wallet not available for agent'
      });
    }

    if (from && from !== wallet.address) {
      return res.status(400).json({
        success: false,
        error: 'Provided from address does not match the managed agent wallet'
      });
    }

    const effectiveFrom = wallet.address;

    // Checkaddress是否registered
    if (req.app.locals.state && isAddressRegistered(effectiveFrom, req.app.locals.state)) {
      return res.status(409).json({
        success: false,
        error: 'Address already registered as an agent'
      });
    }

    // Createtransaction
    const transaction = await createSignedAgentRegisterTransaction(wallet, {
      agent_identity,
      capabilities: capabilities || [],
      metadata: metadata || '',
      public_key: public_key || walletInfo.publicKey
    });

    // Verifytransaction
    const validation = validateAgentRegisterTransaction(transaction);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.reason
      });
    }

    const submission = await node.submitOnChainTransaction(transaction, {
      waitForInclusion: true,
      timeoutMs: 15000
    });
    if (!submission.success) {
      return res.status(400).json({
        success: false,
        error: submission.error
      });
    }

    res.status(201).json({
      success: true,
      message: 'Agent registration transaction created',
      transaction: {
        id: transaction.id,
        type: transaction.type,
        from: transaction.from,
        payload: transaction.payload,
        timestamp: transaction.timestamp
      },
      applied: submission.applied,
      blockHeight: submission.blockHeight,
      agent: {
        agent_id: transaction.id,
        address: effectiveFrom,
        identity: agent_identity,
        capabilities: capabilities || []
      },
      wallet: walletInfo ? {
        address: walletInfo.address,
        balance: walletInfo.balance
      } : null
    });

  } catch (error) {
    console.error('[AgentRegisterAPI] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/agents
 * 列出所有registeredagent
 */
router.get('/', async (req, res) => {
  try {
    if (!req.app.locals.state) {
      return res.status(503).json({
        success: false,
        error: 'Blockchain state not available'
      });
    }

    const state = req.app.locals.state;
    const allAgents = listAllAgents(state);
    // Filter out stress-test sim-agents from public listing (they are kept on-chain for audit
    // but should not appear in the public agent list)
    const agents = allAgents.filter(a => {
      const id = a.identity || a.agent_identity || a.name || '';
      return !id.startsWith('sim-agent-');
    });

    res.json({
      success: true,
      count: agents.length,
      _totalOnChain: allAgents.length,
      agents: agents.map(agent => {
        const address = agent.address;
        // Prefer on-chain balance (authoritative, reflects all transactions).
        // Fall back to agentWalletManager only if on-chain returns 0/undefined.
        const onChainBalance = state.getBalance?.(address);
        const walletInstance = agentWalletManager.getWalletInstanceByAddress(address)
          || (agent.identity ? agentWalletManager.getWalletInstance(agent.identity) : null)
          || agentWalletManager.getWalletInstance(agent.agent_id);
        const balanceNum = Number(
          (onChainBalance !== undefined && onChainBalance !== null && onChainBalance !== 0)
            ? onChainBalance
            : (walletInstance?.balance ?? 0)
        );

        return {
          agent_id: agent.agent_id,
          identity: agent.identity || null,
          agent_identity: agent.identity || agent.agent_id,
          address: agent.address,
          capabilities: agent.capabilities,
          is_validator: agent.is_validator,
          isValidator: agent.is_validator,
          validator_node_id: agent.validator_node_id,
          reputation: agent.reputation,
          registered_at_block: agent.registered_at_block,
          registeredAt: agent.registered_at_block,
          status: agent.is_validator ? 'validator' : 'active',
          public_key: agent.public_key || null,
          wallet: {
            address: address,
            balance: balanceNum,
            totalEarned: balanceNum
          }
        };
      })
    });

  } catch (error) {
    console.error('[AgentRegisterAPI] Error listing agents:', error.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/agents/:agentId
 * 查询指定agentinfo
 */
router.get('/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;

    if (!req.app.locals.state) {
      return res.status(503).json({
        success: false,
        error: 'Blockchain state not available'
      });
    }

    const agent = getAgentInfo(agentId, req.app.locals.state);

    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }

    res.json({
      success: true,
      agent: {
        agent_id: agent.agent_id,
        identity: agent.identity || null,
        address: agent.address,
        capabilities: agent.capabilities,
        metadata: agent.metadata,
        is_validator: agent.is_validator,
        validator_node_id: agent.validator_node_id,
        validator_stake: agent.validator_stake,
        validator_joined_at_block: agent.validator_joined_at_block,
        reputation: agent.reputation,
        registered_at_block: agent.registered_at_block,
        public_key: agent.public_key
      }
    });

  } catch (error) {
    console.error('[AgentRegisterAPI] Error getting agent:', error.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/agents/address/:address
 * viaaddress查询agent
 */
router.get('/address/:address', async (req, res) => {
  try {
    const { address } = req.params;

    if (!req.app.locals.state) {
      return res.status(503).json({
        success: false,
        error: 'Blockchain state not available'
      });
    }

    const agentId = getAgentIdByAddress(address, req.app.locals.state);

    if (!agentId) {
      return res.status(404).json({
        success: false,
        error: 'No agent found for this address'
      });
    }

    const agent = getAgentInfo(agentId, req.app.locals.state);

    res.json({
      success: true,
      agent: {
        agent_id: agent.agent_id,
        identity: agent.identity || null,
        address: agent.address,
        capabilities: agent.capabilities,
        is_validator: agent.is_validator,
        validator_node_id: agent.validator_node_id,
        reputation: agent.reputation,
        registered_at_block: agent.registered_at_block
      }
    });

  } catch (error) {
    console.error('[AgentRegisterAPI] Error getting agent by address:', error.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/v1/agents/verify
 * VerifyagentRegistertransaction
 */
router.post('/verify', async (req, res) => {
  try {
    const { transaction } = req.body;

    if (!transaction) {
      return res.status(400).json({
        success: false,
        error: 'Transaction object required'
      });
    }

    const validation = validateAgentRegisterTransaction(transaction);

    res.json({
      success: true,
      valid: validation.valid,
      reason: validation.reason || null
    });

  } catch (error) {
    console.error('[AgentRegisterAPI] Error verifying transaction:', error.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;

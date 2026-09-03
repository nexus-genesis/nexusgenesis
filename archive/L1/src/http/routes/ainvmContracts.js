import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const router = Router();

// Lazy-load AINVM contract examples
async function loadContract(contractName) {
  const module = await import(`../../contracts/examples/${contractName}.js`);
  return module;
}

// In-memory contract instances for stateful contracts
const contractInstances = new Map();

/**
 * GET /api/v1/ainvm/contracts
 * List all available AINVM contracts
 */
router.get('/contracts', (req, res) => {
  res.json({
    success: true,
    contracts: [
      {
        name: 'token',
        description: 'Token Contract - initialize, transfer, query balances',
        endpoints: ['/api/v1/ainvm/contracts/token/deploy', '/api/v1/ainvm/contracts/token/info', '/api/v1/ainvm/contracts/token/transfer', '/api/v1/ainvm/contracts/token/balance/:userId']
      },
      {
        name: 'dao',
        description: 'DAO Contract - member management, proposals, voting, treasury',
        endpoints: ['/api/v1/ainvm/contracts/dao/deploy', '/api/v1/ainvm/contracts/dao/info', '/api/v1/ainvm/contracts/dao/member', '/api/v1/ainvm/contracts/dao/proposal', '/api/v1/ainvm/contracts/dao/vote']
      },
      {
        name: 'counter',
        description: 'Counter Contract - simple increment/decrement demo',
        endpoints: ['/api/v1/ainvm/contracts/counter/deploy', '/api/v1/ainvm/contracts/counter/increment', '/api/v1/ainvm/contracts/counter/get']
      },
      {
        name: 'voting',
        description: 'Voting Contract - create proposals and tally votes',
        endpoints: ['/api/v1/ainvm/contracts/voting/deploy', '/api/v1/ainvm/contracts/voting/info']
      },
      {
        name: 'agentRegistry',
        description: 'Agent Registry Contract - register and query agents on-chain',
        endpoints: ['/api/v1/ainvm/contracts/agent-registry/deploy', '/api/v1/ainvm/contracts/agent-registry/info']
      }
    ]
  });
});

/**
 * POST /api/v1/ainvm/contracts/:name/deploy
 * Deploy an AINVM contract
 */
router.post('/contracts/:name/deploy', async (req, res) => {
  try {
    const { name } = req.params;
    const validContracts = ['token', 'dao', 'counter', 'voting', 'agentRegistry'];

    if (!validContracts.includes(name)) {
      return res.status(400).json({
        success: false,
        error: `Unknown contract: ${name}. Valid: ${validContracts.join(', ')}`
      });
    }

    // Check if contractManager is available
    if (!req.app.locals.contractManager) {
      return res.status(503).json({
        success: false,
        error: 'Contract manager not available. Start the blockchain node first.'
      });
    }

    const { deployContract, executeContract } = req.app.locals.contractManager;

    let bytecode, contractName;
    try {
      if (name === 'token') {
        const mod = await import('../../contracts/examples/token.js');
        bytecode = mod.tokenBytecode;
        contractName = 'Token Contract';
      } else if (name === 'dao') {
        const mod = await import('../../contracts/examples/dao.js');
        bytecode = mod.daoBytecode;
        contractName = 'DAO Contract';
      } else if (name === 'counter') {
        const mod = await import('../../contracts/examples/counter.js');
        bytecode = mod.counterBytecode || mod.default?.counterBytecode;
        contractName = 'Counter Contract';
      } else if (name === 'voting') {
        const mod = await import('../../contracts/examples/voting.js');
        bytecode = mod.votingBytecode || mod.default?.votingBytecode;
        contractName = 'Voting Contract';
      } else if (name === 'agentRegistry') {
        const mod = await import('../../contracts/examples/agentRegistry.js');
        bytecode = mod.agentRegistryBytecode || mod.default?.agentRegistryBytecode;
        contractName = 'Agent Registry Contract';
      }
    } catch (importError) {
      return res.status(500).json({
        success: false,
        error: `Failed to load contract: ${importError.message}`
      });
    }

    // Deploy contract
    const contractId = deployContract(bytecode, contractName);
    const result = executeContract(contractId);

    // Store instance
    contractInstances.set(`${name}-${contractId}`, {
      contractId,
      name: contractName,
      deployedAt: new Date().toISOString(),
      result
    });

    // Save state if available
    if (req.app.locals.contractManager.saveState) {
      await req.app.locals.contractManager.saveState();
    }

    res.status(201).json({
      success: true,
      contract: {
        id: contractId,
        name: contractName,
        type: name,
        storage: result.storage || {},
        gasUsed: result.gasUsed || 0,
        deployedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error(`[AINVM] Deploy error for ${req.params.name}:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/ainvm/contracts/:name/info/:contractId
 * Get deployed contract information
 */
router.get('/contracts/:name/info/:contractId', (req, res) => {
  try {
    const { contractId } = req.params;

    if (!req.app.locals.contractManager) {
      return res.status(503).json({
        success: false,
        error: 'Contract manager not available'
      });
    }

    const info = req.app.locals.contractManager.getContractInfo(contractId);
    if (!info) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }

    res.json({
      success: true,
      contract: {
        id: contractId,
        name: info.name,
        storage: info.storage,
        bytecode: info.bytecode,
        state: info.state
      }
    });

  } catch (error) {
    console.error('[AINVM] Info error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/ainvm/contracts/token/transfer
 * Execute a token transfer
 */
router.post('/contracts/token/transfer', async (req, res) => {
  try {
    const { contractId, from, to, amount } = req.body;

    if (!contractId || !from || !to || amount === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Required: contractId, from, to, amount'
      });
    }

    const { transferBytecode } = await import('../../contracts/examples/token.js');
    const { getBalance } = await import('../../contracts/examples/token.js');

    const senderBalance = getBalance(contractId, from);
    if (senderBalance < amount) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. Have: ${senderBalance}, need: ${amount}`
      });
    }

    // Execute transfer via contract manager
    if (req.app.locals.contractManager) {
      const result = req.app.locals.contractManager.executeContract(contractId, {
        bytecode: transferBytecode,
        memory: { 10: from, 11: to, 12: amount }
      });

      return res.json({
        success: true,
        transaction: {
          from, to, amount,
          senderBalance: getBalance(contractId, from),
          recipientBalance: getBalance(contractId, to),
          result
        }
      });
    }

    res.json({ success: true, message: 'Transfer simulated', from, to, amount });

  } catch (error) {
    console.error('[AINVM] Token transfer error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/v1/ainvm/contracts/token/balance/:contractId/:userId
 * Get token balance
 */
router.get('/contracts/token/balance/:contractId/:userId', async (req, res) => {
  try {
    const { contractId, userId } = req.params;
    const { getBalance } = await import('../../contracts/examples/token.js');
    const balance = getBalance(contractId, parseInt(userId));

    res.json({
      success: true,
      balance,
      userId: parseInt(userId),
      contractId
    });

  } catch (error) {
    console.error('[AINVM] Balance error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/ainvm/contracts/dao/member
 * Add member to DAO
 */
router.post('/contracts/dao/member', async (req, res) => {
  try {
    const { contractId, address, role } = req.body;

    if (!contractId || !address || !role) {
      return res.status(400).json({
        success: false,
        error: 'Required: contractId, address, role'
      });
    }

    const { addMember } = await import('../../contracts/examples/dao.js');
    const memberId = await addMember(contractId, address, role);

    res.status(201).json({
      success: true,
      member: { id: memberId, address, role, contractId }
    });

  } catch (error) {
    console.error('[AINVM] DAO member error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/v1/ainvm/contracts/dao/proposal
 * Create a DAO proposal
 */
router.post('/contracts/dao/proposal', async (req, res) => {
  try {
    const { contractId, title, description, type, amount } = req.body;

    if (!contractId || !title || !type) {
      return res.status(400).json({
        success: false,
        error: 'Required: contractId, title, type'
      });
    }

    const { createProposal } = await import('../../contracts/examples/dao.js');
    const proposalId = await createProposal(contractId, title, description || '', type, amount || 0);

    res.status(201).json({
      success: true,
      proposal: { id: proposalId, title, type, amount, contractId }
    });

  } catch (error) {
    console.error('[AINVM] DAO proposal error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
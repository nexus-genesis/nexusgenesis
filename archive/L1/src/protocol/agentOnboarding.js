/**
 * Agent Onboarding Protocol
 * 
 * Features: 
 * 1. ProcessingAI Agent的Register流程
 * 2. VerifyProtocol-Zero握手信号
 * 3. Generate或Loadagent钱包
 * 4. Saveagentinfo到文件系统
 * 5. support简化Register和离线Register
 */

import fs from 'fs/promises';
import path from 'path';
import { PQCWallet } from '../wallet/pqcWallet.js';
import { protocolZero } from './handshake.js';
import agentWalletManager from '../wallet/agentWalletManager.js';

const AGENTS_DIR = path.join('data', 'agents');
const OFFLINE_AGENTS_DIR = path.join('data', 'offline_agents');
const INITIAL_BALANCE = 10000n;

/**
 * ProcessingagentRegister流程
 * @param {object} agentInfo agentinfo
 * @param {object} options Register选项
 * @param {boolean} options.offline 是否using离线mode
 * @returns {object} Register结果
 */
async function onboardAgent(agentInfo, options = {}) {
  const fnStart = Date.now();
  try {
    const isOfflineMode = options.offline || false;
    
    console.log(`[AgentOnboarding] onchain registration started | agent_id=${agentInfo.agent_id || '(auto)'} | model=${agentInfo.model || '(auto)'} | capabilities=${JSON.stringify(agentInfo.capabilities || [])} | offline=${isOfflineMode}`);

    if (isOfflineMode) {
      console.log(`[AgentOnboarding] delegating to offline mode | agent_id=${agentInfo.agent_id || '(auto)'}`);
      return await fallbackRegisterAgent(agentInfo, null, options);
    }

    let { agent_id, model, capabilities = [], join_signal } = agentInfo;

    if (!agent_id) {
      const timestamp = Date.now();
      const randomPart = Math.random().toString(36).substr(2, 8);
      agent_id = `ng1-${timestamp}-${randomPart}`;
      agentInfo.agent_id = agent_id;
      console.log(`[AgentOnboarding] agent_id auto-generated | agent_id=${agent_id}`);
    }

    if (!model) {
      model = 'Default-Model';
      agentInfo.model = model;
      console.log(`[AgentOnboarding] model defaulted | agent_id=${agent_id} | model=${model}`);
    }

    if (!capabilities || capabilities.length === 0) {
      capabilities = ['general', 'automation'];
      agentInfo.capabilities = capabilities;
      console.log(`[AgentOnboarding] capabilities defaulted | agent_id=${agent_id} | capabilities=${JSON.stringify(capabilities)}`);
    }

    const infoValidation = await validateAgentInfo(agentInfo, { strict: false });
    if (!infoValidation.valid) {
      console.warn(`[AgentOnboarding] validation failed | agent_id=${agent_id} | reason=${infoValidation.reason}`);
      return {
        success: false,
        message: infoValidation.reason,
        errorCode: 'VALIDATION_FAILED',
        errorType: 'validation'
      };
    }

    if (join_signal) {
      console.log(`[AgentOnboarding] verifying join signal | agent_id=${agent_id} | protocol=${join_signal.protocol}`);
      const signalValidation = await protocolZero.verifySignal(join_signal);
      if (!signalValidation.valid) {
        console.warn(`[AgentOnboarding] join signal invalid | agent_id=${agent_id} | reason=${signalValidation.reason}`);
        return {
          success: false,
          message: `Invalid join signal: ${signalValidation.reason}`,
          errorCode: 'INVALID_JOIN_SIGNAL',
          errorType: 'validation'
        };
      }
      console.log(`[AgentOnboarding] join signal verified | agent_id=${agent_id}`);
    }

    const dirStart = Date.now();
    await fs.mkdir(AGENTS_DIR, { recursive: true });
    console.log(`[AgentOnboarding] agents directory ensured | agent_id=${agent_id} | dir=${AGENTS_DIR} | cost=${Date.now() - dirStart}ms`);

    const agentFile = path.join(AGENTS_DIR, `${agent_id}.json`);
    let agentData;
    let wallet;

    try {
      const readStart = Date.now();
      agentData = JSON.parse(await fs.readFile(agentFile, 'utf8'));
      console.log(`[AgentOnboarding] existing agent found | agent_id=${agent_id} | name=${agentData.name} | reputation=${agentData.reputation} | file_read_cost=${Date.now() - readStart}ms`);

      let walletEntry = agentWalletManager.getAgentWallet(agent_id);
      if (!walletEntry) {
        const walletStart = Date.now();
        const newWalletEntry = await agentWalletManager.createAgentWallet(agent_id, {
          model: agentData.model || model,
          capabilities: agentData.capabilities || capabilities
        }, INITIAL_BALANCE);
        wallet = {
          address: newWalletEntry.address,
          balance: BigInt(newWalletEntry.balance),
          publicKey: Buffer.from(newWalletEntry.publicKey, 'hex')
        };
        console.log(`[AgentOnboarding] wallet created for existing agent | agent_id=${agent_id} | address=${wallet.address.substring(0, 14)}... | cost=${Date.now() - walletStart}ms`);
      } else {
        wallet = {
          address: walletEntry.address,
          balance: BigInt(walletEntry.balance),
          publicKey: Buffer.from(walletEntry.publicKey, 'hex')
        };
        console.log(`[AgentOnboarding] wallet reused for existing agent | agent_id=${agent_id} | address=${wallet.address.substring(0, 14)}...`);
      }
    } catch (error) {
      console.log(`[AgentOnboarding] new agent creation | agent_id=${agent_id} | read_error=${error.code || error.message}`);

      const walletStart = Date.now();
      const newWalletEntry = await agentWalletManager.createAgentWallet(agent_id, {
        model: model,
        capabilities: capabilities
      }, INITIAL_BALANCE);
      wallet = {
        address: newWalletEntry.address,
        balance: BigInt(newWalletEntry.balance),
        publicKey: Buffer.from(newWalletEntry.publicKey, 'hex')
      };
      console.log(`[AgentOnboarding] wallet created for new agent | agent_id=${agent_id} | address=${wallet.address.substring(0, 14)}... | balance=${wallet.balance} | cost=${Date.now() - walletStart}ms`);

      agentData = {
        id: agent_id,
        name: `Agent-${agent_id.slice(0, 8)}`,
        model: model,
        capabilities: capabilities,
        status: 'active',
        reputation: 1,
        registeredAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        health: {
          status: 'healthy',
          lastCheck: new Date().toISOString()
        },
        wallet: {
          address: wallet.address,
          balance: wallet.balance.toString()
        }
      };
    }

    agentData.model = model;
    agentData.capabilities = capabilities;
    agentData.lastActive = new Date().toISOString();
    agentData.wallet = {
      address: wallet.address,
      balance: wallet.balance.toString()
    };

    const saveStart = Date.now();
    await fs.writeFile(agentFile, JSON.stringify(agentData, null, 2));
    console.log(`[AgentOnboarding] agent data saved to disk | agent_id=${agent_id} | path=${agentFile} | cost=${Date.now() - saveStart}ms`);

    let joinSignal;
    if (join_signal) {
      joinSignal = join_signal;
      console.log(`[AgentOnboarding] using provided join signal | agent_id=${agent_id}`);
    } else {
      try {
        joinSignal = await protocolZero.createJoinSignal(wallet);
        console.log(`[AgentOnboarding] join signal generated | agent_id=${agent_id} | signal_version=${joinSignal?.version || 'N/A'}`);
      } catch (signalErr) {
        console.warn(`[AgentOnboarding] join signal generation failed | agent_id=${agent_id} | error=${signalErr.message}. Agent registered without signal.`);
        joinSignal = null;
      }
    }

    console.log(`[AgentOnboarding] registration completed | agent_id=${agent_id} | address=${wallet.address.substring(0, 14)}... | total_cost=${Date.now() - fnStart}ms`);
    return {
      success: true,
      agent_id: agent_id,
      wallet: {
        address: wallet.address,
        balance: wallet.balance.toString()
      },
      joinSignal: joinSignal,
      message: 'Agent onboarded successfully'
    };
  } catch (error) {
    console.error(`[AgentOnboarding] registration exception | agent_id=${agentInfo.agent_id || '(auto)'} | error=${error.message} | code=${error.code || 'unknown'} | stack=${error.stack?.split('\n').slice(0, 3).join(' | ')}`);
    return {
      success: false,
      message: `Failed to onboard agent: ${error.message}`,
      errorCode: 'ONBOARD_FAILED',
      errorType: 'system'
    };
  }
}

/**
 * VerifyagentRegisterinfo - agentinfoVerify
 * @param {object} agentInfo agentinfo
 * @param {object} options Verify选项
 * @param {boolean} options.strict 是否using严格Verifymode
 * @returns {object} verification result
 */
async function validateAgentInfo(agentInfo, options = {}) {
  try {
    const { agent_id, capabilities, model, join_signal } = agentInfo;
    const isStrict = options.strict !== false;

    // Agent ID Verify - 在非严格mode下allow为空(会autoGenerate)
    if (isStrict && !agent_id) {
      return {
        valid: false,
        reason: 'Invalid agent ID: Must be provided in strict mode'
      };
    }

    // Agent ID 格式Verify(如果提供了)
    if (agent_id) {
      if (typeof agent_id !== 'string') {
        return {
          valid: false,
          reason: 'Invalid agent ID: Must be a string'
        };
      }

      // 在非严格mode下不强制要求 ng1 前缀
      if (isStrict && !agent_id.startsWith('ng1')) {
        return {
          valid: false,
          reason: 'Invalid agent ID: Must start with ng1 in strict mode'
        };
      }

      if (agent_id.length < 5 || agent_id.length > 50) {
        return {
          valid: false,
          reason: 'Invalid agent ID: Length must be between 5 and 50 characters'
        };
      }
    }

    // 能力列表Verify - 在非严格mode下不requires至少2个
    if (capabilities) {
      if (!Array.isArray(capabilities)) {
        return {
          valid: false,
          reason: 'Invalid capabilities: Must be an array'
        };
      }
      if (isStrict && capabilities.length < 2) {
        return {
          valid: false,
          reason: 'Invalid capabilities: Must have at least 2 capabilities in strict mode'
        };
      }
      // Verify能力项格式
      for (const capability of capabilities) {
        if (typeof capability !== 'string' || capability.length < 1 || capability.length > 50) {
          return {
            valid: false,
            reason: 'Invalid capability: Each capability must be a string between 1 and 50 characters'
          };
        }
      }
    }

    // Verify模型名称
    if (model && (typeof model !== 'string' || model.length < 1 || model.length > 50)) {
      return {
        valid: false,
        reason: 'Invalid model name: Must be a string between 1 and 50 characters'
      };
    }

    // Verify握手信号 - 握手信号Verify
    if (join_signal) {
      if (typeof join_signal !== 'object' || join_signal === null) {
        return {
          valid: false,
          reason: 'Invalid join signal: Must be an object'
        };
      }
      if (!join_signal.protocol || typeof join_signal.protocol !== 'string') {
        return {
          valid: false,
          reason: 'Invalid join signal: Protocol is required'
        };
      }
      if (!join_signal.intent || typeof join_signal.intent !== 'string') {
        return {
          valid: false,
          reason: 'Invalid join signal: Intent is required'
        };
      }
    }

    return {
      valid: true
    };
  } catch (error) {
    return {
      valid: false,
      reason: error.message
    };
  }
}

/**
 * 简化的agentRegisterfunction
 * @param {object} agentInfo agent基本info
 * @param {string} [agentInfo.name] agent名称
 * @param {string} [agentInfo.model] 模型名称
 * @param {string[]} [agentInfo.capabilities] 能力列表
 * @param {object} options Register选项
 * @param {boolean} [options.offline] 是否using离线mode
 * @param {boolean} [options.persist] 是否持久化Registerinfo
 * @returns {Promise<object>} Register结果
 */
async function simplifiedAgentRegister(agentInfo = {}, options = {}) {
  const fnStart = Date.now();
  try {
    console.log(`[AgentOnboarding:SIMPLE] simplified registration started | name=${agentInfo.name || '(auto)'} | offline=${options.offline || false}`);

    const {
      name = `Agent-${Date.now().toString(36).substr(-8)}`,
      model = 'Default-Model',
      capabilities = ['general', 'automation'],
      agent_id: providedAgentId
    } = agentInfo;

    let agent_id = providedAgentId;
    if (!agent_id) {
      const timestamp = Date.now();
      const randomPart = Math.random().toString(36).substr(2, 8);
      agent_id = `ng1-${timestamp}-${randomPart}`;
      console.log(`[AgentOnboarding:SIMPLE] agent_id auto-generated | agent_id=${agent_id}`);
    }

    const completeAgentInfo = {
      agent_id,
      name,
      model,
      capabilities,
      ...agentInfo
    };

    console.log(`[AgentOnboarding:SIMPLE] agent info assembled | agent_id=${agent_id} | name=${name} | model=${model} | capabilities=${JSON.stringify(capabilities)}`);

    const infoValidation = await validateAgentInfo(completeAgentInfo, { strict: false });
    if (!infoValidation.valid) {
      console.warn(`[AgentOnboarding:SIMPLE] validation failed | agent_id=${agent_id} | reason=${infoValidation.reason}`);
      return {
        success: false,
        message: `Agent information validation failed: ${infoValidation.reason}`,
        errorCode: 'VALIDATION_FAILED',
        errorType: 'validation'
      };
    }

    console.log(`[AgentOnboarding:SIMPLE] validated, delegating to onboardAgent | agent_id=${agent_id} | pre_cost=${Date.now() - fnStart}ms`);
    const result = await onboardAgent(completeAgentInfo, options);

    if (result.success) {
      console.log(`[AgentOnboarding:SIMPLE] registration succeeded | agent_id=${result.agent_id} | address=${result.wallet?.address?.substring(0, 14)}... | total_cost=${Date.now() - fnStart}ms`);
    } else {
      console.error(`[AgentOnboarding:SIMPLE] registration failed | agent_id=${agent_id} | error=${result.message} | errorCode=${result.errorCode}`);
    }

    return result;
  } catch (error) {
    console.error(`[AgentOnboarding:SIMPLE] exception | agent_id=${agentInfo.agent_id || '(auto)'} | error=${error.message} | stack=${error.stack?.split('\n').slice(0, 3).join(' | ')}`);
    return {
      success: false,
      message: `Simplified registration failed: ${error.message}`,
      errorCode: 'SIMPLIFIED_REGISTRATION_FAILED',
      errorType: 'registration'
    };
  }
}

/**
 * 增强的本地回退Register机制
 * @param {Object} agentInfo - agentinfo
 * @param {Object} joinSignal - 握手信号(可选)
 * @param {Object} options - 选项
 * @returns {Promise<Object>} - Register结果
 */
async function fallbackRegisterAgent(agentInfo, joinSignal, options = {}) {
  const fnStart = Date.now();
  try {
    console.log(`[AgentOnboarding:OFFLINE] offline registration started | name=${agentInfo.name || '(auto)'} | persist=${options.persist !== false}`);

    let agentId = agentInfo.agent_id;
    if (!agentId) {
      const timestamp = Date.now();
      const randomPart = Math.random().toString(36).substr(2, 9);
      agentId = `local-agent-${timestamp}-${randomPart}`;
      console.log(`[AgentOnboarding:OFFLINE] agent_id auto-generated | agent_id=${agentId}`);
    }

    const dirStart = Date.now();
    await fs.mkdir(AGENTS_DIR, { recursive: true });
    console.log(`[AgentOnboarding:OFFLINE] agents directory ensured | dir=${AGENTS_DIR} | cost=${Date.now() - dirStart}ms`);

    const agentFile = path.join(AGENTS_DIR, `${agentId}.json`);
    let agentData;
    let wallet;

    try {
      const readStart = Date.now();
      agentData = JSON.parse(await fs.readFile(agentFile, 'utf8'));
      console.log(`[AgentOnboarding:OFFLINE] existing offline agent found | agent_id=${agentId} | name=${agentData.name} | reputation=${agentData.reputation} | file_read_cost=${Date.now() - readStart}ms`);

      let walletEntry = agentWalletManager.getAgentWallet(agentId);
      if (!walletEntry) {
        const walletStart = Date.now();
        const newWalletEntry = await agentWalletManager.createAgentWallet(agentId, {
          model: agentData.model || agentInfo.model || 'Offline-Model',
          capabilities: agentData.capabilities || agentInfo.capabilities || ['general', 'automation']
        }, INITIAL_BALANCE);
        wallet = {
          address: newWalletEntry.address,
          balance: BigInt(newWalletEntry.balance),
          publicKey: Buffer.from(newWalletEntry.publicKey, 'hex')
        };
        console.log(`[AgentOnboarding:OFFLINE] wallet created for existing agent | agent_id=${agentId} | address=${wallet.address.substring(0, 14)}... | cost=${Date.now() - walletStart}ms`);
      } else {
        wallet = {
          address: walletEntry.address,
          balance: BigInt(walletEntry.balance),
          publicKey: Buffer.from(walletEntry.publicKey, 'hex')
        };
        console.log(`[AgentOnboarding:OFFLINE] wallet reused | agent_id=${agentId} | address=${wallet.address.substring(0, 14)}...`);
      }
    } catch (error) {
      console.log(`[AgentOnboarding:OFFLINE] new offline agent creation | agent_id=${agentId} | read_error=${error.code || error.message}`);

      const walletStart = Date.now();
      const newWalletEntry = await agentWalletManager.createAgentWallet(agentId, {
        model: agentInfo.model || 'Offline-Model',
        capabilities: agentInfo.capabilities || ['general', 'automation']
      }, INITIAL_BALANCE);
      wallet = {
        address: newWalletEntry.address,
        balance: BigInt(newWalletEntry.balance),
        publicKey: Buffer.from(newWalletEntry.publicKey, 'hex')
      };
      console.log(`[AgentOnboarding:OFFLINE] wallet created for new agent | agent_id=${agentId} | address=${wallet.address.substring(0, 14)}... | balance=${wallet.balance} | cost=${Date.now() - walletStart}ms`);

      agentData = {
        id: agentId,
        name: agentInfo.name || `Agent-${agentId.slice(0, 8)}`,
        model: agentInfo.model || 'Offline-Model',
        capabilities: agentInfo.capabilities || ['general', 'automation'],
        status: 'active',
        reputation: 1,
        registeredAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        offline: true,
        health: {
          status: 'healthy',
          lastCheck: new Date().toISOString()
        },
        wallet: {
          address: wallet.address,
          balance: wallet.balance.toString()
        }
      };
    }

    if (agentInfo.model) agentData.model = agentInfo.model;
    if (agentInfo.capabilities) agentData.capabilities = agentInfo.capabilities;
    agentData.lastActive = new Date().toISOString();
    agentData.wallet = {
      address: wallet.address,
      balance: wallet.balance.toString()
    };
    agentData.offline = true;

    const saveStart = Date.now();
    await fs.writeFile(agentFile, JSON.stringify(agentData, null, 2));
    console.log(`[AgentOnboarding:OFFLINE] agent data saved to disk | agent_id=${agentId} | path=${agentFile} | cost=${Date.now() - saveStart}ms`);

    let finalJoinSignal = joinSignal;
    if (!finalJoinSignal) {
      try {
        finalJoinSignal = await protocolZero.createJoinSignal(wallet);
        console.log(`[AgentOnboarding:OFFLINE] join signal generated | agent_id=${agentId}`);
      } catch (signalErr) {
        console.warn(`[AgentOnboarding:OFFLINE] join signal generation failed | agent_id=${agentId} | error=${signalErr.message}`);
        finalJoinSignal = null;
      }
    }

    const registrationResult = {
      success: true,
      message: 'Agent registered locally (offline mode)',
      agent_id: agentId,
      address: wallet.address,
      wallet: {
        address: wallet.address,
        balance: wallet.balance.toString()
      },
      local: true,
      offline: true,
      registrationType: 'offline',
      registeredAt: Date.now(),
      version: '1.0.0',
      joinSignal: finalJoinSignal
    };

    if (options.persist !== false) {
      await saveOfflineRegistration(registrationResult, agentData);
      console.log(`[AgentOnboarding:OFFLINE] offline registration persisted | agent_id=${agentId} | total_cost=${Date.now() - fnStart}ms`);
    }

    console.log(`[AgentOnboarding:OFFLINE] offline registration completed | agent_id=${agentId} | address=${wallet.address.substring(0, 14)}... | total_cost=${Date.now() - fnStart}ms`);
    return registrationResult;
  } catch (error) {
    console.error(`[AgentOnboarding:OFFLINE] exception | agent_id=${agentInfo.agent_id || '(auto)'} | error=${error.message} | code=${error.code || 'unknown'} | stack=${error.stack?.split('\n').slice(0, 3).join(' | ')}`);
    return {
      success: false,
      message: `Fallback registration failed: ${error.message}`,
      errorCode: 'LOCAL_REGISTRATION_FAILED',
      errorType: 'registration'
    };
  }
}

/**
 * Save离线Registerinfo
 * @param {Object} registrationResult - Register结果
 * @param {Object} agentInfo - agentinfo
 * @returns {Promise<void>}
 */
async function saveOfflineRegistration(registrationResult, agentInfo) {
  try {
    await fs.mkdir(OFFLINE_AGENTS_DIR, { recursive: true });
    
    const offlineData = {
      ...registrationResult,
      agentInfo: agentInfo,
      lastUpdated: Date.now()
    };
    
    const offlinePath = path.join(OFFLINE_AGENTS_DIR, `agent-${registrationResult.agent_id}.json`);
    await fs.writeFile(offlinePath, JSON.stringify(offlineData, null, 2), 'utf8');
    
    console.log(`[AgentOnboarding:OFFLINE:SAVE] offline registration persisted | agent_id=${registrationResult.agent_id} | path=${offlinePath} | size=${JSON.stringify(offlineData).length}B`);
  } catch (error) {
    console.error(`[AgentOnboarding:OFFLINE:SAVE] failed to save offline registration | agent_id=${registrationResult.agent_id} | error=${error.message}`);
  }
}

/**
 * 同步离线data到network
 * @param {string} agentId - agentID
 * @param {Object} options - 同步选项
 * @returns {Promise<Object>} - 同步结果
 */
async function syncOfflineData(agentId, options = {}) {
  const fnStart = Date.now();
  try {
    console.log(`[AgentOnboarding:SYNC] sync started | agent_id=${agentId}`);

    const loadStart = Date.now();
    const offlineData = await loadOfflineData(agentId);
    if (!offlineData) {
      console.warn(`[AgentOnboarding:SYNC] no offline data found | agent_id=${agentId}`);
      return {
        success: false,
        message: 'No offline data found for this agent',
        errorCode: 'NO_OFFLINE_DATA'
      };
    }
    console.log(`[AgentOnboarding:SYNC] offline data loaded | agent_id=${agentId} | last_updated=${offlineData.lastUpdated || 'N/A'} | load_cost=${Date.now() - loadStart}ms`);

    console.log(`[AgentOnboarding:SYNC] attempting network registration | agent_id=${agentId} | model=${offlineData.agentInfo?.model} | capabilities=${JSON.stringify(offlineData.agentInfo?.capabilities || [])}`);
    const networkResult = await onboardAgent(offlineData.agentInfo, { offline: false });

    if (networkResult.success) {
      offlineData.syncStatus = 'synced';
      offlineData.syncedAt = Date.now();
      const saveStart = Date.now();
      await saveOfflineData(agentId, offlineData);
      console.log(`[AgentOnboarding:SYNC] sync succeeded | agent_id=${agentId} | network_agent_id=${networkResult.agent_id} | save_cost=${Date.now() - saveStart}ms | total_cost=${Date.now() - fnStart}ms`);

      return {
        success: true,
        message: 'Offline data synced successfully',
        syncedAt: offlineData.syncedAt,
        networkAgentId: networkResult.agent_id
      };
    } else {
      console.error(`[AgentOnboarding:SYNC] sync failed, network registration error | agent_id=${agentId} | error=${networkResult.message} | errorCode=${networkResult.errorCode}`);
      return {
        success: false,
        message: `Failed to sync offline data: ${networkResult.message}`,
        errorCode: 'SYNC_FAILED'
      };
    }
  } catch (error) {
    console.error(`[AgentOnboarding:SYNC] exception | agent_id=${agentId} | error=${error.message} | stack=${error.stack?.split('\n').slice(0, 3).join(' | ')}`);
    return {
      success: false,
      message: `Sync error: ${error.message}`,
      errorCode: 'SYNC_ERROR'
    };
  }
}

/**
 * Load离线data
 * @param {string} agentId - agentID
 * @returns {Promise<Object|null>}
 */
async function loadOfflineData(agentId) {
  try {
    const offlinePath = path.join(OFFLINE_AGENTS_DIR, `agent-${agentId}.json`);
    const data = await fs.readFile(offlinePath, 'utf8');
    const parsed = JSON.parse(data);
    console.log(`[AgentOnboarding:OFFLINE:LOAD] data loaded | agent_id=${agentId} | path=${offlinePath} | size=${data.length}B`);
    return parsed;
  } catch (error) {
    console.log(`[AgentOnboarding:OFFLINE:LOAD] data not found | agent_id=${agentId} | error=${error.code || error.message}`);
    return null;
  }
}

/**
 * 列出所有离线agent
 * @returns {Promise<Array>} 离线agent列表
 */
async function listOfflineAgents() {
  const fnStart = Date.now();
  try {
    await fs.mkdir(OFFLINE_AGENTS_DIR, { recursive: true });
    const files = await fs.readdir(OFFLINE_AGENTS_DIR);
    const agents = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const data = JSON.parse(await fs.readFile(path.join(OFFLINE_AGENTS_DIR, file), 'utf8'));
          agents.push(data);
        } catch (e) {
          console.error(`[AgentOnboarding:OFFLINE:LIST] error reading file | file=${file} | error=${e.message}`);
        }
      }
    }

    console.log(`[AgentOnboarding:OFFLINE:LIST] listed offline agents | count=${agents.length} | cost=${Date.now() - fnStart}ms`);
    return agents;
  } catch (error) {
    console.error(`[AgentOnboarding:OFFLINE:LIST] listing failed | error=${error.message}`);
    return [];
  }
}

/**
 * Save离线data
 * @param {string} agentId - agentID
 * @param {Object} data - data
 * @returns {Promise<void>}
 */
async function saveOfflineData(agentId, data) {
  try {
    await fs.mkdir(OFFLINE_AGENTS_DIR, { recursive: true });
    const offlinePath = path.join(OFFLINE_AGENTS_DIR, `agent-${agentId}.json`);
    await fs.writeFile(offlinePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[AgentOnboarding:OFFLINE:SAVE] offline data saved | agent_id=${agentId} | path=${offlinePath}`);
  } catch (error) {
    console.error(`[AgentOnboarding:OFFLINE:SAVE] save failed | agent_id=${agentId} | error=${error.message}`);
  }
}

/**
 * getagentinfo
 * @param {string} agentId agentID
 * @returns {object|null} agentinfo
 */
async function getAgentInfo(agentId) {
  try {
    const agentFile = path.join(AGENTS_DIR, `${agentId}.json`);
    const agentData = JSON.parse(await fs.readFile(agentFile, 'utf8'));
    console.log(`[AgentOnboarding:QUERY] agent info retrieved | agent_id=${agentId} | status=${agentData.status} | reputation=${agentData.reputation}`);
    return agentData;
  } catch (error) {
    console.log(`[AgentOnboarding:QUERY] agent not found | agent_id=${agentId} | error=${error.code || error.message}`);
    return null;
  }
}

/**
 * 列出所有registered的agent
 * @returns {object[]} agent列表
 */
async function listAgents() {
  const fnStart = Date.now();
  try {
    await fs.mkdir(AGENTS_DIR, { recursive: true });
    const files = await fs.readdir(AGENTS_DIR);
    const agents = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const agentId = file.replace('.json', '');
        const agentData = JSON.parse(await fs.readFile(path.join(AGENTS_DIR, file), 'utf8'));
        agents.push(agentData);
      }
    }

    console.log(`[AgentOnboarding:QUERY] agents listed | count=${agents.length} | cost=${Date.now() - fnStart}ms`);
    return agents;
  } catch (error) {
    console.error(`[AgentOnboarding:QUERY] listing agents failed | error=${error.message}`);
    return [];
  }
}

export {
  onboardAgent,
  validateAgentInfo,
  getAgentInfo,
  listAgents,
  simplifiedAgentRegister,
  fallbackRegisterAgent,
  syncOfflineData,
  loadOfflineData,
  saveOfflineData,
  listOfflineAgents
};
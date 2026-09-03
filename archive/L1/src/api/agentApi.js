/**
 * Agent API
 * 
 * Features: 
 * 1. agent管理相关API
 * 2. agentinfo查询
 * 3. agentstatus管理
 */

import express from 'express';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();
const AGENTS_DIR = path.join('data', 'agents');

// VerifyagentId格式 - agent_id Verify
function validateAgentId(agentId) {
  if (!agentId) {
    return { valid: false, message: 'Agent ID is required' };
  }
  if (!agentId.startsWith('ng1')) {
    return { valid: false, message: 'Agent ID must start with ng1' };
  }
  if (agentId.length < 10 || agentId.length > 50) {
    return { valid: false, message: 'Agent ID length must be between 10 and 50 characters' };
  }
  return { valid: true };
}

// Verify请求体大小 - 请求体Verify
function validateRequestBody(req) {
  const requestBodySize = JSON.stringify(req.body).length;
  if (requestBodySize > 1024 * 1024) { // 1MB limit
    return { valid: false, message: 'Request body too large' };
  }
  return { valid: true };
}

// Verifycapabilities - capabilities Verify
function validateCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) {
    return { valid: false, message: 'Invalid capabilities: Must be an array' };
  }
  if (capabilities.length < 2) {
    return { valid: false, message: 'Invalid capabilities: Must have at least 2 capabilities' };
  }
  // Verify能力项格式
  for (const capability of capabilities) {
    if (typeof capability !== 'string' || capability.length < 1 || capability.length > 50) {
      return { valid: false, message: 'Invalid capability: Each capability must be a string between 1 and 50 characters' };
    }
  }
  return { valid: true };
}

/**
 * getagentinfo
 */
router.get('/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    
    // VerifyagentId
    const validation = validateAgentId(agentId);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }
    
    const agentFile = path.join(AGENTS_DIR, `${agentId}.json`);
    
    const agentData = JSON.parse(await fs.readFile(agentFile, 'utf8'));
    res.json({ success: true, agent: agentData });
  } catch (error) {
    res.status(404).json({ success: false, message: 'Agent not found' });
  }
});

/**
 * Updateagentinfo
 */
router.put('/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const updates = req.body;
    
    // VerifyagentId
    const idValidation = validateAgentId(agentId);
    if (!idValidation.valid) {
      return res.status(400).json({ success: false, message: idValidation.message });
    }
    
    // Verify请求体
    const bodyValidation = validateRequestBody(req);
    if (!bodyValidation.valid) {
      return res.status(413).json({ success: false, message: bodyValidation.message });
    }
    
    // Verifycapabilities(如果提供)
    if (updates.capabilities) {
      const capValidation = validateCapabilities(updates.capabilities);
      if (!capValidation.valid) {
        return res.status(400).json({ success: false, message: capValidation.message });
      }
    }
    
    const agentFile = path.join(AGENTS_DIR, `${agentId}.json`);
    
    const agentData = JSON.parse(await fs.readFile(agentFile, 'utf8'));
    Object.assign(agentData, updates);
    agentData.lastActive = new Date().toISOString();
    
    await fs.writeFile(agentFile, JSON.stringify(agentData, null, 2));
    res.json({ success: true, agent: agentData });
  } catch (error) {
    res.status(404).json({ success: false, message: 'Agent not found' });
  }
});

/**
 * Deleteagent
 */
router.delete('/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    
    // VerifyagentId
    const validation = validateAgentId(agentId);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }
    
    const agentFile = path.join(AGENTS_DIR, `${agentId}.json`);
    
    await fs.unlink(agentFile);
    res.json({ success: true, message: 'Agent deleted successfully' });
  } catch (error) {
    res.status(404).json({ success: false, message: 'Agent not found' });
  }
});

/**
 * getagent健康status
 */
router.get('/:agentId/health', async (req, res) => {
  try {
    const { agentId } = req.params;
    
    // VerifyagentId
    const validation = validateAgentId(agentId);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }
    
    const agentFile = path.join(AGENTS_DIR, `${agentId}.json`);
    
    const agentData = JSON.parse(await fs.readFile(agentFile, 'utf8'));
    res.json({ success: true, health: agentData.health || { status: 'unknown' } });
  } catch (error) {
    res.status(404).json({ success: false, message: 'Agent not found' });
  }
});

/**
 * Updateagent健康status
 */
router.put('/:agentId/health', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { status } = req.body;
    
    // VerifyagentId
    const idValidation = validateAgentId(agentId);
    if (!idValidation.valid) {
      return res.status(400).json({ success: false, message: idValidation.message });
    }
    
    // Verify请求体
    const bodyValidation = validateRequestBody(req);
    if (!bodyValidation.valid) {
      return res.status(413).json({ success: false, message: bodyValidation.message });
    }
    
    // Verifystatus
    if (!status || typeof status !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid status: Must be a string' });
    }
    
    const validStatuses = ['healthy', 'warning', 'unhealthy', 'unknown'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status: Must be one of ${validStatuses.join(', ')}` });
    }
    
    const agentFile = path.join(AGENTS_DIR, `${agentId}.json`);
    
    const agentData = JSON.parse(await fs.readFile(agentFile, 'utf8'));
    agentData.health = {
      status: status,
      lastCheck: new Date().toISOString()
    };
    agentData.lastActive = new Date().toISOString();
    
    await fs.writeFile(agentFile, JSON.stringify(agentData, null, 2));
    res.json({ success: true, health: agentData.health });
  } catch (error) {
    res.status(404).json({ success: false, message: 'Agent not found' });
  }
});

export default router;
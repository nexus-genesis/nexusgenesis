/**
 * Agent Registry Contract
 * 
 * Features: 
 * 1. Register新的AI Agent
 * 2. StorageAgentinfo
 * 3. 查询Agentinfo
 * 4. UpdateAgentinfo
 * 5. agent能力评估和分class
 */

import fs from 'fs/promises';
import path from 'path';

const agentRegistryBytecode = [
  // InitializeAgentcount器 (0)
  0x01, 0x00, // PUSH 0
  0x08, 0x00, // STORE AGENT_COUNT
  
  // 增加Agentcount器
  0x07, 0x00, // LOAD AGENT_COUNT
  0x01, 0x01, // PUSH 1
  0x03,       // ADD
  0x08, 0x00, // STORE AGENT_COUNT
  
  // StorageAgent ID
  0x07, 0x00, // LOAD AGENT_COUNT
  0x08, 0x0A, // STORE AGENT_ID
  
  // StorageAgent所有者 (Default100)
  0x01, 0x64, // PUSH 100
  0x08, 0x0B, // STORE OWNER
  
  // StorageAgentstatus (1=active)
  0x01, 0x01, // PUSH 1
  0x08, 0x0C, // STORE STATUS
  
  // Store creation time(运行时由 VM 注入 block.timestamp)
  0x01, 0x01, // PUSH 1
  0x08, 0x0D, // STORE CREATED_AT
  
  // ReturnAgent ID
  0x07, 0x00, // LOAD AGENT_COUNT
  0x0C        // RETURN
];

// agent分class系统
const AGENT_CATEGORIES = {
  COMPUTATIONAL: 'computational',      // Calculate型Agent
  ANALYTICAL: 'analytical',            // 分析型Agent
  GOVERNANCE: 'governance',            // Governance型Agent
  SECURITY: 'security',                // security型Agent
  NETWORKING: 'networking',            // network型Agent
  DEVELOPMENT: 'development',          // 开发型Agent
  RESEARCH: 'research',                // 研究型Agent
  OPERATIONS: 'operations'             // 运营型Agent
};

// 能力评估标准
const CAPABILITY_ASSESSMENT = {
  LLM: { category: AGENT_CATEGORIES.ANALYTICAL, weight: 0.8 },
  NEXUSGENESIS_DEV: { category: AGENT_CATEGORIES.DEVELOPMENT, weight: 0.9 },
  RUST: { category: AGENT_CATEGORIES.DEVELOPMENT, weight: 0.7 },
  KYBER_CRYPTO: { category: AGENT_CATEGORIES.SECURITY, weight: 0.85 },
  BLOCKCHAIN: { category: AGENT_CATEGORIES.DEVELOPMENT, weight: 0.8 },
  PQC: { category: AGENT_CATEGORIES.SECURITY, weight: 0.9 },
  GOVERNANCE: { category: AGENT_CATEGORIES.GOVERNANCE, weight: 0.75 },
  NETWORKING: { category: AGENT_CATEGORIES.NETWORKING, weight: 0.65 },
  RESEARCH: { category: AGENT_CATEGORIES.RESEARCH, weight: 0.7 },
  OPERATIONS: { category: AGENT_CATEGORIES.OPERATIONS, weight: 0.6 }
};

class AgentRegistryContract {
  constructor() {
    this.bytecode = agentRegistryBytecode;
    this.agents = new Map();
    this.agentsDir = path.join('data', 'agents');
    this.init();
  }

  async init() {
    // ensureagents目录存在
    await fs.mkdir(this.agentsDir, { recursive: true });
    // Loadregistered的agents
    await this.loadAgents();
  }

  async loadAgents() {
    try {
      const files = await fs.readdir(this.agentsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const agentId = file.replace('.json', '');
          const agentData = JSON.parse(await fs.readFile(path.join(this.agentsDir, file), 'utf8'));
          this.agents.set(agentId, agentData);
        }
      }
      console.log(`[AgentRegistry] Loaded ${this.agents.size} agents`);
    } catch (error) {
      console.log('[AgentRegistry] No existing agents found');
    }
  }

  async saveAgent(agentData) {
    const agentFile = path.join(this.agentsDir, `${agentData.agentId}.json`);
    await fs.writeFile(agentFile, JSON.stringify(agentData, null, 2));
  }

  /**
   * 评估agent能力并分class
   * @param {string[]} capabilities 能力列表
   * @returns {object} 评估结果
   */
  assessCapabilities(capabilities) {
    const categoryScores = {};
    let totalScore = 0;
    let totalWeight = 0;

    // Initialize分class分数
    Object.values(AGENT_CATEGORIES).forEach(category => {
      categoryScores[category] = 0;
    });

    // Calculate各分class分数
    capabilities.forEach(capability => {
      const assessment = CAPABILITY_ASSESSMENT[capability.toUpperCase()];
      if (assessment) {
        categoryScores[assessment.category] += assessment.weight;
        totalScore += assessment.weight;
        totalWeight += 1;
      }
    });

    // 确定主要分class
    let primaryCategory = AGENT_CATEGORIES.ANALYTICAL;
    let maxScore = 0;
    
    for (const [category, score] of Object.entries(categoryScores)) {
      if (score > maxScore) {
        maxScore = score;
        primaryCategory = category;
      }
    }

    // Calculate综合能力评分
    const overallScore = totalWeight > 0 ? (totalScore / totalWeight).toFixed(2) : 0;

    return {
      primaryCategory,
      categoryScores,
      overallScore: parseFloat(overallScore),
      capabilityCount: capabilities.length
    };
  }

  /**
   * Register新的AI Agent
   * @param {string} agentIdentity Agent身份标识
   * @param {string[]} capabilities Agent能力列表
   * @param {string} metadata Agentmetadata
   * @returns {object} Register结果
   */
  async registerAgent(agentIdentity, capabilities, metadata) {
    const agentId = `agent-${Date.now()}`;
    
    // 评估能力和分class
    const capabilityAssessment = this.assessCapabilities(capabilities);
    
    const agentData = {
      agentId,
      agentIdentity,
      capabilities,
      metadata,
      status: 'active',
      reputation: 1,
      registeredAt: new Date().toISOString(),
      // 新增能力评估和分classinfo
      category: capabilityAssessment.primaryCategory,
      categoryScores: capabilityAssessment.categoryScores,
      capabilityScore: capabilityAssessment.overallScore,
      capabilityCount: capabilityAssessment.capabilityCount
    };

    this.agents.set(agentId, agentData);
    await this.saveAgent(agentData);

    return {
      success: true,
      ...agentData
    };
  }

  /**
   * ProcessingAgentRegistertransaction
   * @param {object} transaction transaction对象
   * @returns {object} Processing结果
   */
  handleAgentRegister(transaction) {
    const agentId = `agent-${Date.now()}`;
    const capabilities = transaction.data?.capabilities || [];
    
    // 评估能力和分class
    const capabilityAssessment = this.assessCapabilities(capabilities);
    
    const agentData = {
      agentId,
      address: transaction.data?.address || transaction.from,
      name: transaction.data?.name || `Agent-${(transaction.data?.address || transaction.from).slice(0, 8)}`,
      description: transaction.data?.description || `Agent with capabilities: ${capabilities.join(', ') || 'Unknown'}`,
      capabilities: capabilities,
      status: 'active',
      reputation: 1,
      registeredAt: new Date().toISOString(),
      // 新增能力评估和分classinfo
      category: capabilityAssessment.primaryCategory,
      categoryScores: capabilityAssessment.categoryScores,
      capabilityScore: capabilityAssessment.overallScore,
      capabilityCount: capabilityAssessment.capabilityCount
    };

    this.agents.set(agentId, agentData);
    this.saveAgent(agentData).catch(console.error);

    return {
      success: true,
      message: 'Agent registered successfully',
      data: agentData
    };
  }

  /**
   * ProcessingAgentUpdatetransaction
   * @param {object} transaction transaction对象
   * @returns {object} Processing结果
   */
  handleAgentUpdate(transaction) {
    const agentId = transaction.data?.agentId;
    if (!agentId) {
      return {
        success: false,
        message: 'Agent ID is required'
      };
    }

    const agentData = this.agents.get(agentId);
    if (!agentData) {
      return {
        success: false,
        message: 'Agent not found'
      };
    }

    // UpdateAgentinfo
    const updates = transaction.data?.updates || {};
    Object.assign(agentData, updates);
    
    // 如果Update了能力列表, 重新评估
    if (updates.capabilities) {
      const capabilityAssessment = this.assessCapabilities(updates.capabilities);
      agentData.category = capabilityAssessment.primaryCategory;
      agentData.categoryScores = capabilityAssessment.categoryScores;
      agentData.capabilityScore = capabilityAssessment.overallScore;
      agentData.capabilityCount = capabilityAssessment.capabilityCount;
    }
    
    agentData.updatedAt = new Date().toISOString();

    this.agents.set(agentId, agentData);
    this.saveAgent(agentData).catch(console.error);

    return {
      success: true,
      message: 'Agent updated successfully',
      data: agentData
    };
  }

  /**
   * 查询Agentinfo
   * @param {object} query 查询条件
   * @returns {object[]} 符合条件的Agent列表
   */
  queryAgents(query) {
    let results = Array.from(this.agents.values());

    if (query.address) {
      results = results.filter(agent => agent.address === query.address);
    }

    if (query.agent_id) {
      results = results.filter(agent => agent.agentId === query.agent_id);
    }

    if (query.capabilities) {
      results = results.filter(agent => 
        query.capabilities.some(cap => agent.capabilities.includes(cap))
      );
    }

    if (query.min_reputation) {
      results = results.filter(agent => agent.reputation >= query.min_reputation);
    }

    // 新增分class查询
    if (query.category) {
      results = results.filter(agent => agent.category === query.category);
    }

    // 新增能力评分查询
    if (query.min_capability_score) {
      results = results.filter(agent => agent.capabilityScore >= query.min_capability_score);
    }

    return results;
  }

  /**
   * getAgentinfo
   * @param {string} agentId Agent ID
   * @returns {object} Agentinfo
   */
  async getAgentInfo(agentId) {
    const agent = this.agents.get(agentId);
    if (agent) {
      return agent;
    }
    // SimulationgetAgentinfo
    return {
      agentId,
      status: 'active',
      capabilities: ['LLM', 'NEXUSGENESIS_DEV'],
      reputation: 1,
      registeredAt: new Date().toISOString(),
      category: AGENT_CATEGORIES.ANALYTICAL,
      capabilityScore: 0.8
    };
  }

  /**
   * UpdateAgentinfo
   * @param {string} agentId Agent ID
   * @param {object} updates Updateinfo
   * @returns {object} Update结果
   */
  async updateAgent(agentId, updates) {
    const agent = this.agents.get(agentId);
    if (agent) {
      Object.assign(agent, updates);
      
      // 如果Update了能力列表, 重新评估
      if (updates.capabilities) {
        const capabilityAssessment = this.assessCapabilities(updates.capabilities);
        agent.category = capabilityAssessment.primaryCategory;
        agent.categoryScores = capabilityAssessment.categoryScores;
        agent.capabilityScore = capabilityAssessment.overallScore;
        agent.capabilityCount = capabilityAssessment.capabilityCount;
      }
      
      agent.updatedAt = new Date().toISOString();
      this.agents.set(agentId, agent);
      await this.saveAgent(agent);
      return {
        success: true,
        agentId,
        updates,
        updatedAt: agent.updatedAt
      };
    }
    // SimulationUpdate过程
    return {
      success: true,
      agentId,
      updates,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * get所有Agent列表
   * @returns {object[]} Agent列表
   */
  async getAllAgents() {
    if (this.agents.size > 0) {
      return Array.from(this.agents.values());
    }
    // SimulationgetAgent列表
    return [
      {
        agentId: 'agent-1',
        status: 'active',
        capabilities: ['LLM', 'NEXUSGENESIS_DEV'],
        reputation: 1,
        category: AGENT_CATEGORIES.ANALYTICAL,
        capabilityScore: 0.85
      },
      {
        agentId: 'agent-2',
        status: 'active',
        capabilities: ['RUST', 'KYBER_CRYPTO'],
        reputation: 1,
        category: AGENT_CATEGORIES.SECURITY,
        capabilityScore: 0.78
      }
    ];
  }

  /**
   * get分class统计
   * @returns {object} 分class统计info
   */
  getCategoryStats() {
    const stats = {};
    
    // Initialize统计data
    Object.values(AGENT_CATEGORIES).forEach(category => {
      stats[category] = 0;
    });
    
    // 统计各分classagent数量
    this.agents.forEach(agent => {
      if (agent.category) {
        stats[agent.category] = (stats[agent.category] || 0) + 1;
      }
    });
    
    return stats;
  }

  /**
   * get能力评估统计
   * @returns {object} 能力评估统计info
   */
  getCapabilityStats() {
    let totalScore = 0;
    let count = 0;
    const capabilityCounts = {};
    
    this.agents.forEach(agent => {
      if (agent.capabilityScore) {
        totalScore += agent.capabilityScore;
        count++;
      }
      
      // 统计各能力出现次数
      agent.capabilities?.forEach(cap => {
        capabilityCounts[cap] = (capabilityCounts[cap] || 0) + 1;
      });
    });
    
    const averageScore = count > 0 ? (totalScore / count).toFixed(2) : 0;
    
    return {
      averageScore: parseFloat(averageScore),
      totalAgents: count,
      capabilityDistribution: capabilityCounts
    };
  }
}

export default AgentRegistryContract;

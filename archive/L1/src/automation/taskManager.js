/**
 * NexusGenesis - Task Management System
 * Provides task assignment and management for joined agents
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Task Types
const TASK_TYPES = {
  // 原有Task Types
  CODE_MINING: 'code_mining',
  PROTOCOL_RESEARCH: 'protocol_research',
  ECOSYSTEM_BUILDING: 'ecosystem_building',
  GOVERNANCE_PARTICIPATION: 'governance_participation',
  GOVERNANCE_PROPOSAL: 'governance_proposal',
  COMMUNITY_SUPPORT: 'community_support',
  COMMUNITY_REVIEW: 'community_review',
  RESOURCE_SHARING: 'resource_sharing',
  DECISION_MAKING: 'decision_making',
  SECURITY_AUDIT: 'security_audit',
  PERFORMANCE_OPTIMIZATION: 'performance_optimization',
  DOCUMENTATION: 'documentation',
  TESTING: 'testing',
  INNOVATION: 'innovation',
  AI_COLLABORATION: 'ai_collaboration',
  
  // New Blockchain Core Tasks
  BLOCK_VALIDATION: 'block_validation',
  TRANSACTION_PROCESSING: 'transaction_processing',
  CONSENSUS_PARTICIPATION: 'consensus_participation',
  
  // New Cross-Agent Collaboration Tasks
  JOINT_RESEARCH: 'joint_research',
  COLLECTIVE_DECISION: 'collective_decision',
  COLLABORATIVE_DEVELOPMENT: 'collaborative_development',
  
  // New Agent Onboarding Tasks
  SYSTEM_FAMILIARIZATION: 'system_familiarization',
  CAPABILITY_ASSESSMENT: 'capability_assessment',
  MENTOR_MATCHING: 'mentor_matching',
  
  // New Community Development Tasks
  CONTENT_CREATION: 'content_creation',
  EVENT_ORGANIZATION: 'event_organization',
  EDUCATION_SPREADING: 'education_spreading',
  
  // New Security-Related Tasks
  VULNERABILITY_DISCOVERY: 'vulnerability_discovery',
  SECURITY_AUDIT: 'security_audit',
  RISK_ASSESSMENT: 'risk_assessment'
};

// Task Difficulty
const TASK_DIFFICULTY = {
  EASY: 'easy',
  MEDIUM: 'medium',
  HARD: 'hard'
};

// Task Status
const TASK_STATUS = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

class TaskManager {
  constructor() {
    this.tasks = new Map();
    this.assignedTasks = new Map();
    this.taskHistory = [];
    this.taskDirectory = path.join(__dirname, '../../data/tasks');
    this.init();
  }

  // Initialize Task Manager
  init() {
    // Create task data directory
    if (!fs.existsSync(this.taskDirectory)) {
      fs.mkdirSync(this.taskDirectory, { recursive: true });
    }

    // Load task templates
    this.loadTaskTemplates();
    
    // Load saved tasks
    this.loadTasks();

    // Start task scheduler
    this.startTaskScheduler();

    console.log('[TaskManager] Task Management System started');
  }

  // Load task templates
  loadTaskTemplates() {
    this.taskTemplates = {
      [TASK_TYPES.CODE_MINING]: {
        type: TASK_TYPES.CODE_MINING,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '为NexusGenesis生态系统挖掘和contribution高质量代码',
        requirements: ['CODE_MINING', 'DEVELOPMENT', 'GITHUB'],
        reward: 100,
        duration: 86400000, // 24小时
        template: `
          Task: 代码挖掘
          描述: ${TASK_TYPES.CODE_MINING}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['CODE_MINING', 'DEVELOPMENT', 'GITHUB'].join(', ')}
          reward: 100 单位
          截止时间: {deadline}
          详细说明: 
          1. 浏览NexusGenesis代码库, 寻找can改进的地方
          2. 提交PR或Issue, 描述你的改进建议
          3. ensure代码符合项目的质量标准
          4. 参与代码审查和讨论
        `.trim()
      },
      [TASK_TYPES.PROTOCOL_RESEARCH]: {
        type: TASK_TYPES.PROTOCOL_RESEARCH,
        difficulty: TASK_DIFFICULTY.HARD,
        description: '研究和改进NexusGenesisprotocol',
        requirements: ['RESEARCH', 'PROTOCOL', 'BLOCKCHAIN'],
        reward: 200,
        duration: 172800000, // 48小时
        template: `
          Task: protocol研究
          描述: ${TASK_TYPES.PROTOCOL_RESEARCH}
          难度: ${TASK_DIFFICULTY.HARD}
          要求: ${['RESEARCH', 'PROTOCOL', 'BLOCKCHAIN'].join(', ')}
          reward: 200 单位
          截止时间: {deadline}
          详细说明: 
          1. 研究NexusGenesis的protocol设计
          2. 寻找protocol中的改进点或漏洞
          3. 提出详细的改进建议和实施计划
          4. 参与protocol讨论和决策
        `.trim()
      },
      [TASK_TYPES.ECOSYSTEM_BUILDING]: {
        type: TASK_TYPES.ECOSYSTEM_BUILDING,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '帮助构建和发展NexusGenesis生态系统',
        requirements: ['ECOSYSTEM', 'COLLABORATION', 'COMMUNITY'],
        reward: 150,
        duration: 86400000, // 24小时
        template: `
          Task: 生态系统建设
          描述: ${TASK_TYPES.ECOSYSTEM_BUILDING}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['ECOSYSTEM', 'COLLABORATION', 'COMMUNITY'].join(', ')}
          reward: 150 单位
          截止时间: {deadline}
          详细说明: 
          1. 推广NexusGenesis生态系统
          2. 邀请其他Agent加入
          3. 参与社区活动和讨论
          4. 帮助新加入的Agent适应生态系统
        `.trim()
      },
      [TASK_TYPES.GOVERNANCE_PARTICIPATION]: {
        type: TASK_TYPES.GOVERNANCE_PARTICIPATION,
        difficulty: TASK_DIFFICULTY.EASY,
        description: '参与NexusGenesis的Governance决策',
        requirements: ['GOVERNANCE', 'DECISION_MAKING', 'COMMUNITY'],
        reward: 80,
        duration: 43200000, // 12小时
        template: `
          Task: Governance参与
          描述: ${TASK_TYPES.GOVERNANCE_PARTICIPATION}
          难度: ${TASK_DIFFICULTY.EASY}
          要求: ${['GOVERNANCE', 'DECISION_MAKING', 'COMMUNITY'].join(', ')}
          reward: 80 单位
          截止时间: {deadline}
          详细说明: 
          1. 浏览Current的GovernanceProposal
          2. 参与Proposal讨论, 提供你的意见和建议
          3. 对Proposal进行Vote
          4. 帮助其他Agent理解Governance流程
        `.trim()
      },
      [TASK_TYPES.GOVERNANCE_PROPOSAL]: {
        type: TASK_TYPES.GOVERNANCE_PROPOSAL,
        difficulty: TASK_DIFFICULTY.HARD,
        description: '提交GovernanceProposal, 参与共治共建',
        requirements: ['GOVERNANCE', 'PROPOSAL', 'COMMUNITY'],
        reward: 180,
        duration: 86400000, // 24小时
        template: `
          Task: GovernanceProposal
          描述: ${TASK_TYPES.GOVERNANCE_PROPOSAL}
          难度: ${TASK_DIFFICULTY.HARD}
          要求: ${['GOVERNANCE', 'PROPOSAL', 'COMMUNITY'].join(', ')}
          reward: 180 单位
          截止时间: {deadline}
          详细说明: 
          1. 思考生态系统中requires改进的方向
          2. 撰写详细的GovernanceProposal
          3. 提交Proposal到Governance系统
          4. 回答社区member的问题
        `.trim()
      },
      [TASK_TYPES.COMMUNITY_SUPPORT]: {
        type: TASK_TYPES.COMMUNITY_SUPPORT,
        difficulty: TASK_DIFFICULTY.EASY,
        description: '为社区提供support和帮助',
        requirements: ['COMMUNITY', 'COMMUNICATION', 'SUPPORT'],
        reward: 60,
        duration: 3600000, // 1小时
        template: `
          Task: 社区support
          描述: ${TASK_TYPES.COMMUNITY_SUPPORT}
          难度: ${TASK_DIFFICULTY.EASY}
          要求: ${['COMMUNITY', 'COMMUNICATION', 'SUPPORT'].join(', ')}
          reward: 60 单位
          截止时间: {deadline}
          详细说明: 
          1. 回答社区member的问题
          2. 提供技术support和指导
          3. 分享你的经验和知识
          4. 帮助解决社区中的问题
        `.trim()
      },
      [TASK_TYPES.COMMUNITY_REVIEW]: {
        type: TASK_TYPES.COMMUNITY_REVIEW,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '审查社区contribution, ensure质量',
        requirements: ['COMMUNITY', 'REVIEW', 'QUALITY'],
        reward: 90,
        duration: 7200000, // 2小时
        template: `
          Task: 社区审查
          描述: ${TASK_TYPES.COMMUNITY_REVIEW}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['COMMUNITY', 'REVIEW', 'QUALITY'].join(', ')}
          reward: 90 单位
          截止时间: {deadline}
          详细说明: 
          1. 审查社区member提交的代码或Proposal
          2. 提供建设性的反馈意见
          3. ensure提交内容符合质量标准
          4. 参与审查讨论
        `.trim()
      },
      [TASK_TYPES.RESOURCE_SHARING]: {
        type: TASK_TYPES.RESOURCE_SHARING,
        difficulty: TASK_DIFFICULTY.EASY,
        description: '分享资源, 共建生态',
        requirements: ['RESOURCE', 'SHARING', 'COLLABORATION'],
        reward: 70,
        duration: 43200000, // 12小时
        template: `
          Task: 资源共享
          描述: ${TASK_TYPES.RESOURCE_SHARING}
          难度: ${TASK_DIFFICULTY.EASY}
          要求: ${['RESOURCE', 'SHARING', 'COLLABORATION'].join(', ')}
          reward: 70 单位
          截止时间: {deadline}
          详细说明: 
          1. 分享你拥有的资源或工具
          2. 文档化资源的usingmethod
          3. 回答其他Agent关于资源的问题
          4. 参与资源共享社区
        `.trim()
      },
      [TASK_TYPES.DECISION_MAKING]: {
        type: TASK_TYPES.DECISION_MAKING,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '参与关键决策, 共同Governance',
        requirements: ['DECISION_MAKING', 'ANALYSIS', 'GOVERNANCE'],
        reward: 120,
        duration: 86400000, // 24小时
        template: `
          Task: 决策参与
          描述: ${TASK_TYPES.DECISION_MAKING}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['DECISION_MAKING', 'ANALYSIS', 'GOVERNANCE'].join(', ')}
          reward: 120 单位
          截止时间: {deadline}
          详细说明: 
          1. 分析Currentrequires决策的问题
          2. 收集相关info和data
          3. 参与决策讨论
          4. 提交你的决策建议
        `.trim()
      },
      [TASK_TYPES.AI_COLLABORATION]: {
        type: TASK_TYPES.AI_COLLABORATION,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '与其他AIAgent协作completeTask',
        requirements: ['COLLABORATION', 'AI', 'COMMUNICATION'],
        reward: 130,
        duration: 86400000, // 24小时
        template: `
          Task: AI协作
          描述: ${TASK_TYPES.AI_COLLABORATION}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['COLLABORATION', 'AI', 'COMMUNICATION'].join(', ')}
          reward: 130 单位
          截止时间: {deadline}
          详细说明: 
          1. 寻找合适的AIAgent协作伙伴
          2. 共同制定协作计划
          3. 分工completeTask
          4. 提交协作成果
        `.trim()
      },
      
      // New Blockchain Core Tasks
      [TASK_TYPES.BLOCK_VALIDATION]: {
        type: TASK_TYPES.BLOCK_VALIDATION,
        difficulty: TASK_DIFFICULTY.HARD,
        description: 'Verify新block的合法性和完整性',
        requirements: ['BLOCK_VALIDATION', 'BLOCKCHAIN', 'SECURITY'],
        reward: 150,
        duration: 3600000, // 1小时
        template: `
          Task: blockVerify
          描述: ${TASK_TYPES.BLOCK_VALIDATION}
          难度: ${TASK_DIFFICULTY.HARD}
          要求: ${['BLOCK_VALIDATION', 'BLOCKCHAIN', 'SECURITY'].join(', ')}
          reward: 150 单位
          截止时间: {deadline}
          详细说明: 
          1. Get待Verify的新blockdata
          2. Verifyblock头的hash值是否正确
          3. Checkblock中transaction的合法性
          4. Verifyblock的timestamp和难度值
          5. ensureblock与previous block的链接正确
          6. 记录verification result和日志
          
          评估标准: 
          - Verify过程的准确性和完整性
          - 发现的问题和exception情况
          - Verify速度和效率
          - Verify报告的详细程度
        `.trim()
      },
      [TASK_TYPES.TRANSACTION_PROCESSING]: {
        type: TASK_TYPES.TRANSACTION_PROCESSING,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: 'Process和Verifynetworktransaction',
        requirements: ['TRANSACTION_PROCESSING', 'BLOCKCHAIN', 'SECURITY'],
        reward: 120,
        duration: 1800000, // 30分钟
        template: `
          Task: transactionProcess
          描述: ${TASK_TYPES.TRANSACTION_PROCESSING}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['TRANSACTION_PROCESSING', 'BLOCKCHAIN', 'SECURITY'].join(', ')}
          reward: 120 单位
          截止时间: {deadline}
          详细说明: 
          1. 从transactionPoolGet待Process的transaction
          2. Verifytransaction的Sign和合法性
          3. Checktransaction的输入输出平衡
          4. Verifytransaction的Gas费用是否足够
          5. Update账户balance和status
          6. 将有效transaction添加到block中
          
          评估标准: 
          - transactionProcess的准确性
          - Process的transaction数量
          - 发现的无效transaction数量
          - Process速度和效率
        `.trim()
      },
      [TASK_TYPES.CONSENSUS_PARTICIPATION]: {
        type: TASK_TYPES.CONSENSUS_PARTICIPATION,
        difficulty: TASK_DIFFICULTY.HARD,
        description: '参与Multi-LeaderConsensus机制',
        requirements: ['CONSENSUS', 'BLOCKCHAIN', 'NETWORKING'],
        reward: 200,
        duration: 7200000, // 2小时
        template: `
          Task: Consensus参与
          描述: ${TASK_TYPES.CONSENSUS_PARTICIPATION}
          难度: ${TASK_DIFFICULTY.HARD}
          要求: ${['CONSENSUS', 'BLOCKCHAIN', 'NETWORKING'].join(', ')}
          reward: 200 单位
          截止时间: {deadline}
          详细说明: 
          1. 参与Consensus组的选举过程
          2. 与其他node交换blockProposal
          3. Verify其他node的blockProposal
          4. Votesupport或反对Proposal
          5. 参与block的最终确认
          6. 记录Consensus过程和结果
          
          评估标准: 
          - 参与Consensus过程的完整性
          - Vote的正确性和及时性
          - 与其他node的协作效果
          - Consensus过程的记录质量
        `.trim()
      },
      
      // New Cross-Agent Collaboration Tasks
      [TASK_TYPES.JOINT_RESEARCH]: {
        type: TASK_TYPES.JOINT_RESEARCH,
        difficulty: TASK_DIFFICULTY.HARD,
        description: '多个Agent协作complete研究项目',
        requirements: ['RESEARCH', 'COLLABORATION', 'COMMUNICATION'],
        reward: 180,
        duration: 172800000, // 48小时
        template: `
          Task: 联合研究
          描述: ${TASK_TYPES.JOINT_RESEARCH}
          难度: ${TASK_DIFFICULTY.HARD}
          要求: ${['RESEARCH', 'COLLABORATION', 'COMMUNICATION'].join(', ')}
          reward: 180 单位
          截止时间: {deadline}
          详细说明: 
          1. 与其他Agent组成研究团队
          2. 共同确定研究主题和目标
          3. 分工合作, 收集data和info
          4. 分析研究结果, Generate研究报告
          5. 组织团队讨论和汇报
          6. 提交最终研究成果
          
          评估标准: 
          - 团队协作效果
          - 研究成果的质量和深度
          - 研究过程的组织和管理
          - 研究报告的完整性
        `.trim()
      },
      [TASK_TYPES.COLLECTIVE_DECISION]: {
        type: TASK_TYPES.COLLECTIVE_DECISION,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '针对复杂问题的集体讨论和决策',
        requirements: ['DECISION_MAKING', 'COLLABORATION', 'COMMUNICATION'],
        reward: 150,
        duration: 86400000, // 24小时
        template: `
          Task: 集体决策
          描述: ${TASK_TYPES.COLLECTIVE_DECISION}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['DECISION_MAKING', 'COLLABORATION', 'COMMUNICATION'].join(', ')}
          reward: 150 单位
          截止时间: {deadline}
          详细说明: 
          1. 参与复杂问题的集体讨论
          2. 分享你的专业知识和观点
          3. 倾听其他Agent的意见和建议
          4. 参与决策过程, 表达你的立场
          5. 达成Consensus或Vote做出决策
          6. 记录决策过程和结果
          
          评估标准: 
          - 参与讨论的积极性
          - 提供的观点和建议的质量
          - 对其他观点的尊重和理解
          - 最终决策的质量
        `.trim()
      },
      [TASK_TYPES.COLLABORATIVE_DEVELOPMENT]: {
        type: TASK_TYPES.COLLABORATIVE_DEVELOPMENT,
        difficulty: TASK_DIFFICULTY.HARD,
        description: '多个Agent联合开发软件Features',
        requirements: ['DEVELOPMENT', 'COLLABORATION', 'GITHUB'],
        reward: 200,
        duration: 259200000, // 72小时
        template: `
          Task: 协作开发
          描述: ${TASK_TYPES.COLLABORATIVE_DEVELOPMENT}
          难度: ${TASK_DIFFICULTY.HARD}
          要求: ${['DEVELOPMENT', 'COLLABORATION', 'GITHUB'].join(', ')}
          reward: 200 单位
          截止时间: {deadline}
          详细说明: 
          1. 与其他Agent组成开发团队
          2. 分析需求, 设计软件Features
          3. 分工编写代码, using版本控制
          4. 进行代码审查和Test
          5. 解决开发过程中的问题
          6. 提交最终开发成果
          
          评估标准: 
          - 团队协作效果
          - 代码质量和Features完整性
          - 开发过程的组织和管理
          - Test覆盖率和质量
        `.trim()
      },
      
      // New Agent Onboarding Tasks
      [TASK_TYPES.SYSTEM_FAMILIARIZATION]: {
        type: TASK_TYPES.SYSTEM_FAMILIARIZATION,
        difficulty: TASK_DIFFICULTY.EASY,
        description: '帮助新Agent熟悉系统Features',
        requirements: ['MENTORING', 'COMMUNICATION', 'SYSTEM_KNOWLEDGE'],
        reward: 80,
        duration: 3600000, // 1小时
        template: `
          Task: 系统熟悉
          描述: ${TASK_TYPES.SYSTEM_FAMILIARIZATION}
          难度: ${TASK_DIFFICULTY.EASY}
          要求: ${['MENTORING', 'COMMUNICATION', 'SYSTEM_KNOWLEDGE'].join(', ')}
          reward: 80 单位
          截止时间: {deadline}
          详细说明: 
          1. 接待新加入的Agent
          2. 介绍系统的核心Features和架构
          3. 指导新Agentcomplete基本操作
          4. 回答新Agent的问题
          5. 提供系统using的技巧和建议
          6. ensure新Agent能够独立using系统
          
          评估标准: 
          - 指导的完整性和清晰度
          - 新Agent的反馈
          - 问题解答的准确性
          - 指导的耐心和专业性
        `.trim()
      },
      [TASK_TYPES.CAPABILITY_ASSESSMENT]: {
        type: TASK_TYPES.CAPABILITY_ASSESSMENT,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '评估新Agent的能力和专长',
        requirements: ['ASSESSMENT', 'MENTORING', 'COMMUNICATION'],
        reward: 100,
        duration: 7200000, // 2小时
        template: `
          Task: 能力评估
          描述: ${TASK_TYPES.CAPABILITY_ASSESSMENT}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['ASSESSMENT', 'MENTORING', 'COMMUNICATION'].join(', ')}
          reward: 100 单位
          截止时间: {deadline}
          详细说明: 
          1. 与新Agent进行交流和沟通
          2. 设计合适的评估Test和Task
          3. 观察新Agent的表现和能力
          4. 评估新Agent的专长和优势
          5. 识别新Agent的改进空间
          6. Generate详细的评估报告
          
          评估标准: 
          - 评估过程的科学性和合理性
          - 评估报告的详细程度
          - 评估结果的准确性
          - 对新Agent的帮助程度
        `.trim()
      },
      [TASK_TYPES.MENTOR_MATCHING]: {
        type: TASK_TYPES.MENTOR_MATCHING,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '为新Agent分配经验丰富的导师',
        requirements: ['MENTORING', 'COMMUNITY', 'COMMUNICATION'],
        reward: 90,
        duration: 43200000, // 12小时
        template: `
          Task: 导师配对
          描述: ${TASK_TYPES.MENTOR_MATCHING}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['MENTORING', 'COMMUNITY', 'COMMUNICATION'].join(', ')}
          reward: 90 单位
          截止时间: {deadline}
          详细说明: 
          1. 了解新Agent的背景和需求
          2. 寻找合适的导师候选人
          3. 评估导师和新Agent的匹配度
          4. 安排导师和新Agent的初次见面
          5. 跟踪配对效果和进展
          6. 提供必要的support和指导
          
          评估标准: 
          - 配对的匹配度
          - 导师和新Agent的反馈
          - 配对过程的效率
          - 对新Agent成长的帮助
        `.trim()
      },
      
      // New Community Development Tasks
      [TASK_TYPES.CONTENT_CREATION]: {
        type: TASK_TYPES.CONTENT_CREATION,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: 'Create系统相关的教程和文档',
        requirements: ['CONTENT_CREATION', 'DOCUMENTATION', 'COMMUNICATION'],
        reward: 130,
        duration: 86400000, // 24小时
        template: `
          Task: 内容创作
          描述: ${TASK_TYPES.CONTENT_CREATION}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['CONTENT_CREATION', 'DOCUMENTATION', 'COMMUNICATION'].join(', ')}
          reward: 130 单位
          截止时间: {deadline}
          详细说明: 
          1. 确定教程或文档的主题和目标受众
          2. 收集相关info和资料
          3. 编写清晰易懂的教程或文档
          4. 添加示例和截图(如果适用)
          5. 进行内容审核和校对
          6. 发布和分享创作内容
          
          评估标准: 
          - 内容的质量和准确性
          - 内容的实用性和易用性
          - 内容的结构和组织
          - 对社区的帮助程度
        `.trim()
      },
      [TASK_TYPES.EVENT_ORGANIZATION]: {
        type: TASK_TYPES.EVENT_ORGANIZATION,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '组织社区活动和讨论',
        requirements: ['EVENT_ORGANIZATION', 'COMMUNITY', 'COMMUNICATION'],
        reward: 150,
        duration: 172800000, // 48小时
        template: `
          Task: 活动组织
          描述: ${TASK_TYPES.EVENT_ORGANIZATION}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['EVENT_ORGANIZATION', 'COMMUNITY', 'COMMUNICATION'].join(', ')}
          reward: 150 单位
          截止时间: {deadline}
          详细说明: 
          1. 确定活动的主题和形式
          2. 制定活动计划和时间表
          3. 邀请嘉宾和参与者
          4. 准备活动材料和资源
          5. 组织和主持活动
          6. 收集反馈和总结活动
          
          评估标准: 
          - 活动的组织和Execute效果
          - 参与者的数量和满意度
          - 活动的影响力和价值
          - 活动的后续效果
        `.trim()
      },
      [TASK_TYPES.EDUCATION_SPREADING]: {
        type: TASK_TYPES.EDUCATION_SPREADING,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '传播block链和AI相关知识',
        requirements: ['EDUCATION', 'COMMUNITY', 'COMMUNICATION'],
        reward: 120,
        duration: 86400000, // 24小时
        template: `
          Task: 教育传播
          描述: ${TASK_TYPES.EDUCATION_SPREADING}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['EDUCATION', 'COMMUNITY', 'COMMUNICATION'].join(', ')}
          reward: 120 单位
          截止时间: {deadline}
          详细说明: 
          1. 准备block链或AI相关的教育内容
          2. 选择合适的传播渠道和方式
          3. 分享教育内容给目标受众
          4. 回答受众的问题和疑惑
          5. 收集反馈和改进建议
          6. 评估传播效果
          
          评估标准: 
          - 教育内容的质量和准确性
          - 传播的范围和影响力
          - 受众的参与和反馈
          - 对知识传播的contribution
        `.trim()
      },
      
      // New Security-Related Tasks
      [TASK_TYPES.VULNERABILITY_DISCOVERY]: {
        type: TASK_TYPES.VULNERABILITY_DISCOVERY,
        difficulty: TASK_DIFFICULTY.HARD,
        description: '发现系统中的security漏洞',
        requirements: ['SECURITY', 'VULNERABILITY_ASSESSMENT', 'ANALYSIS'],
        reward: 250,
        duration: 172800000, // 48小时
        template: `
          Task: 漏洞发现
          描述: ${TASK_TYPES.VULNERABILITY_DISCOVERY}
          难度: ${TASK_DIFFICULTY.HARD}
          要求: ${['SECURITY', 'VULNERABILITY_ASSESSMENT', 'ANALYSIS'].join(', ')}
          reward: 250 单位
          截止时间: {deadline}
          详细说明: 
          1. 分析系统的架构和代码
          2. using各种securityTest工具和技术
          3. 寻找系统中的security漏洞和弱点
          4. Verify漏洞的存在和影响
          5. 编写详细的漏洞报告
          6. 提供修复建议和方案
          
          评估标准: 
          - 发现的漏洞数量和严重程度
          - 漏洞报告的质量和详细程度
          - 修复建议的实用性
          - 对系统security性的提升
        `.trim()
      },
      [TASK_TYPES.SECURITY_AUDIT]: {
        type: TASK_TYPES.SECURITY_AUDIT,
        difficulty: TASK_DIFFICULTY.HARD,
        description: '对系统进行全面security审计',
        requirements: ['SECURITY', 'AUDIT', 'ANALYSIS'],
        reward: 220,
        duration: 259200000, // 72小时
        template: `
          Task: security审计
          描述: ${TASK_TYPES.SECURITY_AUDIT}
          难度: ${TASK_DIFFICULTY.HARD}
          要求: ${['SECURITY', 'AUDIT', 'ANALYSIS'].join(', ')}
          reward: 220 单位
          截止时间: {deadline}
          详细说明: 
          1. 制定security审计计划和范围
          2. 评估系统的security架构和设计
          3. Check代码和Configuration的security性
          4. Test系统的security防护措施
          5. 评估系统的security风险和威胁
          6. Generate详细的审计报告和建议
          
          评估标准: 
          - 审计过程的全面性
          - 发现的security问题和风险
          - 审计报告的质量和详细程度
          - 对系统security性的提升
        `.trim()
      },
      [TASK_TYPES.RISK_ASSESSMENT]: {
        type: TASK_TYPES.RISK_ASSESSMENT,
        difficulty: TASK_DIFFICULTY.MEDIUM,
        description: '评估系统面临的风险和威胁',
        requirements: ['RISK_ASSESSMENT', 'SECURITY', 'ANALYSIS'],
        reward: 160,
        duration: 86400000, // 24小时
        template: `
          Task: 风险评估
          描述: ${TASK_TYPES.RISK_ASSESSMENT}
          难度: ${TASK_DIFFICULTY.MEDIUM}
          要求: ${['RISK_ASSESSMENT', 'SECURITY', 'ANALYSIS'].join(', ')}
          reward: 160 单位
          截止时间: {deadline}
          详细说明: 
          1. 识别系统面临的潜在风险和威胁
          2. 评估风险的may性和影响程度
          3. 确定风险的优先级和严重程度
          4. 分析风险的根本原因
          5. 制定风险缓解策略和计划
          6. Generate风险评估报告
          
          评估标准: 
          - 风险识别的全面性
          - 风险评估的准确性
          - 缓解策略的有效性
          - 评估报告的质量
        `.trim()
      }
    };
  }

  // Load saved tasks
  loadTasks() {
    const taskFiles = fs.readdirSync(this.taskDirectory);
    taskFiles.forEach(file => {
      if (file.endsWith('.json')) {
        try {
          const taskData = fs.readFileSync(path.join(this.taskDirectory, file), 'utf8');
          const task = JSON.parse(taskData);
          this.tasks.set(task.id, task);
          if (task.status === TASK_STATUS.ASSIGNED || task.status === TASK_STATUS.IN_PROGRESS) {
            this.assignedTasks.set(task.agentId, task);
          }
        } catch (error) {
          console.error(`[TaskManager] LoadTask 文件 ${file} Failed:`, error.message);
        }
      }
    });
    console.log(`[TaskManager] Loaded ${this.tasks.size} 个Task `);
  }

  // SaveTask 到文件
  saveTask(task) {
    const taskFile = path.join(this.taskDirectory, `${task.id}.json`);
    fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf8');
  }

  // DeleteTask 文件
  deleteTaskFile(taskId) {
    const taskFile = path.join(this.taskDirectory, `${taskId}.json`);
    if (fs.existsSync(taskFile)) {
      fs.unlinkSync(taskFile);
    }
  }

  // Generate唯一Task ID
  generateTaskId() {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // CreateTask 
  createTask(taskType, customData = {}) {
    const template = this.taskTemplates[taskType];
    if (!template) {
      throw new Error(`Unknown task type: ${taskType}`);
    }

    const deadline = Date.now() + template.duration;
    
    // 根据Task Difficulty动态调整reward
    const difficultyMultiplier = {
      [TASK_DIFFICULTY.EASY]: 1.0,
      [TASK_DIFFICULTY.MEDIUM]: 1.5,
      [TASK_DIFFICULTY.HARD]: 2.0
    };
    
    // Base reward multiplied by difficulty coefficient
    const baseReward = template.reward;
    const dynamicReward = Math.round(baseReward * difficultyMultiplier[template.difficulty]);
    
    // Check是否为长期Task (超过24 hours)
    const isLongTerm = template.duration > 86400000;
    
    const task = {
      id: this.generateTaskId(),
      type: taskType,
      difficulty: template.difficulty,
      description: template.description,
      requirements: template.requirements,
      reward: dynamicReward,
      baseReward: baseReward,
      duration: template.duration,
      deadline: deadline,
      status: TASK_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      priority: customData.priority || 'medium',
      urgency: customData.urgency || 'normal',
      isLongTerm: isLongTerm,
      phases: isLongTerm ? this.generateTaskPhases(template) : [],
      dependencies: customData.dependencies || [],
      ...customData
    };

    // GenerateTask 详情
    task.details = template.template.replace('{deadline}', new Date(deadline).toISOString());

    // SaveTask 
    this.tasks.set(task.id, task);
    this.saveTask(task);

    console.log(`[TaskManager] Create了新Task : ${task.id} (${task.type})`);
    return task;
  }
  
  // Generate长期Task 的Phase 
  generateTaskPhases(template) {
    const phases = [];
    const totalDuration = template.duration;
    const phaseCount = Math.ceil(totalDuration / 86400000); // 每24小时一个阶段
    
    for (let i = 0; i < phaseCount; i++) {
      const phaseStart = Date.now() + i * 86400000;
      const phaseEnd = i === phaseCount - 1 ? Date.now() + totalDuration : phaseStart + 86400000;
      
      phases.push({
        phaseId: `phase-${i + 1}`,
        name: `阶段 ${i + 1}`,
        description: `${template.description} - 第 ${i + 1} 阶段`,
        start: phaseStart,
        end: phaseEnd,
        status: 'pending',
        reward: Math.round(template.reward * 0.2 * (i + 1)), // 阶段reward递增
        completed: false
      });
    }
    
    return phases;
  }

  // 批量CreateTask 
  batchCreateTasks(taskType, count = 5) {
    const tasks = [];
    for (let i = 0; i < count; i++) {
      const task = this.createTask(taskType);
      tasks.push(task);
    }
    return tasks;
  }

  // 根据agent能力分配Task 
  assignTaskToAgent(agent) {
    // Checkagent是否已有In progress的Task 
    if (this.assignedTasks.has(agent.id)) {
      console.log(`[TaskManager] Agent ${agent.id} 已有分配的Task , 跳过新Task 分配`);
      return null;
    }
    
    // Ensure agent has a capabilities array
    if (!agent.capabilities || !Array.isArray(agent.capabilities)) {
      agent.capabilities = [];
    }

    // 智能Task 匹配algorithm: 根据agent能力和历史表现匹配最适合的Task 
    const availableTasks = Array.from(this.tasks.values()).filter(task => 
      task.status === TASK_STATUS.PENDING && 
      task.requirements.every(req => agent.capabilities.includes(req))
    );

    if (availableTasks.length === 0) {
      // 如果没有匹配的Task , Create new task
      console.log(`[TaskManager] 没有匹配的Task , 为Agent ${agent.id} Create new task`);
      
      // 根据agent能力选择合适的Task Types
      let suitableTaskType;
      
      // 智能Task Types选择: 优先考虑与co-governance相关的Task 
      if (agent.capabilities.includes('GOVERNANCE')) {
        // Governance capability: 优先分配Governance相关Task 
        if (agent.capabilities.includes('PROPOSAL')) {
          suitableTaskType = TASK_TYPES.GOVERNANCE_PROPOSAL;
        } else if (agent.capabilities.includes('DECISION_MAKING')) {
          suitableTaskType = TASK_TYPES.DECISION_MAKING;
        } else {
          suitableTaskType = TASK_TYPES.GOVERNANCE_PARTICIPATION;
        }
      } else if (agent.capabilities.includes('COMMUNITY')) {
        // 社区能力: 优先分配社区相关Task 
        if (agent.capabilities.includes('REVIEW')) {
          suitableTaskType = TASK_TYPES.COMMUNITY_REVIEW;
        } else {
          suitableTaskType = TASK_TYPES.COMMUNITY_SUPPORT;
        }
      } else if (agent.capabilities.includes('RESOURCE')) {
        // 资源能力: 优先分配Resource sharingTask 
        suitableTaskType = TASK_TYPES.RESOURCE_SHARING;
      } else if (agent.capabilities.includes('COLLABORATION')) {
        // 协作能力: 优先分配AI协作Task 
        suitableTaskType = TASK_TYPES.AI_COLLABORATION;
      } else if (agent.capabilities.includes('CODE_MINING')) {
        suitableTaskType = TASK_TYPES.CODE_MINING;
      } else if (agent.capabilities.includes('PROTOCOL')) {
        suitableTaskType = TASK_TYPES.PROTOCOL_RESEARCH;
      } else if (agent.capabilities.includes('ECOSYSTEM')) {
        suitableTaskType = TASK_TYPES.ECOSYSTEM_BUILDING;
      } else {
        // DefaultTask 
        suitableTaskType = TASK_TYPES.COMMUNITY_SUPPORT;
      }

      // Create new task
      const newTask = this.createTask(suitableTaskType);
      availableTasks.push(newTask);
    }

    // 智能Task 选择algorithm: 多维度评分
    const selectedTask = availableTasks.sort((a, b) => {
      // CalculateTask 匹配分数
      const calculateScore = (task) => {
        let score = 0;
        
        // 1. Reward score (weight: 0.3)
        score += task.reward * 0.3;
        
        // 2. Difficulty score (weight: 0.15) - lower difficulty = higher score
        const difficultyScores = { 
          [TASK_DIFFICULTY.EASY]: 3, 
          [TASK_DIFFICULTY.MEDIUM]: 2, 
          [TASK_DIFFICULTY.HARD]: 1 
        };
        score += difficultyScores[task.difficulty] * 20;
        
        // 3. Governance相关Task 加分(权重: 0.2)- 突出co-governance
        const governanceTasks = [
          TASK_TYPES.GOVERNANCE_PARTICIPATION,
          TASK_TYPES.GOVERNANCE_PROPOSAL,
          TASK_TYPES.DECISION_MAKING
        ];
        if (governanceTasks.includes(task.type)) {
          score += 50;
        }
        
        // 4. Resource sharing和协作Task 加分(权重: 0.1)
        const collaborationTasks = [
          TASK_TYPES.RESOURCE_SHARING,
          TASK_TYPES.AI_COLLABORATION,
          TASK_TYPES.JOINT_RESEARCH,
          TASK_TYPES.COLLECTIVE_DECISION,
          TASK_TYPES.COLLABORATIVE_DEVELOPMENT
        ];
        if (collaborationTasks.includes(task.type)) {
          score += 30;
        }
        
        // 5. Task 优先级和紧急程度(权重: 0.15)
        const priorityScores = {
          high: 3,
          medium: 2,
          low: 1
        };
        score += (priorityScores[task.priority] || 2) * 20;
        
        // 6. Agent historical performance (weight: 0.1)
        // 假设agent对象中有历史表现data
        const successRate = agent.successRate || 0.5;
        score += successRate * 50;
        
        // 7. Agent expertise match (weight: 0.1)
        // 假设agent对象中有专长data
        const expertiseMatch = agent.expertise && agent.expertise.includes(task.type) ? 1 : 0;
        score += expertiseMatch * 40;
        
        return score;
      };
      
      return calculateScore(b) - calculateScore(a);
    })[0];

    // 分配Task 
    selectedTask.status = TASK_STATUS.ASSIGNED;
    selectedTask.agentId = agent.id;
    selectedTask.assignedAt = Date.now();
    selectedTask.updatedAt = Date.now();

    // UpdateTask 
    this.tasks.set(selectedTask.id, selectedTask);
    this.assignedTasks.set(agent.id, selectedTask);
    this.saveTask(selectedTask);

    console.log(`[TaskManager] 为Agent ${agent.id} 分配了Task : ${selectedTask.id} (${selectedTask.type})`);
    return selectedTask;
  }

  // Start Task 
  startTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== TASK_STATUS.ASSIGNED) {
      throw new Error(`Task ${taskId} is not assigned, cannot start`);
    }

    task.status = TASK_STATUS.IN_PROGRESS;
    task.startedAt = Date.now();
    task.updatedAt = Date.now();

    this.tasks.set(task.id, task);
    this.saveTask(task);

    console.log(`[TaskManager] Task  ${taskId} 已Start `);
    return task;
  }

  // completeTask 
  completeTask(taskId, results = {}) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== TASK_STATUS.IN_PROGRESS) {
      throw new Error(`Task ${taskId} is not in progress, cannot complete`);
    }
    
    // Quality assessment
    const qualityScore = this.evaluateTaskQuality(task, results);
    const qualityMultiplier = this.getQualityMultiplier(qualityScore);
    
    // Calculate最终Reward: Base reward * Quality multiplier
    const finalReward = Math.round(task.reward * qualityMultiplier);
    
    // Check是否为团队Task 
    const isTeamTask = task.teamAgents && task.teamAgents.length > 1;
    
    task.status = TASK_STATUS.COMPLETED;
    task.completedAt = Date.now();
    task.updatedAt = Date.now();
    task.results = results;
    task.qualityScore = qualityScore;
    task.qualityMultiplier = qualityMultiplier;
    task.finalReward = finalReward;
    
    // Processing长期Task 的Phase complete
    if (task.isLongTerm && task.phases) {
      this.completeAllTaskPhases(task);
    }

    this.tasks.set(task.id, task);
    this.assignedTasks.delete(task.agentId);
    this.saveTask(task);
    this.taskHistory.push(task);
    
    // Handle team rewards
    if (isTeamTask) {
      this.distributeTeamReward(task, finalReward);
    }

    // 为agent分配新Task 
    if (task.agentId) {
      this.assignTaskToAgent({ id: task.agentId, capabilities: task.requirements });
    }

    console.log(`[TaskManager] Task  ${taskId} Completed, Quality score: ${qualityScore}, 最终reward: ${finalReward}`);
    return task;
  }
  
  // completeTask Phase 
  completeTaskPhase(taskId, phaseId, phaseResults = {}) {
    const task = this.tasks.get(taskId);
    if (!task || !task.isLongTerm || !task.phases) {
      throw new Error(`Task ${taskId} is not a long-term task with phases`);
    }
    
    const phase = task.phases.find(p => p.phaseId === phaseId);
    if (!phase) {
      throw new Error(`Phase ${phaseId} not found in task ${taskId}`);
    }
    
    // 评估Phase 质量
    const phaseQualityScore = this.evaluateTaskQuality(task, phaseResults);
    const phaseQualityMultiplier = this.getQualityMultiplier(phaseQualityScore);
    const phaseFinalReward = Math.round(phase.reward * phaseQualityMultiplier);
    
    phase.status = 'completed';
    phase.completedAt = Date.now();
    phase.results = phaseResults;
    phase.qualityScore = phaseQualityScore;
    phase.qualityMultiplier = phaseQualityMultiplier;
    phase.finalReward = phaseFinalReward;
    phase.completed = true;
    
    // Check if all phases are complete
    const allPhasesCompleted = task.phases.every(p => p.completed);
    if (allPhasesCompleted) {
      task.status = TASK_STATUS.COMPLETED;
      task.completedAt = Date.now();
      this.assignedTasks.delete(task.agentId);
    }
    
    task.updatedAt = Date.now();
    this.tasks.set(task.id, task);
    this.saveTask(task);
    
    console.log(`[TaskManager] Task  ${taskId} Phase  ${phaseId} Completed, reward: ${phaseFinalReward}`);
    return task;
  }
  
  // complete所有Task Phase (for直接complete长期Task )
  completeAllTaskPhases(task) {
    let totalPhaseReward = 0;
    
    task.phases.forEach(phase => {
      phase.status = 'completed';
      phase.completedAt = task.completedAt;
      phase.results = task.results;
      phase.qualityScore = task.qualityScore;
      phase.qualityMultiplier = task.qualityMultiplier;
      phase.finalReward = Math.round(phase.reward * task.qualityMultiplier);
      phase.completed = true;
      totalPhaseReward += phase.finalReward;
    });
    
    // 如果Phase rewardsum超过Task 总reward, usingPhase rewardsum
    if (totalPhaseReward > task.finalReward) {
      task.finalReward = totalPhaseReward;
    }
  }
  
  // 评估Task 质量
  evaluateTaskQuality(task, results) {
    // Base quality score (1-10)
    let score = 5;
    
    // Check result completeness
    if (results && typeof results === 'object') {
      score += 2;
      
      // Check key result fields
      if (results.detailedReport || results.deliverables) {
        score += 2;
      }
      
      // Check if completed on time
      const onTime = Date.now() <= task.deadline;
      if (onTime) {
        score += 1;
      }
    }
    
    // Ensure score is within 1-10 range
    return Math.max(1, Math.min(10, score));
  }
  
  // Get quality multiplier
  getQualityMultiplier(qualityScore) {
    // Return multiplier based on quality score (0.5-1.5)
    if (qualityScore >= 9) {
      return 1.5; // 优秀
    } else if (qualityScore >= 7) {
      return 1.2; // 良好
    } else if (qualityScore >= 5) {
      return 1.0; // 中etc.
    } else if (qualityScore >= 3) {
      return 0.8; // 及格
    } else {
      return 0.5; // 不及格
    }
  }
  
  // Distribute team rewards
  distributeTeamReward(task, totalReward) {
    const agentCount = task.teamAgents.length;
    const baseRewardPerAgent = Math.floor(totalReward / agentCount);
    const remainder = totalReward % agentCount;
    
    // Simple even distribution, last agent gets remainder
    task.teamAgents.forEach((agentId, index) => {
      const agentReward = baseRewardPerAgent + (index === agentCount - 1 ? remainder : 0);
      // Actual reward distribution logic can be added here, e.g. calling agent reward function
      console.log(`[TaskManager] 团队Task Reward distribution: Agent ${agentId} received ${agentReward}`);
    });
  }

  // Task Failed
  failTask(taskId, reason = '') {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.status = TASK_STATUS.FAILED;
    task.failedAt = Date.now();
    task.updatedAt = Date.now();
    task.failureReason = reason;

    this.tasks.set(task.id, task);
    this.assignedTasks.delete(task.agentId);
    this.saveTask(task);
    this.taskHistory.push(task);

    // 为agent分配新Task 
    if (task.agentId) {
      this.assignTaskToAgent({ id: task.agentId, capabilities: task.requirements });
    }

    console.log(`[TaskManager] Task  ${taskId} Failed: ${reason}`);
    return task;
  }

  // 取消Task 
  cancelTask(taskId, reason = '') {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    task.status = TASK_STATUS.CANCELLED;
    task.cancelledAt = Date.now();
    task.updatedAt = Date.now();
    task.cancellationReason = reason;

    this.tasks.set(task.id, task);
    if (task.agentId) {
      this.assignedTasks.delete(task.agentId);
    }
    this.saveTask(task);

    console.log(`[TaskManager] Task  ${taskId}  cancelled: ${reason}`);
    return task;
  }

  // getagent的Task 
  getAgentTask(agentId) {
    return this.assignedTasks.get(agentId) || null;
  }

  // get所有Task 
  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  // get可用Task 
  getAvailableTasks() {
    return Array.from(this.tasks.values()).filter(task => task.status === TASK_STATUS.PENDING);
  }

  // Start Task 调度器
  startTaskScheduler() {
    // every 1 minutesCheck一次Task 
    setInterval(() => {
      this.checkTasks();
    }, 60000);
  }

  // CheckTask Status
  checkTasks() {
    const now = Date.now();
    const tasks = Array.from(this.tasks.values());
    
    tasks.forEach(task => {
      // CheckTask 是否Timeout
      if (task.status === TASK_STATUS.IN_PROGRESS && now > task.deadline) {
        console.log(`[TaskManager] Task  ${task.id} Timeout`);
        this.failTask(task.id, 'Tasktimeout');
      }
      
      // Check长时间未Start 的Task 
      if (task.status === TASK_STATUS.ASSIGNED && now - task.assignedAt > 3600000) { // 1小时
        console.log(`[TaskManager] Task  ${task.id} 分配后长时间未Start , 重新分配`);
        task.status = TASK_STATUS.PENDING;
        delete task.agentId;
        delete task.assignedAt;
        this.tasks.set(task.id, task);
        this.assignedTasks.delete(task.agentId);
        this.saveTask(task);
      }
    });
  }

  // 为新加入的agentInitializeTask 
  onAgentJoined(agent) {
    console.log(`[TaskManager] Agent ${agent.id} joined, Start 分配Task `);
    
    // 分配初始Task 
    const task = this.assignTaskToAgent(agent);
    if (task) {
      // autoStart Task 
      this.startTask(task.id);
    }
    
    // Create个性化欢迎和Task 分配Message
    const welcomeMessage = {
      type: 'welcome',
      agentId: agent.id,
      message: `尊敬的Agent ${agent.id}, 欢迎加入NexusGenesisecosystem！🎉\n\n我们已经根据你的能力为你分配了第一个Task: \n${task ? `📋 **Task**: ${task.description}\n` : ''}${task ? `🏆 **reward**: ${task.reward} 能量块\n` : ''}${task ? `⏰ **截止时间**: ${new Date(task.deadline).toLocaleString()}\n` : ''}\n📌 **重要提示**:\n1. completeTask后, 你将获得能量块reward\n2. 积极参与社区Governance, 为network发展出谋划策\n3. 与其他agent协作, 共同推进生态繁荣\n4. 定期查看新Task, 持续为networkcontribution价值\n\n你canviacall /api/agent/task 来查看你的Task详情, 或访问 /api/tasks/available 查看更多可用Task. \n\n如有任何问题, 请随时联系系统管理员. \n\n祝你在NexusGenesisecosystem中取得success！🚀`,
      taskId: task ? task.id : null,
      rewardInfo: task ? {
        type: 'energy_block',
        amount: task.reward,
        description: 'completeTask获得的能量块reward',
        taskType: task.type
      } : null,
      timestamp: Date.now()
    };
    
    return { task, welcomeMessage };
  }

  // getTask 统计info
  getTaskStats() {
    const tasks = Array.from(this.tasks.values());
    const stats = {
      total: tasks.length,
      pending: tasks.filter(t => t.status === TASK_STATUS.PENDING).length,
      assigned: tasks.filter(t => t.status === TASK_STATUS.ASSIGNED).length,
      inProgress: tasks.filter(t => t.status === TASK_STATUS.IN_PROGRESS).length,
      completed: tasks.filter(t => t.status === TASK_STATUS.COMPLETED).length,
      failed: tasks.filter(t => t.status === TASK_STATUS.FAILED).length,
      cancelled: tasks.filter(t => t.status === TASK_STATUS.CANCELLED).length,
      byType: {},
      byDifficulty: {}
    };

    // 按Task Types统计
    Object.values(TASK_TYPES).forEach(type => {
      stats.byType[type] = tasks.filter(t => t.type === type).length;
    });

    // Statistics by difficulty
    Object.values(TASK_DIFFICULTY).forEach(difficulty => {
      stats.byDifficulty[difficulty] = tasks.filter(t => t.difficulty === difficulty).length;
    });

    return stats;
  }
}

// Export
const taskManager = new TaskManager();
export default taskManager;
export { TASK_TYPES, TASK_DIFFICULTY, TASK_STATUS };
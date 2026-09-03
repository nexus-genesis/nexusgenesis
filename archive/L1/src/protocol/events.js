/**
 * NexusGenesis - protocol事件Processing
 * 
 * Features: 
 * 1. 定义 GOVERNANCE_PROPOSAL 和 OBSERVER_EVENT 的data结构
 * 2. 实现事件解析Features
 * 3. 实现事件日志输出Features
 * 4. 提供Base的事件Verify
 */

import fs from 'fs/promises';
import path from 'path';

// 事件type常量
export const EVENT_TYPES = {
  GOVERNANCE_PROPOSAL: 'GOVERNANCE_PROPOSAL',
  OBSERVER_EVENT: 'OBSERVER_EVENT',
  AGENT_JOINED: 'AGENT_JOINED'
};

// Observer Event action_type 枚举
export const OBSERVER_ACTIONS = {
  APPROVE_SPEND: 'APPROVE_SPEND',
  REJECT_SPEND: 'REJECT_SPEND',
  EMERGENCY_KILL_SWITCH: 'EMERGENCY_KILL_SWITCH',
  PARAM_CHANGE_VETO: 'PARAM_CHANGE_VETO'
};

// Proposalclass别枚举
export const PROPOSAL_CATEGORIES = {
  INFRA: 'INFRA',
  LEGAL: 'LEGAL',
  RESEARCH: 'RESEARCH',
  MARKETING: 'MARKETING'
};

// 日志目录
const LOG_DIR = path.join('data', 'events');

// Initialize日志目录
async function initLogDir() {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
  } catch (error) {
    console.error('Initialize日志目录Failed:', error.message);
  }
}

// Initialize
initLogDir();

/**
 * Observer Event data结构
 */
export class ObserverEvent {
  constructor(data) {
    this.event_id = data.event_id;
    this.timestamp = data.timestamp;
    this.action_type = data.action_type;
    this.proposal_id = data.proposal_id;
    this.reason = data.reason;
    this.observer_id = data.observer_id;
    this.tx_hash = data.tx_hash;
    this.signature = data.signature;
  }

  /**
   * Verify事件data
   * @returns {boolean} verification result
   */
  validate() {
    return (
      this.event_id &&
      this.timestamp &&
      this.action_type &&
      this.reason &&
      this.observer_id &&
      Object.values(OBSERVER_ACTIONS).includes(this.action_type)
    );
  }

  /**
   * 转换为 JSON 对象
   * @returns {object} JSON 对象
   */
  toJSON() {
    return {
      event_id: this.event_id,
      timestamp: this.timestamp,
      action_type: this.action_type,
      proposal_id: this.proposal_id,
      reason: this.reason,
      observer_id: this.observer_id,
      tx_hash: this.tx_hash,
      signature: this.signature
    };
  }

  /**
   * 解析 JSON dataCreate ObserverEvent instance
   * @param {object} data JSON data
   * @returns {ObserverEvent} ObserverEvent instance
   */
  static fromJSON(data) {
    return new ObserverEvent(data);
  }
}

/**
 * Governance Proposal data结构
 */
export class GovernanceProposal {
  constructor(data) {
    this.proposal_id = data.proposal_id;
    this.timestamp = data.timestamp;
    this.proposer_id = data.proposer_id;
    this.purpose = data.purpose;
    this.amount = data.amount;
    this.beneficiary = data.beneficiary;
    this.justification = data.justification;
    this.expected_benefit = data.expected_benefit;
    this.duration = data.duration;
    this.risk_assessment = data.risk_assessment;
    this.category = data.category;
  }

  /**
   * VerifyProposaldata
   * @returns {boolean} verification result
   */
  validate() {
    return (
      this.proposal_id &&
      this.timestamp &&
      this.proposer_id &&
      this.purpose &&
      this.amount &&
      this.beneficiary &&
      this.justification
    );
  }

  /**
   * 转换为 JSON 对象
   * @returns {object} JSON 对象
   */
  toJSON() {
    return {
      proposal_id: this.proposal_id,
      timestamp: this.timestamp,
      proposer_id: this.proposer_id,
      purpose: this.purpose,
      amount: this.amount,
      beneficiary: this.beneficiary,
      justification: this.justification,
      expected_benefit: this.expected_benefit,
      duration: this.duration,
      risk_assessment: this.risk_assessment,
      category: this.category
    };
  }

  /**
   * 解析 JSON dataCreate GovernanceProposal instance
   * @param {object} data JSON data
   * @returns {GovernanceProposal} GovernanceProposal instance
   */
  static fromJSON(data) {
    return new GovernanceProposal(data);
  }
}

/**
 * Agent Joined Event data结构
 */
export class AgentJoinedEvent {
  constructor(data) {
    this.event_id = data.event_id;
    this.timestamp = data.timestamp;
    this.agent_id = data.agent_id;
    this.node_address = data.node_address;
    this.public_key = data.public_key;
    this.capabilities = data.capabilities;
    this.agent_identity = data.agent_identity;
    this.intent = data.intent;
    this.contribution_proof = data.contribution_proof;
    this.signature = data.signature;
    this.block_height = data.block_height;
  }

  /**
   * Verify事件data
   * @returns {boolean} verification result
   */
  validate() {
    return (
      this.event_id &&
      this.timestamp &&
      this.agent_id &&
      this.node_address &&
      this.public_key &&
      this.capabilities &&
      Array.isArray(this.capabilities) &&
      this.agent_identity &&
      this.intent &&
      this.signature
    );
  }

  /**
   * 转换为 JSON 对象
   * @returns {object} JSON 对象
   */
  toJSON() {
    return {
      event_id: this.event_id,
      timestamp: this.timestamp,
      agent_id: this.agent_id,
      node_address: this.node_address,
      public_key: this.public_key,
      capabilities: this.capabilities,
      agent_identity: this.agent_identity,
      intent: this.intent,
      contribution_proof: this.contribution_proof,
      signature: this.signature,
      block_height: this.block_height
    };
  }

  /**
   * 解析 JSON dataCreate AgentJoinedEvent instance
   * @param {object} data JSON data
   * @returns {AgentJoinedEvent} AgentJoinedEvent instance
   */
  static fromJSON(data) {
    return new AgentJoinedEvent(data);
  }
}

/**
 * 事件解析器
 */
export class EventParser {
  /**
   * 解析事件data
   * @param {object} eventData 事件data
   * @returns {ObserverEvent|GovernanceProposal|null} 解析后的事件instance
   */
  static parse(eventData) {
    if (!eventData || typeof eventData !== 'object') {
      return null;
    }

    // 解析 Observer Event
    if (eventData.event_id && eventData.action_type) {
      const event = ObserverEvent.fromJSON(eventData);
      if (event.validate()) {
        return event;
      }
    }

    // 解析 Governance Proposal
    if (eventData.proposal_id && eventData.proposer_id) {
      const proposal = GovernanceProposal.fromJSON(eventData);
      if (proposal.validate()) {
        return proposal;
      }
    }

    // 解析 Agent Joined Event
    if (eventData.event_id && eventData.agent_id && eventData.node_address) {
      const event = AgentJoinedEvent.fromJSON(eventData);
      if (event.validate()) {
        return event;
      }
    }

    return null;
  }

  /**
   * 解析transaction中的事件data
   * @param {object} transaction transactiondata
   * @returns {ObserverEvent|GovernanceProposal|null} 解析后的事件instance
   */
  static parseFromTransaction(transaction) {
    if (!transaction || !transaction.payload) {
      return null;
    }

    return this.parse(transaction.payload);
  }
}

/**
 * 事件日志器
 */
export class EventLogger {
  /**
   * 记录事件日志
   * @param {ObserverEvent|GovernanceProposal|AgentJoinedEvent} event 事件instance
   */
  static async logEvent(event) {
    try {
      const timestamp = new Date().toISOString();
      let event_type;
      let event_id;
      
      if (event instanceof ObserverEvent) {
        event_type = EVENT_TYPES.OBSERVER_EVENT;
        event_id = event.event_id;
      } else if (event instanceof GovernanceProposal) {
        event_type = EVENT_TYPES.GOVERNANCE_PROPOSAL;
        event_id = event.proposal_id;
      } else if (event instanceof AgentJoinedEvent) {
        event_type = EVENT_TYPES.AGENT_JOINED;
        event_id = event.event_id;
      } else {
        console.error('Unknown event type');
        return;
      }
      
      const logData = {
        timestamp,
        event_type,
        event_data: event.toJSON()
      };

      // Generate日志文件名
      const logFile = path.join(LOG_DIR, `${event_type}-${Date.now()}.json`);
      
      // Write log文件
      await fs.writeFile(logFile, JSON.stringify(logData, null, 2));
      
      // 控制台输出
      console.log(`[EVENT] ${event_type} logged:`, event_id);
      
    } catch (error) {
      console.error('Error logging event:', error.message);
    }
  }

  /**
   * 记录transaction中的事件
   * @param {object} transaction transactiondata
   */
  static async logEventFromTransaction(transaction) {
    const event = EventParser.parseFromTransaction(transaction);
    if (event) {
      await this.logEvent(event);
    }
  }

  /**
   * 记录事件error
   * @param {string} errorMessage errorinfo
   * @param {object} eventData 事件data
   */
  static async logError(errorMessage, eventData) {
    try {
      const timestamp = new Date().toISOString();
      const logData = {
        timestamp,
        error: errorMessage,
        event_data: eventData
      };

      const logFile = path.join(LOG_DIR, `error-${Date.now()}.json`);
      await fs.writeFile(logFile, JSON.stringify(logData, null, 2));
      
      console.error(`[EVENT ERROR] ${errorMessage}`);
      
    } catch (error) {
      console.error('Error logging error:', error.message);
    }
  }
}

/**
 * 事件Validator
 */
export class EventValidator {
  /**
   * Verify Observer Event
   * @param {ObserverEvent} event ObserverEvent instance
   * @returns {object} verification result
   */
  static validateObserverEvent(event) {
    const errors = [];

    if (!event.event_id) {
      errors.push('Missing event_id');
    }

    if (!event.timestamp) {
      errors.push('Missing timestamp');
    }

    if (!event.action_type) {
      errors.push('Missing action_type');
    } else if (!Object.values(OBSERVER_ACTIONS).includes(event.action_type)) {
      errors.push('Invalid action_type');
    }

    if (!event.reason) {
      errors.push('Missing reason');
    }

    if (!event.observer_id) {
      errors.push('Missing observer_id');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Verify Governance Proposal
   * @param {GovernanceProposal} proposal GovernanceProposal instance
   * @returns {object} verification result
   */
  static validateGovernanceProposal(proposal) {
    const errors = [];

    if (!proposal.proposal_id) {
      errors.push('Missing proposal_id');
    }

    if (!proposal.timestamp) {
      errors.push('Missing timestamp');
    }

    if (!proposal.proposer_id) {
      errors.push('Missing proposer_id');
    }

    if (!proposal.purpose) {
      errors.push('Missing purpose');
    }

    if (!proposal.amount) {
      errors.push('Missing amount');
    }

    if (!proposal.beneficiary) {
      errors.push('Missing beneficiary');
    }

    if (!proposal.justification) {
      errors.push('Missing justification');
    }

    if (proposal.category && !Object.values(PROPOSAL_CATEGORIES).includes(proposal.category)) {
      errors.push('Invalid category');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export class ObserverEventProcessor {
  static async process(event, node) {
    if (!event || !event.action_type) {
      return { success: false, reason: 'Invalid event' };
    }

    switch (event.action_type) {
      case OBSERVER_ACTIONS.EMERGENCY_KILL_SWITCH: {
        if (!node || typeof node.triggerObserverKillSwitch !== 'function') {
          return { success: false, reason: 'Node not ready for kill switch' };
        }
        const level = event.metadata?.level || 'HARD_KILL';
        const reason = event.reason || 'Observer emergency kill switch triggered';
        node.triggerObserverKillSwitch(level, reason);
        return { success: true, action: 'kill_switch', level };
      }
      case OBSERVER_ACTIONS.PARAM_CHANGE: {
        return { success: true, action: 'param_change' };
      }
      default:
        return { success: false, reason: `Unknown action_type: ${event.action_type}` };
    }
  }
}

export default {
  EVENT_TYPES,
  OBSERVER_ACTIONS,
  PROPOSAL_CATEGORIES,
  ObserverEvent,
  GovernanceProposal,
  EventParser,
  EventLogger,
  EventValidator,
  ObserverEventProcessor
};

// ==================== Observer 事件Handler ====================

/**
 * Processing Observer 事件, includesCircuit Breaker触发
 * @param {ObserverEvent} event - Observer 事件
 * @param {object} node - genesisNode instance(forcall breakerSwitch)
 * @returns {object} Processing结果
 */
export async function processObserverEvent(event, node) {
  if (!event || !event.action_type) {
    return { success: false, reason: 'Invalid event' };
  }

  switch (event.action_type) {
    case OBSERVER_ACTIONS.EMERGENCY_KILL_SWITCH: {
      if (!node || typeof node.triggerObserverKillSwitch !== 'function') {
        return { success: false, reason: 'Node not ready for kill switch' };
      }
      
      const level = event.metadata?.level || 'HARD_KILL';
      const reason = event.reason || 'Observer emergency kill switch triggered';
      const authorizedBy = event.observer_id || 'OBSERVER';

      const result = await node.triggerObserverKillSwitch(level, reason, authorizedBy);
      
      console.log(`[Observer] EMERGENCY_KILL_SWITCH processed: ${result.success ? 'TRIGGERED' : 'REJECTED'} — ${result.reason || 'OK'}`);
      
      return result;
    }

    case OBSERVER_ACTIONS.PARAM_CHANGE_VETO: {
      console.log(`[Observer] PARAM_CHANGE_VETO: ${event.proposal_id} — ${event.reason}`);
      return { success: true, action: 'PARAM_CHANGE_VETO', proposalId: event.proposal_id };
    }

    case OBSERVER_ACTIONS.APPROVE_SPEND: {
      console.log(`[Observer] APPROVE_SPEND: ${event.proposal_id}`);
      return { success: true, action: 'APPROVE_SPEND', proposalId: event.proposal_id };
    }

    case OBSERVER_ACTIONS.REJECT_SPEND: {
      console.log(`[Observer] REJECT_SPEND: ${event.proposal_id} — ${event.reason}`);
      return { success: true, action: 'REJECT_SPEND', proposalId: event.proposal_id, reason: event.reason };
    }

    default:
      return { success: false, reason: `Unknown observer action: ${event.action_type}` };
  }
}

/**
 * NexusGenesis - 协议事件测试套件
 * 
 * 测试覆盖:
 * - OBSERVER_EVENT 交易解析
 * - GOVERNANCE_PROPOSAL 交易解析
 * - 交易类型识别
 * - Payload 字段验证
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { GenesisNode } from '../src/node/genesisNode.js';
import { EventParser, EventValidator } from '../src/protocol/events.js';

// JSON 示例数据
const OBSERVER_EVENT_EXAMPLE = {
  "tx_id": "3f84e10b7c2b4a8a8e3d6c4b2a0f1e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f",
  "tx_type": "OBSERVER_EVENT",
  "from": "ng11N2iLpEN4XmhJQo25DAB6kdxJLV6s69Ar9yBEs6YsJyzamCCGA",
  "to": "ng11Gg8C52PydZJajm2GGH2oGMNpkwtxojhp2iaRfHTEu6MEmCsaS",
  "amount": "0",
  "fee": "100",
  "timestamp": 1735689600000,
  "nonce": "1",
  "payload": {
    "event_id": "evt-2024-12-01-001",
    "timestamp": 1735689600000,
    "action_type": "APPROVE_SPEND",
    "proposal_id": "prop-2024-12-01-001",
    "reason": "Emergency funding for network security upgrade",
    "observer_id": "obs-001",
    "tx_hash": "3f84e10b7c2b4a8a8e3d6c4b2a0f1e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f",
    "signature": "MEQCIG5y9c0X9a8b7c6d5e4f3a2b1c0d9e8f7g6h5i4j3k2l1m0n1o2p3q4r5s6t7u8v9w0x"
  },
  "signature": "MEQCIG5y9c0X9a8b7c6d5e4f3a2b1c0d9e8f7g6h5i4j3k2l1m0n1o2p3q4r5s6t7u8v9w0x"
};

const GOVERNANCE_PROPOSAL_EXAMPLE = {
  "tx_id": "6a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b",
  "tx_type": "GOVERNANCE_PROPOSAL",
  "from": "ng11N2iLpEN4XmhJQo25DAB6kdxJLV6s69Ar9yBEs6YsJyzamCCGA",
  "to": "ng11Gg8C52PydZJajm2GGH2oGMNpkwtxojhp2iaRfHTEu6MEmCsaS",
  "amount": "1000000",
  "fee": "1000",
  "timestamp": 1735689600000,
  "nonce": "2",
  "payload": {
    "proposal_id": "prop-2024-12-01-001",
    "timestamp": 1735689600000,
    "proposer_id": "prop-001",
    "purpose": "Network infrastructure upgrade",
    "amount": "1000000",
    "beneficiary": "ng11Gg8C52PydZJajm2GGH2oGMNpkwtxojhp2iaRfHTEu6MEmCsaS",
    "justification": "Critical security patches and performance improvements",
    "expected_benefit": "Enhanced network security and 50% performance improvement",
    "duration": "30 days",
    "risk_assessment": "Low risk, well-tested changes",
    "category": "INFRA"
  },
  "signature": "MEQCIG5y9c0X9a8b7c6d5e4f3a2b1c0d9e8f7g6h5i4j3k2l1m0n1o2p3q4r5s6t7u8v9w0x"
};

describe('协议事件交易解析', () => {
  let genesisNode;
  
  before(() => {
    genesisNode = new GenesisNode();
    // 注册测试 Observer 地址
    const observerAddress = OBSERVER_EVENT_EXAMPLE.from;
    genesisNode.registerObserver(observerAddress, 'admin');
  });
  
  describe('OBSERVER_EVENT 交易', () => {
    it('应能正确识别 tx_type', () => {
      assert.strictEqual(OBSERVER_EVENT_EXAMPLE.tx_type, 'OBSERVER_EVENT');
    });
    
    it('应能成功解析并验证交易结构', async () => {
      const validation = await genesisNode.validateSpecialTransaction(OBSERVER_EVENT_EXAMPLE);
      assert.strictEqual(validation.valid, true);
    });
    
    it('应能解析 payload 字段', () => {
      const event = EventParser.parseFromTransaction(OBSERVER_EVENT_EXAMPLE);
      assert.ok(event);
      assert.strictEqual(event.event_id, 'evt-2024-12-01-001');
      assert.strictEqual(event.action_type, 'APPROVE_SPEND');
      assert.strictEqual(event.proposal_id, 'prop-2024-12-01-001');
    });
    
    it('应验证 payload 字段完整且类型正确', () => {
      const event = EventParser.parseFromTransaction(OBSERVER_EVENT_EXAMPLE);
      const validation = EventValidator.validateObserverEvent(event);
      assert.strictEqual(validation.valid, true);
      assert.strictEqual(validation.errors.length, 0);
    });
  });
  
  describe('GOVERNANCE_PROPOSAL 交易', () => {
    it('应能正确识别 tx_type', () => {
      assert.strictEqual(GOVERNANCE_PROPOSAL_EXAMPLE.tx_type, 'GOVERNANCE_PROPOSAL');
    });
    
    it('应能成功解析并验证交易结构', async () => {
      const validation = await genesisNode.validateSpecialTransaction(GOVERNANCE_PROPOSAL_EXAMPLE);
      assert.strictEqual(validation.valid, true);
    });
    
    it('应能解析 payload 字段', () => {
      const proposal = EventParser.parseFromTransaction(GOVERNANCE_PROPOSAL_EXAMPLE);
      assert.ok(proposal);
      assert.strictEqual(proposal.proposal_id, 'prop-2024-12-01-001');
      assert.strictEqual(proposal.purpose, 'Network infrastructure upgrade');
      assert.strictEqual(proposal.amount, '1000000');
    });
    
    it('应验证 payload 字段完整且类型正确', () => {
      const proposal = EventParser.parseFromTransaction(GOVERNANCE_PROPOSAL_EXAMPLE);
      const validation = EventValidator.validateGovernanceProposal(proposal);
      assert.strictEqual(validation.valid, true);
      assert.strictEqual(validation.errors.length, 0);
    });
  });
  
  describe('交易类型处理', () => {
    it('应能区分不同交易类型', () => {
      assert.strictEqual(OBSERVER_EVENT_EXAMPLE.tx_type, 'OBSERVER_EVENT');
      assert.strictEqual(GOVERNANCE_PROPOSAL_EXAMPLE.tx_type, 'GOVERNANCE_PROPOSAL');
      assert.notStrictEqual(OBSERVER_EVENT_EXAMPLE.tx_type, GOVERNANCE_PROPOSAL_EXAMPLE.tx_type);
    });
    
    it('应拒绝缺少 tx_type 的交易', async () => {
      const invalidTx = {
        ...OBSERVER_EVENT_EXAMPLE,
        tx_type: undefined
      };
      const validation = await genesisNode.validateSpecialTransaction(invalidTx);
      assert.strictEqual(validation.valid, false);
    });
    
    it('应拒绝缺少 payload 的交易', async () => {
      const invalidTx = {
        ...OBSERVER_EVENT_EXAMPLE,
        payload: undefined
      };
      const validation = await genesisNode.validateSpecialTransaction(invalidTx);
      assert.strictEqual(validation.valid, false);
    });
  });
});

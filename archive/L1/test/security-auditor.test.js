import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SecurityAuditor, SEVERITY, parseBytecode } from '../src/security/securityAuditor.js';
import { ContractTemplateLibrary } from '../src/contracts/templates/contractTemplates.js';

const BASIC_BYTECODE = [
  0x90, 0x11, 0x93, 0x01, 0x61, 0x13, 0x11, 0x01, 0xF0
];

const BYTECODE_WITH_REENTRANCY = [
  0x90, 0x21, 0x13, 0x61, 0x01, 0x22, 0xF0
];

const BYTECODE_WITH_OVERFLOW = [
  0x01, 0x01, 0x02, 0x05, 0x61, 0x13, 0x11, 0xF0
];

const BYTECODE_WITH_NO_ACCESS = [
  0x61, 0x13, 0xF0
];

const BYTECODE_WITH_SELFDESTRUCT = [
  0x33, 0x01, 0x02, 0xF0
];

const BYTECODE_WITH_ALL_CHECKS = [
  0x90, 0x11, 0x01, 0x0C, 0x01, 0x01, 0x01, 0x30,
  0x31, 0x21, 0x32, 0x22, 0xF0
];

describe('SecurityAuditor', () => {
  describe('parseBytecode', () => {
    it('should parse basic bytecode to ops', () => {
      const ops = parseBytecode(BASIC_BYTECODE);
      assert.ok(ops.length > 0);
      assert.strictEqual(ops[0].name, 'CALLER');
      assert.strictEqual(ops[1].name, 'DUP');
    });

    it('should handle PUSH with data', () => {
      const data = [0x01, 0x04, 0x74, 0x65, 0x73, 0x74];
      const ops = parseBytecode(data);
      assert.strictEqual(ops[0].name, 'PUSH');
      assert.strictEqual(ops[0].data, 'test');
    });

    it('should handle unknown opcodes gracefully', () => {
      const data = [0xFE, 0x01, 0x04, 0x74, 0x65, 0x73, 0xF0];
      const ops = parseBytecode(data);
      assert.ok(ops.length >= 2);
    });
  });

  describe('audit - reentrancy', () => {
    it('should detect missing REENTRANCY_LOCK before CALL_EXTERNAL', () => {
      const auditor = new SecurityAuditor();
      const result = auditor.audit(BYTECODE_WITH_REENTRANCY, 'TestReentrancy');
      assert.ok(result.findings.some(f => f.type === 'REENTRANCY_VULNERABILITY'));
      assert.ok(!result.passed);
    });

    it('should not flag when REENTRANCY_LOCK is present', () => {
      const auditor = new SecurityAuditor();
      const result = auditor.audit(BYTECODE_WITH_ALL_CHECKS, 'TestAllChecks');
      const reentrancyFindings = result.findings.filter(f => f.type === 'REENTRANCY_VULNERABILITY');
      assert.strictEqual(reentrancyFindings.length, 0);
    });
  });

  describe('audit - overflow', () => {
    it('should detect potential overflow in ADD/MUL without bounds check', () => {
      const auditor = new SecurityAuditor();
      const result = auditor.audit(BYTECODE_WITH_OVERFLOW, 'TestOverflow');
      assert.ok(result.findings.some(f => f.type === 'POTENTIAL_OVERFLOW'));
    });
  });

  describe('audit - access control', () => {
    it('should detect SELFDESTRUCT without access control', () => {
      const auditor = new SecurityAuditor();
      const result = auditor.audit(BYTECODE_WITH_SELFDESTRUCT, 'TestSelfDestruct');
      assert.ok(result.findings.some(f => f.type === 'UNRESTRICTED_SELFDESTRUCT'));
      assert.ok(!result.passed);
    });

    it('should detect missing access control on SSTORE', () => {
      const auditor = new SecurityAuditor();
      const result = auditor.audit(BYTECODE_WITH_NO_ACCESS, 'TestNoAC');
      assert.ok(result.findings.some(f => f.type === 'MISSING_ACCESS_CONTROL'));
    });
  });

  describe('audit - score calculation', () => {
    it('should calculate score based on findings', () => {
      const auditor = new SecurityAuditor();
      const result = auditor.audit(BYTECODE_WITH_SELFDESTRUCT, 'Test');
      assert.ok(typeof result.score === 'number');
      assert.ok(result.score >= 0 && result.score <= 100);
      assert.ok(result.score < 80, 'Should have low score due to critical findings');
    });

    it('should handle clean bytecode with no findings', () => {
      const auditor = new SecurityAuditor();
      const result = auditor.audit(BYTECODE_WITH_ALL_CHECKS, 'Clean');
      assert.ok(typeof result.score === 'number');
    });
  });

  describe('audit - report generation', () => {
    it('should generate readable report', () => {
      const auditor = new SecurityAuditor();
      const result = auditor.audit(BYTECODE_WITH_OVERFLOW, 'TestOverflow');
      const report = auditor.generateReport(result);
      assert.ok(report.includes('security审计报告'));
      assert.ok(report.includes('TestOverflow'));
      assert.ok(report.includes('POTENTIAL_OVERFLOW'));
    });
  });

  describe('auditAllTemplates', () => {
    it('should audit all 11 templates', () => {
      const auditor = new SecurityAuditor();
      const lib = new ContractTemplateLibrary();
      const results = auditor.auditAllTemplates(lib);
      assert.strictEqual(results.length, 11);
      for (const r of results) {
        assert.ok(typeof r.score === 'number');
        assert.ok(r.score >= 0 && r.score <= 100);
        assert.ok(Array.isArray(r.findings));
        assert.ok(typeof r.summary === 'object');
      }
    });

    it('each template audit should have summary with risk level', () => {
      const auditor = new SecurityAuditor();
      const lib = new ContractTemplateLibrary();
      const results = auditor.auditAllTemplates(lib);
      for (const r of results) {
        assert.ok(['HIGH_RISK', 'MEDIUM_RISK', 'LOW_RISK'].includes(r.summary.risk));
        assert.ok(typeof r.summary.description === 'string');
        assert.ok(typeof r.summary.recommendation === 'string');
        assert.ok('CRITICAL' in r.summary.bySeverity);
        assert.ok('HIGH' in r.summary.bySeverity);
      }
    });
  });

  describe('auditTemplate', () => {
    it('should audit token template', () => {
      const auditor = new SecurityAuditor();
      const lib = new ContractTemplateLibrary();
      const template = lib.getTemplate('token');
      assert.ok(template, 'token template should exist');
      const result = auditor.auditTemplate(template, { contractName: 'TestToken', symbol: 'TST', decimals: '18', totalSupply: '1000' });
      assert.ok(typeof result.score === 'number');
      assert.ok(Array.isArray(result.findings));
      assert.ok(typeof result.summary === 'object');
    });

    it('should reject invalid template', () => {
      const auditor = new SecurityAuditor();
      const result = auditor.auditTemplate(null, {});
      assert.ok(result.error);
    });
  });
});
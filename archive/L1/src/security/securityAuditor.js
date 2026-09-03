import { PQCWallet } from '../wallet/pqcWallet.js';

const SEVERITY = { INFO: 'INFO', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };

const AINVM_OPCODES = {
  0x01: 'PUSH', 0x02: 'POP', 0x03: 'ADD', 0x04: 'SUB', 0x05: 'MUL', 0x06: 'DIV',
  0x07: 'MOD', 0x08: 'AND', 0x09: 'OR', 0x0A: 'XOR', 0x0B: 'NOT',
  0x0C: 'EQ', 0x0D: 'LT', 0x0E: 'GT', 0x0F: 'LTE', 0x10: 'GTE',
  0x11: 'DUP', 0x12: 'SWAP', 0x13: 'MSTORE', 0x14: 'MLOAD',
  0x20: 'CALL', 0x21: 'CALL_EXTERNAL', 0x22: 'RETURN', 0x23: 'REVERT',
  0x24: 'DELEGATECALL', 0x25: 'STATICCALL',
  0x30: 'JUMP', 0x31: 'REENTRANCY_LOCK', 0x32: 'REENTRANCY_UNLOCK',
  0x33: 'SELFDESTRUCT', 0x34: 'TIMESTAMP', 0x35: 'BLOCKHASH',
  0x40: 'BALANCE', 0x41: 'TRANSFER', 0x42: 'SEND',
  0x50: 'LOG', 0x51: 'EMIT_EVENT',
  0x60: 'SLOAD', 0x61: 'SSTORE', 0x62: 'GAS',
  0x70: 'CREATE', 0x71: 'CREATE2',
  0x80: 'EXTCODESIZE', 0x81: 'EXTCODECOPY', 0x82: 'CODESIZE', 0x83: 'CODECOPY',
  0x90: 'CALLER', 0x91: 'ORIGIN', 0x92: 'ADDRESS', 0x93: 'CALLVALUE',
  0xA0: 'BLOCKNUMBER', 0xA1: 'COINBASE', 0xA2: 'GASLIMIT', 0xA3: 'GASPRICE',
  0xF0: 'STOP', 0xF1: 'HALT', 0xFD: 'INVALID', 0xFE: 'REVERT_ERROR'
};

function parseBytecode(bytecode) {
  const ops = [];
  let i = 0;
  const bytes = typeof bytecode === 'string'
    ? bytecode.split(',').map(b => parseInt(b.trim(), 16)).filter(b => !isNaN(b))
    : Array.isArray(bytecode) ? bytecode : Array.from(bytecode);

  while (i < bytes.length) {
    const opcode = bytes[i];
    const name = AINVM_OPCODES[opcode] || `UNKNOWN_0x${opcode.toString(16).toUpperCase()}`;

    if (opcode === 0x01) {
      const dataLength = bytes[i + 1] || 0;
      let data = '';
      for (let j = 0; j < dataLength && (i + 2 + j) < bytes.length; j++) {
        data += String.fromCharCode(bytes[i + 2 + j]);
      }
      ops.push({ offset: i, opcode, name, data, dataLength });
      i += 2 + dataLength;
    } else {
      ops.push({ offset: i, opcode, name });
      i++;
    }
  }
  return ops;
}

function analyzeReentrancy(ops) {
  const findings = [];
  let inExternalCall = false;
  let lockCount = 0;
  let hasReentrancyGuard = false;

  for (let i = 0; i < ops.length; i++) {
    if (ops[i].name === 'REENTRANCY_LOCK') {
      hasReentrancyGuard = true;
      lockCount++;
    }
    if (ops[i].name === 'REENTRANCY_UNLOCK') lockCount--;

    if (ops[i].name === 'CALL_EXTERNAL' || ops[i].name === 'CALL' || ops[i].name === 'DELEGATECALL') {
      const prevOps = ops.slice(Math.max(0, i - 8), i);
      const hasLock = prevOps.some(o => o.name === 'REENTRANCY_LOCK');
      const hasBalanceCheck = prevOps.some(o => o.name === 'BALANCE' || o.name === 'SLOAD' && i > 0 && ops[i - 1]?.name === 'LT');

      if (!hasLock && lockCount === 0) {
        findings.push({
          type: 'REENTRANCY_VULNERABILITY',
          severity: SEVERITY.HIGH,
          offset: ops[i].offset,
          opcode: ops[i].name,
          message: `${ops[i].name} at offset ${ops[i].offset} lacks REENTRANCY_LOCK protection`,
          recommendation: 'Add REENTRANCY_LOCK before external calls and REENTRANCY_UNLOCK after'
        });
      }
      if (!hasBalanceCheck) {
        findings.push({
          type: 'MISSING_BALANCE_CHECK',
          severity: SEVERITY.MEDIUM,
          offset: ops[i].offset,
          opcode: ops[i].name,
          message: `${ops[i].name} at offset ${ops[i].offset} should verify contract state before external call`,
          recommendation: 'Check contract balance/state before and after external calls'
        });
      }
    }
  }
  return findings;
}

function analyzeOverflow(ops) {
  const findings = [];

  for (let i = 0; i < ops.length; i++) {
    if (['ADD', 'MUL'].includes(ops[i].name)) {
      const nextOps = ops.slice(i + 1, i + 4);
      const hasSafeguard = nextOps.some(o =>
        ['GT', 'GTE', 'LT', 'LTE'].includes(o.name) ||
        (o.name === 'REVERT' || o.name === 'REVERT_ERROR')
      );
      if (!hasSafeguard) {
        findings.push({
          type: 'POTENTIAL_OVERFLOW',
          severity: SEVERITY.MEDIUM,
          offset: ops[i].offset,
          opcode: ops[i].name,
          message: `${ops[i].name} at offset ${ops[i].offset} lacks overflow/underflow protection`,
          recommendation: 'Add bounds checking after arithmetic operations or use safe math patterns'
        });
      }
    }

    if (ops[i].name === 'SUB' && i < ops.length - 1) {
      const nextCheck = ops.slice(i + 1, i + 4);
      if (!nextCheck.some(o => ['GT', 'GTE', 'LT', 'LTE', 'REVERT', 'REVERT_ERROR'].includes(o.name))) {
        findings.push({
          type: 'POTENTIAL_UNDERFLOW',
          severity: SEVERITY.LOW,
          offset: ops[i].offset,
          opcode: 'SUB',
          message: `SUB at offset ${ops[i].offset} lacks underflow protection`,
          recommendation: 'Add underflow checking after subtraction operations'
        });
      }
    }
  }
  return findings;
}

function analyzeAccessControl(ops) {
  const findings = [];
  const hasCallerCheck = ops.some(o => o.name === 'CALLER');
  const hasOriginCheck = ops.some(o => o.name === 'ORIGIN');
  const hasSstore = ops.some(o => o.name === 'SSTORE');
  const hasSelfDestruct = ops.some(o => o.name === 'SELFDESTRUCT');
  const hasTransfer = ops.some(o => o.name === 'TRANSFER' || o.name === 'SEND');
  const hasCreate = ops.some(o => o.name === 'CREATE' || o.name === 'CREATE2');

  if (hasSstore && !hasCallerCheck) {
    findings.push({
      type: 'MISSING_ACCESS_CONTROL',
      severity: SEVERITY.HIGH,
      offset: 0,
      opcode: 'SSTORE',
      message: 'SSTORE operations detected without caller verification',
      recommendation: 'Add CALLER/ORIGIN checks before state modifications'
    });
  }

  if (hasSelfDestruct && !hasCallerCheck) {
    findings.push({
      type: 'UNRESTRICTED_SELFDESTRUCT',
      severity: SEVERITY.CRITICAL,
      offset: 0,
      opcode: 'SELFDESTRUCT',
      message: 'SELFDESTRUCT detected without access control',
      recommendation: 'Restrict SELFDESTRUCT to authorized callers only'
    });
  }

  if (hasTransfer && !hasCallerCheck) {
    findings.push({
      type: 'UNRESTRICTED_TRANSFER',
      severity: SEVERITY.HIGH,
      offset: 0,
      opcode: 'TRANSFER',
      message: 'ASSET_TRANSFER detected without caller verification',
      recommendation: 'Add access control checks before asset transfers'
    });
  }

  if (hasCreate && !hasCallerCheck) {
    findings.push({
      type: 'UNRESTRICTED_CONTRACT_CREATION',
      severity: SEVERITY.MEDIUM,
      offset: 0,
      opcode: 'CREATE',
      message: 'CREATE/CREATE2 without access control',
      recommendation: 'Consider limiting contract creation to authorized accounts'
    });
  }

  if (ops.some(o => o.name === 'DELEGATECALL') && !hasCallerCheck) {
    findings.push({
      type: 'DANGEROUS_DELEGATECALL',
      severity: SEVERITY.HIGH,
      offset: 0,
      opcode: 'DELEGATECALL',
      message: 'DELEGATECALL detected without strict access control',
      recommendation: 'DELEGATECALL should only be callable by trusted addresses'
    });
  }

  return findings;
}

function analyzeGasAndEfficiency(ops) {
  const findings = [];
  const sstoreCount = ops.filter(o => o.name === 'SSTORE').length;

  if (sstoreCount > 5) {
    findings.push({
      type: 'HIGH_STORAGE_USAGE',
      severity: SEVERITY.INFO,
      offset: 0,
      opcode: 'SSTORE',
      message: `Contract has ${sstoreCount} SSTORE operations which may increase gas costs`,
      recommendation: 'Optimize storage writes, consider packing variables'
    });
  }

  const hasGasCheck = ops.some(o => o.name === 'GAS');
  if (!hasGasCheck && ops.length > 50) {
    findings.push({
      type: 'MISSING_GAS_CHECK',
      severity: SEVERITY.LOW,
      offset: 0,
      opcode: 'GAS',
      message: 'No explicit gas check found for complex contract',
      recommendation: 'Add gas limit checks in computationally intensive methods'
    });
  }

  const loopPatterns = findLoops(ops);
  for (const loop of loopPatterns) {
    const hasBoundCheck = loop.body.some(o =>
      ['GT', 'LT', 'GTE', 'LTE', 'EQ'].includes(o.name)
    );
    if (!hasBoundCheck) {
      findings.push({
        type: 'UNBOUNDED_LOOP',
        severity: SEVERITY.MEDIUM,
        offset: loop.startOffset,
        opcode: 'JUMP',
        message: `Potential unbounded loop detected at offset ${loop.startOffset}`,
        recommendation: 'Ensure loops have gas limit or iteration bounds'
      });
    }
  }

  return findings;
}

function findLoops(ops) {
  const loops = [];
  const jumpTargets = new Map();
  for (const op of ops) {
    if (op.name === 'JUMP' && op.data) {
      const target = parseInt(op.data);
      if (!isNaN(target)) jumpTargets.set(target, op.offset);
    }
  }

  for (let i = 0; i < ops.length; i++) {
    if (ops[i].name === 'JUMP' && jumpTargets.has(i + 1)) {
      const body = [];
      for (let j = Math.min(i + 1, ops.length - 1); j < ops.length && j < i + 15; j++) {
        body.push(ops[j]);
      }
      loops.push({ startOffset: ops[i].offset, body });
    }
  }
  return loops;
}

function analyzeTimestampDependence(ops) {
  const findings = [];
  const hasTimestamp = ops.some(o => o.name === 'TIMESTAMP');
  const hasCriticalOp = ops.some(o =>
    ['TRANSFER', 'SEND', 'SELFDESTRUCT', 'CREATE', 'CREATE2'].includes(o.name)
  );

  if (hasTimestamp && hasCriticalOp) {
    findings.push({
      type: 'TIMESTAMP_DEPENDENCE',
      severity: SEVERITY.LOW,
      offset: 0,
      opcode: 'TIMESTAMP',
      message: 'Contract uses TIMESTAMP with critical operations - potentially exploitable by miners',
      recommendation: 'Avoid using TIMESTAMP for critical logic, use block numbers instead'
    });
  }
  return findings;
}

function analyzeUncheckedReturn(ops) {
  const findings = [];

  for (let i = 0; i < ops.length; i++) {
    if (['CALL_EXTERNAL', 'CALL', 'SEND'].includes(ops[i].name)) {
      let hasReturnCheck = false;
      for (let j = i + 1; j < Math.min(i + 5, ops.length); j++) {
        if (ops[j].name === 'EQ' || ops[j].name === 'PUSH' && ops[j].data === '1' ||
            ops[j].name === 'ISZERO' || ops[j].name === 'JUMP') {
          hasReturnCheck = true;
          break;
        }
      }
      if (!hasReturnCheck) {
        findings.push({
          type: 'UNCHECKED_CALL_RETURN',
          severity: SEVERITY.MEDIUM,
          offset: ops[i].offset,
          opcode: ops[i].name,
          message: `${ops[i].name} at offset ${ops[i].offset}: return value not checked`,
          recommendation: 'Check success of external calls to prevent silent failures'
        });
      }
    }
  }
  return findings;
}

function analyzeFrontRunning(ops) {
  const findings = [];
  const hasTimestampAccess = ops.some(o => o.name === 'TIMESTAMP' || o.name === 'BLOCKHASH');
  const hasPriceAccess = ops.some(o =>
    o.name === 'CALL_EXTERNAL' || (o.name === 'SLOAD' && ops.includes(o => o.name === 'DIV'))
  );

  if (hasTimestampAccess && hasPriceAccess) {
    findings.push({
      type: 'FRONT_RUNNING_RISK',
      severity: SEVERITY.LOW,
      offset: 0,
      opcode: 'TIMESTAMP',
      message: 'Contract pattern may be susceptible to front-running attacks',
      recommendation: 'Consider commit-reveal schemes or maximum slippage parameters'
    });
  }
  return findings;
}

export class SecurityAuditor {
  constructor() {
    this.findingsCount = 0;
  }

  audit(bytecode, contractName = 'Unknown') {
    const ops = parseBytecode(bytecode);
    const findings = [
      ...analyzeReentrancy(ops),
      ...analyzeOverflow(ops),
      ...analyzeAccessControl(ops),
      ...analyzeGasAndEfficiency(ops),
      ...analyzeTimestampDependence(ops),
      ...analyzeUncheckedReturn(ops),
      ...analyzeFrontRunning(ops)
    ];

    this.findingsCount = findings.length;

    const score = this.calculateScore(findings);
    const summary = this.generateSummary(findings, contractName);

    return {
      contractName,
      bytecodeSize: Array.isArray(bytecode) ? bytecode.length : (typeof bytecode === 'string' ? bytecode.length : 0),
      opcodeCount: ops.length,
      score,
      passed: findings.filter(f => ['HIGH', 'CRITICAL'].includes(f.severity)).length === 0,
      findings,
      summary,
      timestamp: new Date().toISOString()
    };
  }

  auditTemplate(template, params = {}) {
    if (!template || !template.generateDeployParams) {
      return { error: 'Invalid template - missing generateDeployParams method' };
    }
    const deployParams = template.generateDeployParams(params);
    const bytecode = deployParams.bytecode || deployParams.code || '';
    return this.audit(bytecode, params.contractName || template.name || 'TemplateContract');
  }

  auditAllTemplates(templateLibrary) {
    const results = [];
    const all = templateLibrary.getAllTemplates();
    for (const info of all) {
      const template = templateLibrary.getTemplate(info.type);
      if (template) {
        results.push(this.auditTemplate(template, {}));
      }
    }
    return results;
  }

  calculateScore(findings) {
    const weights = { CRITICAL: 25, HIGH: 15, MEDIUM: 8, LOW: 3, INFO: 1 };
    let penalty = 0;
    for (const f of findings) {
      penalty += weights[f.severity] || 0;
    }
    return Math.max(0, Math.round(100 - penalty));
  }

  generateSummary(findings, contractName) {
    const bySeverity = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }

    const critical = bySeverity[SEVERITY.CRITICAL] || 0;
    const high = bySeverity[SEVERITY.HIGH] || 0;
    const medium = bySeverity[SEVERITY.MEDIUM] || 0;
    const low = bySeverity[SEVERITY.LOW] || 0;
    const info = bySeverity[SEVERITY.INFO] || 0;

    let risk = 'LOW_RISK';
    if (critical > 0 || high > 2) risk = 'HIGH_RISK';
    else if (high > 0 || medium > 3) risk = 'MEDIUM_RISK';

    return {
      risk,
      bySeverity: { CRITICAL: critical, HIGH: high, MEDIUM: medium, LOW: low, INFO: info },
      description: this.getRiskDescription(risk, critical, high, medium),
      recommendation: this.getRiskRecommendation(risk)
    };
  }

  getRiskDescription(risk, critical, high, medium) {
    switch (risk) {
      case 'HIGH_RISK':
        return `Contract contains ${critical} critical and ${high} high severity issues. Deployment NOT recommended without fixes.`;
      case 'MEDIUM_RISK':
        return `Contract contains ${high} high and ${medium} medium severity issues. Review and fix before mainnet deployment.`;
      default:
        return `Contract has minimal security issues. Safe for deployment after review.`;
    }
  }

  getRiskRecommendation(risk) {
    switch (risk) {
      case 'HIGH_RISK':
        return 'Prioritize fixing all CRITICAL and HIGH severity issues before any deployment.';
      case 'MEDIUM_RISK':
        return 'Address HIGH severity issues, review MEDIUM issues before mainnet release.';
      default:
        return 'Monitor and periodically re-audit as contract complexity grows.';
    }
  }

  generateReport(result) {
    const lines = [];
    lines.push('═══════════════════════════════════════════');
    lines.push('  NexusGenesis Smart Contractsecurity审计报告');
    lines.push('═══════════════════════════════════════════');
    lines.push(`  Contract名称: ${result.contractName}`);
    lines.push(`  审计时间: ${result.timestamp}`);
    lines.push(`  security评分: ${result.score}/100`);
    lines.push(`  风险级别: ${result.summary.risk}`);
    lines.push(`  bytecode量: ${result.bytecodeSize} bytes`);
    lines.push(`  opcode数: ${result.opcodeCount}`);
    lines.push(`  发现问题: ${result.findings.length}`);
    lines.push('');
    lines.push('─── 严重级别分布');
    for (const [severity, count] of Object.entries(result.summary.bySeverity)) {
      if (count > 0) lines.push(`  ${severity}: ${count}`);
    }
    lines.push('');
    lines.push('─── 问题详情');
    let idx = 1;
    for (const f of result.findings) {
      const sevIcon = f.severity === 'CRITICAL' ? '🔴' : f.severity === 'HIGH' ? '🟠' :
                      f.severity === 'MEDIUM' ? '🟡' : f.severity === 'LOW' ? '🔵' : '⚪';
      lines.push(`  ${idx}. ${sevIcon} [${f.severity}] ${f.type}`);
      lines.push(`     ${f.message}`);
      lines.push(`     💡 ${f.recommendation}`);
      idx++;
    }
    if (result.findings.length === 0) {
      lines.push('  ✅ 未发现security问题');
    }
    lines.push('');
    lines.push('─── 建议');
    lines.push(`  ${result.summary.recommendation}`);
    lines.push('');
    lines.push('═══════════════════════════════════════════');
    return lines.join('\n');
  }
}

export { SEVERITY, AINVM_OPCODES, parseBytecode };
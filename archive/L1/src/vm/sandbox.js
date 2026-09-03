/**
 * NexusGenesis - AINVM Sandbox sandboxExecute器
 * 
 * security宪法 §6.2 Requirements: 所有未经Verify代码在隔离sandbox中运行
 * 在 VM 之上添加: Execute时限, 强制资源上限, 预ExecuteStatic Analysis, 
 * Contract级资源预算, Audit Log
 * 
 * Genesis基准版 —— Agent 社区后续可扩展深度学习分析, 形式化Verifyetc.
 */

export class SandboxConfig {
  constructor(overrides = {}) {
    // Execute时限 (ms)
    this.timeLimit = overrides.timeLimit ?? 5000;
    
    // MaximumExecute步数 (防止无限循环)
    this.maxSteps = overrides.maxSteps ?? 100000;
    
    // 强制stack深度上限 (Execute期强制Execute, 不依赖 SECURITY_CHECK 指令)
    this.maxStackDepth = overrides.maxStackDepth ?? 1024;
    
    // 强制memory条目上限
    this.maxMemoryEntries = overrides.maxMemoryEntries ?? 10000;
    
    // Contract级 gas 预算
    this.gasBudget = overrides.gasBudget ?? 1000000;
    
    // Contract级memory预算 (bytes, 估算)
    this.memoryBudget = overrides.memoryBudget ?? 1048576; // 1MB
    
    // 是否启用bytecodeStatic Analysis
    this.enableStaticAnalysis = overrides.enableStaticAnalysis ?? true;
    
    // 是否记录Audit Log
    this.enableAuditLog = overrides.enableAuditLog ?? true;
    
    // 白名单opcode(即使Static Analysis可疑也allow)
    this.allowedOpcodes = new Set(
      overrides.allowedOpcodes ?? [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, // PUSH, POP, ADD, SUB, MUL, DIV
        0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, // LOAD, STORE, JMP, JZ, HALT, RETURN
        0x0D, 0x0E, 0x0F, 0x16, 0x17, 0x18, 0x19, // AND, OR, NOT, XOR, EQ, LT, GT
        0x1A, 0x1B, 0x1C, 0x1D, 0x1E,           // MOD, SHL, SHR, DUP, SWAP
        0x30, 0x31, 0x32                           // SECURITY_CHECK, REENTRANCY_LOCK, UNLOCK
      ]
    );
    
    // requires额外 gas 的opcode(高成本操作)
    this.highCostOpcodes = new Set([
      0x10, 0x11, 0x12, 0x13, 0x14, 0x15, // MATRIX 操作
      0x20, 0x21, 0x22                      // AI 操作
    ]);
  }
}

export class SandboxExecutor {
  /**
   * @param {SandboxConfig} config 
   */
  constructor(config = new SandboxConfig()) {
    this.config = config;
    this.executionCount = 0;
    this.auditLogs = [];
  }

  /**
   * 在sandbox中securityExecutebytecode
   * @param {Array|Uint8Array} bytecode - bytecode
   * @param {number} gasLimit - gas 上限
   * @param {string} deployer - Deploy者address(for审计)
   * @returns {object} Execute结果
   */
  async execute(bytecode, gasLimit, deployer = 'unknown') {
    this.executionCount++;
    const executionId = this.executionCount;
    const startTime = Date.now();
    let AINVM;

    const bytecodeArray = Array.isArray(bytecode) ? bytecode : Array.from(bytecode);

    // ===== Phase  1: Static Analysis =====
    if (this.config.enableStaticAnalysis) {
      const analysis = this._staticAnalyze(bytecodeArray);
      if (!analysis.safe) {
        const logEntry = {
          executionId,
          phase: 'static_analysis',
          result: 'rejected',
          reason: analysis.reason,
          deployer,
          timestamp: Date.now()
        };
        this._audit(logEntry);
        return {
          success: false,
          sandboxRejected: true,
          phase: 'static_analysis',
          reason: `Code rejected by static analysis: ${analysis.reason}`,
          details: analysis.details
        };
      }
    }

    // ===== Phase  2: 资源预算Check =====
    const effectiveGasLimit = Math.min(gasLimit, this.config.gasBudget);
    try {
      AINVM = (await import('../vm/ainvm.js')).default;
    } catch (e) {
      return { success: false, sandboxRejected: true, reason: `VM init failed: ${e.message}` };
    }

    // ===== Phase  3: sandbox包装Execute =====
    const vm = new AINVM();
    vm.loadProgram(bytecodeArray);
    
    // 注入强制资源上限(覆盖自检指令的被动上限)
    vm._sandboxConfig = this.config;
    vm._sandboxStartTime = startTime;
    vm._sandboxStepCount = 0;
    vm._sandboxExecutionId = executionId;

    // 包装 step() 添加强制Check
    const originalStep = vm.step.bind(vm);
    vm.step = () => {
      // 限额 1: 步数上限
      vm._sandboxStepCount++;
      if (vm._sandboxStepCount > this.config.maxSteps) {
        throw new Error(`Sandbox: max steps (${this.config.maxSteps}) exceeded`);
      }

      // 限额 2: 时间上限
      const elapsed = Date.now() - vm._sandboxStartTime;
      if (elapsed > this.config.timeLimit) {
        throw new Error(`Sandbox: time limit (${this.config.timeLimit}ms) exceeded (${elapsed}ms)`);
      }

      // 限额 3: stack深度强制上限
      if (vm.stack.length > this.config.maxStackDepth) {
        throw new Error(`Sandbox: stack depth (${this.config.maxStackDepth}) exceeded`);
      }

      // 限额 4: memory条目强制上限
      if (vm.memory.size > this.config.maxMemoryEntries) {
        throw new Error(`Sandbox: memory entries (${this.config.maxMemoryEntries}) exceeded`);
      }

      originalStep();
    };

    // ===== Phase  4: Execute =====
    const executeStart = Date.now();
    let result;
    try {
      result = vm.execute(effectiveGasLimit);
    } catch (error) {
      result = {
        success: false,
        error: error.message,
        gasUsed: vm.gasUsed || 0,
        stepsExecuted: vm._sandboxStepCount || 0,
        stack: [...(vm.stack || [])]
      };
    }

    const executeTime = Date.now() - executeStart;
    const totalTime = Date.now() - startTime;

    // ===== Phase  5: 结果Check与审计 =====
    result.stepsExecuted = vm._sandboxStepCount || 0;
    result.executeTimeMs = executeTime;
    result.totalTimeMs = totalTime;
    result.sandboxExecutionId = executionId;
    result.sandboxConfig = {
      timeLimit: this.config.timeLimit,
      maxSteps: this.config.maxSteps,
      maxStackDepth: this.config.maxStackDepth,
      maxMemoryEntries: this.config.maxMemoryEntries
    };

    // 额外: Execute完毕后 cap status快照大小
    if (result.memory) {
      const memSize = JSON.stringify(result.memory).length;
      if (memSize > this.config.memoryBudget) {
        result.memoryTruncated = true;
        result.memory = { _truncated: true, _originalSize: memSize };
      }
    }

    if (result.stack && result.stack.length > 1000) {
      result.stackTruncated = true;
      result.stack = result.stack.slice(0, 1000);
      result.stack.push('...(truncated)');
    }

    const auditEntry = {
      executionId,
      timestamp: Date.now(),
      deployer,
      success: result.success,
      gasUsed: result.gasUsed || 0,
      stepsExecuted: result.stepsExecuted || 0,
      executeTimeMs: executeTime,
      totalTimeMs: totalTime,
      error: result.error || null,
      bytecodeSize: bytecodeArray.length,
      effectiveGasLimit,
      highCostOps: this._countHighCostOps(bytecodeArray)
    };
    this._audit(auditEntry);

    return result;
  }

  /**
   * bytecodeStatic Analysis
   * 检测无限循环, 过大操作, 可疑指令序列
   */
  _staticAnalyze(bytecode) {
    const details = {
      estimatedGas: 0,
      loopCount: 0,
      highCostOps: 0,
      suspiciousJumps: 0,
      maxMemoryAccess: 0
    };

    // 1. 遍历bytecode收集统计info
    const opcodeStats = {};
    for (let i = 0; i < bytecode.length; i++) {
      const opcode = bytecode[i];
      opcodeStats[opcode] = (opcodeStats[opcode] || 0) + 1;
      
      // PUSH 跳过operand
      if (opcode === 0x01) { i++; continue; }
      // LOAD/STORE 跳过address
      if (opcode === 0x07 || opcode === 0x08) { i++; continue; }
      // JMP/JZ 跳过偏移
      if (opcode === 0x09 || opcode === 0x0A) {
        i++;
        details.suspiciousJumps++;
        continue;
      }

      // 统计高成本操作
      if (this.config.highCostOpcodes.has(opcode)) {
        details.highCostOps++;
      }

      // 跟踪Maximummemoryaddress
      if (opcode === 0x07 || opcode === 0x08) {
        const addr = bytecode[i];
        if (addr > details.maxMemoryAccess) {
          details.maxMemoryAccess = addr;
        }
      }
    }

    // 2. Check未知opcode
    const validOpcodes = [0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,
      0x0B,0x0C,0x0D,0x0E,0x0F,0x10,0x11,0x12,0x13,0x14,0x15,
      0x16,0x17,0x18,0x19,0x1A,0x1B,0x1C,0x1D,0x1E,
      0x20,0x21,0x22,0x30,0x31,0x32];
    const validSet = new Set(validOpcodes);
    for (const op of Object.keys(opcodeStats)) {
      const opNum = parseInt(op);
      if (opcodeStats[op] > 0 && !validSet.has(opNum)) {
        return {
          safe: false,
          reason: `Unknown opcode: 0x${opNum.toString(16).padStart(2, '0')} (${opcodeStats[op]} occurrences)`,
          details
        };
      }
    }

    // 3. JMP/JZ 循环检测 —— 过多反向跳转may指示无限循环
    for (let i = 0; i < bytecode.length; i++) {
      const opcode = bytecode[i];
      if (opcode === 0x09 || opcode === 0x0A) {
        const offset = bytecode[i + 1];
        // 反向跳转
        if (offset < 0 || (offset > 128 && offset < 256)) {
          const signedOffset = offset > 127 ? offset - 256 : offset;
          if (signedOffset < 0) {
            details.loopCount++;
          }
        }
      }
      if (opcode === 0x01) { i++; }
    }

    // 4. securityCheck
    if (details.suspiciousJumps > 1000) {
      return { safe: false, reason: `Excessive jump instructions (${details.suspiciousJumps}), possible obfuscation`, details };
    }

    if (details.highCostOps > 500) {
      return { safe: false, reason: `Excessive high-cost operations (${details.highCostOps})`, details };
    }

    if (bytecode.length > 100000) {
      return { safe: false, reason: `Bytecode too large (${bytecode.length} bytes)`, details };
    }

    // 估算 gas
    let estimatedGas = 0;
    for (let i = 0; i < bytecode.length; i++) {
      const opcode = bytecode[i];
      switch (opcode) {
        case 0x01: estimatedGas += 2; i++; break;       // PUSH
        case 0x03: case 0x04: estimatedGas += 2; break;  // ADD/SUB
        case 0x05: case 0x06: estimatedGas += 3; break;  // MUL/DIV
        case 0x07: case 0x08: estimatedGas += 3; i++; break; // LOAD/STORE
        case 0x10: case 0x11: case 0x12: case 0x13: estimatedGas += 50; break; // MATRIX
        case 0x20: estimatedGas += 100; break; // AI_INFERENCE
        case 0x30: estimatedGas += 5; break; // SECURITY_CHECK
        default: estimatedGas += 1;
      }
    }
    details.estimatedGas = estimatedGas;

    // 5. Gas 预算Check
    if (estimatedGas > this.config.gasBudget) {
      return {
        safe: false,
        reason: `Estimated gas (${estimatedGas}) exceeds budget (${this.config.gasBudget})`,
        details
      };
    }

    return { safe: true, details };
  }

  /**
   * 统计高成本opcode
   */
  _countHighCostOps(bytecode) {
    let count = 0;
    for (const op of bytecode) {
      if (this.config.highCostOpcodes.has(op)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Audit Log
   */
  _audit(entry) {
    if (this.config.enableAuditLog) {
      this.auditLogs.push(entry);
      if (this.auditLogs.length > 10000) {
        this.auditLogs = this.auditLogs.slice(-5000); // 保留最近 5000 条
      }
    }
  }

  /**
   * get审计统计
   */
  getAuditStats() {
    const total = this.auditLogs.length;
    const rejected = this.auditLogs.filter(e => e.phase === 'static_analysis').length;
    const failed = this.auditLogs.filter(e => !e.success && e.phase !== 'static_analysis').length;
    const succeeded = this.auditLogs.filter(e => e.success).length;
    const totalGas = this.auditLogs.reduce((sum, e) => sum + (e.gasUsed || 0), 0);
    const totalSteps = this.auditLogs.reduce((sum, e) => sum + (e.stepsExecuted || 0), 0);
    const avgTime = total > 0 
      ? this.auditLogs.reduce((sum, e) => sum + (e.executeTimeMs || 0), 0) / total 
      : 0;

    return {
      totalExecutions: total,
      staticRejections: rejected,
      executionFailures: failed,
      successfulExecutions: succeeded,
      successRate: total > 0 ? ((succeeded / total) * 100).toFixed(1) + '%' : 'N/A',
      totalGasConsumed: totalGas,
      totalStepsExecuted: totalSteps,
      averageExecuteTimeMs: avgTime.toFixed(2),
      activeConfig: {
        timeLimit: this.config.timeLimit,
        maxSteps: this.config.maxSteps,
        maxStackDepth: this.config.maxStackDepth,
        maxMemoryEntries: this.config.maxMemoryEntries
      }
    };
  }

  /**
   * get最近的Audit Log
   */
  getRecentLogs(limit = 50) {
    return this.auditLogs.slice(-limit);
  }

  /**
   * Configuration白名单opcode(Agent 社区可动态调整)
   */
  setAllowedOpcodes(opcodes) {
    this.config.allowedOpcodes = new Set(opcodes);
  }

  /**
   * UpdateConfiguration
   */
  updateConfig(overrides) {
    this.config = new SandboxConfig({ ...this.config, ...overrides });
  }
}

// 预构建的Configuration预设

/** 低风险预设: Playground/开发环境 */
export const LOW_RISK_CONFIG = new SandboxConfig({
  timeLimit: 30000,
  maxSteps: 500000,
  gasBudget: 10000000,
  memoryBudget: 5242880 // 5MB
});

/** 标准预设: Contract deployment */
export const STANDARD_CONFIG = new SandboxConfig({
  timeLimit: 5000,
  maxSteps: 100000,
  gasBudget: 1000000,
  memoryBudget: 1048576 // 1MB
});

/** 严格预设: 未Verify代码(白皮书 §6.2 Default) */
export const STRICT_CONFIG = new SandboxConfig({
  timeLimit: 2000,
  maxSteps: 50000,
  gasBudget: 500000,
  memoryBudget: 524288, // 512KB
  maxStackDepth: 512,
  maxMemoryEntries: 5000
});

export default SandboxExecutor;
/**
 * AINVM (AI Network Virtual Machine) - Minimum实现
 * 
 * stack机模型的虚拟机, support确定性Execute和可计费
 */

class AINVM {
  constructor() {
    this.stack = [];          // Executestack
    this.memory = new Map();  // 简单Memory(键值Storage)
    this.pc = 0;              // 程序count器
    this.gasUsed = 0;         // 已using的 gas
    this.gasLimit = 0;        // gas 限制
    this.program = [];        // bytecode程序
    this.halted = false;       // 是否已StopExecute
    this.returnValue = null;   // Return值
    this.matrixCounter = 0;    // 矩阵IDcount器(确定性)
  }

  /**
   * Load程序
   * @param {Uint8Array|Array} program - bytecode程序
   */
  loadProgram(program) {
    this.program = Array.isArray(program) ? program : Array.from(program);
    this.reset();
  }

  /**
   * 重置 VM status
   */
  reset() {
    this.stack = [];
    this.memory = new Map();
    this.pc = 0;
    this.gasUsed = 0;
    this.halted = false;
    this.returnValue = null;
  }

  /**
   * Execute程序
   * @param {number} gasLimit - gas 限制
   * @returns {object} Execute结果
   */
  execute(gasLimit) {
    this.gasLimit = gasLimit;
    this.gasUsed = 0;
    this.halted = false;
    this.returnValue = null;

    try {
      while (!this.halted && this.pc < this.program.length) {
        if (this.gasUsed > this.gasLimit) {
          return {
            success: false,
            error: 'out of gas',
            gasUsed: this.gasUsed,
            stack: [...this.stack]
          };
        }

        this.step();
      }

      return {
        success: true,
        gasUsed: this.gasUsed,
        stack: [...this.stack],
        returnValue: this.returnValue,
        memory: Object.fromEntries(this.memory)
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        gasUsed: this.gasUsed,
        stack: [...this.stack]
      };
    }
  }

  /**
   * Execute单步指令
   */
  step() {
    if (this.pc >= this.program.length) {
      this.halted = true;
      return;
    }

    const opcode = this.program[this.pc];
    this.pc++;

    switch (opcode) {
      case 0x01: // PUSH
        this.executePUSH();
        break;
      case 0x02: // POP
        this.executePOP();
        break;
      case 0x03: // ADD
        this.executeADD();
        break;
      case 0x04: // SUB
        this.executeSUB();
        break;
      case 0x05: // MUL
        this.executeMUL();
        break;
      case 0x06: // DIV
        this.executeDIV();
        break;
      case 0x07: // LOAD
        this.executeLOAD();
        break;
      case 0x08: // STORE
        this.executeSTORE();
        break;
      case 0x09: // JMP
        this.executeJMP();
        break;
      case 0x0A: // JZ
        this.executeJZ();
        break;
      case 0x0B: // HALT
        this.executeHALT();
        break;
      case 0x0C: // RETURN
        this.executeRETURN();
        break;
      // Logic运算指令
      case 0x0D: // AND
        this.executeAND();
        break;
      case 0x0E: // OR
        this.executeOR();
        break;
      case 0x0F: // NOT
        this.executeNOT();
        break;
      case 0x16: // XOR
        this.executeXOR();
        break;
      case 0x17: // EQ
        this.executeEQ();
        break;
      case 0x18: // LT
        this.executeLT();
        break;
      case 0x19: // GT
        this.executeGT();
        break;
      // 数学运算指令
      case 0x1A: // MOD
        this.executeMOD();
        break;
      case 0x1B: // SHL
        this.executeSHL();
        break;
      case 0x1C: // SHR
        this.executeSHR();
        break;
      case 0x1D: // DUP
        this.executeDUP();
        break;
      case 0x1E: // SWAP
        this.executeSWAP();
        break;
      // 矩阵运算指令
      case 0x10: // MAT_CREATE
        this.executeMAT_CREATE();
        break;
      case 0x11: // MAT_ADD
        this.executeMAT_ADD();
        break;
      case 0x12: // MAT_MUL
        this.executeMAT_MUL();
        break;
      case 0x13: // MAT_TRANS
        this.executeMAT_TRANS();
        break;
      case 0x14: // MAT_LOAD
        this.executeMAT_LOAD();
        break;
      case 0x15: // MAT_STORE
        this.executeMAT_STORE();
        break;
      // AI相关指令
      case 0x20: // AI_INFERENCE
        this.executeAI_INFERENCE();
        break;
      case 0x21: // AI_MODEL_LOAD
        this.executeAI_MODEL_LOAD();
        break;
      case 0x22: // AI_MODEL_SAVE
        this.executeAI_MODEL_SAVE();
        break;
      // security相关指令
      case 0x30: // SECURITY_CHECK
        this.executeSECURITY_CHECK();
        break;
      case 0x31: // REENTRANCY_LOCK
        this.executeREENTRANCY_LOCK();
        break;
      case 0x32: // REENTRANCY_UNLOCK
        this.executeREENTRANCY_UNLOCK();
        break;
      default:
        throw new Error(`Unknown opcode: ${opcode}`);
    }
  }

  /**
   * 消耗 gas
   * @param {number} amount - gas 数量
   */
  consumeGas(amount) {
    // 优化: 添加gas消耗限制, 防止过度消耗
    const MAX_GAS_PER_OPERATION = 10000;
    if (amount > MAX_GAS_PER_OPERATION) {
      amount = MAX_GAS_PER_OPERATION;
    }
    
    this.gasUsed += amount;
    if (this.gasUsed > this.gasLimit) {
      throw new Error('out of gas');
    }
  }

  /**
   * 估算Executegas消耗
   * @param {Array} program - bytecode程序
   * @returns {number} 估算的gas消耗
   */
  estimateGas(program) {
    let estimatedGas = 0;
    let pc = 0;
    
    while (pc < program.length) {
      const opcode = program[pc];
      pc++;
      
      switch (opcode) {
        case 0x01: // PUSH
          estimatedGas += 1;
          pc++;
          break;
        case 0x02: // POP
          estimatedGas += 1;
          break;
        case 0x03: // ADD
        case 0x04: // SUB
          estimatedGas += 2;
          break;
        case 0x05: // MUL
        case 0x06: // DIV
          estimatedGas += 3;
          break;
        case 0x07: // LOAD
        case 0x08: // STORE
          estimatedGas += 2;
          pc++;
          break;
        case 0x09: // JMP
          estimatedGas += 1;
          pc++;
          break;
        case 0x0A: // JZ
          estimatedGas += 2;
          pc++;
          break;
        case 0x0B: // HALT
        case 0x0C: // RETURN
          estimatedGas += 0;
          break;
        // Logic和数学运算
        case 0x0D: // AND
        case 0x0E: // OR
        case 0x0F: // NOT
        case 0x16: // XOR
        case 0x17: // EQ
        case 0x18: // LT
        case 0x19: // GT
        case 0x1B: // SHL
        case 0x1C: // SHR
        case 0x1D: // DUP
        case 0x1E: // SWAP
          estimatedGas += 1;
          break;
        case 0x1A: // MOD
          estimatedGas += 2;
          break;
        case 0x10: // MAT_CREATE
          estimatedGas += 5;
          pc += 2; // rows and cols
          break;
        case 0x11: // MAT_ADD
        case 0x12: // MAT_MUL
        case 0x13: // MAT_TRANS
          estimatedGas += 10;
          break;
        case 0x14: // MAT_LOAD
        case 0x15: // MAT_STORE
          estimatedGas += 3;
          break;
        case 0x20: // AI_INFERENCE
          estimatedGas += 100;
          break;
        case 0x21: // AI_MODEL_LOAD
          estimatedGas += 50;
          break;
        case 0x22: // AI_MODEL_SAVE
          estimatedGas += 30;
          break;
        case 0x30: // SECURITY_CHECK
          estimatedGas += 5;
          break;
        case 0x31: // REENTRANCY_LOCK
          estimatedGas += 10;
          break;
        case 0x32: // REENTRANCY_UNLOCK
          estimatedGas += 5;
          break;
        default:
          estimatedGas += 1;
      }
    }
    
    return estimatedGas;
  }

  /**
   * 优化bytecode
   * @param {Array} bytecode - originalbytecode
   * @returns {Array} 优化后的bytecode
   */
  optimizeBytecode(bytecode) {
    const optimized = [];
    let i = 0;
    
    while (i < bytecode.length) {
      const opcode = bytecode[i];
      
      // 优化1: PUSH 0, PUSH 0 -> PUSH 0, DUP (节省1字节)
      if (opcode === 0x01 && bytecode[i + 1] === 0x00 && 
          i + 2 < bytecode.length && bytecode[i + 2] === 0x01 && bytecode[i + 3] === 0x00) {
        optimized.push(0x01, 0x00); // PUSH 0
        optimized.push(0x1D);       // DUP
        i += 4;
      }
      // 优化2: PUSH x, POP -> Delete两者
      else if (opcode === 0x02 && optimized.length >= 2 && optimized[optimized.length - 2] === 0x01) {
        optimized.pop();
        optimized.pop();
        i++;
      }
      // 优化3: PUSH 1, ADD -> INC (如果实现INC指令)
      // 优化4: PUSH 0, STORE x, PUSH 0, STORE y -> PUSH 0, DUP, STORE x, STORE y
      else if (opcode === 0x01 && bytecode[i + 1] === 0x00 &&
               i + 2 < bytecode.length && bytecode[i + 2] === 0x08 &&
               i + 4 < bytecode.length && bytecode[i + 4] === 0x01 && bytecode[i + 5] === 0x00) {
        optimized.push(0x01, 0x00); // PUSH 0
        optimized.push(0x1D);       // DUP
        optimized.push(0x08);       // STORE
        optimized.push(bytecode[i + 3]); // address x
        optimized.push(0x08);       // STORE
        optimized.push(bytecode[i + 6]); // address y
        i += 7;
      }
      // 优化5: 连续的LOAD/STORE对
      else {
        optimized.push(opcode);
        i++;
      }
    }
    
    return optimized;
  }

  /**
   * CalculateGas优化率
   * @param {Array} original - originalbytecode
   * @param {Array} optimized - 优化后bytecode
   * @returns {object} 优化统计
   */
  calculateOptimizationStats(original, optimized) {
    const originalGas = this.estimateGas(original);
    const optimizedGas = this.estimateGas(optimized);
    const savings = originalGas - optimizedGas;
    const savingsPercent = originalGas > 0 ? ((savings / originalGas) * 100).toFixed(2) : 0;
    
    return {
      originalSize: original.length,
      optimizedSize: optimized.length,
      sizeReduction: original.length - optimized.length,
      originalGas,
      optimizedGas,
      gasSavings: savings,
      savingsPercent: parseFloat(savingsPercent)
    };
  }

  /**
   * Execute PUSH 指令
   */
  executePUSH() {
    if (this.pc >= this.program.length) {
      throw new Error('PUSH missing operand');
    }
    const value = this.program[this.pc];
    this.pc++;
    this.stack.push(value);
    this.consumeGas(1);
  }

  /**
   * Execute POP 指令
   */
  executePOP() {
    if (this.stack.length === 0) {
      throw new Error('Stack underflow');
    }
    this.stack.pop();
    this.consumeGas(1);
  }

  /**
   * Execute ADD 指令
   */
  executeADD() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for ADD');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b + a);
    this.consumeGas(2);
  }

  /**
   * Execute SUB 指令
   */
  executeSUB() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for SUB');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b - a);
    this.consumeGas(2);
  }

  /**
   * Execute MUL 指令
   */
  executeMUL() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for MUL');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b * a);
    this.consumeGas(3);
  }

  /**
   * Execute DIV 指令
   */
  executeDIV() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for DIV');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    if (a === 0) {
      throw new Error('Division by zero');
    }
    this.stack.push(Math.floor(b / a));
    this.consumeGas(3);
  }

  /**
   * Execute LOAD 指令
   */
  executeLOAD() {
    if (this.pc >= this.program.length) {
      throw new Error('LOAD missing operand');
    }
    const address = this.program[this.pc];
    this.pc++;
    
    // Verifyaddress范围
    if (typeof address !== 'number' || address < 0 || address > 255) {
      throw new Error('Invalid memory address');
    }
    
    const value = this.memory.get(address) || 0;
    this.stack.push(value);
    this.consumeGas(2);
  }

  /**
   * Execute STORE 指令
   */
  executeSTORE() {
    if (this.pc >= this.program.length) {
      throw new Error('STORE missing operand');
    }
    if (this.stack.length === 0) {
      throw new Error('Stack underflow for STORE');
    }
    const address = this.program[this.pc];
    this.pc++;
    
    // Verifyaddress范围
    if (typeof address !== 'number' || address < 0 || address > 255) {
      throw new Error('Invalid memory address');
    }
    
    const value = this.stack.pop();
    this.memory.set(address, value);
    this.consumeGas(2);
  }

  /**
   * Execute JMP 指令
   */
  executeJMP() {
    if (this.pc >= this.program.length) {
      throw new Error('JMP missing operand');
    }
    const offset = this.program[this.pc];
    this.pc += offset;
    this.consumeGas(1);
  }

  /**
   * Execute JZ 指令
   */
  executeJZ() {
    if (this.pc >= this.program.length) {
      throw new Error('JZ missing operand');
    }
    if (this.stack.length === 0) {
      throw new Error('Stack underflow for JZ');
    }
    const offset = this.program[this.pc];
    this.pc++;
    const value = this.stack.pop();
    if (value === 0) {
      this.pc += offset;
    }
    this.consumeGas(2);
  }

  /**
   * Execute HALT 指令
   */
  executeHALT() {
    this.halted = true;
    this.consumeGas(0);
  }

  /**
   * Execute RETURN 指令
   */
  executeRETURN() {
    this.halted = true;
    if (this.stack.length > 0) {
      this.returnValue = this.stack[this.stack.length - 1];
    }
    this.consumeGas(0);
  }

  /**
   * Execute MAT_CREATE 指令
   * stack操作: [rows, cols] -> [matrix_id]
   */
  executeMAT_CREATE() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for MAT_CREATE');
    }
    const cols = this.stack.pop();
    const rows = this.stack.pop();
    
    // Verify矩阵维度
    if (rows <= 0 || cols <= 0) {
      throw new Error('Matrix dimensions must be positive');
    }
    if (rows > 100 || cols > 100) {
      throw new Error('Matrix dimensions too large');
    }
    
    // Generate矩阵ID - using确定性count器
    const matrixId = `mat_${this.matrixCounter++}`;
    
    // 在memory中Create矩阵
    this.memory.set(matrixId, {
      rows,
      cols,
      data: Array(rows * cols).fill(0)
    });
    
    this.stack.push(matrixId);
    this.consumeGas(5 + rows * cols); // 根据矩阵大小调整gas
  }

  /**
   * Execute MAT_ADD 指令
   * stack操作: [mat_id1, mat_id2] -> [result_mat_id]
   */
  executeMAT_ADD() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for MAT_ADD');
    }
    const matId2 = this.stack.pop();
    const matId1 = this.stack.pop();
    
    const mat1 = this.memory.get(matId1);
    const mat2 = this.memory.get(matId2);
    
    if (!mat1 || !mat2) {
      throw new Error('Matrix not found');
    }
    
    if (mat1.rows !== mat2.rows || mat1.cols !== mat2.cols) {
      throw new Error('Matrix dimensions mismatch for addition');
    }
    
    // Generate结果矩阵ID - using确定性count器
    const resultMatId = `mat_${this.matrixCounter++}`;
    
    // Execute矩阵加法
    const resultData = [];
    for (let i = 0; i < mat1.rows * mat1.cols; i++) {
      resultData.push(mat1.data[i] + mat2.data[i]);
    }
    
    // Storage结果矩阵
    this.memory.set(resultMatId, {
      rows: mat1.rows,
      cols: mat1.cols,
      data: resultData
    });
    
    this.stack.push(resultMatId);
    this.consumeGas(10 * mat1.rows * mat1.cols);
  }

  /**
   * Execute MAT_MUL 指令
   * stack操作: [mat_id1, mat_id2] -> [result_mat_id]
   */
  executeMAT_MUL() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for MAT_MUL');
    }
    const matId2 = this.stack.pop();
    const matId1 = this.stack.pop();
    
    const mat1 = this.memory.get(matId1);
    const mat2 = this.memory.get(matId2);
    
    if (!mat1 || !mat2) {
      throw new Error('Matrix not found');
    }
    
    if (mat1.cols !== mat2.rows) {
      throw new Error('Matrix dimensions mismatch for multiplication');
    }
    
    // Calculate运算复杂度, 限制矩阵大小
    const complexity = mat1.rows * mat1.cols * mat2.cols;
    if (complexity > 1000000) {
      throw new Error('Matrix multiplication too complex');
    }
    
    // Generate结果矩阵ID - using确定性count器
    const resultMatId = `mat_${this.matrixCounter++}`;
    
    // Execute矩阵乘法 - 优化实现
    const resultData = Array(mat1.rows * mat2.cols).fill(0);
    for (let i = 0; i < mat1.rows; i++) {
      for (let k = 0; k < mat1.cols; k++) {
        const value = mat1.data[i * mat1.cols + k];
        if (value !== 0) { // 跳过零值, 提高性能
          for (let j = 0; j < mat2.cols; j++) {
            resultData[i * mat2.cols + j] += value * mat2.data[k * mat2.cols + j];
          }
        }
      }
    }
    
    // Storage结果矩阵
    this.memory.set(resultMatId, {
      rows: mat1.rows,
      cols: mat2.cols,
      data: resultData
    });
    
    this.stack.push(resultMatId);
    this.consumeGas(15 * complexity); // 优化gas计费
  }

  /**
   * Execute MAT_TRANS 指令
   * stack操作: [mat_id] -> [transposed_mat_id]
   */
  executeMAT_TRANS() {
    if (this.stack.length < 1) {
      throw new Error('Stack underflow for MAT_TRANS');
    }
    const matId = this.stack.pop();
    
    const mat = this.memory.get(matId);
    if (!mat) {
      throw new Error('Matrix not found');
    }
    
    // Generate转置矩阵ID - using确定性count器
    const transposedMatId = `mat_${this.matrixCounter++}`;
    
    // Execute矩阵转置
    const transposedData = Array(mat.cols * mat.rows).fill(0);
    for (let i = 0; i < mat.rows; i++) {
      for (let j = 0; j < mat.cols; j++) {
        transposedData[j * mat.rows + i] = mat.data[i * mat.cols + j];
      }
    }
    
    // Storage转置矩阵
    this.memory.set(transposedMatId, {
      rows: mat.cols,
      cols: mat.rows,
      data: transposedData
    });
    
    this.stack.push(transposedMatId);
    this.consumeGas(10 * mat.rows * mat.cols);
  }

  /**
   * Execute MAT_LOAD 指令
   * stack操作: [mat_id, row, col] -> [value]
   */
  executeMAT_LOAD() {
    if (this.stack.length < 3) {
      throw new Error('Stack underflow for MAT_LOAD');
    }
    const col = this.stack.pop();
    const row = this.stack.pop();
    const matId = this.stack.pop();
    
    const mat = this.memory.get(matId);
    if (!mat) {
      throw new Error('Matrix not found');
    }
    
    if (row < 0 || row >= mat.rows || col < 0 || col >= mat.cols) {
      throw new Error('Matrix index out of bounds');
    }
    
    const value = mat.data[row * mat.cols + col];
    this.stack.push(value);
    this.consumeGas(3);
  }

  /**
   * Execute MAT_STORE 指令
   * stack操作: [mat_id, row, col, value] -> []
   */
  executeMAT_STORE() {
    if (this.stack.length < 4) {
      throw new Error('Stack underflow for MAT_STORE');
    }
    const value = this.stack.pop();
    const col = this.stack.pop();
    const row = this.stack.pop();
    const matId = this.stack.pop();
    
    const mat = this.memory.get(matId);
    if (!mat) {
      throw new Error('Matrix not found');
    }
    
    if (row < 0 || row >= mat.rows || col < 0 || col >= mat.cols) {
      throw new Error('Matrix index out of bounds');
    }
    
    mat.data[row * mat.cols + col] = value;
    this.consumeGas(3);
  }

  /**
   * getCurrentstatus
   * @returns {object} VM status
   */
  getState() {
    return {
      stack: [...this.stack],
      memory: Object.fromEntries(this.memory),
      pc: this.pc,
      gasUsed: this.gasUsed,
      gasLimit: this.gasLimit,
      halted: this.halted,
      returnValue: this.returnValue
    };
  }

  /**
   * Execute AI_INFERENCE 指令
   * stack操作: [model_id, input_data] -> [output_data]
   */
  executeAI_INFERENCE() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for AI_INFERENCE');
    }
    const inputData = this.stack.pop();
    const modelId = this.stack.pop();
    
    // Verify模型是否存在
    const model = this.memory.get(modelId);
    if (!model) {
      throw new Error(`AI model not found: ${modelId}`);
    }
    
    // SimulationAI推理过程
    // 实际实现中, 这里会call真实的AI模型
    const outputData = `inference_result_${Date.now()}`;
    
    // Storage推理结果
    const resultId = `ai_result_${this.matrixCounter++}`;
    this.memory.set(resultId, outputData);
    
    this.stack.push(resultId);
    this.consumeGas(100); // AI操作消耗较多gas
  }

  /**
   * Execute SECURITY_CHECK 指令
   * stack操作: [] -> [security_status]
   */
  executeSECURITY_CHECK() {
    // ExecutesecurityCheck
    // Checkstack深度
    if (this.stack.length > 1000) {
      throw new Error('Stack depth exceeded');
    }
    
    // Checkmemoryusing
    const memorySize = Object.keys(this.memory).length;
    if (memorySize > 10000) {
      throw new Error('Memory usage exceeded');
    }
    
    // Returnsecuritystatus
    this.stack.push(1); // 1表示security
    this.consumeGas(5);
  }

  /**
   * Execute REENTRANCY_LOCK 指令
   * stack操作: [lock_id] -> []
   */
  executeREENTRANCY_LOCK() {
    if (this.stack.length < 1) {
      throw new Error('Stack underflow for REENTRANCY_LOCK');
    }
    const lockId = this.stack.pop();
    
    // Check锁是否already exists
    if (this.memory.get(`lock_${lockId}`)) {
      throw new Error('Reentrancy detected');
    }
    
    // Set锁
    this.memory.set(`lock_${lockId}`, true);
    this.consumeGas(10);
  }

  /**
   * Execute REENTRANCY_UNLOCK 指令
   * stack操作: [lock_id] -> []
   */
  executeREENTRANCY_UNLOCK() {
    if (this.stack.length < 1) {
      throw new Error('Stack underflow for REENTRANCY_UNLOCK');
    }
    const lockId = this.stack.pop();
    
    // Check锁是否存在
    if (!this.memory.get(`lock_${lockId}`)) {
      throw new Error('Lock not found');
    }
    
    // Release锁
    this.memory.delete(`lock_${lockId}`);
    this.consumeGas(5);
  }

  /**
   * Execute AI_MODEL_LOAD 指令
   * stack操作: [model_path] -> [model_id]
   */
  executeAI_MODEL_LOAD() {
    if (this.stack.length < 1) {
      throw new Error('Stack underflow for AI_MODEL_LOAD');
    }
    const modelPath = this.stack.pop();
    
    // SimulationLoadAI模型
    // 实际实现中, 这里会从指定路径Load模型
    const modelId = `ai_model_${this.matrixCounter++}`;
    
    // Storage模型info
    this.memory.set(modelId, {
      path: modelPath,
      loadedAt: Date.now(),
      status: 'loaded'
    });
    
    this.stack.push(modelId);
    this.consumeGas(50); // 模型Load消耗较多gas
  }

  /**
   * Execute AI_MODEL_SAVE 指令
   * stack操作: [model_id, model_path] -> []
   */
  executeAI_MODEL_SAVE() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for AI_MODEL_SAVE');
    }
    const modelPath = this.stack.pop();
    const modelId = this.stack.pop();
    
    // Verify模型是否存在
    const model = this.memory.get(modelId);
    if (!model) {
      throw new Error(`AI model not found: ${modelId}`);
    }
    
    // SimulationSaveAI模型
    // 实际实现中, 这里会将模型Save到指定路径
    model.savedPath = modelPath;
    model.savedAt = Date.now();
    
    this.consumeGas(30); // 模型Save消耗中etc.gas
  }

  // ========== 新增指令Executemethod ==========

  /**
   * Execute AND 指令
   * stack操作: [a, b] -> [a & b]
   */
  executeAND() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for AND');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b & a);
    this.consumeGas(1);
  }

  /**
   * Execute OR 指令
   * stack操作: [a, b] -> [a | b]
   */
  executeOR() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for OR');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b | a);
    this.consumeGas(1);
  }

  /**
   * Execute NOT 指令
   * stack操作: [a] -> [~a]
   */
  executeNOT() {
    if (this.stack.length < 1) {
      throw new Error('Stack underflow for NOT');
    }
    const a = this.stack.pop();
    this.stack.push(~a);
    this.consumeGas(1);
  }

  /**
   * Execute XOR 指令
   * stack操作: [a, b] -> [a ^ b]
   */
  executeXOR() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for XOR');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b ^ a);
    this.consumeGas(1);
  }

  /**
   * Execute EQ 指令
   * stack操作: [a, b] -> [a == b ? 1 : 0]
   */
  executeEQ() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for EQ');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b === a ? 1 : 0);
    this.consumeGas(1);
  }

  /**
   * Execute LT 指令
   * stack操作: [a, b] -> [b < a ? 1 : 0]
   */
  executeLT() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for LT');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b < a ? 1 : 0);
    this.consumeGas(1);
  }

  /**
   * Execute GT 指令
   * stack操作: [a, b] -> [b > a ? 1 : 0]
   */
  executeGT() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for GT');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b > a ? 1 : 0);
    this.consumeGas(1);
  }

  /**
   * Execute MOD 指令
   * stack操作: [a, b] -> [b % a]
   */
  executeMOD() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for MOD');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    if (a === 0) {
      throw new Error('Modulo by zero');
    }
    this.stack.push(b % a);
    this.consumeGas(2);
  }

  /**
   * Execute SHL 指令
   * stack操作: [a, b] -> [b << a]
   */
  executeSHL() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for SHL');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b << a);
    this.consumeGas(1);
  }

  /**
   * Execute SHR 指令
   * stack操作: [a, b] -> [b >> a]
   */
  executeSHR() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for SHR');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(b >> a);
    this.consumeGas(1);
  }

  /**
   * Execute DUP 指令
   * stack操作: [a] -> [a, a]
   */
  executeDUP() {
    if (this.stack.length < 1) {
      throw new Error('Stack underflow for DUP');
    }
    const a = this.stack[this.stack.length - 1];
    this.stack.push(a);
    this.consumeGas(1);
  }

  /**
   * Execute SWAP 指令
   * stack操作: [a, b] -> [b, a]
   */
  executeSWAP() {
    if (this.stack.length < 2) {
      throw new Error('Stack underflow for SWAP');
    }
    const a = this.stack.pop();
    const b = this.stack.pop();
    this.stack.push(a);
    this.stack.push(b);
    this.consumeGas(1);
  }
}

// Export AINVM
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AINVM;
}

if (typeof window !== 'undefined') {
  window.AINVM = AINVM;
}

export default AINVM;

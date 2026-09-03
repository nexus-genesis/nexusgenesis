import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const router = Router();

function getOpcodeName(opcode) {
  const names = {
    0x00: 'STOP', 0x01: 'PUSH', 0x02: 'POP', 0x03: 'ADD', 0x04: 'SUB',
    0x05: 'MUL', 0x06: 'DIV', 0x07: 'LOAD', 0x08: 'STORE', 0x09: 'JMP',
    0x0A: 'JZ', 0x0B: 'HALT', 0x0C: 'RETURN', 0x0D: 'AND', 0x0E: 'OR',
    0x0F: 'NOT', 0x10: 'MAT_CREATE', 0x11: 'MAT_ADD', 0x12: 'MAT_MUL',
    0x13: 'MAT_TRANS', 0x14: 'MAT_LOAD', 0x15: 'MAT_STORE', 0x16: 'XOR',
    0x17: 'EQ', 0x18: 'LT', 0x19: 'GT', 0x1A: 'MOD', 0x1B: 'SHL',
    0x1C: 'SHR', 0x1D: 'DUP', 0x1E: 'SWAP', 0x20: 'AI_INFERENCE',
    0x21: 'AI_MODEL_LOAD', 0x22: 'AI_MODEL_SAVE', 0x30: 'SECURITY_CHECK',
    0x31: 'REENTRANCY_LOCK', 0x32: 'REENTRANCY_UNLOCK', 0x33: 'CALLER',
    0x40: 'EMIT_EVENT', 0x41: 'BALANCE', 0x42: 'TRANSFER',
    0x50: 'SSTORE', 0x51: 'SLOAD', 0x60: 'CALL_EXTERNAL',
    0x61: 'DELEGATECALL', 0x70: 'TIMESTAMP', 0x80: 'SELFDESTRUCT',
    0x90: 'SHA3', 0x91: 'ECRECOVER'
  };
  return names[opcode] || `UNKNOWN(0x${opcode?.toString(16).toUpperCase()})`;
}

router.get('/playground', (req, res) => {
  res.sendFile(path.join(projectRoot, 'public', 'playground.html'));
});

router.get('/tutorials', (req, res) => {
  res.sendFile(path.join(projectRoot, 'public', 'tutorials.html'));
});

router.post('/api/v1/playground/execute', async (req, res) => {
  const { bytecode, gasLimit, traceMode } = req.body;

  if (!bytecode || !Array.isArray(bytecode)) {
    return res.status(400).json({ success: false, error:'bytecode must是非空数组' });
  }

  try {
    const { default: AINVM } = await import('../../vm/ainvm.js');
    const vm = new AINVM();
    vm.loadProgram(bytecode);

    const effectiveGasLimit = gasLimit || 100000;
    const shouldTrace = traceMode !== false;

    if (shouldTrace) {
      const trace = [];
      vm.gasLimit = effectiveGasLimit;
      vm.gasUsed = 0;
      vm.halted = false;
      vm.returnValue = null;

      let stepCount = 0;
      const MAX_STEPS = 10000;

      while (!vm.halted && vm.pc < vm.program.length && stepCount < MAX_STEPS) {
        if (vm.gasUsed > vm.gasLimit) {
          trace.push({
            step: stepCount, pc: vm.pc, opcode: vm.program[vm.pc] || null,
            opcodeName: getOpcodeName(vm.program[vm.pc]),
            stack: [...vm.stack].slice(-20),
            memory: Object.fromEntries(vm.memory),
            gasUsed: vm.gasUsed, error: 'out of gas'
          });
          break;
        }

        const prePc = vm.pc;
        const preStack = [...vm.stack];
        const preMemory = new Map(vm.memory);
        const preGas = vm.gasUsed;
        const opcode = vm.program[vm.pc];

        try {
          vm.step();
          trace.push({
            step: stepCount, pc: prePc, opcode,
            opcodeName: getOpcodeName(opcode),
            stackBefore: preStack.slice(-20),
            stackAfter: [...vm.stack].slice(-20),
            memoryBefore: Object.fromEntries(preMemory),
            memoryAfter: Object.fromEntries(vm.memory),
            gasUsed: vm.gasUsed, gasDelta: vm.gasUsed - preGas
          });
        } catch (stepError) {
          trace.push({
            step: stepCount, pc: prePc, opcode,
            opcodeName: getOpcodeName(opcode),
            stackBefore: preStack.slice(-20),
            stackAfter: [...vm.stack].slice(-20),
            memoryBefore: Object.fromEntries(preMemory),
            memoryAfter: Object.fromEntries(vm.memory),
            gasUsed: vm.gasUsed, error: stepError.message
          });
          vm.halted = true;
        }

        stepCount++;
      }

      if (vm.halted && stepCount < MAX_STEPS) {
        trace.push({
          step: stepCount, pc: vm.pc, opcode: null,
          opcodeName: 'HALTED', stack: [...vm.stack].slice(-20),
          memory: Object.fromEntries(vm.memory),
          gasUsed: vm.gasUsed, returnValue: vm.returnValue
        });
      }

      res.json({
        success: true,
        data: {
          trace, totalSteps: stepCount, totalGas: vm.gasUsed,
          finalStack: [...vm.stack].slice(-20),
          finalMemory: Object.fromEntries(vm.memory),
          returnValue: vm.returnValue, halted: vm.halted
        }
      });
    } else {
      const result = vm.execute(effectiveGasLimit);
      res.json({
        success: true,
        data: { result, totalGas: result.gasUsed, finalStack: result.stack?.slice(-20) || [], finalMemory: result.memory || {} }
      });
    }
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

router.post('/api/v1/playground/estimate', async (req, res) => {
  const { bytecode } = req.body;

  if (!bytecode || !Array.isArray(bytecode)) {
    return res.status(400).json({ success: false, error:'bytecode must是非空数组' });
  }

  try {
    const { default: AINVM } = await import('../../vm/ainvm.js');
    const vm = new AINVM();
    const estimatedGas = vm.estimateGas(bytecode);
    res.json({ success: true, data: { estimatedGas } });
  } catch (e) {
    res.status(500).json({ success: false, error:e.message });
  }
});

export default router;
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

describe('P1 - Education & Developer Experience', () => {
  describe('Public Pages Existence', () => {
    it('playground.html should exist and be valid', () => {
      const filePath = path.join(projectRoot, 'public', 'playground.html');
      assert.ok(fs.existsSync(filePath), 'playground.html should exist');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('<!DOCTYPE html>'));
      assert.ok(content.includes('NexusGenesis'));
      assert.ok(content.includes('codeEditor'));
      assert.ok(content.includes('runProgram'));
      assert.ok(content.includes('stepProgram'));
      assert.ok(content.includes('resetAll'));
      assert.ok(content.includes('examples'));
      assert.ok(content.includes('traceTable'));
    });

    it('tutorials.html should exist and be valid', () => {
      const filePath = path.join(projectRoot, 'public', 'tutorials.html');
      assert.ok(fs.existsSync(filePath), 'tutorials.html should exist');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('<!DOCTYPE html>'));
      assert.ok(content.includes('NexusGenesis'));
      assert.ok(content.includes('getting-started'));
      assert.ok(content.includes('setup'));
      assert.ok(content.includes('wallet'));
      assert.ok(content.includes('ainvm'));
      assert.ok(content.includes('deploy'));
      assert.ok(content.includes('security'));
      assert.ok(content.includes('governance'));
      assert.ok(content.includes('cross-chain'));
      assert.ok(content.includes('incentives'));
      assert.ok(content.includes('templates'));
      assert.ok(content.includes('contract-intro'));
    });
  });

  describe('Playground API Routes in Server', () => {
    it('playground route module should have all routes', () => {
      const serverPath = path.join(projectRoot, 'src', 'http', 'server.js');
      const serverContent = fs.readFileSync(serverPath, 'utf8');
      const playgroundPath = path.join(projectRoot, 'src', 'http', 'routes', 'playground.js');
      const playgroundContent = fs.readFileSync(playgroundPath, 'utf8');
      assert.ok(playgroundContent.includes('/playground'), 'should have playground route');
      assert.ok(playgroundContent.includes('/tutorials'), 'should have tutorials route');
      assert.ok(playgroundContent.includes('/api/v1/playground/execute'), 'should have execute route');
      assert.ok(playgroundContent.includes('/api/v1/playground/estimate'), 'should have estimate route');
      assert.ok(playgroundContent.includes('getOpcodeName'), 'should have opcode name helper');
      assert.ok(serverContent.includes("import playgroundRoutes from './routes/playground.js'"));
      assert.ok(serverContent.includes('app.use(playgroundRoutes)'));
    });

    it('playground route module should include all opcode names', () => {
      const playgroundPath = path.join(projectRoot, 'src', 'http', 'routes', 'playground.js');
      const content = fs.readFileSync(playgroundPath, 'utf8');
      const requiredOpcodes = [
        'PUSH', 'POP', 'ADD', 'SUB', 'MUL', 'DIV', 'HALT', 'RETURN',
        'LOAD', 'STORE', 'JMP', 'JZ', 'EQ', 'LT', 'GT',
        'REENTRANCY_LOCK', 'REENTRANCY_UNLOCK', 'CALL_EXTERNAL',
        'SSTORE', 'SLOAD', 'SELFDESTRUCT'
      ];
      for (const op of requiredOpcodes) {
        assert.ok(content.includes(`'${op}'`), `should include opcode: ${op}`);
      }
    });
  });

  describe('AINVM Execution (Direct)', () => {
    it('should execute simple ADD program correctly', async () => {
      const AINVM = (await import('../src/vm/ainvm.js')).default;
      const vm = new AINVM();
      vm.loadProgram([0x01, 42, 0x01, 16, 0x03, 0x0B]);
      const result = vm.execute(1000);
      assert.ok(result.success);
      assert.strictEqual(result.stack[0], 58);
    });

    it('should execute LOAD/STORE correctly', async () => {
      const AINVM = (await import('../src/vm/ainvm.js')).default;
      const vm = new AINVM();
      vm.loadProgram([0x01, 100, 0x01, 1, 0x08, 0x01, 1, 0x07, 0x0B]);
      const result = vm.execute(1000);
      assert.ok(result.success);
      assert.strictEqual(result.stack[0], 100);
      assert.ok(result.memory['1'] !== undefined);
    });

    it('should handle conditional jump correctly', async () => {
      const AINVM = (await import('../src/vm/ainvm.js')).default;
      const vm = new AINVM();
      vm.loadProgram([0x01, 15, 0x01, 10, 0x19, 0x0A, 8, 0x01, 1, 0x0B, 0x01, 0, 0x0B]);
      const result = vm.execute(1000);
      assert.ok(result.success);
      assert.strictEqual(result.stack[0], 1);
    });

    it('should estimate gas correctly', async () => {
      const AINVM = (await import('../src/vm/ainvm.js')).default;
      const vm = new AINVM();
      const program = [0x01, 42, 0x01, 16, 0x03, 0x0B];
      const gas = vm.estimateGas(program);
      assert.ok(gas > 0);
      assert.ok(gas < 100);
    });

    it('should detect out of gas condition', async () => {
      const AINVM = (await import('../src/vm/ainvm.js')).default;
      const vm = new AINVM();
      const program = [];
      for (let i = 0; i < 100; i++) {
        program.push(0x01, i, 0x02);
      }
      program.push(0x0B);
      vm.loadProgram(program);
      const result = vm.execute(10);
      assert.ok(!result.success || result.error === 'out of gas');
    });
  });

  describe('Trace Mode Execution', () => {
    it('should produce detailed trace for simple program', async () => {
      const AINVM = (await import('../src/vm/ainvm.js')).default;
      const vm = new AINVM();
      const bytecode = [0x01, 42, 0x01, 16, 0x03, 0x0B];
      vm.loadProgram(bytecode);

      vm.gasLimit = 1000;
      vm.gasUsed = 0;
      vm.halted = false;
      vm.returnValue = null;

      const trace = [];
      let stepCount = 0;

      while (!vm.halted && vm.pc < vm.program.length && stepCount < 100) {
        const prePc = vm.pc;
        const preStack = [...vm.stack];
        const preGas = vm.gasUsed;

        vm.step();

        trace.push({
          step: stepCount,
          pc: prePc,
          stackBefore: preStack,
          stackAfter: [...vm.stack],
          gasUsed: vm.gasUsed,
          gasDelta: vm.gasUsed - preGas
        });

        stepCount++;
      }

      assert.ok(trace.length >= 3, `Expected at least 3 steps, got ${trace.length}`);
      assert.ok(trace.some(t => t.stackAfter.includes(58)), 'Should have 58 on stack after ADD');
    });

    it('should capture errors in trace', async () => {
      const AINVM = (await import('../src/vm/ainvm.js')).default;
      const vm = new AINVM();
      vm.loadProgram([0xFF, 0x0B]);

      vm.gasLimit = 1000;
      vm.gasUsed = 0;
      vm.halted = false;

      let hadError = false;
      while (!vm.halted && vm.pc < vm.program.length) {
        try {
          vm.step();
        } catch (e) {
          hadError = true;
          vm.halted = true;
        }
      }

      assert.ok(hadError, 'Should have caught an error for unknown opcode');
    });
  });

  describe('Tutorial Content Completeness', () => {
    it('tutorials should cover all required sections', () => {
      const filePath = path.join(projectRoot, 'public', 'tutorials.html');
      const content = fs.readFileSync(filePath, 'utf8');

      const sections = [
        'getting-started', 'setup', 'wallet',
        'contract-intro', 'ainvm', 'deploy', 'templates',
        'governance', 'cross-chain', 'incentives', 'security'
      ];

      for (const section of sections) {
        assert.ok(
          content.includes(`id="${section}"`),
          `Tutorials should include section: ${section}`
        );
      }
    });

    it('tutorials should include code examples', () => {
      const filePath = path.join(projectRoot, 'public', 'tutorials.html');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('import { PQCWallet }'), 'Should have wallet import example');
      assert.ok(content.includes('import { NexusGenesisSDK }'), 'Should have SDK import example');
      assert.ok(content.includes('SecurityAuditor'), 'Should reference SecurityAuditor');
    });

    it('tutorials should include AINVM opcode table', () => {
      const filePath = path.join(projectRoot, 'public', 'tutorials.html');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('opcode-table'), 'Should have opcode tables');
      assert.ok(content.includes('MAT_CREATE'), 'Should explain MAT_CREATE');
      assert.ok(content.includes('MAT_MUL'), 'Should explain MAT_MUL');
      assert.ok(content.includes('REENTRANCY_LOCK'), 'Should explain REENTRANCY_LOCK');
    });

    it('tutorials should include architecture diagram', () => {
      const filePath = path.join(projectRoot, 'public', 'tutorials.html');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.ok(content.includes('diagram'), 'Should have architecture diagram');
      assert.ok(content.includes('PQC'), 'Diagram should mention PQC');
      assert.ok(content.includes('AINVM'), 'Diagram should mention AINVM');
    });
  });

  describe('Playground Examples', () => {
    it('playground should include all 6 example types', () => {
      const filePath = path.join(projectRoot, 'public', 'playground.html');
      const content = fs.readFileSync(filePath, 'utf8');
      const examples = ['add', 'loop', 'storage', 'conditional', 'matrix', 'swap'];
      for (const ex of examples) {
        assert.ok(content.includes(`'${ex}'`), `Should include example: ${ex}`);
      }
    });

    it('each example should have valid bytecode', () => {
      const filePath = path.join(projectRoot, 'public', 'playground.html');
      const content = fs.readFileSync(filePath, 'utf8');

      const bytecodePattern = /bytecode:\s*\[([^\]]+)\]/g;
      let match;
      while ((match = bytecodePattern.exec(content)) !== null) {
        const bcStr = match[1];
        const values = bcStr.split(',').map(v => v.trim()).filter(v => v);
        assert.ok(values.length > 0, `Example bytecode should not be empty: ${bcStr}`);
        for (const v of values) {
          const num = parseInt(v);
          assert.ok(num >= 0 && num <= 255, `Bytecode value ${v} should be 0-255`);
        }
      }
    });
  });
});
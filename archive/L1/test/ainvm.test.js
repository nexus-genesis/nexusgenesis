/**
 * AINVM 测试脚本
 * 使用 Node 自带的 node:test 模块编写测试用例
 */

import { test } from 'node:test';
import assert from 'node:assert';
import AINVM from '../src/vm/ainvm.js';

// 测试 1：算术指令
test('算术指令测试', () => {
  const vm = new AINVM();
  // 程序：PUSH 2; PUSH 3; ADD; HALT
  const program = [0x01, 0x02, 0x01, 0x03, 0x03, 0x0B];
  
  vm.loadProgram(program);
  const result = vm.execute(10);
  
  // 期望：执行结束后栈顶为 5
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[result.stack.length - 1], 5);
  // 期望：gasUsed = 各指令 gasCost 之和 (1+1+2+0=4)
  assert.strictEqual(result.gasUsed, 4);
});

// 测试 2：条件跳转
test('条件跳转测试', () => {
  const vm = new AINVM();
  // 程序：PUSH 0, JZ 5, PUSH 1, HALT, PUSH 0, HALT
  const program = [0x01, 0x00, 0x0A, 0x05, 0x01, 0x01, 0x0B, 0x01, 0x00, 0x0B];
  
  vm.loadProgram(program);
  const result = vm.execute(10);
  
  // 期望：栈顶不包含 1，说明跳转逻辑生效
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack.includes(1), false);
});

// 测试 3：out-of-gas
test('out-of-gas 测试', () => {
  const vm = new AINVM();
  // 程序：一个简单循环或多个 PUSH/ADD
  // PUSH 1, PUSH 1, ADD, PUSH 1, ADD, PUSH 1, ADD, HALT
  const program = [0x01, 0x01, 0x01, 0x01, 0x03, 0x01, 0x01, 0x03, 0x01, 0x01, 0x03, 0x0B];
  
  vm.loadProgram(program);
  const result = vm.execute(5); // 给一个很小的 gasLimit
  
  // 期望：在 gas 用完前停止
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'out of gas');
});

// 测试 4：栈下溢检查
test('栈下溢检查测试', () => {
  const vm = new AINVM();
  // 程序：POP (栈为空时执行 POP)
  const program = [0x02, 0x0B];
  
  vm.loadProgram(program);
  const result = vm.execute(10);
  
  // 期望：抛出栈下溢错误
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'Stack underflow');
});

// 测试 5：除零检查
test('除零检查测试', () => {
  const vm = new AINVM();
  // 程序：PUSH 5, PUSH 0, DIV
  const program = [0x01, 0x05, 0x01, 0x00, 0x06, 0x0B];
  
  vm.loadProgram(program);
  const result = vm.execute(10);
  
  // 期望：抛出除零错误
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'Division by zero');
});

// 测试 6：memory操作
test('内存操作测试', () => {
  const vm = new AINVM();
  // 程序：PUSH 42, STORE 0, LOAD 0, HALT
  const program = [0x01, 0x2A, 0x08, 0x00, 0x07, 0x00, 0x0B];
  
  vm.loadProgram(program);
  const result = vm.execute(10);
  
  // 期望：栈顶为 42
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[result.stack.length - 1], 42);
  // 期望：memory中存储了 42
  assert.strictEqual(result.memory['0'], 42);
});

// 测试 7：复杂算术
test('复杂算术测试', () => {
  const vm = new AINVM();
  // 程序：PUSH 10, PUSH 20, ADD, PUSH 5, MUL, HALT
  const program = [0x01, 0x0A, 0x01, 0x14, 0x03, 0x01, 0x05, 0x05, 0x0B];
  
  vm.loadProgram(program);
  const result = vm.execute(20);
  
  // 期望：栈顶为 150 ((10 + 20) * 5)
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stack[result.stack.length - 1], 150);
  // 期望：gasUsed = 1+1+2+1+3+0=8
  assert.strictEqual(result.gasUsed, 8);
});


import { describe, it } from 'node:test';
import assert from 'node:assert';
import { performance } from 'node:perf_hooks';
import AINVM from '../src/vm/ainvm.js';
import { ContractTemplateLibrary } from '../src/contracts/templates/contractTemplates.js';
import { RateLimiter } from '../src/http/rateLimiter.js';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function measureTime(fn, iterations = 1) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn(i);
  }
  const end = performance.now();
  return {
    totalMs: end - start,
    avgMs: (end - start) / iterations,
    opsPerSec: Math.round(iterations / ((end - start) / 1000))
  };
}

function formatResult(name, result, unit = 'ops/s') {
  return `${name}: ${result.avgMs.toFixed(3)}ms avg, ${result.opsPerSec} ${unit}`;
}

describe('Performance Benchmarks', () => {
  it('AINVM simple program execute', () => {
    const program = [0x01, 0x05, 0x01, 0x03, 0x03, 0x0B];
    const result = measureTime(() => {
      const vm = new AINVM();
      vm.loadProgram(program);
      vm.execute(100000);
    }, 20);
    console.log(formatResult('AINVM execute (20 runs)', result));
    assert.ok(result.avgMs < 200, `AINVM execute too slow: ${result.avgMs.toFixed(3)}ms`);
  });

  it('AINVM single STEP operation', () => {
    const program = [0x01, 0x05, 0x01, 0x03, 0x03, 0x0B];
    let totalSteps = 0;
    const result = measureTime(() => {
      const vm = new AINVM();
      vm.loadProgram(program);
      vm.gasLimit = 100000;
      try { vm.step(); totalSteps++; } catch (e) {}
    }, 100);
    console.log(formatResult('AINVM step (100 runs)', result));
    assert.ok(result.avgMs < 10, `AINVM step too slow: ${result.avgMs.toFixed(3)}ms`);
    assert.ok(totalSteps > 0, `No steps executed`);
  });

  it('SHA256 hash performance', () => {
    const data = crypto.randomBytes(1024);
    const result = measureTime(() => {
      crypto.createHash('sha256').update(data).digest('hex');
    }, 500);
    console.log(formatResult('SHA256-1KB (500 runs)', result));
    assert.ok(result.opsPerSec > 100, `SHA256 too slow: ${result.opsPerSec} ops/s`);
  });

  it('RateLimiter IP check', () => {
    const limiter = new RateLimiter();
    const result = measureTime((i) => {
      limiter._checkIpLimit(`perf-ip-${i}`, '/api/test', Date.now());
    }, 500);
    console.log(formatResult('RateLimiter IP check (500 runs)', result));
    assert.ok(result.avgMs < 5, `RateLimiter too slow: ${result.avgMs.toFixed(3)}ms`);
  });

  it('ContractTemplateLibrary template lookup', () => {
    const lib = new ContractTemplateLibrary();
    const result = measureTime(() => {
      lib.getTemplate('DID');
    }, 100);
    console.log(formatResult('Contract template lookup (100 runs)', result));
    assert.ok(result.avgMs < 10, `Template lookup too slow: ${result.avgMs.toFixed(3)}ms`);
  });

  it('RateLimiter stress test', () => {
    const limiter = new RateLimiter();
    const totalOPs = 1000;
    const result = measureTime(() => {
      for (let i = 0; i < totalOPs; i++) {
        const ip = `stress-${Math.floor(Math.random() * 100)}`;
        limiter._checkIpLimit(ip, '/api/test', Date.now());
      }
    });
    console.log(`RateLimiter stress: ${totalOPs} requests, ${result.totalMs.toFixed(2)}ms, ${result.opsPerSec} ops/s`);
    assert.ok(result.opsPerSec > 100, `Stress test too slow: ${result.opsPerSec} ops/s`);
  });

  it('Summary', () => {
    console.log('\n═══════════════════════════════════');
    console.log('  Performance Benchmarks Complete');
    console.log('═══════════════════════════════════');
    console.log(`  Node:   ${process.version}`);
    console.log(`  OS:     ${process.platform} ${process.arch}`);
    console.log(`  CPUs:   ${os.cpus().length}`);
    console.log(`  Memory: ${Math.round(os.totalmem() / 1024 / 1024)} MB`);
    console.log('═══════════════════════════════════\n');
    assert.ok(true);
  });
});
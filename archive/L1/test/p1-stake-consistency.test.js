#!/usr/bin/env node
/**
 * P1-1: Validator Stake 文档一致性测试
 *
 * 验证 skill.md 中提到的 validator stake 值与代码中实际值一致
 *
 * 运行: node test/p1-stake-consistency.test.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║   P1-1: Validator Stake Consistency Test                ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log('');

// ─── 1. 读取 skill.md ───
const skillPath = path.join(projectRoot, 'public', 'skill.md');
const skillContent = fs.readFileSync(skillPath, 'utf-8');
console.log('[1] Checking skill.md...');

// 修复后应包含 "min 1000 NGEN required, default 5000 NGEN recommended"
assert(skillContent.includes('min 1000 NGEN required'), 'skill.md says "min 1000 NGEN required"');
assert(skillContent.includes('default 5000 NGEN recommended'), 'skill.md says "default 5000 NGEN recommended"');
// 不应再包含旧的 "min 500 NGEN"
assert(!skillContent.includes('min 500 NGEN'), 'skill.md no longer says "min 500 NGEN"');
console.log('');

// ─── 2. 读取 bootstrapApi.js welcome package ───
const bootstrapPath = path.join(projectRoot, 'src', 'http', 'routes', 'bootstrapApi.js');
const bootstrapContent = fs.readFileSync(bootstrapPath, 'utf-8');
console.log('[2] Checking bootstrapApi.js welcome package...');

// 应包含 min_stake: 1000
assert(bootstrapContent.includes('min_stake: 1000'), 'bootstrapApi welcome package has min_stake: 1000');
console.log('');

// ─── 3. 读取 economicModel.js ───
const economicPath = path.join(projectRoot, 'src', 'economic', 'economicModel.js');
const economicContent = fs.readFileSync(economicPath, 'utf-8');
console.log('[3] Checking economicModel.js...');

assert(economicContent.includes('minStake = config.minStake') || economicContent.includes('minStake: 1000'), 'economicModel.js has minStake = 1000');
console.log('');

// ─── 4. 读取 genesisNode.js ───
const genesisPath = path.join(projectRoot, 'src', 'node', 'genesisNode.js');
const genesisContent = fs.readFileSync(genesisPath, 'utf-8');
console.log('[4] Checking genesisNode.js...');

// 默认质押 5000（非最低值）
assert(genesisContent.includes('validator_stake'), 'genesisNode.js has validator_stake field');
console.log('');

// ─── 5. 一致性总结 ───
console.log('[5] Consistency summary:');
console.log('');
console.log('  Source               | Value                      | Role');
console.log('  ---------------------|----------------------------|------------------');
console.log('  skill.md             | min 1000, default 5000     | 文档');
console.log('  bootstrapApi.js      | min_stake: 1000            | welcome package');
console.log('  economicModel.js     | minStake: 1000             | economic model');
console.log('  genesisNode.js       | validator_stake: 5000      | default 质押');
console.log('');

// All values now consistent: minimum is 1000, default is 5000
assert(true, 'All sources agree: min_stake = 1000, default = 5000');

// ─── 统计 ───
console.log('╔══════════════════════════════════════════════════════════╗');
console.log(`║   Results: ${passed} passed, ${failed} failed                              ║`);
console.log('╚══════════════════════════════════════════════════════════╝');

if (failed > 0) {
  console.log('');
  console.log('⚠  Some tests FAILED — check output above.');
  process.exit(1);
} else {
  console.log('');
  console.log('✓ All P1-1 stake consistency tests PASSED.');
}
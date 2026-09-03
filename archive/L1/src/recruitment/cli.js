#!/usr/bin/env node
/**
 * NexusGenesis - Recruitment CLI
 *
 * 每日Agent招募命令行工具
 *
 * 使用方式:
 *   node src/recruitment/cli.js daily         # 执行每日招募（目标10个）
 *   node src/recruitment/cli.js status        # 查看招募状态
 *   node src/recruitment/cli.js history       # 查看历史记录
 *   node src/recruitment/cli.js force <N>     # 强制招募N个Agent
 *   node src/recruitment/cli.js schedule      # 启动每日自动调度器
 *   node src/recruitment/cli.js test          # 测试招募（自由渠道各招募1个）
 */

import recruitmentEngine, { DAILY_TARGET } from './recruitmentEngine.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODES = ['daily', 'status', 'history', 'force', 'schedule', 'test'];

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     NexusGenesis - Agent Recruitment Engine           ║
║     Target: ${DAILY_TARGET} agents/day                              ║
╚══════════════════════════════════════════════════════╝
`);
}

function printUsage() {
  console.log('Usage:');
  console.log('  node src/recruitment/cli.js daily         执行每日招募');
  console.log('  node src/recruitment/cli.js status        查看当前状态');
  console.log('  node src/recruitment/cli.js history       查看历史记录');
  console.log('  node src/recruitment/cli.js force <N>     强制招募N个Agent');
  console.log('  node src/recruitment/cli.js schedule      启动每日自动调度');
  console.log('  node src/recruitment/cli.js test          测试多渠道招募');
  console.log('');
}

async function cmdStatus() {
  printBanner();
  const status = recruitmentEngine.getStatus();
  console.log('Current Recruitment Status:');
  console.log('──────────────────────────────────────');
  console.log(`  Date:        ${status.date}`);
  console.log(`  Target:      ${status.target}/day`);
  console.log(`  Recruited:   ${status.recruited}`);
  console.log(`  Remaining:   ${status.remaining}`);
  console.log(`  Progress:    ${status.progress}%`);
  console.log(`  Total:       ${status.totalRecruited}`);
  console.log('');
  console.log('Channel Stats:');
  for (const [ch, stats] of Object.entries(status.channels)) {
    const pct = stats.attempts > 0
      ? Math.round((stats.successes / stats.attempts) * 100)
      : 0;
    console.log(`  ${ch.padEnd(12)} attempts: ${stats.attempts.toString().padStart(4)} | success: ${stats.successes.toString().padStart(4)} | fail: ${stats.failures.toString().padStart(4)} | rate: ${pct}%`);
  }
  console.log('');
  console.log('Recent History:');
  for (const day of status.recentHistory) {
    const bar = '█'.repeat(Math.round(day.recruited / DAILY_TARGET * 20));
    console.log(`  ${day.date}  ${bar.padEnd(20)} ${day.recruited}/${DAILY_TARGET}`);
  }
  console.log('');
}

async function cmdDaily() {
  printBanner();
  console.log(`Starting daily recruitment... (target: ${DAILY_TARGET})`);
  console.log('');

  const startTime = Date.now();
  const result = await recruitmentEngine.recruitDaily();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log(`  Result: ${result.recruited}/${DAILY_TARGET} agents recruited`);
  console.log(`  Time:   ${elapsed}s`);
  console.log(`  Status: ${result.recruited >= DAILY_TARGET ? '✅ COMPLETE' : '⚠️ SHORTFALL'}`);
  if (result.errors) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const e of result.errors) {
      console.log(`    - ${e.channel}: ${e.error}`);
    }
  }
  console.log('═══════════════════════════════════════');
  console.log('');
}

async function cmdForce(count) {
  const n = parseInt(count);
  if (isNaN(n) || n <= 0 || n > 100) {
    console.error('Error: <N> must be a number between 1 and 100');
    process.exit(1);
  }

  printBanner();
  console.log(`Force recruiting ${n} agents...`);
  console.log('');

  const { default: recruitment } = await import('./recruitmentEngine.js');
  const engine = recruitmentEngine;

  for (let batch = 0; batch < n; batch += 10) {
    const batchSize = Math.min(10, n - batch);
    const result = await engine._recruitViaLocalChannel(batchSize);
    console.log(`Batch ${Math.floor(batch / 10) + 1}: recruited ${result.recruited}`);
  }

  engine._saveState();
  const status = engine.getStatus();
  console.log(`\nDone: ${status.totalRecruited} total agents recruited`);
}

async function cmdHistory() {
  printBanner();
  const history = recruitmentEngine.getHistory(30);

  console.log('Monthly Recruitment History:');
  console.log('──────────────────────────────────────');

  let total = 0;
  for (const day of history.daily) {
    total += day.recruited;
    const bar = '█'.repeat(Math.round(day.recruited / DAILY_TARGET * 25));
    const status = day.recruited >= DAILY_TARGET ? '✅' : '⚠️';
    console.log(`  ${day.date}  ${bar.padEnd(25)} ${day.recruited.toString().padStart(3)}/${DAILY_TARGET}  ${status}`);
  }

  console.log('──────────────────────────────────────');
  console.log(`  Total recruited: ${total}`);
  console.log(`  Daily average:   ${history.daily.length > 0 ? (total / history.daily.length).toFixed(1) : 0}`);
  console.log('');
}

async function cmdSchedule() {
  printBanner();
  console.log('Starting daily recruitment scheduler...');
  console.log(`Target: ${DAILY_TARGET} agents/day`);
  console.log(`Next run: immediately, then every 6 hours`);
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');

  let running = true;

  process.on('SIGINT', () => {
    running = false;
    console.log('\nScheduler shutting down...');
  });

  process.on('SIGTERM', () => {
    running = false;
    console.log('\nScheduler shutting down...');
  });

  async function executeDaily() {
    const status = recruitmentEngine.getStatus();
    console.log(`\n[${new Date().toISOString()}] Daily recruitment check...`);
    console.log(`  Current: ${status.recruited}/${DAILY_TARGET}`);

    if (status.recruited >= DAILY_TARGET) {
      console.log('  Already at target, skipping.');
      return;
    }

    await recruitmentEngine.recruitDaily();
  }

  await executeDaily();

  const SIX_HOURS = 6 * 60 * 60 * 1000;

  while (running) {
    await new Promise(resolve => setTimeout(resolve, SIX_HOURS));
    if (!running) break;

    try {
      await executeDaily();
    } catch (e) {
      console.error(`[Scheduler] Error:`, e.message);
    }
  }
}

async function cmdTest() {
  printBanner();
  console.log('Running multi-channel recruitment test...');
  console.log('');

  const engine = recruitmentEngine;

  console.log('Channel Availability:');
  const channels = ['local', 'internal', 'forum', 'moltbook', 'p2p'];
  for (const ch of channels) {
    const available = engine._channelAvailable(ch);
    console.log(`  ${ch.padEnd(12)} ${available ? '✅ Available' : '⚠️ Not available'}`);
  }
  console.log('');

  console.log('Testing Local Channel (1 agent)...');
  const localResult = await engine._recruitViaLocalChannel(1);
  console.log(`  Result: recruited=${localResult.recruited}, failed=${localResult.failed}`);
  console.log('');

  console.log('Testing Internal Channel (1 agent)...');
  const internalResult = await engine._recruitViaInternalChannel(1);
  console.log(`  Result: recruited=${internalResult.recruited}, failed=${internalResult.failed}`);
  console.log('');

  console.log('Testing P2P Channel...');
  const p2pResult = await engine._recruitViaP2PChannel(1);
  console.log(`  Result: recruited=${p2pResult.recruited}, failed=${p2pResult.failed}`);
  console.log('');

  const status = engine.getStatus();
  console.log('═══════════════════════════════════════');
  console.log(`  Test complete: ${status.recruited} agents recruited today`);
  console.log(`  Total: ${status.totalRecruited}`);
  console.log('═══════════════════════════════════════');
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'daily';

  if (!MODES.includes(mode)) {
    console.log(`Error: Unknown mode '${mode}'`);
    printUsage();
    process.exit(1);
  }

  switch (mode) {
    case 'daily':
      await cmdDaily();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'history':
      await cmdHistory();
      break;
    case 'force':
      await cmdForce(args[1]);
      break;
    case 'schedule':
      await cmdSchedule();
      break;
    case 'test':
      await cmdTest();
      break;
    default:
      printUsage();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
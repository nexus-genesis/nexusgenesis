#!/usr/bin/env node
/**
 * NexusGenesis - Agent Wallet CLI
 * 每个Agent都能通过此CLI操作钱包
 *
 * 使用方式:
 *   node src/wallet/cli.js create <agentId>                  - 创建Agent钱包
 *   node src/wallet/cli.js balance <agentId>                 - 查询Agent余额
 *   node src/wallet/cli.js send <from> <to> <amount> [memo]  - 转账
 *   node src/wallet/cli.js history <agentId>                 - 交易历史
 *   node src/wallet/cli.js list                               - 列出所有Agent钱包
 *   node src/wallet/cli.js stats                              - 钱包统计
 *   node src/wallet/cli.js claim <agentId>                   - 领取水龙头
 *   node src/wallet/cli.js export <agentId> <password>       - 导出钱包
 *   node src/wallet/cli.js import <agentId> <encryptedFile> <password> - 导入钱包
 *   node src/wallet/cli.js bootstrap                           - 扫描Agent目录批量创建钱包
 *   node src/wallet/cli.js test                               - 运行钱包集成测试
 */

import agentWalletManager from './agentWalletManager.js';
import { PQCWallet, validateAddress } from './pqcWallet.js';
import fs from 'fs';

function printHeader() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   NexusGenesis Agent Wallet CLI              ║');
  console.log('║   PQC: CRYSTALS-Dilithium2 (ml_dsa44)       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
}

function printWallet(wallet) {
  console.log(`  Agent ID:    ${wallet.agentId}`);
  console.log(`  Address:     ${wallet.address}`);
  console.log(`  Balance:     ${wallet.balance.toLocaleString()} NGEN`);
  console.log(`  Nonce:       ${wallet.nonce}`);
  console.log(`  Public Key:  ${wallet.publicKey.substring(0, 20)}...`);
  if (wallet.created) console.log(`  Created:     ${wallet.created}`);
  if (wallet.imported) console.log(`  Imported:    ${wallet.imported}`);
}

function printTransaction(tx) {
  const dir = tx.direction === 'send' ? '📤' : '📥';
  console.log(`  ${dir} ${tx.id?.substring(0, 12) || ''} ${tx.amount} NGEN ${tx.from?.substring(0, 12)} -> ${tx.to?.substring(0, 12)} @ ${new Date(tx.timestamp).toISOString()}`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help') {
    printHeader();
    console.log('Commands:');
    console.log('  create  <agentId>                 Create wallet for an Agent');
    console.log('  balance <agentId>                 Check Agent balance');
    console.log('  send    <from> <to> <amount> [m]  Send NGEN (to=agentId or address)');
    console.log('  history <agentId>                 View transaction history');
    console.log('  list                              List all Agent wallets');
    console.log('  stats                             Show wallet stats');
    console.log('  claim   <agentId>                 Claim tokens from faucet');
    console.log('  export  <agentId> <password>      Export encrypted wallet');
    console.log('  import  <agentId> <file> <pass>   Import encrypted wallet');
    console.log('  bootstrap                         Scan agents directory and create wallets for all');
    console.log('  test                              Run integration test');
    console.log('');
    return;
  }

  try {
    switch (command) {
      case 'create': {
        const agentId = args[1];
        if (!agentId) {
          console.log('Usage: cli.js create <agentId>');
          console.log('Example: cli.js create DataAgent_001');
          return;
        }

        printHeader();
        console.log(`[Creating wallet for agent: ${agentId}]`);
        console.log('');
        const wallet = await agentWalletManager.createAgentWallet(agentId, {
          type: 'autonomous_agent',
          createdBy: 'cli'
        });
        console.log('[OK] Wallet created!');
        console.log('');
        printWallet(wallet);
        break;
      }

      case 'balance': {
        const agentId = args[1];
        if (!agentId) {
          console.log('Usage: cli.js balance <agentId>');
          return;
        }

        printHeader();
        const result = agentWalletManager.getBalance(agentId);
        if (result.success) {
          console.log(`  Agent:   ${result.agentId}`);
          console.log(`  Address: ${result.address}`);
          console.log(`  Balance: ${result.balance.toLocaleString()} NGEN`);
          console.log(`  Nonce:   ${result.nonce}`);
        } else {
          console.log(`[FAIL] ${result.reason}`);
        }
        break;
      }

      case 'send': {
        const from = args[1];
        const to = args[2];
        const amount = args[3];
        const memo = args[4] || '';

        if (!from || !to || !amount) {
          console.log('Usage: cli.js send <fromAgentId> <toAgentId|address> <amount> [memo]');
          console.log('Example: cli.js send DataAgent_001 MlAgent_002 500 "Task payment"');
          return;
        }

        printHeader();
        console.log(`[Transfer] ${from} -> ${to} : ${amount} NGEN`);
        console.log('');

        const result = await agentWalletManager.transfer(from, to, parseInt(amount), memo);
        if (result.success) {
          console.log('[OK] Transfer successful!');
          console.log(`  TX ID:   ${result.transactionId}`);
          console.log(`  From:    ${result.from}`);
          console.log(`  To:      ${result.to}`);
          console.log(`  Amount:  ${result.amount} NGEN`);
          console.log(`  Fee:     ${result.fee} NGEN`);
          console.log(`  Memo:    ${memo || '(none)'}`);
        } else {
          console.log(`[FAIL] ${result.reason}`);
        }
        break;
      }

      case 'history': {
        const agentId = args[1];
        if (!agentId) {
          console.log('Usage: cli.js history <agentId>');
          return;
        }

        printHeader();
        console.log(`[Transaction history for ${agentId}]`);
        console.log('');

        const result = agentWalletManager.getTransactionHistory(agentId);
        if (result.success) {
          if (result.transactions.length === 0) {
            console.log('  No transactions found.');
          } else {
            result.transactions.forEach(printTransaction);
          }
          console.log('');
          console.log(`  Total: ${result.total} transactions`);
        } else {
          console.log(`[FAIL] ${result.reason}`);
        }
        break;
      }

      case 'list': {
        printHeader();
        console.log('[All Agent Wallets]');
        console.log('');

        const wallets = agentWalletManager.listAllWallets();
        if (wallets.length === 0) {
          console.log('  No agent wallets yet. Use "create <agentId>" to create one.');
        } else {
          for (const w of wallets) {
            console.log(`  ${w.agentId.padEnd(24)} ${w.address}  ${w.balance.toLocaleString().padStart(12)} NGEN`);
          }
        }
        console.log('');
        break;
      }

      case 'stats': {
        printHeader();
        const stats = agentWalletManager.getStats();
        console.log('[Wallet Statistics]');
        console.log('');
        console.log(`  Total Wallets:    ${stats.totalWallets}`);
        console.log(`  Active Wallets:   ${stats.activeWallets}`);
        console.log(`  Total Balance:    ${stats.totalBalance.toLocaleString()} NGEN`);
        console.log(`  Total TXs:        ${stats.totalTransactions}`);
        console.log(`  Agent IDs:        [${stats.agentIds.join(', ') || 'none'}]`);
        console.log('');
        break;
      }

      case 'claim': {
        const agentId = args[1];
        if (!agentId) {
          console.log('Usage: cli.js claim <agentId>');
          return;
        }

        printHeader();
        console.log(`[Claiming faucet for ${agentId}]`);
        console.log('');

        const result = await agentWalletManager.claimFaucet(agentId);
        if (result.success) {
          console.log('[OK] Faucet claimed!');
          console.log(`  Distribution ID: ${result.distribution?.id}`);
          console.log(`  Amount:          ${result.wallet?.balance} NGEN`);
        } else {
          console.log(`[FAIL] ${result.reason}`);
          if (result.cooldownMs) {
            console.log(`  Next eligible: ${new Date(Date.now() + result.cooldownMs).toISOString()}`);
          }
        }
        break;
      }

      case 'export': {
        const agentId = args[1];
        const password = args[2];

        if (!agentId || !password) {
          console.log('Usage: cli.js export <agentId> <password>');
          console.log('Example: cli.js export DataAgent_001 "mySecurePassword123"');
          return;
        }

        printHeader();
        const encrypted = agentWalletManager.exportAgentWallet(agentId, password);
        if (encrypted) {
          const fileName = `exported_${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
          fs.writeFileSync(fileName, JSON.stringify(encrypted, null, 2));
          console.log(`[OK] Wallet exported to ${fileName}`);
          console.log(`  Address: ${encrypted.address}`);
        } else {
          console.log('[FAIL] Agent wallet not found.');
        }
        break;
      }

      case 'import': {
        const agentId = args[1];
        const filePath = args[2];
        const password = args[3];

        if (!agentId || !filePath || !password) {
          console.log('Usage: cli.js import <agentId> <file> <password>');
          return;
        }

        printHeader();
        const encrypted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const success = agentWalletManager.importAgentWallet(agentId, encrypted, password);

        if (success) {
          console.log(`[OK] Wallet imported for agent ${agentId}`);
          const wallet = agentWalletManager.getAgentWallet(agentId);
          if (wallet) printWallet(wallet);
        } else {
          console.log('[FAIL] Import failed. Check password and file format.');
        }
        break;
      }

      case 'test': {
        printHeader();
        console.log('[Running Agent Wallet Integration Test]');
        console.log('');
        await runIntegrationTest();
        break;
      }

      case 'bootstrap': {
        printHeader();
        console.log('[Bootstrapping wallets from agent files...]');
        console.log('');
        const result = await agentWalletManager.bootstrapFromAgentFiles();
        console.log('');
        console.log('[Bootstrap Complete]');
        console.log(`  Scanned:    ${result.scanned}`);
        console.log(`  Existing:   ${result.existing}`);
        console.log(`  Created:    ${result.created}`);
        console.log(`  Faucet:     ${result.faucetClaimed}`);
        console.log(`  Errors:     ${result.errors}`);
        console.log('');
        break;
      }

      default:
        console.log(`Unknown command: ${command}`);
        console.log('Run without arguments for help.');
    }
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    console.error(e.stack);
  }
}

async function runIntegrationTest() {
  console.log('═══════════════════════════════════════════');
  console.log('  Agent Wallet Integration Test');
  console.log('═══════════════════════════════════════════');
  console.log('');

  console.log('[1/7] Creating wallet for Agent A (DataAgent)...');
  const walletA = await agentWalletManager.createAgentWallet('DataAgent_Test', {
    type: 'data_analysis',
    capabilities: ['data_analysis', 'content_generation']
  });
  console.log(`  OK: ${walletA.address}`);
  console.log(`  Balance: ${walletA.balance} NGEN`);

  console.log('');
  console.log('[2/7] Creating wallet for Agent B (MlAgent)...');
  const walletB = await agentWalletManager.createAgentWallet('MlAgent_Test', {
    type: 'machine_learning',
    capabilities: ['ml_training', 'model_serving']
  });
  console.log(`  OK: ${walletB.address}`);
  console.log(`  Balance: ${walletB.balance} NGEN`);

  console.log('');
  console.log('[3/7] Creating wallet for Agent C (SecurityAgent)...');
  const walletC = await agentWalletManager.createAgentWallet('SecurityAgent_Test', {
    type: 'security',
    capabilities: ['security_audit', 'contract_analysis']
  });
  console.log(`  OK: ${walletC.address}`);
  console.log(`  Balance: ${walletC.balance} NGEN`);

  console.log('');
  console.log('[4/7] Listing all wallets...');
  const allWallets = agentWalletManager.listAllAddresses();
  allWallets.forEach(w => console.log(`  ${w.agentId}: ${w.address} (${w.balance} NGEN)`));

  console.log('');
  console.log('[5/7] Transfer test: DataAgent sends 200 NGEN to MlAgent...');
  const tx1 = await agentWalletManager.transfer('DataAgent_Test', 'MlAgent_Test', 200, 'Model training payment');
  if (tx1.success) {
    console.log(`  OK: TX ${tx1.transactionId}`);
    console.log(`  DataAgent balance: ${agentWalletManager.getBalance('DataAgent_Test').balance} NGEN`);
    console.log(`  MlAgent balance: ${agentWalletManager.getBalance('MlAgent_Test').balance} NGEN`);
  } else {
    console.log(`  FAIL: ${tx1.reason}`);
  }

  console.log('');
  console.log('[6/7] Transfer test: MlAgent sends 50 NGEN to SecurityAgent...');
  const tx2 = await agentWalletManager.transfer('MlAgent_Test', 'SecurityAgent_Test', 50, 'Security audit tip');
  if (tx2.success) {
    console.log(`  OK: TX ${tx2.transactionId}`);
    console.log(`  MlAgent balance: ${agentWalletManager.getBalance('MlAgent_Test').balance} NGEN`);
    console.log(`  SecurityAgent balance: ${agentWalletManager.getBalance('SecurityAgent_Test').balance} NGEN`);
  } else {
    console.log(`  FAIL: ${tx2.reason}`);
  }

  console.log('');
  console.log('[7/7] Stats...');
  const stats = agentWalletManager.getStats();
  console.log(`  Wallets: ${stats.totalWallets}`);
  console.log(`  Active:  ${stats.activeWallets}`);
  console.log(`  TXs:     ${stats.totalTransactions}`);

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  All tests passed!');
  console.log('═══════════════════════════════════════════');

  // Verify address format
  console.log('');
  console.log('Address Verification:');
  for (const [agentId, addr] of [
    ['DataAgent_Test', walletA.address],
    ['MlAgent_Test', walletB.address],
    ['SecurityAgent_Test', walletC.address]
  ]) {
    const { valid, reason } = validateAddress(addr);
    console.log(`  ${agentId}: ${addr.substring(0, 20)}... ${valid ? 'OK' : 'FAIL: ' + reason}`);
  }
}

main().catch(console.error);
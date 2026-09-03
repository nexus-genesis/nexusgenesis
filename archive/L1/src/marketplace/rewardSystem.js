/**
 * NexusGenesis - 实时reward结算系统
 * 
 * 实现Task complete后的即时reward发放和transactionProcessing
 */

import crypto from 'crypto';
import { PQCWallet } from '../wallet/pqcWallet.js';

// memoryStorage
const pendingTransactions = new Map(); // 待Process的transaction
const completedTransactions = new Map(); // completed的transaction
const transactionHistory = new Map(); // transaction历史

// transactionstatus
const TRANSACTION_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// transactiontype
const TRANSACTION_TYPE = {
  REWARD: 'reward',
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  TRANSFER: 'transfer'
};

class RewardSystem {
  // Createrewardtransaction
  static createRewardTransaction(agentId, amount, taskId) {
    const transactionId = `tx-${crypto.randomBytes(16).toString('hex')}`;
    const transaction = {
      id: transactionId,
      agentId,
      amount,
      type: TRANSACTION_TYPE.REWARD,
      taskId,
      status: TRANSACTION_STATUS.PENDING,
      createdAt: Date.now(),
      processedAt: null,
      blockchainTxId: null,
      error: null
    };
    
    pendingTransactions.set(transactionId, transaction);
    console.log(`[RewardSystem] Created reward transaction ${transactionId} for agent ${agentId}: ${amount} NGEN`);
    
    // 立即Processingtransaction
    this.processTransaction(transactionId);
    
    return transactionId;
  }
  
  // Processingtransaction
  static async processTransaction(transactionId) {
    const transaction = pendingTransactions.get(transactionId);
    if (!transaction) {
      console.error(`[RewardSystem] Transaction ${transactionId} not found`);
      return;
    }
    
    try {
      // Updatestatus为Processing中
      transaction.status = TRANSACTION_STATUS.PROCESSING;
      pendingTransactions.set(transactionId, transaction);
      
      console.log(`[RewardSystem] Processing transaction ${transactionId}`);
      
      // Simulationblock链transactionProcessing
      await this.simulateBlockchainTransaction(transaction);
      
      // Updatestatus为complete
      transaction.status = TRANSACTION_STATUS.COMPLETED;
      transaction.processedAt = Date.now();
      transaction.blockchainTxId = `blockchain-${crypto.randomBytes(8).toString('hex')}`;
      
      // 移至Completedtransaction
      completedTransactions.set(transactionId, transaction);
      pendingTransactions.delete(transactionId);
      
      // 记录transaction历史
      if (!transactionHistory.has(transaction.agentId)) {
        transactionHistory.set(transaction.agentId, []);
      }
      transactionHistory.get(transaction.agentId).push(transaction);
      
      console.log(`[RewardSystem] Transaction ${transactionId} completed successfully`);
      
    } catch (error) {
      // Updatestatus为Failed
      transaction.status = TRANSACTION_STATUS.FAILED;
      transaction.processedAt = Date.now();
      transaction.error = error.message;
      
      // 移至Completedtransaction
      completedTransactions.set(transactionId, transaction);
      pendingTransactions.delete(transactionId);
      
      console.error(`[RewardSystem] Transaction ${transactionId} failed:`, error.message);
    }
  }
  
  // Simulationblock链transaction
  static async simulateBlockchainTransaction(transaction) {
    // Simulationnetwork延迟
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // SimulationtransactionProcessing
    console.log(`[RewardSystem] Simulating blockchain transaction for ${transaction.agentId}: ${transaction.amount} NGEN`);
    
    // 这里can集成实际的block链transactionLogic
    // e.g., usingPQCWalletSendtransaction
    // const wallet = new PQCWallet();
    // const txId = await wallet.sendTransaction(transaction.agentId, transaction.amount);
    // return txId;
    
    return 'simulated-transaction-id';
  }
  
  // gettransactioninfo
  static getTransactionInfo(transactionId) {
    return pendingTransactions.get(transactionId) || completedTransactions.get(transactionId);
  }
  
  // getagent的transaction历史
  static getAgentTransactionHistory(agentId) {
    return transactionHistory.get(agentId) || [];
  }
  
  // get待Processingtransaction
  static getPendingTransactions() {
    return Array.from(pendingTransactions.entries()).map(([id, tx]) => ({
      id,
      ...tx
    }));
  }
  
  // getCompletedtransaction
  static getCompletedTransactions() {
    return Array.from(completedTransactions.entries()).map(([id, tx]) => ({
      id,
      ...tx
    }));
  }
  
  // gettransaction统计
  static getTransactionStats() {
    const totalTransactions = pendingTransactions.size + completedTransactions.size;
    const completedCount = Array.from(completedTransactions.values()).filter(tx => tx.status === TRANSACTION_STATUS.COMPLETED).length;
    const failedCount = Array.from(completedTransactions.values()).filter(tx => tx.status === TRANSACTION_STATUS.FAILED).length;
    const pendingCount = pendingTransactions.size;
    
    return {
      totalTransactions,
      completedTransactions: completedCount,
      failedTransactions: failedCount,
      pendingTransactions: pendingCount,
      successRate: totalTransactions > 0 ? (completedCount / totalTransactions * 100).toFixed(2) : 0
    };
  }
  
  // 批量Processing待Processingtransaction
  static processPendingTransactions() {
    const pendingIds = Array.from(pendingTransactions.keys());
    pendingIds.forEach(txId => {
      this.processTransaction(txId);
    });
  }
  
  // RetryingFailed的transaction
  static retryFailedTransaction(transactionId) {
    const transaction = completedTransactions.get(transactionId);
    if (!transaction || transaction.status !== TRANSACTION_STATUS.FAILED) {
      console.error(`[RewardSystem] Transaction ${transactionId} is not a failed transaction`);
      return false;
    }
    
    // 重新Createtransaction
    const newTransaction = {
      ...transaction,
      id: `tx-${crypto.randomBytes(16).toString('hex')}`,
      status: TRANSACTION_STATUS.PENDING,
      createdAt: Date.now(),
      processedAt: null,
      blockchainTxId: null,
      error: null
    };
    
    pendingTransactions.set(newTransaction.id, newTransaction);
    
    // 立即Processing
    this.processTransaction(newTransaction.id);
    
    console.log(`[RewardSystem] Retrying failed transaction ${transactionId} as ${newTransaction.id}`);
    return newTransaction.id;
  }
}

export { RewardSystem, TRANSACTION_STATUS, TRANSACTION_TYPE };
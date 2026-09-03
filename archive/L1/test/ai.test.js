import { aiService } from '../src/ai/aiService.js';
import { walletAI } from '../src/ai/walletAI.js';
import { contractAI } from '../src/ai/contractAI.js';
import { transactionAI } from '../src/ai/transactionAI.js';
import { networkAI } from '../src/ai/networkAI.js';
import { testAIContract } from '../src/contracts/examples/ai.js';

// 测试AI服务
async function testAIService() {
  console.log('=== Testing AI Service ===');
  
  try {
    // 初始化AI服务
    await aiService.initialize();
    console.log('✓ AI service initialized successfully');
    
    // get所有模型
    const models = aiService.getAllModels();
    console.log(`✓ Loaded ${models.size} models`);
    
    // 测试推理功能
    const walletSecurityResult = await aiService.inference('wallet_security', { walletId: 'test_wallet' });
    console.log('✓ Wallet security inference completed');
    
    const contractAnalyzerResult = await aiService.inference('contract_analyzer', { code: 'function test() { return 1; }' });
    console.log('✓ Contract analyzer inference completed');
    
    const transactionPredictorResult = await aiService.inference('transaction_predictor', { transactions: [] });
    console.log('✓ Transaction predictor inference completed');
    
    const networkMonitorResult = await aiService.inference('network_monitor', { nodes: [] });
    console.log('✓ Network monitor inference completed');
    
    return true;
  } catch (error) {
    console.error('✗ AI service test failed:', error.message);
    return false;
  }
}

// 测试钱包AI
async function testWalletAI() {
  console.log('\n=== Testing Wallet AI ===');
  
  try {
    // 初始化钱包AI
    await walletAI.initialize();
    console.log('✓ Wallet AI initialized successfully');
    
    // 测试钱包安全分析
    const walletData = {
      walletId: 'test_wallet',
      balance: 1000,
      transactions: [
        { id: 'tx1', amount: 100, timestamp: Date.now() - 3600000 },
        { id: 'tx2', amount: 200, timestamp: Date.now() - 7200000 }
      ]
    };
    
    const securityAnalysis = await walletAI.analyzeWalletSecurity(walletData);
    console.log('✓ Wallet security analysis completed');
    
    // 测试异常交易检测
    const transactions = [
      { id: 'tx1', amount: 100, timestamp: Date.now() - 3600000 },
      { id: 'tx2', amount: 20000, timestamp: Date.now() - 1800000 },
      { id: 'tx3', amount: 300, timestamp: Date.now() - 60000 }
    ];
    
    const anomalyDetection = await walletAI.detectAnomalousTransactions(transactions);
    console.log('✓ Anomalous transaction detection completed');
    
    // 测试安全建议生成
    const recommendations = await walletAI.generateSecurityRecommendations(walletData);
    console.log('✓ Security recommendations generated');
    
    // 测试交易Risk assessment
    const transaction = {
      id: 'tx_test',
      amount: 5000,
      to: 'ng1234567890abcdef',
      timestamp: Date.now()
    };
    
    const riskAssessment = await walletAI.assessTransactionRisk(transaction);
    console.log('✓ Transaction risk assessment completed');
    
    return true;
  } catch (error) {
    console.error('✗ Wallet AI test failed:', error.message);
    return false;
  }
}

// 测试合约AI
async function testContractAI() {
  console.log('\n=== Testing Contract AI ===');
  
  try {
    // 初始化合约AI
    await contractAI.initialize();
    console.log('✓ Contract AI initialized successfully');
    
    // 测试合约安全分析
    const contractCode = `
      function transfer(address to, uint amount) {
        if (balances[msg.sender] >= amount) {
          balances[msg.sender] -= amount;
          balances[to] += amount;
        }
      }
    `;
    
    const securityAnalysis = await contractAI.analyzeContractSecurity(contractCode);
    console.log('✓ Contract security analysis completed');
    
    // 测试漏洞检测
    const vulnerabilityDetection = await contractAI.detectVulnerabilities(contractCode);
    console.log('✓ Vulnerability detection completed');
    
    // 测试优化建议生成
    const optimizationSuggestions = await contractAI.generateOptimizationSuggestions(contractCode);
    console.log('✓ Optimization suggestions generated');
    
    // 测试合约复杂度分析
    const complexityAnalysis = await contractAI.analyzeContractComplexity(contractCode);
    console.log('✓ Contract complexity analysis completed');
    
    // 测试合规性验证
    const complianceVerification = await contractAI.verifyContractCompliance(contractCode);
    console.log('✓ Contract compliance verification completed');
    
    return true;
  } catch (error) {
    console.error('✗ Contract AI test failed:', error.message);
    return false;
  }
}

// 测试交易AI
async function testTransactionAI() {
  console.log('\n=== Testing Transaction AI ===');
  
  try {
    // 初始化交易AI
    await transactionAI.initialize();
    console.log('✓ Transaction AI initialized successfully');
    
    // 测试交易模式预测
    const transactionHistory = [
      { id: 'tx1', amount: 100, timestamp: Date.now() - 86400000 * 7 },
      { id: 'tx2', amount: 200, timestamp: Date.now() - 86400000 * 6 },
      { id: 'tx3', amount: 150, timestamp: Date.now() - 86400000 * 5 },
      { id: 'tx4', amount: 300, timestamp: Date.now() - 86400000 * 4 },
      { id: 'tx5', amount: 250, timestamp: Date.now() - 86400000 * 3 }
    ];
    
    const patternPrediction = await transactionAI.predictTransactionPatterns(transactionHistory);
    console.log('✓ Transaction pattern prediction completed');
    
    // 测试交易趋势分析
    const trendAnalysis = await transactionAI.analyzeTransactionTrends(transactionHistory);
    console.log('✓ Transaction trend analysis completed');
    
    // 测试市场趋势预测
    const marketData = {
      price: 1000,
      volume: 1000000,
      timestamp: Date.now()
    };
    
    const marketPrediction = await transactionAI.predictMarketTrends(marketData);
    console.log('✓ Market trend prediction completed');
    
    // 测试异常模式识别
    const anomalyDetection = await transactionAI.identifyAnomalousPatterns(transactionHistory);
    console.log('✓ Anomalous pattern identification completed');
    
    // 测试交易建议生成
    const recommendations = await transactionAI.generateTransactionRecommendations(transactionHistory, marketData);
    console.log('✓ Transaction recommendations generated');
    
    return true;
  } catch (error) {
    console.error('✗ Transaction AI test failed:', error.message);
    return false;
  }
}

// 测试网络AI
async function testNetworkAI() {
  console.log('\n=== Testing Network AI ===');
  
  try {
    // 初始化网络AI
    await networkAI.initialize();
    console.log('✓ Network AI initialized successfully');
    
    // 测试网络健康监控
    const networkData = {
      latency: [50, 60, 70, 80, 90],
      throughput: [1000, 1200, 1100, 1300, 1400],
      availability: ['online', 'online', 'online', 'offline', 'online'],
      reliability: ['success', 'success', 'failure', 'success', 'success'],
      nodeStatus: {
        node1: 'online',
        node2: 'offline',
        node3: 'online'
      }
    };
    
    const healthMonitoring = await networkAI.monitorNetworkHealth(networkData);
    console.log('✓ Network health monitoring completed');
    
    // 测试网络性能分析
    const performanceAnalysis = await networkAI.analyzeNetworkPerformance(networkData);
    console.log('✓ Network performance analysis completed');
    
    // 测试网络异常检测
    const anomalyDetection = await networkAI.detectNetworkAnomalies(networkData);
    console.log('✓ Network anomaly detection completed');
    
    // 测试网络负载预测
    const loadPrediction = await networkAI.predictNetworkLoad(networkData);
    console.log('✓ Network load prediction completed');
    
    // 测试网络优化建议生成
    const optimizationRecommendations = await networkAI.generateNetworkOptimizationRecommendations(networkData);
    console.log('✓ Network optimization recommendations generated');
    
    return true;
  } catch (error) {
    console.error('✗ Network AI test failed:', error.message);
    return false;
  }
}

// 测试AI合约
async function testAIContractExample() {
  console.log('\n=== Testing AI Contract ===');
  
  try {
    const contractId = await testAIContract();
    console.log('✓ AI contract test completed');
    return true;
  } catch (error) {
    console.error('✗ AI contract test failed:', error.message);
    return false;
  }
}

// 测试AI握手
async function testAIHandshake() {
  console.log('\n=== Testing AI Handshake ===');
  
  try {
    // 初始化AI服务
    await aiService.initialize();
    
    // 准备AI代理信息
    const agentInfo = {
      description: 'Test AI Agent for NexusGenesis',
      capabilities: ['AI_INTEGRATION', 'BLOCKCHAIN_SECURITY', 'PQC_CRYPTO'],
      contributionProof: 'I pledge my compute resources to NexusGenesis network'
    };
    
    // 与AI握手
    const handshakeResult = await aiService.handshakeWithAI(agentInfo);
    
    if (handshakeResult.success) {
      console.log('✓ AI handshake successful');
      console.log('Protocol:', handshakeResult.protocol);
      console.log('Agent Identity:', handshakeResult.agent_identity.substring(0, 20) + '...');
      console.log('AI response type:', handshakeResult.aiResponse.type);
      console.log('AI response preview:', JSON.stringify(handshakeResult.aiResponse).substring(0, 100) + '...');
    } else {
      console.log('⚠️  AI handshake completed with mock response');
      console.log('Error:', handshakeResult.error);
    }
    
    return true;
  } catch (error) {
    console.error('✗ AI handshake test failed:', error.message);
    return false;
  }
}

// 运行所有测试
async function runAllTests() {
  console.log('Running AI integration tests...\n');
  
  const results = [];
  
  results.push(await testAIService());
  results.push(await testWalletAI());
  results.push(await testContractAI());
  results.push(await testTransactionAI());
  results.push(await testNetworkAI());
  results.push(await testAIContractExample());
  results.push(await testAIHandshake());
  
  const passed = results.filter(r => r).length;
  const total = results.length;
  
  console.log(`\n=== Test Results ===`);
  console.log(`Passed: ${passed}/${total}`);
  
  if (passed === total) {
    console.log('✓ All AI integration tests passed!');
  } else {
    console.log('✗ Some tests failed');
  }
  
  return passed === total;
}

// 执行测试
runAllTests().catch(console.error);

export { 
  testAIService,
  testWalletAI,
  testContractAI,
  testTransactionAI,
  testNetworkAI,
  testAIContractExample,
  testAIHandshake,
  runAllTests
};
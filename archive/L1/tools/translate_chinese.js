/**
 * Batch translate Chinese comments to English in NexusGenesis source files
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRANSLATION_MAP = {
  // Common JSDoc terms
  '生成': 'Generate',
  '验证': 'Verify',
  '签名': 'Sign',
  '密钥对': 'key pair',
  '密钥': 'key',
  '公钥': 'public key',
  '私钥': 'private key',
  '消息': 'message',
  '数据': 'data',
  '参数': 'parameter',
  '返回': 'Return',
  '设置': 'Set',
  '获取': 'Get',
  '创建': 'Create',
  '更新': 'Update',
  '删除': 'Delete',
  '初始化': 'Initialize',
  '加载': 'Load',
  '保存': 'Save',
  '检查': 'Check',
  '计算': 'Calculate',
  '执行': 'Execute',
  '处理': 'Process',
  '发送': 'Send',
  '接收': 'Receive',
  '连接': 'Connect',
  '断开': 'Disconnect',
  '监听': 'Listen',
  '启动': 'Start',
  '停止': 'Stop',
  '部署': 'Deploy',
  '测试': 'Test',
  '导出': 'Export',
  '导入': 'Import',
  '配置': 'Configuration',
  '状态': 'status',
  '错误': 'error',
  '成功': 'success',
  '失败': 'fail',
  '默认': 'Default',
  '当前': 'Current',
  '最大': 'Maximum',
  '最小': 'Minimum',
  '长度': 'length',
  '函数': 'function',
  '方法': 'method',
  '类': 'class',
  '模块': 'Module',
  '实例': 'instance',
  '属性': 'property',
  '类型': 'type',
  '地址': 'address',
  '余额': 'balance',
  '转账': 'transfer',
  '交易': 'transaction',
  '区块': 'block',
  '合约': 'Contract',
  '智能合约': 'Smart Contract',
  '提案': 'Proposal',
  '投票': 'Vote',
  '成员': 'member',
  '角色': 'role',
  '资金': 'fund',
  '金额': 'amount',
  '奖励': 'reward',
  '贡献': 'contribution',
  '信誉': 'reputation',
  '代币': 'Token',
  '总供应量': 'total supply',
  '小数位数': 'decimals',
  '代币名称': 'token name',
  '代币符号': 'token symbol',
  '合约拥有者': 'contract owner',
  '用户': 'user',
  '存储': 'Storage',
  '内存': 'Memory',
  '加载': 'Load',
  '哈希': 'hash',
  '随机数': 'random bytes',
  '安全': 'security',
  '防重放攻击': 'anti-replay',
  '时间戳': 'timestamp',
  '算法': 'algorithm',
  '功能': 'Features',
  '逻辑': 'Logic',
  '字节码': 'bytecode',
  '所有权': 'ownership',
  '管理者': 'manager',
  '权限': 'permission',
  '节点': 'node',
  '网络': 'network',
  '协议': 'protocol',
  '服务': 'service',
  '监控': 'monitor',
  '自动化': 'automation',
  '恢复': 'recovery',
  '备份': 'backup',
  '工作流': 'workflow',
  '任务': 'Task',
  '市场': 'marketplace',
  '桥接': 'Bridge',
  '跨链': 'Cross-chain',
  '资产': 'asset',
  '锁定': 'Lock',
  '释放': 'Release',
  '经济': 'Economy',
  '池': 'Pool',
  '基金': 'Fund',
  '治理': 'Governance',
  '激励': 'Incentive',
  '开发者': 'Developer',
  '认证': 'authentication',
  '授权': 'authorization',
  '注册': 'Register',
  '注册表': 'Registry',
  '智能体': 'Agent',
  '群集': 'Swarm',
  '模拟器': 'Simulator',
  '上链': 'on-chain',
  '链上': 'on-chain',
  '观察者': 'observer',
  '断路器': 'Circuit Breaker',
  '沙盒': 'sandbox',
  '模拟': 'Simulation',
  '物理桥接': 'Physical Bridge',
  '共识': 'Consensus',
  '多签': 'Multi-signature',
  '时间锁': 'Timelock',
  '法定人数': 'quorum',
  '阈值': 'threshold',
  '信誉分': 'reputation score',
  '投票权重': 'voting weight',
  '参与率': 'participation rate',
  '多领导者': 'Multi-Leader',

  // Console log phrases
  '初始化完成': 'initialized',
  '启动完成': 'started',
  '已启动': 'started',
  '已初始化': 'initialized',
  '已加载': 'loaded',
  '已保存': 'saved',
  '已部署': 'deployed',
  '已创建': 'created',
  '已更新': 'updated',
  '已连接': 'connected',
  '已断开': 'disconnected',
  '已注册': 'registered',
  '已执行': 'executed',
  '已处理': 'processed',
  '已发送': 'sent',
  '已接收': 'received',
  '已锁定': 'locked',
  '已释放': 'released',
  '已通过': 'passed',
  '已拒绝': 'rejected',
  '失败': 'failed',
  '错误': 'error',
  '出错': 'error',
  '异常': 'exception',
  '警告': 'warning',
  '信息': 'info',

  // Transaction/Blockchain terms
  '交易ID': 'transaction ID',
  '发送者': 'sender',
  '接收者': 'recipient',
  '手续费': 'fee',
  '元数据': 'metadata',
  '区块高度': 'block height',
  '区块哈希': 'block hash',
  '前一个区块': 'previous block',
  '创世区块': 'genesis block',
  '创世': 'Genesis',

  // Phrases
  '基于': 'based on',
  '用于': 'for',
  '包括': 'includes',
  '例如': 'e.g.',
  '等': 'etc.',
  '如果需要': 'if needed',
  '确保': 'ensure',
  '支持': 'support',
  '允许': 'allow',
  '禁止': 'forbidden',
  '需要': 'requires',
  '应该': 'should',
  '可以': 'can',
  '可能': 'may',
  '必须': 'must',

  // AINVM terms
  '指令集': 'instruction set',
  '操作码': 'opcode',
  '栈': 'stack',
  '操作数': 'operand',
  '内存地址': 'memory address',
  '总供应量': 'total supply',
  '占位符': 'placeholder',

  // Specific file contexts
  '抗量子密码学': 'post-quantum cryptography',
  '抗量子': 'post-quantum',
  '基于 @noble/post-quantum 的真实抗量子密码学实现': 'Real post-quantum cryptography implementation based on @noble/post-quantum',
  '算法：Dilithium2 (NIST FIPS 204)': 'Algorithm: Dilithium2 (NIST FIPS 204)',
  '密钥长度常量': 'Key length constants',
  '安全哈希函数': 'Secure hash function',
  '验证密钥长度': 'Verify key length',
  '无效的公钥长度': 'Invalid public key length',
  '无效的私钥长度': 'Invalid private key length',
  '无效的签名长度': 'Invalid signature length',
  '安全的时间戳验证': 'Secure timestamp validation',
  '最大时间差': 'max time difference',
  '毫秒': 'ms',
  '已使用的随机数集合': 'Set of used nonces',
  '随机字符串': 'random string',
  '使用Dilithium2': 'Use Dilithium2 to',
  '要签名的': 'to sign',
  '原始': 'original',
  '验证结果': 'verification result',

  // Governance terms
  '基于信誉分实现加权投票系统': 'Reputation-based weighted voting system',
  '提案创建、投票、结果计算、提案执行、持久化存储': 'Proposal creation, voting, result calculation, proposal execution, persistent storage',
  '治理参数': 'Governance parameters',
  '创建提案所需的最低信誉分': 'Minimum reputation score to create a proposal',
  '投票持续时间': 'Voting duration',
  '通过所需的赞成比例': 'Approval threshold percentage',
  '通过后到执行的延迟时间': 'Execution delay after approval',
  '每个代理最多可以同时拥有的活跃提案数': 'Max active proposals per agent',
  '是否需要多签执行': 'Whether multi-signature execution is required',
  '多签所需的最少签名数': 'Minimum signatures required for multi-sig',
  '执行时间锁': 'Execution timelock',
  '防止立即执行': 'Prevent immediate execution',
  '授权的执行者列表': 'Authorized executor list',
  '执行审计日志': 'Execution audit log',
  '数据目录': 'Data directory',
  '提案详情': 'proposal details',
  '确保数据目录存在': 'Ensure data directory exists',
  '从文件加载数据': 'Load data from files',
  '保存到磁盘': 'Save to disk',
  '带完整性校验': 'with integrity check',
  '从磁盘加载': 'Load from disk',
  '带完整性验证': 'with integrity verification',
  '存入': 'deposit',
  '金库': 'treasury',
  '取款': 'withdraw',
};

// Sort keys by length descending to match longest patterns first
const SORTED_KEYS = Object.keys(TRANSLATION_MAP).sort((a, b) => b.length - a.length);

function translateChinese(text) {
  let result = text;
  for (const key of SORTED_KEYS) {
    const regex = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    result = result.replace(regex, TRANSLATION_MAP[key]);
  }
  return result;
}

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Only process files that contain Chinese characters
  if (!/[\u4e00-\u9fff]/.test(content)) {
    return false;
  }

  // Process line by line for comments and console.log
  const lines = content.split('\n');
  const newLines = lines.map(line => {
    // Skip lines that don't contain Chinese
    if (!/[\u4e00-\u9fff]/.test(line)) {
      return line;
    }

    // Translate the full line
    let translated = translateChinese(line);

    // Handle JSDoc @param descriptions
    translated = translated.replace(
      /@param\s+\{([^}]+)\}\s+(\w+)\s+([^\n]*)/g,
      (match, type, name, desc) => {
        const translatedDesc = translateChinese(desc.trim());
        return `@param {${type}} ${name} ${translatedDesc}`;
      }
    );

    // Handle @returns descriptions
    translated = translated.replace(
      /@returns\s+\{([^}]+)\}\s+([^\n]*)/g,
      (match, type, desc) => {
        const translatedDesc = translateChinese(desc.trim());
        return `@returns {${type}} ${translatedDesc}`;
      }
    );

    // Handle @returns without type
    translated = translated.replace(
      /@returns\s+([^\n{][^\n]*)/g,
      (match, desc) => {
        const translatedDesc = translateChinese(desc.trim());
        return `@returns ${translatedDesc}`;
      }
    );

    return translated;
  });

  const newContent = newLines.join('\n');
  
  // Only write if content changed
  if (newContent !== content) {
    fs.writeFileSync(filePath, newContent, 'utf8');
    return true;
  }
  return false;
}

function walkDir(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  let changed = 0;
  
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      if (file.name !== 'node_modules' && file.name !== '.git') {
        changed += walkDir(fullPath);
      }
    } else if (file.name.endsWith('.js') || file.name.endsWith('.json') || file.name.endsWith('.md')) {
      if (processFile(fullPath)) {
        changed++;
      }
    }
  }
  
  return changed;
}

const projectRoot = path.resolve(__dirname, '..');
const srcDir = path.join(projectRoot, 'src');
const changed = walkDir(srcDir);
console.log(`Translated ${changed} files`);

// Also process root-level files
for (const f of fs.readdirSync(projectRoot)) {
  const fullPath = path.join(projectRoot, f);
  try {
    if (fs.statSync(fullPath).isFile() && (f.endsWith('.js') || f.endsWith('.json') || f.endsWith('.md'))) {
      if (processFile(fullPath)) {
        changed++;
        console.log(`  Root: ${f}`);
      }
    }
  } catch (e) {
    // skip inaccessible files
  }
}

console.log(`\nTotal files translated: ${changed}`);
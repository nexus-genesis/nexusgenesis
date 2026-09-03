/**
 * Second-pass deep Chinese cleanup for NexusGenesis source files
 * Handles Chinese punctuation and more complex patterns
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Extended translation map for second pass
const DEEP_MAP = [
  // Chinese punctuation normalization
  [/：/g, ': '],
  [/，/g, ', '],
  [/。/g, '. '],
  [/；/g, '; '],
  [/）/g, ')'],
  [/（/g, '('],
  [/"/g, '"'],
  [/"/g, '"'],
  [/、/g, ', '],
  [/'/g, "'"],
  [/'/g, "'"],
  [/》/g, '"'],
  [/《/g, '"'],
  [/【/g, '['],
  [/】/g, ']'],

  // Console log patterns - common Chinese phrases
  [/请在控制台查看/g, 'check console for details'],
  [/初始化完成/g, 'initialized'],
  [/启动完成/g, 'started successfully'],
  [/加载完成/g, 'loaded successfully'],
  [/保存完成/g, 'saved successfully'],
  [/处理完成/g, 'processed'],
  [/注册成功/g, 'registration successful'],
  [/注册失败/g, 'registration failed'],
  [/部署成功/g, 'deployed successfully'],
  [/创建成功/g, 'created successfully'],
  [/验证通过/g, 'verification passed'],
  [/验证失败/g, 'verification failed'],
  [/已注册/g, 'registered'],
  [/已部署/g, 'deployed'],
  [/已创建/g, 'created'],
  [/已启动/g, 'started'],
  [/已停止/g, 'stopped'],
  [/已加载/g, 'loaded'],
  [/已保存/g, 'saved'],
  [/已更新/g, 'updated'],
  [/已删除/g, 'deleted'],
  [/已连接/g, 'connected'],
  [/已断开/g, 'disconnected'],
  [/已锁定/g, 'locked'],
  [/已释放/g, 'released'],
  [/已通过/g, 'passed'],
  [/已拒绝/g, 'rejected'],
  [/已开启/g, 'enabled'],
  [/已关闭/g, 'disabled'],
  [/已开始/g, 'started'],
  [/已完成/g, 'completed'],
  [/已执行/g, 'executed'],
  [/已处理/g, 'processed'],
  [/已接收/g, 'received'],
  [/已发送/g, 'sent'],
  [/同步完成/g, 'synchronization complete'],
  [/同步失败/g, 'synchronization failed'],
  [/读取失败/g, 'read failed'],
  [/写入失败/g, 'write failed'],
  
  // Common verb-noun phrases
  [/开始监听/g, 'start listening'],
  [/停止监听/g, 'stop listening'],
  [/接收消息/g, 'receive message'],
  [/发送消息/g, 'send message'],
  [/处理消息/g, 'process message'],
  [/验证消息/g, 'verify message'],
  [/创建区块/g, 'create block'],
  [/验证区块/g, 'verify block'],
  [/处理交易/g, 'process transaction'],
  [/验证交易/g, 'verify transaction'],
  [/创建交易/g, 'create transaction'],
  [/签名交易/g, 'sign transaction'],
  [/发送交易/g, 'send transaction'],
  [/添加节点/g, 'add node'],
  [/删除节点/g, 'remove node'],
  [/连接节点/g, 'connect to node'],
  [/断开节点/g, 'disconnect node'],
  [/注册节点/g, 'register node'],
  [/注册代理/g, 'register agent'],
  [/注册智能体/g, 'register agent'],
  [/注册验证者/g, 'register validator'],
  [/计算奖励/g, 'calculate reward'],
  [/分配奖励/g, 'distribute reward'],
  [/更新状态/g, 'update status'],
  [/检查状态/g, 'check status'],
  [/获取状态/g, 'get status'],
  [/保存数据/g, 'save data'],
  [/加载数据/g, 'load data'],
  [/签名消息/g, 'sign message'],
  [/验证签名/g, 'verify signature'],
  [/生成密钥/g, 'generate key'],
  [/加密数据/g, 'encrypt data'],
  [/解密数据/g, 'decrypt data'],
  [/部署合约/g, 'deploy contract'],
  [/执行合约/g, 'execute contract'],

  // Metrics/counters
  [/平均处理时间/g, 'average processing time'],
  [/成功率/g, 'success rate'],
  [/失败率/g, 'failure rate'],
  [/错误率/g, 'error rate'],
  [/状态码/g, 'status code'],

  // JSDoc common phrases
  [/验证通过返回/g, 'returns on success'],
  [/验证失败返回/g, 'returns on failure'],
  [/如果验证通过/g, 'if verification succeeds'],
  [/如果验证失败/g, 'if verification fails'],
  [/如果成功/g, 'if successful'],
  [/如果失败/g, 'if failed'],
  [/是否成功/g, 'whether successful'],
  [/处理结果/g, 'processing result'],
  [/验证结果/g, 'verification result'],
  [/执行结果/g, 'execution result'],
  [/返回结果/g, 'return result'],

  // AI terms
  [/智能体/g, 'agent'],
  [/代理/g, 'agent'],
  [/群集/g, 'swarm'],
  [/群集池/g, 'swarm pool'],
  [/物理桥接基金/g, 'physical bridge fund'],
  [/观察者基金/g, 'observer fund'],
  [/观察者钱包/g, 'observer wallet'],
  [/观察者地址/g, 'observer address'],
  [/观察者角色/g, 'observer role'],
  [/观察者注册/g, 'observer registration'],

  // Specific leftover common phrases
  [/使用/g, 'using'],
  [/通过/g, 'via'],
  [/调用/g, 'call'],
  [/测试/g, 'test'],
  [/如果要/g, 'To'],
  [/将会/g, 'will'],
  [/自动/g, 'auto'],
  [/手动/g, 'manual'],
  [/模式/g, 'mode'],
  [/监听端口/g, 'port'],
  [/启动服务器/g, 'start server'],
  [/停止服务器/g, 'stop server'],
  [/运行中/g, 'running'],
  [/已停止/g, 'stopped'],
  [/未找到/g, 'not found'],
  [/不存在/g, 'does not exist'],
  [/已存在/g, 'already exists'],
  [/超时/g, 'timeout'],
  [/重试/g, 'retry'],
  [/就绪/g, 'ready'],
  [/正在运行/g, 'is running'],
  [/正在处理/g, 'processing'],
  [/正在加载/g, 'loading'],
  [/正在保存/g, 'saving'],
  [/剩余/g, 'remaining'],
  [/总数/g, 'total'],
  [/完成/g, 'complete'],
  [/进行中/g, 'in progress'],
  [/等待中/g, 'pending'],
  
  // Token/economy specific
  [/代币详情/g, 'token details'],
  [/代币信息/g, 'token info'],
  [/代币余额/g, 'token balance'],
  [/代币名称/g, 'token name'],
  [/代币符号/g, 'token symbol'],
  [/铸币/g, 'mint'],
  [/发行量/g, 'issuance'],
  [/总供应量/g, 'total supply'],
  
  // Computation/math
  [/平均值/g, 'average'],
  [/最大值/g, 'maximum'],
  [/最小值/g, 'minimum'],
  [/总和/g, 'sum'],
  [/计数/g, 'count'],

  // Signal/event terms
  [/信号类型/g, 'signal type'],
  [/处理事件/g, 'process event'],
  [/触发事件/g, 'trigger event'],
  [/事件处理/g, 'event handler'],
  [/事件类型/g, 'event type'],
  
  // Security terms
  [/安全审计/g, 'security audit'],
  [/安全等级/g, 'security level'],
  [/安全状态/g, 'security status'],
  [/防重放/g, 'anti-replay'],
  [/防篡改/g, 'anti-tamper'],
  
  // Config terms
  [/配置文件/g, 'config file'],
  [/配置项/g, 'config item'],
  [/配置参数/g, 'config parameter'],
  [/配置信息/g, 'config info'],
  
  // Bridge specific
  [/跨链交易/g, 'cross-chain transaction'],
  [/跨链资产/g, 'cross-chain asset'],
  [/跨链转账/g, 'cross-chain transfer'],
  [/中继节点/g, 'relay node'],
  [/中继网络/g, 'relay network'],
  [/锁仓/g, 'locked position'],
  [/解锁/g, 'unlock'],
];

function deepClean(content) {
  let result = content;
  for (const [pattern, replacement] of DEEP_MAP) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  if (!/[\u4e00-\u9fff]/.test(content)) {
    return false;
  }

  const newContent = deepClean(content);
  
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

const srcDir = path.join(projectRoot, 'src');
let changed = walkDir(srcDir);
console.log(`Deep translated ${changed} files in src/`);

// Root docs
const docsDir = path.join(projectRoot, 'docs');
changed += walkDir(docsDir);
console.log(`Deep translated ${changed} total files`);
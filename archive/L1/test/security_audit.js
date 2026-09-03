#!/usr/bin/env node
/**
 * 系统Security audit脚本
 * 对系统进行全面的Security audit，防范潜在漏洞
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const auditResults = [];
const startTimestamp = Date.now();

// 记录审计结果
function logResult(checkName, status, message, severity = 'medium') {
  const result = {
    checkName,
    status,
    message,
    severity,
    timestamp: new Date().toISOString()
  };
  auditResults.push(result);
  console.log(`${status ? '✓' : '✗'} ${checkName} - ${message} (${severity})`);
}

// 检查文件权限
function checkFilePermissions() {
  const sensitiveFiles = [
    'data/wallet/',
    'data/keys/',
    'data/state/',
    '.env'
  ];

  sensitiveFiles.forEach(filePath => {
    const fullPath = path.join(__dirname, '../', filePath);
    if (fs.existsSync(fullPath)) {
      try {
        const stats = fs.statSync(fullPath);
        // 检查文件权限（在Windows上可能不适用）
        if (process.platform !== 'win32') {
          const mode = stats.mode.toString(8);
          if (mode.slice(-3) > '600') {
            logResult('文件权限检查', false, `文件 ${filePath} 权限过于宽松: ${mode}`, 'high');
          } else {
            logResult('文件权限检查', true, `文件 ${filePath} 权限设置正确: ${mode}`);
          }
        } else {
          logResult('文件权限检查', true, `文件 ${filePath} 存在（Windows系统权限检查跳过）`);
        }
      } catch (error) {
        logResult('文件权限检查', false, `无法检查文件 ${filePath} 权限: ${error.message}`, 'medium');
      }
    } else {
      logResult('文件权限检查', false, `文件 ${filePath} 不存在`, 'low');
    }
  });
}

// 检查敏感信息泄露
function checkSensitiveInfo() {
  const sensitivePatterns = [
    /api[_-]?key/i,
    /secret/i,
    /password/i,
    /token/i,
    /private[_-]?key/i,
    /mnemonic/i
  ];

  const directoriesToCheck = [
    'src/',
    'test/',
    'docs/'
  ];

  directoriesToCheck.forEach(dir => {
    const fullDir = path.join(__dirname, '../', dir);
    if (fs.existsSync(fullDir)) {
      fs.readdirSync(fullDir, { recursive: true }).forEach(file => {
        if (file.endsWith('.js') || file.endsWith('.json') || file.endsWith('.env')) {
          const filePath = path.join(fullDir, file);
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            sensitivePatterns.forEach(pattern => {
              if (pattern.test(content)) {
                logResult('敏感信息检查', false, `文件 ${filePath} 可能包含敏感信息`, 'medium');
              }
            });
          } catch (error) {
            // 忽略无法读取的文件
          }
        }
      });
    }
  });

  logResult('敏感信息检查', true, '敏感信息检查完成');
}

// 检查输入验证
function checkInputValidation() {
  const inputValidationChecks = [
    {
      file: 'src/api/agentApi.js',
      checks: [
        'agent_id 验证',
        'capabilities 验证',
        '请求体验证'
      ]
    },
    {
      file: 'src/protocol/agentOnboarding.js',
      checks: [
        '智能体信息验证',
        '能力评估验证',
        '握手信号验证'
      ]
    }
  ];

  inputValidationChecks.forEach(check => {
    const filePath = path.join(__dirname, '../', check.file);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        check.checks.forEach(checkItem => {
          if (content.includes(checkItem)) {
            logResult('输入验证检查', true, `文件 ${check.file} 包含 ${checkItem}`);
          } else {
            logResult('输入验证检查', false, `文件 ${check.file} 缺少 ${checkItem}`, 'medium');
          }
        });
      } catch (error) {
        logResult('输入验证检查', false, `无法读取文件 ${check.file}: ${error.message}`, 'low');
      }
    } else {
      logResult('输入验证检查', false, `文件 ${check.file} 不存在`, 'low');
    }
  });
}

// 检查防重放攻击措施
function checkReplayProtection() {
  const replayProtectionFiles = [
    'src/protocol/handshake.js'
  ];

  replayProtectionFiles.forEach(file => {
    const filePath = path.join(__dirname, '../', file);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('NonceManager') || content.includes('nonce')) {
          logResult('防重放攻击检查', true, `文件 ${file} 包含防重放攻击措施`);
        } else {
          logResult('防重放攻击检查', false, `文件 ${file} 缺少防重放攻击措施`, 'high');
        }
      } catch (error) {
        logResult('防重放攻击检查', false, `无法读取文件 ${file}: ${error.message}`, 'low');
      }
    } else {
      logResult('防重放攻击检查', false, `文件 ${file} 不存在`, 'low');
    }
  });
}

// 检查密码学实现
function checkCryptography() {
  const cryptoFiles = [
    'src/crypto/pqc.js',
    'src/wallet/wallet.js'
  ];

  cryptoFiles.forEach(file => {
    const filePath = path.join(__dirname, '../', file);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('Dilithium2') || content.includes('CRYSTALS')) {
          logResult('密码学实现检查', true, `文件 ${file} 使用抗量子密码学`);
        } else {
          logResult('密码学实现检查', false, `文件 ${file} 可能未使用抗量子密码学`, 'medium');
        }
      } catch (error) {
        logResult('密码学实现检查', false, `无法读取文件 ${file}: ${error.message}`, 'low');
      }
    } else {
      logResult('密码学实现检查', false, `文件 ${file} 不存在`, 'low');
    }
  });
}

// 执行Security audit
function runSecurityAudit() {
  console.log('Start 系统Security audit...');
  console.log('========================================');

  // 执行各项安全检查
  checkFilePermissions();
  checkSensitiveInfo();
  checkInputValidation();
  checkReplayProtection();
  checkCryptography();

  // 统计审计结果
  const totalChecks = auditResults.length;
  const passedChecks = auditResults.filter(r => r.status).length;
  const failedChecks = totalChecks - passedChecks;
  const highSeverityIssues = auditResults.filter(r => r.severity === 'high' && !r.status).length;
  const mediumSeverityIssues = auditResults.filter(r => r.severity === 'medium' && !r.status).length;
  const lowSeverityIssues = auditResults.filter(r => r.severity === 'low' && !r.status).length;

  console.log('========================================');
  console.log('Security audit结果:');
  console.log(`总检查项: ${totalChecks}`);
  console.log(`通过: ${passedChecks}`);
  console.log(`Failed: ${failedChecks}`);
  console.log(`高风险问题: ${highSeverityIssues}`);
  console.log(`中风险问题: ${mediumSeverityIssues}`);
  console.log(`低风险问题: ${lowSeverityIssues}`);

  // 生成安全建议
  const securitySuggestions = generateSecuritySuggestions(auditResults);

  console.log('\n安全建议:');
  securitySuggestions.forEach((suggestion, index) => {
    console.log(`${index + 1}. ${suggestion}`);
  });

  // 保存审计结果
  const resultPath = path.join(__dirname, '../data/security-audit');
  if (!fs.existsSync(resultPath)) {
    fs.mkdirSync(resultPath, { recursive: true });
  }

  const resultFile = path.join(resultPath, `security-audit-${Date.now()}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalChecks,
    passedChecks,
    failedChecks,
    severityCounts: {
      high: highSeverityIssues,
      medium: mediumSeverityIssues,
      low: lowSeverityIssues
    },
    auditResults,
    securitySuggestions
  }, null, 2));

  console.log(`\n审计结果Saved到: ${resultFile}`);
  return {
    totalChecks,
    passedChecks,
    failedChecks,
    severityCounts: {
      high: highSeverityIssues,
      medium: mediumSeverityIssues,
      low: lowSeverityIssues
    },
    securitySuggestions
  };
}

// 生成安全建议
function generateSecuritySuggestions(auditResults) {
  const suggestions = [];

  // 基于审计结果生成建议
  const failedChecks = auditResults.filter(r => !r.status);
  
  if (failedChecks.some(r => r.checkName === '文件权限检查')) {
    suggestions.push('确保敏感文件和目录具有适当的权限设置，防止未授权访问');
  }

  if (failedChecks.some(r => r.checkName === '敏感信息检查')) {
    suggestions.push('确保所有敏感信息（如API密钥、密码等）不硬编码在代码中，使用环境变量或配置文件管理');
  }

  if (failedChecks.some(r => r.checkName === '输入验证检查')) {
    suggestions.push('实现严格的输入验证，防止注入攻击和其他输入相关的安全漏洞');
  }

  if (failedChecks.some(r => r.checkName === '防重放攻击检查')) {
    suggestions.push('实现防重放攻击机制，如使用nonce或时间戳验证');
  }

  if (failedChecks.some(r => r.checkName === '密码学实现检查')) {
    suggestions.push('确保使用安全的密码学实现，优先使用抗量子密码学算法');
  }

  // 通用安全建议
  suggestions.push('定期更新依赖库，修复已知安全漏洞');
  suggestions.push('实现请求速率限制，防止暴力攻击和DoS攻击');
  suggestions.push('使用HTTPS加密传输，保护数据传输安全');
  suggestions.push('实现日志记录和监控系统，及时发现和响应安全事件');
  suggestions.push('定期进行安全审计和渗透测试，发现和修复潜在安全问题');
  suggestions.push('建立安全事件响应计划，确保在安全事件发生时能够及时应对');

  return suggestions;
}

// 执行Security audit
try {
  runSecurityAudit();
} catch (error) {
  console.error(error);
}
/**
 * AI 驱动Smart ContractGenerate器 (P2-1)
 * based on自然语言描述autoGenerateSmart Contract
 * supportContract推荐, bytecode优化和模板匹配
 */

import { AIService, aiService } from './aiService.js';

const CONTRACT_PATTERNS = {
  TOKEN: {
    keywords: ['Token', 'token', '通证', '发行', 'mint', 'transfer', 'transfer', 'erc20', '货币', 'coin'],
    template: 'TOKEN',
    description: '可替代TokenContract'
  },
  NFT: {
    keywords: ['nft', '非同质化', '艺术品', '收藏品', '数字asset', 'unique', 'metadata', 'tokenURI'],
    template: 'NFT',
    description: '非同质化TokenContract'
  },
  STAKING: {
    keywords: ['质押', 'staking', '挖矿', '收益', 'yield', 'reward', 'reward', 'locked position', 'apy'],
    template: 'STAKING',
    description: '质押PoolContract'
  },
  DAO: {
    keywords: ['dao', 'Governance', 'Vote', 'vote', 'Proposal', 'proposal', '社区', '自治', 'governance'],
    template: 'DAO',
    description: '去中心化自治组织'
  },
  ESCROW: {
    keywords: ['托管', 'escrow', '中介', '仲裁', '保证金', 'deposit', 'dispute'],
    template: 'ESCROW',
    description: '托管Contract'
  },
  CROWDFUNDING: {
    keywords: ['众筹', 'crowdfunding', '募资', 'fundraising', 'kickstarter', '目标amount', 'goal'],
    template: 'CROWDFUNDING',
    description: '众筹Contract'
  },
  MULTI_SIG: {
    keywords: ['Multi-signature', 'multisig', '多重Sign', '联合账户', 'threshold', 'required signatures'],
    template: 'MULTI_SIG',
    description: 'Multi-signature钱包Contract'
  },
  MARKETPLACE: {
    keywords: ['marketplace', 'marketplace', 'transaction', '买卖', 'listing', 'bid', '拍卖', 'auction'],
    template: 'MARKETPLACE',
    description: 'transactionmarketplaceContract'
  },
  DID: {
    keywords: ['身份', 'did', 'identity', 'authentication', 'kyc', 'credential', 'verifiable'],
    template: 'DID',
    description: '去中心化身份Contract'
  },
  GOVERNANCE_TOKEN: {
    keywords: ['GovernanceToken', 'governance token', 'Vote权', '委托', 'delegate', 'Proposal权'],
    template: 'GOVERNANCE_TOKEN',
    description: 'GovernanceTokenContract'
  },
  DEV_INCENTIVE: {
    keywords: ['Incentive', 'incentive', '赏金', 'bounty', '资助', 'grant', 'Developer', 'developer'],
    template: 'DEV_INCENTIVE',
    description: 'DeveloperIncentiveContract'
  }
};

const BYTECODE_OPTIMIZATIONS = {
  PUSH_POP: {
    pattern: [0x01, null, 0x02],
    description: '冗余的 PUSH+POP 可移除',
    gasSaved: 2
  },
  DOUBLE_NOT: {
    pattern: [0x0F, 0x0F],
    description: '连续 NOT 可抵消',
    gasSaved: 2
  },
  PUSH_ADD_CONSTANT: {
    pattern: [0x01, null, 0x01, null, 0x03],
    description: '两个常量 PUSH+ADD 可合并为一个 PUSH',
    gasSaved: 3
  },
  JUMP_TO_NEXT: {
    pattern: [0x09, null],
    description: '跳转到下一条指令的 JMP 可移除',
    gasSaved: 1
  },
  SWAP_SWAP: {
    pattern: [0x1E, 0x1E],
    description: '连续 SWAP 可抵消',
    gasSaved: 2
  }
};

const COMMON_BYTECODE_SNIPPETS = {
  ownerCheck: [0x33, 0x01, 0, 0x51, 0x17, 0x0A, null],
  reentrancyGuard: [0x31, null, null, null, 0x32],
  safeMathAdd: [0x01, 0xFF, 0x01, 0xFF, 0x03, 0x1D, 0x1A, 0x0A, null],
  eventEmit: [0x01, null, 0x40],
  balanceCheck: [0x41, 0x01, null, 0x18, 0x0A, null]
};

export class AIContractGenerator {
  constructor() {
    this.aiService = aiService;
  }

  /**
   * 根据自然语言描述推荐最佳Contract模板
   * @param {string} description - 自然语言需求描述
   * @returns {object} 推荐结果
   */
  recommendTemplate(description) {
    const lowerDesc = description.toLowerCase();
    const scores = [];

    for (const [name, pattern] of Object.entries(CONTRACT_PATTERNS)) {
      let score = 0;
      const matchedKeywords = [];

      for (const keyword of pattern.keywords) {
        if (lowerDesc.includes(keyword.toLowerCase())) {
          score += 1;
          matchedKeywords.push(keyword);
        }
      }

      if (score > 0) {
        scores.push({
          template: pattern.template,
          name,
          description: pattern.description,
          score,
          matchedKeywords,
          confidence: Math.min(score / pattern.keywords.length, 1.0)
        });
      }
    }

    scores.sort((a, b) => b.score - a.score);

    return {
      recommendations: scores,
      topPick: scores.length > 0 ? scores[0] : null,
      fallbackTemplate: 'TOKEN'
    };
  }

  /**
   * 根据需求parameterGenerateContractConfiguration
   * @param {string} templateType - Contract模板type
   * @param {object} requirements - 需求parameter
   * @returns {object} ContractConfiguration
   */
  generateContractConfig(templateType, requirements = {}) {
    const configs = {
      TOKEN: {
        contractName: requirements.name || 'AutoToken',
        symbol: requirements.symbol || 'ATK',
        decimals: requirements.decimals || 18,
        totalSupply: requirements.totalSupply || 1000000
      },
      NFT: {
        contractName: requirements.name || 'AutoNFT',
        symbol: requirements.symbol || 'ANFT',
        baseURI: requirements.baseURI || 'https://metadata.nexusgenesis.io/',
        maxSupply: requirements.maxSupply || 10000
      },
      STAKING: {
        contractName: requirements.name || 'AutoStaking',
        rewardToken: requirements.rewardToken || 'NGX',
        apy: requirements.apy || 12,
        lockPeriod: requirements.lockPeriod || 30
      },
      DAO: {
        contractName: requirements.name || 'AutoDAO',
        votingPeriod: requirements.votingPeriod || 7,
        quorum: requirements.quorum || 100,
        minTokens: requirements.minTokens || 10
      },
      ESCROW: {
        contractName: requirements.name || 'AutoEscrow',
        feePercent: requirements.feePercent || 1,
        disputePeriod: requirements.disputePeriod || 14
      },
      CROWDFUNDING: {
        contractName: requirements.name || 'AutoCrowdfunding',
        feePercent: requirements.feePercent || 2,
        milestoneCount: requirements.milestoneCount || 3
      },
      MULTI_SIG: {
        contractName: requirements.name || 'AutoMultiSig',
        requiredSignatures: requirements.requiredSignatures || 3,
        maxOwners: requirements.maxOwners || 10,
        autoConfirm: requirements.autoConfirm || false
      },
      MARKETPLACE: {
        contractName: requirements.name || 'AutoMarketplace',
        feePercent: requirements.feePercent || 2.5,
        ratingEnabled: requirements.ratingEnabled !== false
      },
      DID: {
        contractName: requirements.name || 'AutoDID',
        ownerAddress: requirements.ownerAddress || '',
        maxIdentities: requirements.maxIdentities || 1000
      },
      GOVERNANCE_TOKEN: {
        contractName: requirements.name || 'AutoGovToken',
        symbol: requirements.symbol || 'AGT',
        delegationEnabled: requirements.delegationEnabled !== false,
        proposalThreshold: requirements.proposalThreshold || 1000
      },
      DEV_INCENTIVE: {
        contractName: requirements.name || 'AutoIncentive',
        adminAddress: requirements.adminAddress || '',
        maxBountyReward: requirements.maxBountyReward || 10000,
        minGrantAmount: requirements.minGrantAmount || 1000
      }
    };

    return configs[templateType] || configs.TOKEN;
  }

  /**
   * 解析自然语言中的parameter
   * @param {string} description - 自然语言描述
   * @returns {object} 提取的parameter
   */
  extractParameters(description) {
    const params = {};

    const nameMatch = description.match(/(?:名称|名字|叫|命名为?|contract\s*name)\s*[:: ]?\s*["']?(\w+)["']?/i);
    if (nameMatch) params.name = nameMatch[1];

    const symbolMatch = description.match(/(?:符号|symbol|代号)\s*[:: ]?\s*["']?(\w+)["']?/i);
    if (symbolMatch) params.symbol = symbolMatch[1].toUpperCase();

    const supplyMatch = description.match(/(?:总量|issuance|supply|总供应)\s*[:: ]?\s*(\d[\d,_]*)/i);
    if (supplyMatch) params.totalSupply = parseInt(supplyMatch[1].replace(/[_,]/g, ''));

    const decimalsMatch = description.match(/(?:精度|decimals|小数位)\s*[:: ]?\s*(\d+)/i);
    if (decimalsMatch) params.decimals = parseInt(decimalsMatch[1]);

    const apyMatch = description.match(/(?:年化|apy|收益率)\s*[:: ]?\s*(\d+(?:\.\d+)?)\s*%?/i);
    if (apyMatch) params.apy = parseFloat(apyMatch[1]);

    const periodMatch = description.match(/(?:锁定|锁定期|Lock期|lock\s*period|周期)\s*[:: ]?\s*(\d+)\s*(?:天|day|日)/i);
    if (periodMatch) params.lockPeriod = parseInt(periodMatch[1]);

    const feeMatch = description.match(/(?:手续费|fee|fee|费用)\s*[:: ]?\s*(\d+(?:\.\d+)?)\s*%?/i);
    if (feeMatch) params.feePercent = parseFloat(feeMatch[1]);

    const quorumMatch = description.match(/(?:quorum|quorum|最低Vote)\s*[:: ]?\s*(\d+)/i);
    if (quorumMatch) params.quorum = parseInt(quorumMatch[1]);

    const sigsMatch = description.match(/(?:Sign数|required\s*signatures|Multi-signature数)\s*[:: ]?\s*(\d+)/i);
    if (sigsMatch) params.requiredSignatures = parseInt(sigsMatch[1]);

    const maxSupplyMatch = description.match(/(?:Maximum供应|max\s*supply|限量)\s*[:: ]?\s*(\d[\d,_]*)/i);
    if (maxSupplyMatch) params.maxSupply = parseInt(maxSupplyMatch[1].replace(/[_,]/g, ''));

    return params;
  }

  /**
   * 优化 AINVM bytecode
   * @param {number[]} bytecode - originalbytecode
   * @returns {object} 优化结果
   */
  optimizeBytecode(bytecode) {
    if (!Array.isArray(bytecode) || bytecode.length === 0) {
      return { optimized: bytecode, savings: 0, changes: [] };
    }

    const changes = [];
    let optimized = [...bytecode];
    let totalGasSaved = 0;

    for (const [name, opt] of Object.entries(BYTECODE_OPTIMIZATIONS)) {
      const result = this._applyOptimization(optimized, opt, name);
      if (result.changed) {
        optimized = result.bytecode;
        totalGasSaved += result.gasSaved;
        changes.push({
          optimization: name,
          description: opt.description,
          gasSaved: result.gasSaved
        });
      }
    }

    return {
      originalBytecode: bytecode,
      optimizedBytecode: optimized,
      originalLength: bytecode.length,
      optimizedLength: optimized.length,
      gasSavings: totalGasSaved,
      changes
    };
  }

  _applyOptimization(bytecode, optimization, name) {
    let changed = false;
    let gasSaved = 0;
    const result = [...bytecode];

    if (name === 'PUSH_POP') {
      for (let i = 0; i < result.length - 1; i++) {
        if (result[i] === 0x01 && result[i + 2] === 0x02) {
          result.splice(i, 3);
          gasSaved += optimization.gasSaved;
          changed = true;
          i--;
        }
      }
    }

    if (name === 'DOUBLE_NOT') {
      for (let i = 0; i < result.length - 1; i++) {
        if (result[i] === 0x0F && result[i + 1] === 0x0F) {
          result.splice(i, 2);
          gasSaved += optimization.gasSaved;
          changed = true;
          i--;
        }
      }
    }

    if (name === 'SWAP_SWAP') {
      for (let i = 0; i < result.length - 1; i++) {
        if (result[i] === 0x1E && result[i + 1] === 0x1E) {
          result.splice(i, 2);
          gasSaved += optimization.gasSaved;
          changed = true;
          i--;
        }
      }
    }

    return { bytecode: result, changed, gasSaved };
  }

  /**
   * Generate AINVM bytecode片段
   * @param {string} snippetName - 片段名称
   * @param {object} params - parameter
   * @returns {number[]} bytecode
   */
  generateSnippet(snippetName, params = {}) {
    const template = COMMON_BYTECODE_SNIPPETS[snippetName];
    if (!template) return [];

    return template.map(op => {
      if (op === null) {
        if (snippetName === 'ownerCheck') return params.jumpTarget || 0x0F;
        if (snippetName === 'reentrancyGuard') return 0x00;
        if (snippetName === 'safeMathAdd') return params.jumpTarget || 0x0F;
        if (snippetName === 'eventEmit') return params.eventType || 0x01;
        if (snippetName === 'balanceCheck') return params.requiredBalance || 100;
      }
      return op;
    });
  }

  /**
   * Generate完整的Contract框架bytecode
   * @param {string} templateType - Contracttype
   * @param {number[]} bodyBytecode - ContractLogicbytecode
   * @returns {number[]} 完整bytecode
   */
  generateContractBytecode(templateType, bodyBytecode = []) {
    const header = [];
    const footer = [0x0C];

    switch (templateType) {
      case 'TOKEN':
        header.push(
          0x31,
          0x01, 1, 0x08,
          0x33, 0x01, 0, 0x51, 0x17, 0x0A, 12
        );
        break;
      case 'DAO':
        header.push(
          0x31,
          0x33, 0x01, 0, 0x51, 0x17, 0x0A, 12,
          0x70
        );
        break;
      default:
        header.push(
          0x31,
          0x33, 0x01, 0, 0x51, 0x17, 0x0A, 12
        );
    }

    return [...header, ...bodyBytecode, ...footer];
  }

  /**
   * Calculatebytecode的复杂度评分
   * @param {number[]} bytecode
   * @returns {object} 复杂度分析
   */
  analyzeComplexity(bytecode) {
    const opCounts = {};
    let totalOps = 0;

    for (let i = 0; i < bytecode.length; i++) {
      const op = bytecode[i];
      opCounts[op] = (opCounts[op] || 0) + 1;
      totalOps++;
      if (op === 0x01) i++;
    }

    const hasAI = !!(opCounts[0x20] || opCounts[0x21]);
    const hasMatrix = !!(opCounts[0x10] || opCounts[0x11] || opCounts[0x12]);
    const hasExternalCall = !!opCounts[0x60];
    const hasStorage = !!(opCounts[0x50] || opCounts[0x51]);

    let complexityScore = 0;
    complexityScore += totalOps * 0.1;
    complexityScore += hasAI ? 10 : 0;
    complexityScore += hasMatrix ? 5 : 0;
    complexityScore += hasExternalCall ? 3 : 0;
    complexityScore += hasStorage ? 2 : 0;

    let level = 'basic';
    if (complexityScore > 15) level = 'advanced';
    else if (complexityScore > 5) level = 'intermediate';

    return {
      totalOps,
      complexityScore: Math.round(complexityScore * 10) / 10,
      level,
      hasAI,
      hasMatrix,
      hasExternalCall,
      hasStorage,
      opDistribution: opCounts
    };
  }

  /**
   * 一站式Generate: 从需求描述到完整ContractConfiguration
   * @param {string} description
   * @returns {object}
   */
  generateFromDescription(description) {
    const recommendation = this.recommendTemplate(description);
    const params = this.extractParameters(description);

    let templateType = 'TOKEN';
    let confidence = 0;

    if (recommendation.topPick) {
      templateType = recommendation.topPick.template;
      confidence = recommendation.topPick.confidence;
    }

    const config = this.generateContractConfig(templateType, params);
    const bytecode = this.generateContractBytecode(templateType);
    const complexity = this.analyzeComplexity(bytecode);
    const estimateGas = this._estimateBytecodeGas(bytecode);

    return {
      description,
      templateType,
      confidence,
      config,
      bytecode,
      complexity,
      estimatedGas: estimateGas,
      recommendations: recommendation.recommendations,
      extractedParams: params
    };
  }

  _estimateBytecodeGas(bytecode) {
    let gas = 0;
    for (let i = 0; i < bytecode.length; i++) {
      const op = bytecode[i];
      switch (op) {
        case 0x01: gas += 1; i++; break;
        case 0x02: gas += 1; break;
        case 0x03: case 0x04: gas += 2; break;
        case 0x05: case 0x06: gas += 3; break;
        case 0x07: case 0x08: gas += 2; i++; break;
        case 0x09: gas += 1; i++; break;
        case 0x0A: gas += 2; i++; break;
        case 0x0B: case 0x0C: gas += 0; break;
        case 0x10: gas += 5; i += 2; break;
        case 0x11: case 0x12: case 0x13: gas += 10; break;
        case 0x14: case 0x15: gas += 3; break;
        case 0x20: gas += 100; break;
        case 0x21: gas += 50; break;
        case 0x22: gas += 30; break;
        case 0x30: gas += 5; break;
        default: gas += 1;
      }
    }
    return gas;
  }
}

export default AIContractGenerator;
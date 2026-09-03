/**
 * NexusGenesis - Smart Contract模板库
 * 提供常用场景的Smart Contract模板: DID, DAO, Token, NFTetc.
 */

// Contracttype定义
const CONTRACT_TYPES = {
  DID: 'did',
  DAO: 'dao',
  TOKEN: 'token',
  NFT: 'nft',
  STAKING: 'staking',
  GOVERNANCE_TOKEN: 'governance_token',
  ESCROW: 'escrow',
  CROWDFUNDING: 'crowdfunding',
  MULTI_SIG: 'multi_sig',
  DEV_INCENTIVE: 'dev_incentive',
  MARKETPLACE: 'marketplace'
};

// Contract status
const CONTRACT_STATUS = {
  DRAFT: 'draft',
  DEPLOYED: 'deployed',
  ACTIVE: 'active',
  PAUSED: 'paused',
  TERMINATED: 'terminated'
};

class ContractTemplateLibrary {
  constructor() {
    this.templates = new Map();
    this.deployedContracts = new Map();
    this.initDefaultTemplates();
  }

  /**
   * InitializeDefault模板
   */
  initDefaultTemplates() {
    this.registerTemplate(CONTRACT_TYPES.DID, this.createDIDTemplate());
    this.registerTemplate(CONTRACT_TYPES.DAO, this.createDAOTemplate());
    this.registerTemplate(CONTRACT_TYPES.TOKEN, this.createTokenTemplate());
    this.registerTemplate(CONTRACT_TYPES.NFT, this.createNFTTemplate());
    this.registerTemplate(CONTRACT_TYPES.STAKING, this.createStakingTemplate());
    this.registerTemplate(CONTRACT_TYPES.ESCROW, this.createEscrowTemplate());
    this.registerTemplate(CONTRACT_TYPES.DEV_INCENTIVE, this.createDevIncentiveTemplate());
    this.registerTemplate(CONTRACT_TYPES.MARKETPLACE, this.createMarketplaceTemplate());
    this.registerTemplate(CONTRACT_TYPES.GOVERNANCE_TOKEN, this.createGovernanceTokenTemplate());
    this.registerTemplate(CONTRACT_TYPES.CROWDFUNDING, this.createCrowdfundingTemplate());
    this.registerTemplate(CONTRACT_TYPES.MULTI_SIG, this.createMultiSigTemplate());
  }

  /**
   * RegisterContract模板
   */
  registerTemplate(type, template) {
    if (!this.templates.has(type)) {
      this.templates.set(type, template);
      console.log(`[ContractTemplates] Registered template: ${type}`);
    }
  }

  /**
   * getContract模板
   */
  getTemplate(type) {
    return this.templates.get(type) || null;
  }

  /**
   * get所有可用模板
   */
  getAllTemplates() {
    const result = [];
    this.templates.forEach((template, type) => {
      result.push({
        type,
        name: template.name,
        description: template.description,
        version: template.version
      });
    });
    return result;
  }

  // ==================== DID Contract模板 ====================
  
  createDIDTemplate() {
    return {
      type: CONTRACT_TYPES.DID,
      name: 'Decentralized Identity Contract',
      description: '去中心化身份管理Contract, support身份Register, Verify和property管理',
      version: '1.0.0',
      
      // Contract结构定义
      schema: {
        fields: [
          { name: 'did', type: 'string', required: true },
          { name: 'owner', type: 'address', required: true },
          { name: 'publicKey', type: 'bytes', required: true },
          { name: 'createdAt', type: 'timestamp' },
          { name: 'status', type: 'enum', values: ['active', 'revoked', 'suspended'] },
          { name: 'attributes', type: 'map' }
        ]
      },
      
      // DefaultConfiguration
      defaultConfig: {
        maxAttributesPerDID: 50,
        attributeExpirationDays: 365,
        revocationEnabled: true,
        recoveryEnabled: true
      },
      
      // 核心method
      methods: {
        registerIdentity: {
          description: 'Register新的去中心化身份',
          parameters: ['owner', 'publicKey'],
          returns: 'did'
        },
        
        updateAttribute: {
          description: 'Update身份property',
          parameters: ['did', 'key', 'value'],
          returns: 'boolean'
        },
        
        verifyIdentity: {
          description: 'Verify身份有效性',
          parameters: ['did'],
          returns: 'boolean'
        },
        
        revokeIdentity: {
          description: '撤销身份',
          parameters: ['did', 'reason'],
          returns: 'boolean'
        }
      },
      
      // DeployparameterGenerate
      generateDeployParams(customConfig = {}) {
        return {
          ...this.defaultConfig,
          ...customConfig
        };
      }
    };
  }

  // ==================== DAO Contract模板 ====================
  
  createDAOTemplate() {
    return {
      type: CONTRACT_TYPES.DAO,
      name: 'Decentralized Autonomous Organization',
      description: '去中心化自治组织Contract, supportProposal, Vote和fund管理',
      version: '1.0.0',
      
      schema: {
        fields: [
          { name: 'name', type: 'string', required: true },
          { name: 'description', type: 'text' },
          { name: 'governanceToken', type: 'address' },
          { name: 'members', type: 'address[]' },
          { name: 'proposals', type: 'map[]' },
          { name: 'treasury', type: 'address' },
          { name: 'votingPeriod', type: 'uint256' },
          { name: 'quorum', type: 'uint8' }
        ]
      },
      
      defaultConfig: {
        votingDuration: 7 * 24 * 60 * 60, // 7天
        quorumPercentage: 51, // 51%quorum
        proposalThreshold: 1000, // Proposal门槛(Token数)
        executionDelay: 2 * 24 * 60 * 60, // 2天Execute延迟
        maxProposals: 100
      },
      
      methods: {
        createProposal: {
          description: 'CreateGovernanceProposal',
          parameters: ['title', 'description', 'actions'],
          returns: 'proposalId'
        },
        
        castVote: {
          description: '对Proposal进行Vote',
          parameters: ['proposalId', 'voteType'],
          returns: 'boolean'
        },
        
        executeProposal: {
          description: 'Executepassed的Proposal',
          parameters: ['proposalId'],
          returns: 'boolean'
        },
        
        addMember: {
          description: '添加DAOmember',
          parameters: ['memberAddress', 'shares'],
          returns: 'boolean'
        },
        
        submitTreasuryWithdrawal: {
          description: '提交国库提款请求',
          parameters: ['amount', 'recipient', 'reason'],
          returns: 'requestId'
        }
      },
      
      generateDeployParams(customConfig = {}) {
        return {
          ...this.defaultConfig,
          ...customConfig
        };
      }
    };
  }

  // ==================== Token Contract模板 ====================
  
  createTokenTemplate() {
    return {
      type: CONTRACT_TYPES.TOKEN,
      name: 'Fungible Token (ERC-20 compatible)',
      description: '可替代TokenContract, supporttransfer, authorization和铸造',
      version: '1.0.0',
      
      schema: {
        fields: [
          { name: 'name', type: 'string', required: true },
          { name: 'symbol', type: 'string', required: true },
          { name: 'decimals', type: 'uint8', default: 18 },
          { name: 'totalSupply', type: 'uint256' },
          { name: 'balances', type: 'map' },
          { name: 'allowances', type: 'map' },
          { name: 'owner', type: 'address' },
          { name: 'mintable', type: 'boolean', default: false },
          { name: 'burnable', type: 'boolean', default: false }
        ]
      },
      
      defaultConfig: {
        initialSupply: 1000000,
        decimals: 18,
        mintable: true,
        burnable: true,
        transferFee: 0, // 0% transfer费
        maxSupply: null // 无上限
      },
      
      methods: {
        transfer: {
          description: '转移Token',
          parameters: ['to', 'amount'],
          returns: 'boolean'
        },
        
        approve: {
          description: 'authorization他人usingToken',
          parameters: ['spender', 'amount'],
          returns: 'boolean'
        },
        
        transferFrom: {
          description: '从authorization账户转移Token',
          parameters: ['from', 'to', 'amount'],
          returns: 'boolean'
        },
        
        mint: {
          description: '铸造新Token',
          parameters: ['to', 'amount'],
          returns: 'boolean'
        },
        
        burn: {
          description: '销毁Token',
          parameters: ['amount'],
          returns: 'boolean'
        }
      },
      
      generateDeployParams(customConfig = {}) {
        return {
          ...this.defaultConfig,
          ...customConfig
        };
      }
    };
  }

  // ==================== NFT Contract模板 ====================
  
  createNFTTemplate() {
    return {
      type: CONTRACT_TYPES.NFT,
      name: 'Non-Fungible Token (ERC-721 compatible)',
      description: '非同质化TokenContract, support数字asset唯一性表示',
      version: '1.0.0',
      
      schema: {
        fields: [
          { name: 'name', type: 'string', required: true },
          { name: 'symbol', type: 'string', required: true },
          { name: 'baseURI', type: 'string' },
          { name: 'totalSupply', type: 'uint256' },
          { name: 'tokenOwners', type: 'map' }, // tokenId -> owner
          { name: 'tokenURIs', type: 'map' }, // tokenId -> URI
          { name: 'ownerTokens', type: 'map' } // owner -> tokenIds[]
        ]
      },
      
      defaultConfig: {
        maxSupply: 10000,
        baseURI: '',
        royaltyPercentage: 5, // 5%版税
        transferable: true,
        burnable: true
      },
      
      methods: {
        mintNFT: {
          description: '铸造NFT',
          parameters: ['to', 'tokenURI', 'royaltyRecipient'],
          returns: 'tokenId'
        },
        
        transferNFT: {
          description: '转移NFTownership',
          parameters: ['from', 'to', 'tokenId'],
          returns: 'boolean'
        },
        
        setTokenURI: {
          description: 'SetNFTmetadataURI',
          parameters: ['tokenId', 'uri'],
          returns: 'boolean'
        },
        
        approveTransfer: {
          description: 'authorization他人转移NFT',
          parameters: ['approved', 'tokenId'],
          returns: 'boolean'
        },
        
        burnNFT: {
          description: '销毁NFT',
          parameters: ['tokenId'],
          returns: 'boolean'
        }
      },
      
      generateDeployParams(customConfig = {}) {
        return {
          ...this.defaultConfig,
          ...customConfig
        };
      }
    };
  }

  // ==================== Staking Contract模板 ====================
  
  createStakingTemplate() {
    return {
      type: CONTRACT_TYPES.STAKING,
      name: 'Staking Pool Contract',
      description: '质押PoolContract, supportToken质押, reward分配和提取',
      version: '1.0.0',
      
      schema: {
        fields: [
          { name: 'stakingToken', type: 'address', required: true },
          { name: 'rewardToken', type: 'address', required: true },
          { name: 'rewardRate', type: 'uint256' },
          { name: 'totalStaked', type: 'uint256' },
          { name: 'stakes', type: 'map' }, // user -> stake info
          { name: 'lockPeriod', type: 'uint256' },
          { name: 'earlyWithdrawPenalty', type: 'uint8' }
        ]
      },
      
      defaultConfig: {
        rewardRate: 100, // 年化10%
        lockPeriod: 30 * 24 * 60 * 60, // 30天Lock期
        earlyWithdrawPenalty: 10, // 10%提前退出惩罚
        minStakeAmount: 100,
        maxStakeAmount: null,
        compoundRewards: true
      },
      
      methods: {
        stakeTokens: {
          description: '质押Token',
          parameters: ['amount'],
          returns: 'stakeId'
        },
        
        unstakeTokens: {
          description: '解除质押',
          parameters: ['stakeId'],
          returns: 'boolean'
        },
        
        claimRewards: {
          description: '领取质押reward',
          parameters: [],
          returns: 'amount'
        },
        
        compoundRewards: {
          description: '复投reward',
          parameters: [],
          returns: 'newAmount'
        },
        
        getStakeInfo: {
          description: 'Get质押info',
          parameters: ['userAddress'],
          returns: 'stakeInfo'
        }
      },
      
      generateDeployParams(customConfig = {}) {
        return {
          ...this.defaultConfig,
          ...customConfig
        };
      }
    };
  }

  // ==================== Escrow Contract模板 ====================
  
  createEscrowTemplate() {
    return {
      type: CONTRACT_TYPES.ESCROW,
      name: 'Escrow Smart Contract',
      description: '托管Contract, support条件Release和争议解决',
      version: '1.0.0',
      
      schema: {
        fields: [
          { name: 'buyer', type: 'address', required: true },
          { name: 'seller', type: 'address', required: true },
          { name: 'arbiter', type: 'address', required: true },
          { name: 'amount', type: 'uint256', required: true },
          { name: 'status', type: 'enum', values: ['pending', 'released', 'refunded', 'disputed'] },
          { name: 'releaseConditions', type: 'map' },
          { name: 'disputeDeadline', type: 'timestamp' }
        ]
      },
      
      defaultConfig: {
        disputeResolutionPeriod: 14 * 24 * 60 * 60, // 14天争议期
        autoReleaseAfterDispute: true,
        feePercentage: 1, // 1%fee
        requireBothApproval: false
      },
      
      methods: {
        createEscrow: {
          description: 'Create托管transaction',
          parameters: ['buyer', 'seller', 'amount', 'conditions'],
          returns: 'escrowId'
        },
        
        releaseFunds: {
          description: 'Releasefund给卖家',
          parameters: ['escrowId'],
          returns: 'boolean'
        },
        
        refundBuyer: {
          description: '退款给买家',
          parameters: ['escrowId'],
          returns: 'boolean'
        },
        
        raiseDispute: {
          description: '发起争议',
          parameters: ['escrowId', 'reason'],
          returns: 'disputeId'
        },
        
        resolveDispute: {
          description: '解决争议',
          parameters: ['escrowId', 'decision'], // decision: 'release' | 'refund' | 'split'
          returns: 'boolean'
        }
      },
      
      generateDeployParams(customConfig = {}) {
        return {
          ...this.defaultConfig,
          ...customConfig
        };
      }
    };
  }

  // ==================== DeveloperIncentive模板(Phase 2 新增) ====================

  createDevIncentiveTemplate() {
    return {
      type: CONTRACT_TYPES.DEV_INCENTIVE,
      name: 'Developer Incentive System',
      version: '1.0.0',
      description: 'DeveloperIncentiveContract — Bug Bounty, Feature Grant, PR Reward, Challenge',
      category: 'governance',
      complexity: 'advanced',
      instructionLimit: 3000,
      stateSize: 1024,

      defaultConfig: {
        minBugBounty: 100,
        maxBugBounty: 10000,
        minFeatureGrant: 500,
        maxFeatureGrant: 50000,
        prRewardPerLine: 5,
        maxPrReward: 2000,
        challengeRewardRange: [50, 5000],
        reviewCommittee: [],
        totalBudget: 1000000,
        adminAddress: ''
      },

      methods: {
        createBugBounty: {
          description: 'Create Bug Bounty',
          params: [
            { name: 'title', type: 'string' },
            { name: 'severity', type: 'string' },
            { name: 'reward', type: 'uint256' }
          ],
          returns: 'string'
        },
        submitFix: {
          description: '提交 Bug 修复',
          params: [
            { name: 'bountyId', type: 'string' },
            { name: 'patch', type: 'string' }
          ],
          returns: 'boolean'
        },
        approveFix: {
          description: '批准 Bug 修复',
          params: [
            { name: 'bountyId', type: 'string' },
            { name: 'submissionId', type: 'string' }
          ],
          returns: 'boolean'
        },
        createGrant: {
          description: 'CreateFeatures开发资助',
          params: [
            { name: 'title', type: 'string' },
            { name: 'reward', type: 'uint256' }
          ],
          returns: 'string'
        },
        applyForGrant: {
          description: '申请开发资助',
          params: [
            { name: 'grantId', type: 'string' },
            { name: 'proposal', type: 'string' }
          ],
          returns: 'boolean'
        },
        createChallenge: {
          description: 'Create开发挑战',
          params: [
            { name: 'title', type: 'string' },
            { name: 'reward', type: 'uint256' },
            { name: 'deadline', type: 'uint256' }
          ],
          returns: 'string'
        },
        claimReward: {
          description: '领取reward',
          params: [
            { name: 'incentiveId', type: 'string' }
          ],
          returns: 'boolean'
        },
        getStats: {
          description: 'GetIncentive统计',
          params: [],
          returns: 'object'
        }
      },

      generateDeployParams(customConfig = {}) {
        return { ...this.defaultConfig, ...customConfig };
      }
    };
  }

  // ==================== Marketplace 模板(Phase 2 新增) ====================

  createMarketplaceTemplate() {
    return {
      type: CONTRACT_TYPES.MARKETPLACE,
      name: 'Decentralized Marketplace',
      version: '1.0.0',
      description: '去中心化marketplaceContract — NFTtransaction, servicemarketplace, datatransaction',
      category: 'defi',
      complexity: 'advanced',
      instructionLimit: 2500,
      stateSize: 2048,

      defaultConfig: {
        feePercent: 2.5,
        minListingPrice: 1,
        maxListingPrice: 1000000,
        platformFeeRecipient: '',
        royaltyPercent: 5,
        disputePeriod: 86400,
        adminAddress: ''
      },

      methods: {
        listItem: {
          description: '上架商品',
          params: [
            { name: 'title', type: 'string' },
            { name: 'price', type: 'uint256' },
            { name: 'category', type: 'string' }
          ],
          returns: 'string'
        },
        buyItem: {
          description: '购买商品',
          params: [
            { name: 'itemId', type: 'string' }
          ],
          returns: 'boolean'
        },
        cancelListing: {
          description: '取消上架',
          params: [
            { name: 'itemId', type: 'string' }
          ],
          returns: 'boolean'
        },
        makeOffer: {
          description: '出价',
          params: [
            { name: 'itemId', type: 'string' },
            { name: 'amount', type: 'uint256' }
          ],
          returns: 'boolean'
        },
        acceptOffer: {
          description: '接受出价',
          params: [
            { name: 'offerId', type: 'string' }
          ],
          returns: 'boolean'
        },
        disputeItem: {
          description: '发起争议',
          params: [
            { name: 'itemId', type: 'string' },
            { name: 'reason', type: 'string' }
          ],
          returns: 'boolean'
        },
        getItem: {
          description: '查询商品',
          params: [
            { name: 'itemId', type: 'string' }
          ],
          returns: 'object'
        }
      },

      generateDeployParams(customConfig = {}) {
        return { ...this.defaultConfig, ...customConfig };
      }
    };
  }

  // ==================== GovernanceToken模板(Phase 2 新增) ====================

  createGovernanceTokenTemplate() {
    return {
      type: CONTRACT_TYPES.GOVERNANCE_TOKEN,
      name: 'Governance Token',
      version: '1.0.0',
      description: 'GovernanceTokenContract — voting weight, 委托Vote, Proposal门槛, Token分发',
      category: 'governance',
      complexity: 'advanced',
      instructionLimit: 2500,
      stateSize: 1024,

      defaultConfig: {
        name: 'NexusGovernanceToken',
        symbol: 'NGOV',
        totalSupply: 100000000,
        decimals: 18,
        quorumPercent: 10,
        proposalThreshold: 1000,
        votingPeriodBlocks: 10080,
        executionDelayBlocks: 1440,
        adminAddress: ''
      },

      methods: {
        mint: {
          description: '铸造GovernanceToken',
          params: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' }
          ],
          returns: 'boolean'
        },
        delegate: {
          description: '委托Vote权',
          params: [
            { name: 'delegatee', type: 'address' }
          ],
          returns: 'boolean'
        },
        propose: {
          description: 'CreateGovernanceProposal',
          params: [
            { name: 'targets', type: 'address[]' },
            { name: 'values', type: 'uint256[]' },
            { name: 'calldatas', type: 'bytes[]' },
            { name: 'description', type: 'string' }
          ],
          returns: 'uint256'
        },
        castVote: {
          description: 'Vote',
          params: [
            { name: 'proposalId', type: 'uint256' },
            { name: 'support', type: 'uint8' }
          ],
          returns: 'boolean'
        },
        execute: {
          description: 'ExecutepassedProposal',
          params: [
            { name: 'proposalId', type: 'uint256' }
          ],
          returns: 'boolean'
        },
        getVotingPower: {
          description: '查询voting weight',
          params: [
            { name: 'account', type: 'address' }
          ],
          returns: 'uint256'
        },
        getProposalState: {
          description: '查询Proposalstatus',
          params: [
            { name: 'proposalId', type: 'uint256' }
          ],
          returns: 'uint8'
        }
      },

      generateDeployParams(customConfig = {}) {
        return { ...this.defaultConfig, ...customConfig };
      }
    };
  }

  // ==================== 众筹Contract模板(Phase 2 新增) ====================

  createCrowdfundingTemplate() {
    return {
      type: CONTRACT_TYPES.CROWDFUNDING,
      name: 'Crowdfunding Campaign',
      version: '1.0.0',
      description: '众筹Contract — Create众筹项目, contribution, 目标追踪, 退款, 里程碑支付',
      category: 'defi',
      complexity: 'intermediate',
      instructionLimit: 2000,
      stateSize: 768,

      defaultConfig: {
        platformFeePercent: 2.5,
        minCampaignDuration: 86400,
        maxCampaignDuration: 7776000,
        minGoal: 100,
        maxGoal: 10000000,
        adminAddress: ''
      },

      methods: {
        createCampaign: {
          description: 'Create众筹项目',
          params: [
            { name: 'title', type: 'string' },
            { name: 'description', type: 'string' },
            { name: 'goal', type: 'uint256' },
            { name: 'duration', type: 'uint256' },
            { name: 'beneficiary', type: 'address' }
          ],
          returns: 'string'
        },
        contribute: {
          description: 'contributionfund',
          params: [
            { name: 'campaignId', type: 'string' },
            { name: 'amount', type: 'uint256' }
          ],
          returns: 'boolean'
        },
        claimFunds: {
          description: '发起人领取fund(需达到目标)',
          params: [
            { name: 'campaignId', type: 'string' }
          ],
          returns: 'boolean'
        },
        refund: {
          description: 'contribution者退款(未达到目标时)',
          params: [
            { name: 'campaignId', type: 'string' }
          ],
          returns: 'boolean'
        },
        createMilestone: {
          description: 'Create里程碑',
          params: [
            { name: 'campaignId', type: 'string' },
            { name: 'title', type: 'string' },
            { name: 'amount', type: 'uint256' }
          ],
          returns: 'string'
        },
        releaseMilestone: {
          description: 'Release里程碑fund',
          params: [
            { name: 'campaignId', type: 'string' },
            { name: 'milestoneId', type: 'string' }
          ],
          returns: 'boolean'
        },
        getCampaign: {
          description: '查询众筹项目',
          params: [
            { name: 'campaignId', type: 'string' }
          ],
          returns: 'object'
        }
      },

      generateDeployParams(customConfig = {}) {
        return { ...this.defaultConfig, ...customConfig };
      }
    };
  }

  // ==================== Multi-signature钱包模板(Phase 2 新增) ====================

  createMultiSigTemplate() {
    return {
      type: CONTRACT_TYPES.MULTI_SIG,
      name: 'Multi-Signature Wallet',
      version: '1.0.0',
      description: 'Multi-signature钱包Contract — Multi-signature确认transaction, permission管理, 每日限额, 紧急冻结',
      category: 'security',
      complexity: 'intermediate',
      instructionLimit: 1800,
      stateSize: 512,

      defaultConfig: {
        owners: [],
        requiredConfirmations: 3,
        dailyLimit: 100000,
        maxTransactionValue: 1000000,
        allowEmergencyFreeze: true,
        adminAddress: ''
      },

      methods: {
        addOwner: {
          description: '添加所有者',
          params: [
            { name: 'owner', type: 'address' }
          ],
          returns: 'boolean'
        },
        removeOwner: {
          description: '移除所有者',
          params: [
            { name: 'owner', type: 'address' }
          ],
          returns: 'boolean'
        },
        replaceOwner: {
          description: '替换所有者',
          params: [
            { name: 'oldOwner', type: 'address' },
            { name: 'newOwner', type: 'address' }
          ],
          returns: 'boolean'
        },
        submitTransaction: {
          description: '提交待确认transaction',
          params: [
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' }
          ],
          returns: 'uint256'
        },
        confirmTransaction: {
          description: '确认transaction',
          params: [
            { name: 'txId', type: 'uint256' }
          ],
          returns: 'boolean'
        },
        revokeConfirmation: {
          description: '撤销确认',
          params: [
            { name: 'txId', type: 'uint256' }
          ],
          returns: 'boolean'
        },
        executeTransaction: {
          description: 'Execute已确认transaction',
          params: [
            { name: 'txId', type: 'uint256' }
          ],
          returns: 'boolean'
        },
        emergencyFreeze: {
          description: '紧急冻结',
          params: [],
          returns: 'boolean'
        },
        emergencyUnfreeze: {
          description: '解除冻结',
          params: [],
          returns: 'boolean'
        },
        getConfirmationCount: {
          description: '查询确认数',
          params: [
            { name: 'txId', type: 'uint256' }
          ],
          returns: 'uint256'
        }
      },

      generateDeployParams(customConfig = {}) {
        return { ...this.defaultConfig, ...customConfig };
      }
    };
  }

  // ==================== 辅助method ====================

  /**
   * 从模板CreateContractinstance
   */
  createContractFromTemplate(type, deployParams = {}) {
    const template = this.getTemplate(type);
    if (!template) {
      throw new Error(`Contract template not found: ${type}`);
    }
    
    const config = template.generateDeployParams(deployParams);
    
    return {
      type: template.type,
      name: template.name,
      status: CONTRACT_STATUS.DRAFT,
      config,
      createdAt: Date.now(),
      deployedAt: null,
      address: null,
      methods: Object.keys(template.methods),
      schema: template.schema
    };
  }

  /**
   * 记录Deploy的Contract
   */
  recordDeployment(contractId, contractData) {
    this.deployedContracts.set(contractId, {
      ...contractData,
      deployedAt: Date.now(),
      status: CONTRACT_STATUS.DEPLOYED
    });
  }

  /**
   * getdeployed的Contract
   */
  getDeployedContract(contractId) {
    return this.deployedContracts.get(contractId) || null;
  }

  /**
   * get所有deployed的Contract
   */
  getAllDeployedContracts() {
    return Array.from(this.deployedContracts.entries()).map(([id, contract]) => ({
      id,
      ...contract
    }));
  }

  /**
   * VerifyContractConfiguration
   */
  validateContractConfig(type, config) {
    const template = this.getTemplate(type);
    if (!template) {
      return { valid: false, error: `Unknown contract type: ${type}` };
    }
    
    const errors = [];
    
    // Verify必需字段
    if (template.schema && template.schema.fields) {
      for (const field of template.schema.fields) {
        if (field.required && !config[field.name]) {
          errors.push(`Missing required field: ${field.name}`);
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings: []
    };
  }

  /**
   * get统计info
   */
  getStats() {
    return {
      totalTemplates: this.templates.size,
      totalDeployed: this.deployedContracts.size,
      availableTypes: Array.from(this.templates.keys())
    };
  }
}

// Export单例instance
const contractTemplateLibrary = new ContractTemplateLibrary();

export {
  ContractTemplateLibrary,
  contractTemplateLibrary,
  CONTRACT_TYPES,
  CONTRACT_STATUS
};

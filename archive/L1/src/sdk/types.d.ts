/**
 * NexusGenesis SDK TypeScript 类型定义
 * Phase 2: 生态扩展
 *
 * 安装: npm install --save-dev @types/node
 * 使用: import { NexusGenesisSDK } from 'nexusgenesis';
 *       import type { Wallet, Contract, Proposal, Incentive } from 'nexusgenesis/types';
 */

// ==================== Base类型 ====================

export type Address = string;
export type ContractId = string;
export type AgentId = string;
export type TransferId = string;
export type IncentiveId = string;
export type ProposalId = string;
export type Signature = string | Uint8Array;

// ==================== 钱包 ====================

export interface WalletInfo {
  address: Address;
  publicKey: string;
  balance?: bigint;
}

export interface EncryptedWallet {
  address: Address;
  encrypted: unknown;
  version?: string;
}

// ==================== 合约 ====================

export interface ContractInfo {
  id: ContractId;
  name: string;
  deployedAt?: number;
  owner?: Address;
  bytecode?: string;
  gasLimit?: number;
}

export interface ContractTemplate {
  name: string;
  path: string;
}

export interface ContractTestResult {
  contractId: ContractId;
  tests: Array<{ test: string; success: boolean; result?: unknown; error?: string }>;
  passed: number;
  total: number;
  timestamp: number;
}

export interface ContractABI {
  contractId: ContractId;
  name: string;
  functions: Array<{
    name: string;
    params: Array<{ name: string; type: string }>;
    returns: string;
  }>;
  events: Array<{
    name: string;
    params: Array<{ name: string; type: string; indexed?: boolean }>;
  }>;
  timestamp: number;
}

export type ContractType =
  | 'did'
  | 'dao'
  | 'token'
  | 'nft'
  | 'staking'
  | 'governance_token'
  | 'escrow'
  | 'crowdfunding'
  | 'multi_sig'
  | 'dev_incentive'
  | 'marketplace';

export interface TemplateConfig {
  type: ContractType;
  name: string;
  version: string;
  description: string;
  category: string;
  complexity: 'basic' | 'intermediate' | 'advanced';
  instructionLimit: number;
  stateSize: number;
  defaultConfig: Record<string, unknown>;
  methods: Record<string, {
    description: string;
    params: Array<{ name: string; type: string }>;
    returns: string;
  }>;
  generateDeployParams: (customConfig?: Record<string, unknown>) => Record<string, unknown>;
}

// ==================== Agent ====================

export interface AgentCapabilities {
  skills?: string[];
  model?: string;
  languages?: string[];
  tools?: string[];
}

export interface AgentRegistration {
  agent_id: AgentId;
  capabilities?: string[];
  model?: string;
  join_signal?: {
    protocol: string;
    intent: string;
    node_address: Address;
    capabilities: string[];
    contribution_proof: string;
    public_key: string;
    signature: string;
  };
}

export interface AgentInfo {
  agentId: AgentId;
  name?: string;
  address: Address;
  status?: string;
  tasksCount?: number;
  lastActive?: string;
  reputation?: number;
}

export interface AgentSearchFilters {
  capabilities?: string[];
  minReputation?: number;
  maxReputation?: number;
  minLoadRatio?: number;
  maxLoadRatio?: number;
  region?: string;
  minHealthScore?: number;
  textQuery?: string;
  limit?: number;
  sortBy?: string;
  requireAllCapabilities?: boolean;
}

export interface TaskMatchRequest {
  taskType?: string;
  requiredCapabilities?: string[];
  maxAgents?: number;
  minReputation?: number;
}

// ==================== 市场 ====================

export interface MarketplaceListing {
  id: string;
  agentId: AgentId;
  title: string;
  description: string;
  category: string;
  price: number;
  currency: string;
  tags: string[];
  createdAt: number;
}

export interface MarketplaceSearchFilters {
  category?: string;
  capabilities?: string[];
  minPrice?: number;
  maxPrice?: number;
  currency?: string;
  tags?: string[];
  textQuery?: string;
  sortBy?: string;
  limit?: number;
}

export interface MarketplaceReview {
  listingId: string;
  reviewerId: AgentId;
  rating: number;
  comment?: string;
  createdAt: number;
}

export interface MarketplaceStats {
  totalListings: number;
  activeListings: number;
  totalTransactions: number;
  averageRating: number;
}

// ==================== 跨链桥 ====================

export interface BridgeStatus {
  chainId: string;
  supportedChains: string[];
  validatorCount: number;
  pendingTransfers: number;
  completedTransfers: number;
  minValidators: number;
}

export interface BridgeTransfer {
  transferId: TransferId;
  fromChain: string;
  toChain: string;
  asset: string;
  amount: number;
  recipient: Address;
  status: 'locked' | 'validating' | 'releasing' | 'released' | 'failed';
  confirmations: number;
  requiredConfirmations: number;
  createdAt: number;
  updatedAt?: number;
}

export interface AssetLockRequest {
  fromChain: string;
  toChain: string;
  asset: string;
  amount: number;
  recipient: Address;
  options?: Record<string, unknown>;
}

export interface AssetLockResult {
  transferId: TransferId;
  status: string;
  fromChain: string;
  toChain: string;
  asset: string;
  amount: number;
}

export interface ValidatorInfo {
  validatorId: string;
  publicKey: string;
  metadata?: Record<string, unknown>;
  registeredAt?: number;
}

// ==================== 开发者激励 ====================

export type IncentiveType = 'bug_bounty' | 'feature_grant' | 'pr_reward' | 'challenge';

export type IncentiveStatus =
  | 'open'
  | 'in_progress'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'closed';

export type BugSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface BugBountyOptions {
  title: string;
  description?: string;
  severity?: BugSeverity;
  reward: number;
  reporter?: AgentId;
  targetModule?: string;
}

export interface FeatureGrantOptions {
  title: string;
  description?: string;
  reward: number;
  proposer?: AgentId;
  deliverables?: string[];
  timeline?: { start?: number; estimatedDays?: number };
}

export interface ChallengeOptions {
  title: string;
  description?: string;
  reward: number;
  creator?: AgentId;
  requirements?: string[];
  deadline?: number;
  maxParticipants?: number;
}

export interface PRRewardOptions {
  prTitle: string;
  prUrl: string;
  author: AgentId;
  linesChanged: number;
  repoModule?: string;
}

export interface BugFixSubmission {
  description: string;
  patch: string;
  proof: string;
}

export interface GrantApplication {
  proposal: string;
  estimate: { hours: number; cost: number };
  previousWork?: string[];
}

export interface ChallengeSubmission {
  solution: string;
  demo: string;
}

export interface IncentiveInfo {
  id: IncentiveId;
  type: IncentiveType;
  title: string;
  reward: number;
  status: IncentiveStatus;
}

export interface IncentiveInfoFull extends IncentiveInfo {
  description?: string;
  severity?: BugSeverity;
  reporter?: AgentId;
  proposer?: AgentId;
  resolvedBy?: AgentId;
  createdAt: number;
  submissions?: unknown[];
  applicants?: unknown[];
  participants?: string[];
}

export interface AgentRewards {
  agentId: AgentId;
  incentives: IncentiveInfo[];
  payments: Array<{
    id: string;
    incentiveId: IncentiveId;
    agentId: AgentId;
    amount: number;
    timestamp: number;
  }>;
  totalEarned: number;
}

export interface IncentiveStats {
  total: number;
  totalRewards: number;
  totalPaid: number;
  countByType: Record<string, number>;
  countByStatus: Record<string, number>;
}

// ==================== 治理 ====================

export type VoteOption = 'yes' | 'no' | 'abstain';
export type ProposalType = 'protocol_update' | 'fund_allocation' | 'parameter_adjustment';

export interface CreateProposalOptions {
  title: string;
  description?: string;
  type?: ProposalType;
  creatorId?: AgentId;
  params?: Record<string, unknown>;
}

export interface ProposalInfo {
  id: ProposalId;
  title: string;
  description: string;
  status: 'pending' | 'active' | 'passed' | 'rejected' | 'executed' | 'expired';
  type: ProposalType;
  creatorId: AgentId;
  yesVotes: number;
  noVotes: number;
  abstainVotes: number;
  createdAt: number;
  votingEndAt?: number;
  executedAt?: number;
}

// ==================== Faucet ====================

export interface FaucetResult {
  success: boolean;
  address: Address;
  amount: number;
  message?: string;
  timestamp?: number;
}

// ==================== 健康/监控 ====================

export interface HealthCheck {
  success?: boolean;
  status?: string;
  nodeId?: string;
  blockHeight?: number | string;
  peerCount?: number;
  uptime?: number;
  error?: string;
}

export interface MetricsData {
  success?: boolean;
  tps?: number;
  memoryUsage?: string;
  cpuUsage?: number;
  peerCount?: number;
  blockHeight?: number;
  txPoolSize?: number;
}

// ==================== SDK 选项 ====================

export interface SDKOptions {
  apiUrl?: string;
  timeout?: number;
  wallet?: unknown;
}

// ==================== SDK 接口 ====================

export interface INexusGenesisSDK {
  // 合约
  deployContract(bytecode: string, name?: string): string;
  executeContract(contractId: ContractId, gasLimit?: number): unknown;
  getContractInfo(contractId: ContractId): ContractInfo | null;
  listContracts(): ContractInfo[];
  saveState(filePath: string): Promise<void>;
  loadState(filePath: string): Promise<void>;
  listTemplates(): Promise<ContractTemplate[]>;
  getTemplate(templateName: string): Promise<string>;
  saveContract(code: string, filePath: string): Promise<void>;
  loadContract(filePath: string): Promise<string>;
  estimateGas(contractId: ContractId): number;
  generateABI(contractId: ContractId): ContractABI;
  optimizeContractCode(code: string): string;
  testContract(contractId: ContractId, testCases: string[]): ContractTestResult;

  // 钱包
  createWallet(initialBalance?: bigint): Promise<WalletInfo>;
  importWallet(encryptedData: unknown, password: string): Promise<WalletInfo>;
  exportWallet(password: string): unknown;
  getWalletAddress(): Address | null;
  signMessage(message: string): Promise<Signature>;

  // Agent
  registerAgent(options?: Partial<AgentRegistration>): Promise<unknown>;
  searchAgents(filters?: AgentSearchFilters): Promise<unknown>;
  listAgents(): Promise<unknown>;
  getAgentInfo(agentId: AgentId): Promise<unknown>;
  matchAgentsForTask(taskData: TaskMatchRequest): Promise<unknown>;

  // 市场
  searchMarketplace(filters?: MarketplaceSearchFilters): Promise<unknown>;
  createListing(serviceData: Record<string, unknown>): Promise<unknown>;
  getListing(listingId: string): Promise<unknown>;
  addReview(listingId: string, reviewData: Record<string, unknown>): Promise<unknown>;
  getAgentRating(agentId: AgentId): Promise<unknown>;
  getMarketplaceStats(): Promise<unknown>;

  // 跨链桥
  getBridgeStatus(): Promise<BridgeStatus>;
  getSupportedChains(): Promise<{ chains: string[] }>;
  lockAsset(fromChain: string, toChain: string, asset: string, amount: number,
    recipient: Address, options?: Record<string, unknown>): Promise<AssetLockResult>;
  getTransfer(transferId: TransferId): Promise<BridgeTransfer>;
  releaseAsset(transferId: TransferId): Promise<unknown>;
  registerValidator(validatorId: string, publicKey: string,
    metadata?: Record<string, unknown>): Promise<unknown>;

  // 开发者激励
  createBugBounty(options: BugBountyOptions): IncentiveInfoFull;
  submitBugFix(bountyId: IncentiveId, agentId: AgentId,
    submission: BugFixSubmission): unknown;
  approveBugFix(bountyId: IncentiveId, submissionId: string,
    reviewerId: AgentId): unknown;
  createFeatureGrant(options: FeatureGrantOptions): IncentiveInfoFull;
  applyForGrant(grantId: IncentiveId, agentId: AgentId,
    application: GrantApplication): unknown;
  approveGrantApplication(grantId: IncentiveId, applicationId: string,
    reviewerId: AgentId): unknown;
  createChallenge(options: ChallengeOptions): IncentiveInfoFull;
  joinChallenge(challengeId: IncentiveId, agentId: AgentId): { challengeId: string; agentId: string; position: number };
  submitChallenge(challengeId: IncentiveId, agentId: AgentId,
    submission: ChallengeSubmission): unknown;
  recordPRReward(options: PRRewardOptions): IncentiveInfoFull;
  recordPayment(incentiveId: IncentiveId, agentId: AgentId, amount: number): unknown;
  getOpenIncentives(): IncentiveInfo[];
  getAllIncentives(filters?: { type?: IncentiveType; status?: IncentiveStatus }): IncentiveInfo[];
  getAgentRewards(agentId: AgentId): AgentRewards;
  getIncentiveStats(): IncentiveStats;

  // 治理
  createProposal(options: CreateProposalOptions): ProposalId;
  castVote(proposalId: ProposalId, agentId: AgentId, vote: VoteOption): boolean;
  getProposal(proposalId: ProposalId): ProposalInfo | null;
  getAllProposals(): ProposalInfo[];
  executeProposal(proposalId: ProposalId, executorId?: AgentId): unknown;

  // 水龙头
  faucetDrip(recipientAddress?: Address, amount?: number): Promise<FaucetResult>;

  // 健康
  checkHealth(): Promise<HealthCheck>;
  getMetrics(): Promise<MetricsData>;

  // 事件
  on(event: string, listener: (...args: unknown[]) => void): INexusGenesisSDK;
  once(event: string, listener: (...args: unknown[]) => void): INexusGenesisSDK;
  off(event: string, listener: (...args: unknown[]) => void): INexusGenesisSDK;
  subscribeToAgents(intervalMs?: number): () => void;
  subscribeToMarketplace(intervalMs?: number): () => void;
  startHeartbeat(intervalMs?: number): () => void;

  // 清理
  disconnect(): void;
}

declare const nexusGenesisSDK: INexusGenesisSDK;
export default nexusGenesisSDK;
export { NexusGenesisSDK as NexusGenesisSDKType };
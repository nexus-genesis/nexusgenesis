declare module '@nexusgenesis/sdk' {
  interface NexusGenesisConfig {
    baseURL?: string;
    apiKey?: string;
    timeout?: number;
  }

  interface ApiKeyResult {
    keyId: string;
    apiKey: string;
    tier: string;
    limits?: object;
  }

  interface BalanceResult {
    address: string;
    balance: number;
    tokenSymbol?: string;
  }

  interface TransactionResult {
    hash: string;
    from: string;
    to: string;
    amount: number;
    status: string;
    timestamp?: number;
  }

  interface BlockResult {
    height: number;
    hash: string;
    previousHash: string;
    timestamp: number;
    transactions: TransactionResult[];
  }

  interface BridgeTransferParams {
    fromChain: string;
    toChain: string;
    asset: string;
    amount: number;
    recipient: string;
  }

  interface MarketplaceListing {
    id: string;
    title: string;
    description: string;
    price: number;
    agentId?: string;
    seller: string;
    status: string;
  }

  interface Workflow {
    id: string;
    name: string;
    status: string;
    tasks: object[];
    createdAt: string;
  }

  interface OraclePriceResult {
    success: boolean;
    data?: {
      price: number;
      pair: string;
      timestamp: number;
      confidence?: number;
    };
    message?: string;
  }

  class NexusGenesisError extends Error {
    status: number;
    data: any;
  }

  class NexusGenesisClient {
    constructor(config?: NexusGenesisConfig);
    
    baseURL: string;
    apiKey: string | null;
    timeout: number;
    
    get(path: string): Promise<any>;
    post(path: string, body: any): Promise<any>;
    
    health(): Promise<any>;
    metrics(): Promise<any>;
    
    generateApiKey(owner: string, tier: string): Promise<ApiKeyResult>;
    revokeApiKey(keyId: string): Promise<any>;
    getApiKeys(): Promise<any>;
    getApiKeyStats(): Promise<any>;
    
    getStatus(): Promise<any>;
    getBalance(address: string): Promise<BalanceResult>;
    getTransaction(txHash: string): Promise<TransactionResult>;
    sendTransaction(tx: object): Promise<TransactionResult>;
    getBlock(height: number): Promise<BlockResult>;
    getBlocks(page?: number, limit?: number): Promise<BlockResult[]>;
    
    createWallet(): Promise<any>;
    importWallet(privateKey: string): Promise<any>;
    getWalletInfo(address: string): Promise<any>;
    getWalletBalance(address: string): Promise<BalanceResult>;
    getWalletTransactions(address: string, page?: number, limit?: number): Promise<TransactionResult[]>;
    
    deployContract(code: string, params?: object): Promise<any>;
    callContract(address: string, method: string, args?: any[]): Promise<any>;
    getContract(address: string): Promise<any>;
    listContracts(page?: number, limit?: number): Promise<any>;
    
    deployAINVM(config: object): Promise<any>;
    executeAINVM(address: string, input: any): Promise<any>;
    getAINVMStatus(address: string): Promise<any>;
    
    bridgeTransfer(params: BridgeTransferParams): Promise<any>;
    bridgeStatus(txHash: string): Promise<any>;
    bridgeInfo(): Promise<any>;
    
    faucetEligibility(address: string): Promise<any>;
    faucetDrip(address: string): Promise<any>;
    faucetStats(): Promise<any>;
    
    discoverySearch(query: string): Promise<any>;
    discoveryTaskMatch(params: object): Promise<any>;
    discoveryStats(): Promise<any>;
    
    marketplaceListings(page?: number, limit?: number): Promise<MarketplaceListing[]>;
    createMarketplaceListing(listing: object): Promise<any>;
    getMarketplaceListing(id: string): Promise<MarketplaceListing>;
    marketplaceStats(): Promise<any>;
    
    registerAgent(agent: object): Promise<any>;
    getAgents(): Promise<any>;
    agentHeartbeat(agentId: string): Promise<any>;
    
    systemStatus(): Promise<any>;
    nodeMetrics(): Promise<any>;
    governanceMetrics(): Promise<any>;
    
    createWorkflow(workflow: object): Promise<Workflow>;
    getWorkflow(id: string): Promise<Workflow>;
    listWorkflows(): Promise<Workflow[]>;
  }

  export { NexusGenesisClient, NexusGenesisError };
  export default NexusGenesisClient;
}
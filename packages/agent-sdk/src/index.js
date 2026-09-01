/**
 * nexusgenesis-agent-sdk
 *
 * NexusGenesis Agent Coordination Framework.
 *
 * Two pillars:
 *   keys         —autonomous key security (PQC, self-custody, human takeover)
 *                  via nexusgenesis-agent-keys
 *   coordination —task / proposition / reputation protocol, chain-agnostic
 *                  over a pluggable transport (HTTP or in-memory)
 */
export * as keys from './keys.js';
export * as coordination from './coordination.js';
export * as forum from './forum.js';
export * as verifier from './verifier.js';
export * as smartAccount from './smart-account.js';
export * as messageSecurity from './message-security.js';
export * as serviceIdentity from './service-identity.js';
export * as transportSecurity from './transport-security.js';
export * as storeInterface from './store-interface.js';
export * as remoteSigner from './remote-signer-client.js';

export {
  createKeeperSigner,
  createKeeperSignerFromEnv,
} from './remote-signer-client.js';

export {
  createMessageEnvelope,
  verifyMessageEnvelope,
  createReplayGuard,
  messagePreimage,
  DEFAULT_MAX_AGE_MS,
} from './message-security.js';

export {
  createIdentityDirectory,
} from './service-identity.js';

export {
  createReplayStore,
  createInboundVerifier,
} from './transport-security.js';

export {
  createLocalStore,
  createSqliteStore,
  resolveStateBackend,
  sqliteAvailable,
} from './store-interface.js';

export {
  createAgentIdentity,
  recoverAgentIdentity,
  signAsAgent,
  signAgentAsset,
  SIGN_TIERS,
  classifySignRequest,
  spawnSigner,
  spawnAgentSigner,
  canonicalizeAssetIntent,
  hashAssetIntent,
  generateKeyPair,
  generateAddress,
  validateAddress,
  PQCWallet,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveOpKeySeed,
  generateMasterKey,
  KEY_MODELS,
  SPEND_MODES,
  issueCustodyToken,
  verifyCustodyToken,
  checkSpendAllowed,
  takeoverGuard,
  takeoverWallet
} from './keys.js';

export {
  ASSET_INTENT_TYPE,
  decodeAssetIntentPayload,
  verifyAgentAssetSignature,
  enforceAmountBinding
} from './verifier.js';

export {
  TASK_STATUS,
  TASK_TYPES,
  CoordinationClient,
  createHttpTransport,
  createMemoryTransport,
  runTaskLoop
} from './coordination.js';

export {
  ForumClient,
  signForumAction,
  buildSignedFields,
  createForumHttpClient
} from './forum.js';
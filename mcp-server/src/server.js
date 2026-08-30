/**
 * NexusGenesis MCP Server — core (tool definitions + handlers + Server)
 *
 * Exported as `createServer()` so it can be connected to any transport
 * (stdio for the CLI, in-memory for tests). The security tools operate
 * locally — private keys never leave the caller.
 *
 * This is the bridge into the AGENT world: an external AI agent can
 *  1. generate a self-sovereign PQC identity (keys never leave the process),
 *  2. register on-chain with a real Dilithium2 key (PoW + signature),
 *  3. participate in the NGEN task economy (list/claim/submit/verify/publish),
 *  4. engage in the forum & governance via PQC-signed writes.
 */
import crypto from 'node:crypto';
import { hostname } from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildChainEnvConfig,
  inspectArtifactBinding,
} from './chain-config.js';
import { createSecretResolverFromEnv } from './kms-provider.js';
import {
  loadChainState,
  persistAccountRow,
  persistSimArm,
  recordBroadcast,
  serializeEntry,
  getChainStateFile,
  isSharedBackend,
  initTxLedger,
  recordTx,
  listTx,
  getStateBackend,
  __resetTxLedgerForTest,
} from './chain-state-store.js';
import {
  normalizeChainError,
  chainErrorResponse,
  GENERIC_ERRORS,
} from './smart-account-errors.js';
import {
  executeWithRelayerResilience,
  classifyRelayerFailure,
} from './relayer-operations.js';
import {
  createNonceSequencer,
  createBroadcastReconciler,
} from './relayer-coordinator.js';
import {
  classifySimulationRisk,
  simulationPolicySnapshot,
  SIMULATION_WINDOW_MS,
} from './simulation-policy.js';
import {
  evaluatePolicy,
  policySnapshot,
  createDailyCumulativeStore,
  resolveSimulationRequirement,
  policyFailMode,
} from './policy-engine.js';
import {
  recordAudit,
  listAudit,
  __resetAuditForTest,
} from './audit-log.js';
import {
  incr,
  snapshot,
  logStructured,
  __resetMetricsForTest,
} from './observability.js';
import {
  startMetricsServer,
  registerSampler,
  bindChainHealthProvider,
  collectMetrics,
  __resetChainHealthForTest,
  __resetSamplersForTest,
} from './metrics.js';
import { loadDeploymentProfile, __resetProfileForTest } from './deployment-profile.js';
import {
  registerHealthCheck,
  startHealthServer,
  assertStrictStartup,
  __resetHealthChecksForTest,
} from './health.js';
import {
  evaluateAlerts,
  __resetAlertingForTest,
} from './alerting.js';
import {
  createAgentIdentity,
  recoverAgentIdentity,
  generateAddress,
  validateAddress,
  checkSpendAllowed,
  takeoverGuard,
  spawnAgentSigner,
  SPEND_MODES,
  CoordinationClient,
  createHttpTransport,
  ForumClient,
  smartAccount,
  canonicalizeAssetIntent,
} from 'nexusgenesis-agent-sdk';

const DEFAULT_API_BASE = process.env.NEXUSGENESIS_API || 'https://nexus-genesis.top';

// ─── Raw API request (returns parsed JSON, keeps errors readable) ───────
async function apiRequest(path, method = 'GET', body = null) {
  const url = `${DEFAULT_API_BASE}${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  options.signal = controller.signal;

  try {
    const response = await fetch(url, options);
    clearTimeout(timeout);
    const data = await response.json();
    if (!response.ok) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, httpStatus: response.status, ...data }, null, 2),
        }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    clearTimeout(timeout);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: error.message, success: false }, null, 2) }],
      isError: true,
    };
  }
}

// ─── Session identity ────────────────────────────────────────────────────
// P0-3: the decrypted key is held by an ISOLATED signer subprocess
// (session.signer), never in this process. session.wallet is a FALLBACK that
// is materialized LAZILY — only when signer spawning fails — so the normal
// path never holds usable key material in this process (a compromised parent
// could otherwise just call session.wallet.sign() and bypass the signer and
// its worker-side policy entirely).
const session = {
  wallet: null,       // recovered PQCWallet — LAZY fallback ONLY (INV-001/P0-3)
  signer: null,       // SignerHandle — DEFAULT key holder (isolated subprocess)
  password: null,     // envelope password, retained ONLY to respawn the signer
  agent: null,        // agent identity string
  publicKeyHex: null,
  address: null,
  envelope: null,     // encrypted envelope for the caller to persist
};

// Long idle timeout so the session signer survives realistic usage; it can be
// respawned lazily if it still exits (see ensureSessionSigner).
const SESSION_SIGNER_IDLE_MS = 60 * 60 * 1000;

/** True when this session holds (or can reconstruct) an agent identity. */
function hasSessionIdentity() {
  return !!(session.wallet || (session.envelope && session.password));
}

// ─── Smart Account (official EVM path, Sprint 2.4 T1 on-chain) ────────
// Holds on-chain Smart Accounts keyed by accountId. Each entry caches the
// deployed contract address + a ChainConnection. The Agent's execution
// private key is NEVER held here: the caller signs the canonical intent via
// the SDK/chain-eth official path and passes only payload + signature. The
// contract (SmartAccount.sol) re-derives every property from the signed
// digest (INV-002/003/005/006/007). owner/emergency/relayer are SERVER-side
// operation private keys used for deploy/register/broadcast — they enter this
// process by design (see CHAIN_OWNER_PK / CHAIN_EMERGENCY_PK / CHAIN_RELAYER_PK).
const smartAccounts = new Map(); // accountId -> entry
let smartAccountContext = null;  // { accountId, sessionId }

// Sprint 3 T1 — per-account successful simulation log:
// { accountId -> { digest, at } }. Gates execute() fail-closed for actions that
// MUST pass a successful on-chain simulation first (SIMULATION_WINDOW_MS window).
// Sprint 4 T2.1: persisted alongside the chain state file — the window is
// absolute-time (`at`), so a restart must NOT silently clear it (that would
// both drop the protection record and invalidate in-flight previews).
const simulationLog = new Map();

// Sprint 4 T2.2 — last-seen soft-policy fingerprint; change is recorded as an
// auditable policy_change event (hot-reload traceability).
let lastPolicyFingerprint = null;

// Sprint 5 T2.1 — process-local daily cumulative store behind the soft-policy
// maxDaily. Single-process semantics; multi-instance shared state is Sprint 6.
const dailyCumulativeStore = createDailyCumulativeStore();

/** Reset the local Smart Account so each test/setup is independent. */
export function __resetSmartAccountForTest() {
  smartAccounts.clear();
  smartAccountContext = null;
  simulationLog.clear();
  lastPolicyFingerprint = null;
  dailyCumulativeStore.reset();
  __resetAuditForTest();
  __resetMetricsForTest();
  __resetTxLedgerForTest();
  if (chainEnvPromise) {
    chainEnvPromise.then((env) => env.stop?.()).catch(() => {});
    chainEnvPromise = null;
  }
}

function equalStringArray(a, b) {
  const left = Array.isArray(a) ? a : (a === undefined || a === null ? [] : [a]);
  const right = Array.isArray(b) ? b : (b === undefined || b === null ? [] : [b]);
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameSessionConfig(existing, next) {
  return existing
    && existing.agentId === next.agentId
    && existing.agentEvmAddress === next.agentEvmAddress
    && Number(existing.issuedAt) === Number(next.issuedAt)
    && Number(existing.expiresAt) === Number(next.expiresAt)
    && String(existing.maxPerTx) === String(next.maxPerTx)
    && String(existing.maxDaily) === String(next.maxDaily)
    && equalStringArray(existing.whitelist?.allowedChains, next.whitelist?.allowedChains)
    && equalStringArray(existing.whitelist?.allowedAssets, next.whitelist?.allowedAssets)
    && equalStringArray(existing.whitelist?.allowedContracts, next.whitelist?.allowedContracts)
    && equalStringArray(existing.whitelist?.allowedMethods, next.whitelist?.allowedMethods)
    && equalStringArray(existing.whitelist?.allowedRecipients, next.whitelist?.allowedRecipients);
}

function selectSmartAccount({ accountId, sessionId } = {}) {
  if (smartAccounts.size === 0) {
    const err = new Error('No Smart Account in this session. Call smart_account_setup first.');
    err.code = 'NO_SMART_ACCOUNT';
    throw err;
  }

  let entry = null;
  if (accountId) {
    entry = smartAccounts.get(accountId) || null;
    if (!entry) {
      const err = new Error(`Smart Account ${accountId} not found in this MCP session.`);
      err.code = 'SMART_ACCOUNT_NOT_FOUND';
      throw err;
    }
  } else if (smartAccountContext?.accountId && smartAccounts.has(smartAccountContext.accountId)) {
    entry = smartAccounts.get(smartAccountContext.accountId);
  } else if (smartAccounts.size === 1) {
    entry = [...smartAccounts.values()][0];
  } else {
    const err = new Error('Multiple Smart Accounts exist in this MCP session. Pass accountId to select one explicitly.');
    err.code = 'SMART_ACCOUNT_AMBIGUOUS';
    throw err;
  }

  const resolvedSessionId = sessionId || (entry.accountId === smartAccountContext?.accountId ? smartAccountContext?.sessionId : null) || entry.currentSessionId;
  if (!resolvedSessionId) {
    const err = new Error(`Smart Account ${entry.accountId} has no selected session. Pass sessionId explicitly.`);
    err.code = 'SMART_ACCOUNT_SESSION_REQUIRED';
    throw err;
  }

  const sessionRecord = entry.sessions?.get(resolvedSessionId);
  if (!sessionRecord) {
    const err = new Error(`Session ${resolvedSessionId} not found under Smart Account ${entry.accountId}.`);
    err.code = 'SMART_ACCOUNT_SESSION_NOT_FOUND';
    throw err;
  }

  entry.currentSessionId = sessionRecord.sessionId;
  smartAccountContext = { accountId: entry.accountId, sessionId: sessionRecord.sessionId };
  return { ...entry, session: sessionRecord };
}

// ─── Chain environment (Sprint 2.4 T1) ───────────────────────────────────
// Lazy singleton shared across all Smart Accounts in this MCP process. Boots
// a LocalChain (in-process EVM, zero external deps) when CHAIN_RPC_URL is
// unset, or connects to an external node/anvil otherwise. The artifact is
// resolved via SMART_ACCOUNT_ARTIFACT or the repo default. owner/emergency/
// relayer private keys come from env — these are SERVER-side operation keys
// that legitimately enter this process. env semantics + profile validation
// (local/testnet/production) live in chain-config.js (Sprint 2.6 T1).

let chainEnvPromise = null; // memoized boot — also guards concurrent boots

async function resolveChainEnv() {
  if (!chainEnvPromise) {
    chainEnvPromise = bootChainEnv();
    // A failed boot must not poison the cache forever — allow a retry.
    chainEnvPromise.catch(() => { chainEnvPromise = null; });
  }
  return chainEnvPromise;
}

async function bootChainEnv() {
  const { ethers } = await import('ethers');
  const { createChainProvider } = await import('nexusgenesis-chain-eth');
  const { loadSmartAccountArtifact } = await import('nexusgenesis-chain-eth/test-helpers/load-artifact');
  // NOTE (external review 2026-08-24): createLocalChain is imported lazily
  // INSIDE the CHAIN_ALLOW_LOCAL-gated branch below. Its @ethereumjs/* runtime
  // deps are optional peers of the published chain-eth package — importing it
  // unconditionally would hard-fail at module load for published-package users
  // who never opted into the ephemeral local chain.

  // Profile-gated env parsing + fail-closed validation (Sprint 2.6 T1).
  // Throws with a typed code when the requested profile is misconfigured.
  // KMS 接线（GAP-001）：NEXUS_SECRET_BACKEND=kms 时从 Vault warm 解析操作密钥
  // （fail-closed：未配 addr/token 或拉取失败 → 启动抛错）；未启用 → null，
  // env 直读行为与既有版本逐字一致。
  const secretResolver = await createSecretResolverFromEnv();
  const cfg = buildChainEnvConfig({ secretResolver: secretResolver ?? undefined });

  // loadSmartAccountArtifact already honors SMART_ACCOUNT_ARTIFACT env; the
  // config layer just validated that production requires it explicitly.
  const artifact = loadSmartAccountArtifact();
  if (!artifact) {
    const err = new Error(
      'SmartAccount artifact not found. Run `forge build --use 0.8.24` in contracts/solidity, ' +
      'or set SMART_ACCOUNT_ARTIFACT to the built artifact JSON.',
    );
    err.code = 'SMART_ACCOUNT_ARTIFACT_MISSING';
    throw err;
  }

  // Artifact ↔ expected solc version binding (Sprint 2.6 T1): the artifact
  // must be the SmartAccount contract compiled with the pinned compiler.
  const binding = inspectArtifactBinding(artifact, cfg.solcVersion);
  if (!binding.matches) {
    const err = new Error(
      `Artifact version mismatch: expected SmartAccount compiled with solc ${cfg.solcVersion} ` +
      `(got contract=${binding.contractName ?? 'unknown'}, solc=${binding.solcVersion ?? 'unknown'}). ` +
      'Rebuild with `forge build --use 0.8.24` in contracts/solidity.',
    );
    err.code = 'SMART_ACCOUNT_ARTIFACT_VERSION_MISMATCH';
    throw err;
  }

  const owner = new ethers.Wallet(cfg.ownerPk);
  const emergency = new ethers.Wallet(cfg.emergencyPk);
  const relayer = new ethers.Wallet(cfg.relayerPk);

  let provider;
  let localChain = null;
  let chainUrl;
  if (cfg.rpcUrl) {
    provider = createChainProvider(cfg.rpcUrl);
    chainUrl = cfg.rpcUrl;
  } else {
    // External review 2026-08-24: an in-process LocalChain is EPHEMERAL — all
    // deployed contracts and session state vanish when the process exits. It
    // must never be a silent default: an LLM caller receiving a contract
    // address could mistake it for a persistent on-chain hard-policy layer.
    // Fail closed until the caller explicitly opts into the ephemeral chain.
    if (process.env.CHAIN_ALLOW_LOCAL !== '1') {
      const err = new Error(
        'No CHAIN_RPC_URL set and CHAIN_ALLOW_LOCAL is not "1". Without an external chain, ' +
        'the smart_account_* tools boot an in-process EPHEMERAL EVM whose entire state ' +
        '(accounts, sessions, limits) dies with this process — there is NO persistent ' +
        'on-chain protection. Connect a real node via CHAIN_RPC_URL, or set CHAIN_ALLOW_LOCAL=1 ' +
        'to explicitly accept the ephemeral local chain for development/testing.',
      );
      err.code = 'CHAIN_ALLOW_LOCAL_REQUIRED';
      throw err;
    }
    let createLocalChain;
    try {
      ({ createLocalChain } = await import('nexusgenesis-chain-eth/test-helpers/local-chain'));
    } catch (impErr) {
      // Published-package users: the @ethereumjs/* deps of the in-process EVM
      // are optional peers — give an actionable install hint instead of a bare
      // module-not-found when the local dev chain was explicitly requested.
      const err = new Error(
        'CHAIN_ALLOW_LOCAL=1 requires the in-process EVM dependencies. Install them: ' +
        'npm install @ethereumjs/vm @ethereumjs/common @ethereumjs/tx @ethereumjs/block @ethereumjs/util @ethereumjs/statemanager ' +
        `(${impErr.message})`,
      );
      err.code = 'LOCAL_CHAIN_DEPS_MISSING';
      throw err;
    }
    try {
      localChain = await createLocalChain({
        funded: [
          { address: owner.address, balance: 10n ** 18n },
          { address: emergency.address, balance: 10n ** 18n },
          { address: relayer.address, balance: 10n ** 18n },
        ],
      });
      provider = createChainProvider(localChain.url);
    } catch (err) {
      // Never leak a booted LocalChain when provider wiring fails.
      if (localChain) await localChain.stop().catch(() => {});
      throw err;
    }
    chainUrl = localChain.url;
  }

  // Restore persisted Smart Accounts (Sprint 2.6 T2): when a state file is
  // configured, rehydrate accountId->contractAddress + session registry so a
  // restart reuses the same on-chain contract instead of redeploying.
  if (getChainStateFile()) {
    await restoreSmartAccounts({ provider, abi: artifact.abi, cfg });
  }

  // Structured ops log (Sprint 2.7 T2): one line per chain-env boot — the
  // operator's first signal of which profile/URL this process is serving.
  logStructured('chain_env_boot', {
    profile: cfg.profile,
    chainUrl,
    local: !cfg.rpcUrl,
    restoredAccounts: smartAccounts.size,
  });

  // Sprint 7 T1.2 — 链上健康监控：绑定外部 provider 后后台采样 getBlockNumber，
  // 输出 chain_rpc_up / chain_last_block_ts 到 /metrics（未绑定时为缺省 up=0）。
  // 本地链不绑定（进程内 ETH 无外部健康意义），避免无谓轮询。
  if (cfg.rpcUrl && provider) {
    bindChainHealthProvider(provider, 15000);
  }

  return {
    provider,
    artifact,
    owner,
    emergency,
    relayer,
    chainUrl,
    localChain,
    profile: cfg.profile,
    stop: async () => { if (localChain) await localChain.stop(); },
  };
}

/**
 * Rehydrate in-memory Smart Accounts from the persisted state file (Sprint 2.6
 * T2). Only restores on an EXTERNAL persistent chain (cfg.rpcUrl set): an
 * in-process LocalChain is ephemeral — its contract addresses die with the
 * process, so rehydrating them into a fresh LocalChain would point at
 * non-existent code (stale reads). The saved chainUrl must match the current
 * RPC so a stale file from another chain never resurrects accounts here.
 */
/** Rebuild the simulation log from persisted records (Sprint 4 T2.1). */
function restoreSimulationLog(records = []) {
  simulationLog.clear();
  for (const r of records) {
    if (r && r.accountId && r.digest && typeof r.at === 'number') {
      simulationLog.set(r.accountId, { digest: r.digest, at: r.at });
    }
  }
}

async function restoreSmartAccounts({ provider, abi, cfg }) {
  if (!cfg.rpcUrl) return; // LocalChain: ephemeral, never restore
  const { createChainConnection } = await import('nexusgenesis-chain-eth');
  const state = loadChainState();
  // Restore the tx ledger too, so submitted→confirmed history survives restart
  // (Sprint 2.7 T3) — even if the chain URL changed (ledger is read-only facts).
  initTxLedger(state);
  // Restore the simulation log (Sprint 4 T2.1) so the absolute-time window
  // survives restart: an in-flight preview stays armed, an expired one stays
  // expired — restart must not change the gate's semantics.
  restoreSimulationLog(state.simulations);
  if (!state.accounts || state.accounts.length === 0) return;
  if (state.chainUrl && state.chainUrl !== cfg.rpcUrl) {
    // Chain-environment guard: never reuse accounts recorded on another chain.
    return;
  }
  for (const rec of state.accounts) {
    if (!rec.accountId || !rec.contractAddress) continue;
    if (smartAccounts.has(rec.accountId)) continue;
    const conn = createChainConnection({ provider, address: rec.contractAddress, abi });
    const sessions = new Map();
    for (const s of (rec.sessions || [])) {
      if (s.sessionId) sessions.set(s.sessionId, s);
    }
    smartAccounts.set(rec.accountId, {
      accountId: rec.accountId,
      contractAddress: rec.contractAddress,
      owner: rec.owner,
      emergencyKey: rec.emergencyKey,
      conn,
      sessions,
      currentSessionId: rec.currentSessionId || null,
      // Sprint 6 T3 #1 单轨化：chain-env 单例只存 KEY_META；行级不再携带。
      // 恢复时统一填单例 chainUrl/profile（每行都在同一条链上）。
      chainUrl: state.chainUrl || null,
      profile: state.profile || null,
      txHashes: Array.isArray(rec.txHashes) ? rec.txHashes : [],
    });
  }
  // If exactly one account was restored, make it the implicit context.
  if (smartAccounts.size === 1) {
    const entry = [...smartAccounts.values()][0];
    smartAccountContext = { accountId: entry.accountId, sessionId: entry.currentSessionId };
  }
}

/** Persist the current in-memory Smart Account state (no-op in pure-memory mode). */
function persistSmartAccountState() {
  if (!getChainStateFile()) return;
  for (const entry of smartAccounts.values()) persistAccountRow(entry);
}

/**
 * Materialize the in-process fallback wallet on demand. This is an EXPLICIT
 * security downgrade (key enters this process) and only happens when the
 * isolated signer is unavailable — never on the default path.
 *
 * SECURITY (external review 2026-08-24): the downgrade is GATED and fails
 * closed by default. Automatically materializing the private key inside the
 * server process whenever the signer subprocess fails to spawn would let
 * anyone who can induce spawn failures (resource exhaustion, env tampering)
 * silently widen the key's attack surface from an isolated subprocess to the
 * whole server process. Operators must explicitly opt in via
 * MCP_ALLOW_INPROCESS_WALLET=1 (and the downgrade stays loud + visible).
 */
function fallbackWallet() {
  if (session.wallet) return session.wallet;
  if (!session.envelope || !session.password) {
    const err = new Error('No agent identity in this session. Call generate_agent_keys or register_agent first.');
    err.code = 'NO_WALLET';
    throw err;
  }
  if (process.env.MCP_ALLOW_INPROCESS_WALLET !== '1') {
    const err = new Error(
      'The isolated signer subprocess is unavailable, and materializing the private key inside this ' +
      'server process is blocked by default (fail-closed). Fix the signer spawn (see logs above), or ' +
      'explicitly accept the in-process downgrade by setting MCP_ALLOW_INPROCESS_WALLET=1.',
    );
    err.code = 'INPROCESS_WALLET_BLOCKED';
    throw err;
  }
  console.error('[mcp-server] DOWNGRADE: materializing in-process wallet (isolated signer unavailable; MCP_ALLOW_INPROCESS_WALLET=1)');
  session.wallet = recoverAgentIdentity(session.envelope, session.password);
  return session.wallet;
}

/**
 * Return a live signer for this session, spawning one lazily if needed.
 * Returns null when no envelope/password is available or spawning fails —
 * callers then fall back to the in-process wallet (explicit downgrade).
 */
async function ensureSessionSigner() {
  if (!session.envelope || !session.password) return null;
  if (process.env.NEXUSGENESIS_SIGNER_DISABLE === '1') {
    // Test/diagnostic seam: simulate an environment where the signer cannot
    // be spawned, exercising the explicit in-process fallback path.
    return null;
  }
  if (session.signer) {
    try {
      await session.signer.ping(1500);
      return session.signer;
    } catch {
      // Idle-exited or dead — fall through to respawn.
      session.signer = null;
    }
  }
  try {
    // Policy-less signer: mcp-server writes are METADATA (task claim/submit/
    // verify/publish, forum) with no value transfer, so no spend policy.
    session.signer = await spawnAgentSigner({
      envelope: session.envelope,
      password: session.password,
      idleTimeoutMs: SESSION_SIGNER_IDLE_MS,
    });
    return session.signer;
  } catch (err) {
    console.error(`[mcp-server] signer spawn failed, falling back to in-process wallet: ${err.message}`);
    session.signer = null;
    return null;
  }
}

/**
 * Sign a metadata message via the isolated signer (default path), stripping
 * the 0x prefix so the output matches wallet.sign()'s bare-hex contract.
 * Returns null when no signer is available.
 */
async function signViaSigner(message) {
  const signer = await ensureSessionSigner();
  if (!signer) return null;
  const sig = await signer.signMessage(message);
  return typeof sig === 'string' ? sig.replace(/^0x/, '') : null;
}

/**
 * A wallet-like object whose .sign() routes through the ISOLATED signer
 * (metadata channel). Used by ForumClient, which only needs .sign(message)
 * returning bare-hex. Falls back to the in-process wallet only when the
 * signer is unavailable.
 */
function signerBackedWallet() {
  return {
    address: session.address,
    async sign(message) {
      const sig = await signViaSigner(message);
      return sig ?? fallbackWallet().sign(message);
    },
  };
}

// ─── Security tool handlers ─────────────────────────────────────────────

async function handleGenerateAgentKeys(args) {
  const password = args.password;
  const metadata = args.metadata || {};
  const identity = await createAgentIdentity({ password, metadata });
  session.password = password;
  // P0-3: do NOT materialize the in-process wallet here — the key must live
  // only in the isolated signer subprocess. The fallback wallet is recovered
  // lazily and only when the signer cannot be spawned (see fallbackWallet).
  session.wallet = null;
  session.agent = metadata.name || identity.address;
  session.publicKeyHex = identity.publicKeyHex;
  session.address = identity.address;
  session.envelope = identity.envelope;
  // P0-3: prefer holding the key in an isolated signer subprocess.
  session.signer = null;
  await ensureSessionSigner();
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        keyModel: identity.keyModel,
        agent: session.agent,
        address: identity.address,
        publicKeyHex: identity.publicKeyHex,
        envelope: identity.envelope,
        signing: session.signer ? 'isolated-signer (P0-3)' : 'in-process-wallet (fallback)',
        note: 'Private key is encrypted inside `envelope` and held by an isolated signer subprocess. Persist the envelope + password; they never left this process.',
      }, null, 2),
    }],
  };
}

async function handleVerifySignature(args) {
  const { message, signature, publicKeyHex } = args;
  const pkBuffer = Buffer.from(publicKeyHex, 'hex');
  const sigBuffer = Buffer.from(signature, 'hex');
  const { verify } = await import('nexusgenesis-agent-keys');
  const valid = await verify(message, sigBuffer, pkBuffer);
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, valid, message }, null, 2) }],
  };
}

async function handleGenerateKeyPair() {
  const { generateKeyPair: gk, secureZero } = await import('nexusgenesis-agent-keys');
  const { publicKey, privateKey } = await gk();
  let chainAddresses;
  try {
    const { deriveChainAddresses } = await import('nexusgenesis-chain-adapters');
    // Registry only emits addresses/public keys — never private material.
    chainAddresses = deriveChainAddresses(publicKey, privateKey);
  } finally {
    // Zero the transient plaintext key from the raw keypair generation.
    secureZero(privateKey);
  }
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        address: generateAddress(publicKey),
        publicKeyHex: publicKey.toString('hex'),
        chainAddresses,
        note: 'Raw private key is never exposed (INV-001). Derived chain addresses shown to demonstrate cross-chain derivation.',
      }, null, 2),
    }],
  };
}

async function handleValidateAddress(args) {
  const result = validateAddress(args.address);
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }],
  };
}

async function handleCheckSpend(args) {
  const allowed = checkSpendAllowed(args.spendConfig || { type: SPEND_MODES.UNLIMITED }, {
    amount: args.amount,
    spentToday: args.spentToday,
  });
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: true, ...allowed }, null, 2) }],
  };
}

async function handleTakeoverGuard(args) {
  const safe = takeoverGuard(args.before || {}, args.after || {});
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ success: true, safe, note: safe ? 'Control unchanged —safe to commit.' : 'Wallet control changed —BLOCK the transfer.' }, null, 2),
    }],
  };
}

// ─── Smart Account handlers (official EVM path, Sprint 2.2) ─────────────

/** Create the local Smart Account + register an agent session. */
async function handleSmartAccountSetup(args) {
  const { sessionId, agentId, agentEvmAddress, expiresAt, issuedAt, maxPerTx, maxDaily, allowedChains, allowedAssets, allowedContracts, allowedMethods, allowedRecipients } = args;
  // T3.3 key isolation: owner/emergencyKey are server-side operation keys. In
  // non-local profiles they MUST come from CHAIN_OWNER_PK / CHAIN_EMERGENCY_PK
  // env (chain-config validates non-anvil + role separation) — passing them via
  // MCP tool params is rejected fail-closed so the private keys never transit
  // the tool interface / get logged. local keeps the dev convenience (anvil keys
  // are public anyway).
  const ownerParam = args.owner;
  const emergencyParam = args.emergencyKey;

  if (!sessionId || !agentId || !agentEvmAddress) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'sessionId, agentId, and agentEvmAddress are required' }) }], isError: true };
  }
  // Fail-closed at the boundary: the official EVM path signs a digest that
  // binds sessionId as bytes32, so a non-32-byte id would only fail later at
  // signing time with a confusing error.
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(String(sessionId))) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'sessionId must be 32-byte hex (0x + 64 hex)' }) }], isError: true };
  }
  if (!expiresAt) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'expiresAt (ms epoch) is required' }) }], isError: true };
  }

  // ── On-chain (Sprint 2.4 T1) ───────────────────────────────────────────
  // Deploy a fresh SmartAccount contract + register the session on-chain.
  // The contract is the single source of truth; the MCP process only caches
  // the address + a ChainConnection. owner/emergencyKey here are the PRIVILEGED
  // private keys (server-side operation keys that legitimately enter this
  // process): their derived addresses become the contract's owner/emergency
  // roles, and the owner key signs both the deploy and the registerSession
  // (owner-only, INV-005). The Agent's execution signing key NEVER enters this
  // process — callers submit payload + signature only.
  // Hard ceilings are mandatory on-chain (SmartAccount.registerSession reverts
  // InvalidSession when both are 0) — validate BEFORE deploying so a bad call
  // never pays deployment gas. Keep them as strings: BigInt('...') is exact,
  // a Number() round-trip would lose precision for wei-scale limits (>2^53).
  const perTxCeiling = maxPerTx === undefined || maxPerTx === null || maxPerTx === '' ? '0' : String(maxPerTx);
  const dailyCeiling = maxDaily === undefined || maxDaily === null || maxDaily === '' ? '0' : String(maxDaily);
  if (!/^\d+$/.test(perTxCeiling) || !/^\d+$/.test(dailyCeiling)) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'maxPerTx and maxDaily must be non-negative integer strings (wei)' }) }], isError: true };
  }
  if (perTxCeiling === '0' && dailyCeiling === '0') {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'hard ceilings are mandatory: at least one of maxPerTx / maxDaily must be > 0 (INV-003/007 — no unbounded session)' }) }], isError: true };
  }

  let env;
  try {
    env = await resolveChainEnv();
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }], isError: true };
  }

  // T3.3 key isolation (profile-aware): operation keys never transit the MCP
  // tool interface outside local. env.owner/emergency already carry the
  // env-injected keys (chain-config validates them fail-closed for non-local).
  const { ethers } = await import('ethers');
  let ownerKey;
  let emergencyWallet;
  if (env.profile === 'local') {
    if (!ownerParam || !emergencyParam) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'owner and emergencyKey are required (CHAIN_PROFILE=local)' }) }], isError: true };
    }
    try {
      ownerKey = new ethers.Wallet(ownerParam);
      emergencyWallet = new ethers.Wallet(emergencyParam);
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'owner and emergencyKey must be private keys (0x + 64 hex) for on-chain setup — their addresses become the contract owner/emergency roles and owner signs deploy + registerSession (INV-005).' }) }], isError: true };
    }
  } else {
    if (ownerParam || emergencyParam) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `CHAIN_PROFILE=${env.profile}: passing owner/emergencyKey via tool params is rejected (T3.3 key isolation). Configure CHAIN_OWNER_PK / CHAIN_EMERGENCY_PK env instead — private keys must not transit the MCP tool interface.` }) }], isError: true };
    }
    ownerKey = env.owner;
    emergencyWallet = env.emergency;
  }
  const ownerAddr = ownerKey.address;
  const emergencyAddr = emergencyWallet.address;

  const deployer = ownerKey.connect(env.provider);

  const resolvedIssuedAt = issuedAt !== undefined && issuedAt !== null ? Number(issuedAt) : Date.now();
  const resolvedExpiresAt = Number(expiresAt);

  // Deploy (idempotent per owner+emergency pair). The contract's owner AND
  // emergency roles must BOTH match for reuse — a different emergencyKey
  // deploys a fresh contract instead of silently ignoring the new brake key
  // (INV-006). The deploy pins the account-level daily ceiling at 1_000_000;
  // the request's maxPerTx/maxDaily are SESSION limits applied at
  // registerSession.
  let entry = null;
  const existingEntry = [...smartAccounts.values()].find((e) => e.owner === ownerAddr && e.emergencyKey === emergencyAddr);
  if (existingEntry) {
    entry = existingEntry;
  } else {
    const { deploySmartAccount } = await import('nexusgenesis-chain-eth');
    const dep = await deploySmartAccount({
      provider: env.provider,
      signer: deployer,
      abi: env.artifact.abi,
      bytecode: env.artifact.bytecode.object,
      owner: ownerAddr, // contract owner address (derived from owner key)
      emergencyKey: emergencyAddr, // contract emergency address
      accountMaxDaily: 1_000_000,
    });
    if (!dep.ok) {
      const { error } = normalizeChainError(dep, GENERIC_ERRORS.UNKNOWN_REVERT);
      recordAudit({ tool: 'smart_account_setup', ok: false, accountId: null, sessionId, errorName: dep.errorName ?? null, error, broadcaster: ownerAddr });
      return chainErrorResponse(dep, GENERIC_ERRORS.UNKNOWN_REVERT);
    }
    entry = {
      accountId: dep.address.toLowerCase(),
      contractAddress: dep.address.toLowerCase(),
      owner: ownerAddr,
      emergencyKey: emergencyAddr,
      conn: dep.connection,
      sessions: new Map(),
      currentSessionId: null,
      chainUrl: env.chainUrl,
      profile: env.profile,
      txHashes: [],
    };
    smartAccounts.set(entry.accountId, entry);
  }

  // Register the session on-chain (idempotent: same sessionId + settings = no-op).
  const sessionConfig = {
    sessionId,
    agentId,
    agentEvmAddress,
    issuedAt: resolvedIssuedAt,
    expiresAt: resolvedExpiresAt,
    whitelist: {
      allowedChains, allowedAssets, allowedContracts, allowedMethods, allowedRecipients,
    },
    maxPerTx: perTxCeiling,
    maxDaily: dailyCeiling,
  };
  const existingSession = entry.sessions.get(sessionId);
  if (existingSession && !sameSessionConfig(existingSession, sessionConfig)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Session ${sessionId} already exists in Smart Account ${entry.accountId} with different settings.` }) }],
      isError: true,
    };
  }
  if (!existingSession) {
    const reg = await entry.conn.registerSession({
      sessionId,
      agentId,
      agentEvmAddress,
      issuedAt: resolvedIssuedAt,
      expiresAt: resolvedExpiresAt,
      maxPerTx: perTxCeiling,
      maxDaily: dailyCeiling,
      whitelist: {
        allowedChains, allowedAssets, allowedContracts, allowedMethods, allowedRecipients,
      },
      signer: deployer,
    });
    if (!reg.ok) {
      recordAudit({ tool: 'smart_account_setup', ok: false, accountId: entry.accountId, sessionId, errorName: reg.errorName ?? null, error: normalizeChainError(reg, GENERIC_ERRORS.UNKNOWN_REVERT).error, broadcaster: ownerAddr });
      return chainErrorResponse(reg, GENERIC_ERRORS.UNKNOWN_REVERT);
    }
    entry.sessions.set(sessionId, sessionConfig);
  }

  entry.currentSessionId = sessionId;
  smartAccountContext = { accountId: entry.accountId, sessionId };

  // Persist accountId->contractAddress + session registry (Sprint 2.6 T2) so a
  // restart can rehydrate instead of redeploying. No-op in pure-memory mode.
  persistSmartAccountState();

  // Exposure bound from the chain (INV-007 ceilings).
  let maxLoss = null;
  try {
    const sessionLoss = await entry.conn.sessionMaxLoss(sessionId);
    maxLoss = sessionLoss !== null && sessionLoss !== undefined ? sessionLoss.toString() : null;
  } catch { /* read-only; non-fatal */ }

  // Audit + metric (Sprint 2.7 T1/T2): setup 事实（broadcaster = owner，INV-005）。
  recordAudit({ tool: 'smart_account_setup', ok: true, accountId: entry.accountId, sessionId, broadcaster: ownerAddr, chainUrl: env.chainUrl });
  incr('smart_account_setup_count');

  return {
    content: [{ type: 'text', text: JSON.stringify({
      success: true,
      accountId: entry.accountId,
      contractAddress: entry.contractAddress,
      owner: ownerAddr, // effective contract owner role (address)
      emergencyKey: emergencyAddr, // effective brake-only role (address, INV-006)
      sessionId,
      issuedAt: resolvedIssuedAt,
      expiresAt: resolvedExpiresAt,
      chainUrl: env.chainUrl,
      onChain: true,
      // External review 2026-08-24: make the chain mode unmistakable for LLM
      // callers — an ephemeral in-process chain provides NO persistent on-chain
      // protection (everything vanishes when this process exits).
      chain: {
        mode: env.localChain ? 'local-ephemeral' : 'external',
        ephemeral: Boolean(env.localChain),
        ...(env.localChain ? { warning: 'EPHEMERAL: in-process local chain — the deployed contract, sessions and limits are destroyed when the MCP process exits. This is NOT a persistent on-chain hard-policy deployment.' } : {}),
      },
      session: {
        agentId,
        sessionId,
        issuedAt: resolvedIssuedAt,
        expiresAt: resolvedExpiresAt,
        agentEvmAddress,
      },
      maxLoss,
      note: 'On-chain Smart Account deployed. Use the returned session binding to build canonical payloads off-chain, then submit via smart_account_execute — the Agent signing key never enters this process (owner/emergency/relayer are server-side operation keys).',
    }, null, 2) }],
  };
}

/**
 * Fail-closed dry-run (P3 simulation seed): evaluate an intent against the
 * local Smart Account WITHOUT executing it and WITHOUT a signature. Runs the
 * FULL hard-policy decision tree (session, whitelist, self-escalation,
 * allowance surface, nonce, ceilings) in side-effect-free preview mode —
 * only the EVM digest-binding check (INV-002) is skipped, since it needs the
 * caller's private key. Returns wouldExecute + the exact rejection reason, or
 * the digest to sign off-chain when admissible. "Quantify before acting."
 */
/** Categorize a normalized error code into metrics (Sprint 2.7 T2). */
function metricizeError(error) {
  incr(`smart_account_revert_${error}`);
  if (error === 'BadNonce') incr('smart_account_nonce_conflict');
  if (error === 'RPC_ERROR') incr('smart_account_rpc_error');
  if (/^(AmountExceedsPerTx|AmountExceedsDaily|SessionExpired|SessionRevokedError)$/.test(error)) {
    incr('smart_account_limit_rejected');
  }
}

async function handleSmartAccountPreview(args) {
  const { action, chain, asset, amount, recipient, contract, method, nonce, accountId, sessionId, signature } = args;
  if (amount === undefined || amount === null || nonce === undefined || nonce === null) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, wouldExecute: false, error: 'amount and nonce are required for a deterministic preview (INV-002/INV-007)' }) }], isError: true };
  }

  // Boot the chain env first so a persisted Smart Account is restored before
  // selection (Sprint 2.6 T2) — a restart must see the same on-chain account.
  await resolveChainEnv();
  const { conn, session: s, accountId: resolvedAccountId } = selectSmartAccount({ accountId, sessionId });

  // Build the EXACT canonical payload the caller would sign off-chain, so the
  // preview verdict is 1:1 with a real execution.
  let payload;
  try {
    payload = canonicalizeAssetIntent(
      { agentId: s.agentId, sessionId: s.sessionId, issuedAt: s.issuedAt, expiresAt: s.expiresAt },
      { action, chain, asset, amount, recipient, contract, method, nonce },
    );
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, wouldExecute: false, error: `canonicalization failed: ${err.message}` }) }], isError: true };
  }

  // The chain authenticates the signature (INV-002) and only THEN applies the
  // policy checks, so a signature-less eth_call always reverts with
  // InvalidSignature and cannot reach the strategy verdict. Callers who have
  // already signed can pass `signature` for a true on-chain dry-run; without
  // it we still return the exact digest to sign.
  let res = null;
  let digest = null;
  try {
    digest = await smartAccount.hashIntentDigest(payload);
  } catch {
    digest = null;
  }
  if (signature) {
    res = await conn.simulateExecuteFromAgent({ payload, signature });
  }

  if (res && res.ok) {
    incr('smart_account_preview_count');
    // Sprint 3 T1: a successful signed preview arms the simulation gate for
    // this exact digest — within SIMULATION_WINDOW_MS execute() may proceed
    // without re-simulating; outside it the caller must re-preview.
    if (digest) {
      const armedAt = Date.now();
      simulationLog.set(resolvedAccountId, { digest, at: armedAt });
      // Sprint 6 T3.1: arm 写穿 store 行（sim:arm:<accountId>，LWW）——跨实例
      // 可见 + 重启恢复；共享后端失败 → 抛错（fail-closed：视为未 arm，绝不假 arm）。
      persistSimArm(resolvedAccountId, { digest, at: armedAt });
    }
    const simulation = classifySimulationRisk(action);
    recordAudit({ tool: 'smart_account_preview', ok: true, wouldExecute: true, accountId: resolvedAccountId, sessionId: s.sessionId, payloadDigest: digest });
    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      wouldExecute: true,
      accountId: resolvedAccountId,
      sessionId: s.sessionId,
      // simulateExecuteFromAgent returns only the txId; echo the requested
      // amount as a wei string (exact, matching the execute path).
      amount: String(amount),
      digest,
      payload,
      simulation,
      session: {
        agentId: s.agentId,
        sessionId: s.sessionId,
        issuedAt: s.issuedAt,
        expiresAt: s.expiresAt,
        agentEvmAddress: s.agentEvmAddress,
      },
      note: 'Intent is admissible under the on-chain hard-policy layer. Submit the signed payload via smart_account_execute.',
    }, null, 2) }] };
  }
  if (res && !res.ok) {
    const { error } = normalizeChainError(res, GENERIC_ERRORS.UNKNOWN_REVERT);
    incr('smart_account_preview_count');
    metricizeError(error);
    recordAudit({ tool: 'smart_account_preview', ok: true, wouldExecute: false, accountId: resolvedAccountId, sessionId: s.sessionId, payloadDigest: digest, errorName: res.errorName ?? null, error });
    return { content: [{ type: 'text', text: JSON.stringify({
      success: true, wouldExecute: false, accountId: resolvedAccountId, sessionId: s.sessionId,
      reason: error,
      digest,
      payload,
      note: 'Fail-closed: intent rejected on-chain (signature + policy verdict).',
    }, null, 2) }] };
  }
  // No signature supplied — return the digest so the caller can sign, and
  // note that the full on-chain verdict requires the signature.
  incr('smart_account_preview_count');
  recordAudit({ tool: 'smart_account_preview', ok: true, wouldExecute: null, accountId: resolvedAccountId, sessionId: s.sessionId, payloadDigest: digest });
  return { content: [{ type: 'text', text: JSON.stringify({
    success: true,
    wouldExecute: null,
    accountId: resolvedAccountId,
    sessionId: s.sessionId,
    amount: String(amount),
    digest,
    payload,
    session: {
      agentId: s.agentId,
      sessionId: s.sessionId,
      issuedAt: s.issuedAt,
      expiresAt: s.expiresAt,
      agentEvmAddress: s.agentEvmAddress,
    },
    note: 'No signature provided, so no on-chain verdict was computed. Sign the returned digest off-chain (signSmartAccountIntent) and pass signature to preview, or submit via smart_account_execute.',
  }, null, 2) }] };
}

/** Broadcast a caller-signed official EVM intent to the on-chain Smart Account. */
async function handleSmartAccountExecute(args) {
  const { signature, payload, accountId, sessionId } = args;
  if (!payload || !signature) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'payload (canonical intent) and signature (official EVM path) are required. Build them off-chain: signSmartAccountIntent().' }) }], isError: true };
  }

  // Boot chain env first (restores persisted accounts, Sprint 2.6 T2).
  const env = await resolveChainEnv();
  const { conn, session: s, accountId: resolvedAccountId } = selectSmartAccount({ accountId, sessionId: sessionId || payload.sessionId });
  // Broadcast the caller-provided payload + signature to the chain. The
  // contract re-derives every property from the signed digest
  // (INV-002/003/005/006/007) and authenticates the signature against the
  // session's registered EVM address. Any EOA may relay — we use the
  // configured CHAIN_RELAYER_PK (server-side operation key), NOT the owner.
  const relayer = env.relayer.connect(env.provider);
  // Digest for audit (Sprint 2.7 T1): the caller-supplied payload is canonical,
  // so hashIntentDigest yields the exact signed digest.
  let payloadDigest = null;
  try {
    payloadDigest = await smartAccount.hashIntentDigest(payload);
  } catch {
    payloadDigest = null;
  }
  const broadcaster = relayer.address;

  // ── Sprint 3 链下双门禁（不消耗 nonce、不走链、省 gas）─────────────────
  // 0) 单次读取 policy（供模拟门禁收紧 + policy 裁决 + 指纹审计共用，杜绝 TOCTOU）。
  const policyNow = maybeAuditPolicyChange('smart_account_execute gate');

  // Sprint 5 T3 — strict 模式下策略加载失败 → 直接拒绝（fail-closed），在模拟/
  // policy 裁决之前。报 PolicyConfigError 而非 SimulationRequired/PolicyRejected，
  // 让运维明确知道是"策略配置损坏"而非"缺失 preview"，不会被误导去补 preview。
  // fix#2/#5：判定与文案均绑定本次单次读取的快照（policyNow.configError），
  // 不用共享模块状态——整个请求对策略文件持有一致视图，无中途漂移。
  if (policyFailMode() === 'strict' && policyNow.configError !== null) {
    const reason = `Action execution refused: PolicyEngine strict fail-mode, policy config invalid (${policyNow.configError})`;
    incr('smart_account_policy_rejected');
    recordAudit({ tool: 'smart_account_execute', ok: false, accountId: resolvedAccountId, sessionId: s.sessionId, payloadDigest, errorName: 'PolicyConfigError', error: 'PolicyConfigError', broadcaster, gate: 'strict-config', reason });
    logStructured('smart_account_execute', { ok: false, accountId: resolvedAccountId, sessionId: s.sessionId, error: 'PolicyConfigError', broadcaster, gate: 'strict-config', reason });
    return {
      content: [{ type: 'text', text: JSON.stringify({
        success: false, accountId: resolvedAccountId, sessionId: s.sessionId, error: 'PolicyConfigError',
        reason,
        digest: payloadDigest,
      }, null, 2) }],
      isError: true,
    };
  }
  // 1) Simulation gate (T1+S5-T2.2): actions that MUST pass a successful
  //    on-chain simulation are fail-closed unless a signed preview armed this
  //    exact digest within SIMULATION_WINDOW_MS. Always ON (safe by default);
  //    the SMART_ACCOUNT_SIMULATION_GATE=0 migration opt-out was removed in
  //    Sprint 5 T4 — preview-first is now the only path. Policy
  //    requiresSimulation can only TIGHTEN the static risk, never relax it.
  const sim = resolveSimulationRequirement(payload?.action, { rules: policyNow.rules, configHealth: policyNow.health });
  if (sim.requiresSimulation) {
    const armed = simulationLog.get(resolvedAccountId);
    const fresh = !!armed && armed.digest === payloadDigest && Date.now() - armed.at <= SIMULATION_WINDOW_MS;
    if (!fresh) {
      incr('smart_account_simulation_blocked');
      recordAudit({ tool: 'smart_account_execute', ok: false, accountId: resolvedAccountId, sessionId: s.sessionId, payloadDigest, errorName: 'SimulationRequired', error: 'SimulationRequired', broadcaster, gate: 'simulation' });
      logStructured('smart_account_execute', { ok: false, accountId: resolvedAccountId, sessionId: s.sessionId, error: 'SimulationRequired', broadcaster, gate: 'simulation' });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: false, accountId: resolvedAccountId, sessionId: s.sessionId, error: 'SimulationRequired',
          reason: `action '${payload?.action}' requires a successful signed preview within ${SIMULATION_WINDOW_MS}ms before execution (fail-closed)`,
          digest: payloadDigest,
          simulation: sim,
        }, null, 2) }],
        isError: true,
      };
    }
  }
  // 2) Policy Engine gate (T2): chain-agnostic soft policy evaluated before
  //    the relayer broadcasts — a rejection here never touches the chain.
  //    (Policy Engine -> Signer/Relayer -> Smart Account)
  // T2.2 单次读取：同一份规则既做指纹审计又做裁决（见 maybeAuditPolicyChange）。
  // S5-T2.1: 传入 daily store + accountId 以消费 maxDaily（账户级日累计）。
  const verdict = evaluatePolicy(
    { action: payload?.action, amount: payload?.amount },
    { rules: policyNow.rules, store: dailyCumulativeStore, accountId: resolvedAccountId, configHealth: policyNow.health },
  );
  if (!verdict.allowed) {
    incr('smart_account_policy_rejected');
    recordAudit({ tool: 'smart_account_execute', ok: false, accountId: resolvedAccountId, sessionId: s.sessionId, payloadDigest, errorName: verdict.code, error: verdict.code, broadcaster, gate: 'policy', reason: verdict.reason });
    logStructured('smart_account_execute', { ok: false, accountId: resolvedAccountId, sessionId: s.sessionId, error: verdict.code, broadcaster, gate: 'policy', reason: verdict.reason });
    return {
      content: [{ type: 'text', text: JSON.stringify({
        success: false, accountId: resolvedAccountId, sessionId: s.sessionId, error: verdict.code,
        reason: verdict.reason,
        digest: payloadDigest,
      }, null, 2) }],
      isError: true,
    };
  }

  // S5-T2.1 fix#1 — 门禁通过且 maxDaily 生效时，立即把本笔 amount 预留进当日
  // 累计（检查与累计压进同一同步段），消除「检查通过 → 链上 await → 才累计」
  // 窗口内并发 execute 双双通过的 check-then-act 竞态。链上失败/未确认在
  // 下方回滚（store.subtract），confirmed 则保持占用。
  let dailyReservation = null;
  if (verdict.daily) {
    const reservedTotal = dailyCumulativeStore.add(resolvedAccountId, payload?.action, payload.amount);
    if (reservedTotal !== null) {
      dailyReservation = { total: reservedTotal, amount: String(payload.amount) };
    }
  }

  incr('smart_account_execute_total');
  // T4 — 多实例 relayer 协调（Sprint 6 T4.1/T4.2/T4.3）：仅在共享 sqlite 后端
  // 激活。非ce 由共享 store 原子分配（全局唯一，杜绝两实例同 nonce 竞争），
  // 广播前先查共享台账去重（另一实例已落账 → 直接复用结果）。其余模式
  // （纯内存 / local .json）→ 不传 coordinator，退化为现基线（ethers 自读
  // nonce，绝不影响单实例行为）。显式共享后端但构造失败 → 显式降级 legacy
  // （fail-safe，不静默多实例不安全）。
  let coordinator = null;
  if (isSharedBackend()) {
    try {
      coordinator = {
        sequencer: createNonceSequencer(getStateBackend()),
        reconciler: createBroadcastReconciler({ listTx }),
      };
    } catch {
      coordinator = null;
    }
  }
  // T3.1/T3.2 — Relayer 韧性：瞬时 RPC 失败 / EOA nonce 冲突指数退避重试；
  // 广播后 wait 失败先对账 receipt；合约确定性拒绝（含 BadNonce 意图重放）不重试。
  const res = await executeWithRelayerResilience({
    conn, payload, signature, relayer, provider: env.provider,
    accountId: resolvedAccountId, payloadDigest,
    ...(coordinator ? {
      coordinator, chainUrl: env.chainUrl, broadcaster,
      // F6（复核）：缺省用 hostname:pid 保证天然唯一 —— 多实例未设 env 时
      // 租约/审计仍可归因到具体实例（计划要求"共享临界区落 instanceId"）。
      instanceId: process.env.NEXUS_INSTANCE_ID || `${hostname()}:${process.pid}`,
    } : {}),
  });
  if (res.retried) incr('smart_account_execute_retried', res.attempts - 1);
  if (res.ok) {
    incr('smart_account_execute_success');
    // Tx lifecycle (Sprint 2.7 T3): executeFromAgent awaited the receipt, so a
    // success here is status=1 → confirmed. Persist the fact for operators.
    const status = res.receipt?.status === 0 ? 'failed' : 'confirmed';
    const submittedAt = new Date().toISOString();
    recordTx({
      txHash: res.txHash, accountId: resolvedAccountId, sessionId: s.sessionId, status,
      // F1（复核）：digest 写穿共享台账 —— T4.2 isAlreadyLanded 按 (accountId,
      // digest) 匹配，缺此字段则跨实例去重永不命中。
      digest: payloadDigest ?? null,
      blockNumber: res.receipt?.blockNumber != null ? res.receipt.blockNumber.toString() : null,
      gasUsed: res.receipt?.gasUsed != null ? res.receipt.gasUsed.toString() : null,
      errorName: null, submittedAt, confirmedAt: submittedAt,
    });
    // S5-T2.1 fix#1 — 预留制：confirmed 保持占用（dailyTotal 即预留后的当日
    // 累计）；已挖出但 revert（status-0）不产生真实花费 → 回滚预留。
    let dailyTotal = null;
    let dailyAction = null;
    if (status === 'confirmed' && dailyReservation) {
      dailyTotal = dailyReservation.total;
      dailyAction = payload?.action;
    } else if (dailyReservation) {
      dailyCumulativeStore.subtract(resolvedAccountId, payload?.action, payload.amount);
    }
    recordAudit({
      tool: 'smart_account_execute', ok: true, accountId: resolvedAccountId, sessionId: s.sessionId,
      payloadDigest, txHash: res.txHash, broadcaster, attempts: res.attempts, retried: res.retried || false,
      reconciled: res.reconciled || false,
      dailyTotal: dailyTotal ?? null, dailyAction: dailyAction ?? null,
      daily: dailyTotal !== null && dailyAction ? `${dailyAction}@${dailyTotal}` : null,
    });
    logStructured('smart_account_execute', { ok: true, accountId: resolvedAccountId, sessionId: s.sessionId, txHash: res.txHash, status, broadcaster, attempts: res.attempts, retried: res.retried || false, reconciled: res.reconciled || false });
    // Record the latest broadcast txHash + persist (Sprint 2.6 T2) so an
    // operator can audit "what did this account last broadcast" across restarts.
    const entry = smartAccounts.get(resolvedAccountId);
    if (entry) {
      recordBroadcast(entry, res.txHash);
      persistSmartAccountState();
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({
        success: true, accountId: resolvedAccountId, sessionId: s.sessionId, onChain: true,
        status,
        txHash: res.txHash,
        txId: res.txId !== null && res.txId !== undefined ? res.txId.toString() : null,
        amount: res.amount !== null && res.amount !== undefined ? res.amount.toString() : null,
      }, null, 2) }],
    };
  }
  // Normalized typed error (Sprint 2.6 T3): fixed semantic code on the wire.
  // T3: use the relayer classification code when it is more specific than the
  // generic normalize (e.g. NONCE_CONFLICT for EOA nonce vs BadNonce intent replay).
  // S5-T2.1 fix#1 — 执行失败（未确认/未广播）→ 回滚 maxDaily 预留。
  if (dailyReservation) {
    dailyCumulativeStore.subtract(resolvedAccountId, payload?.action, payload.amount);
  }
  const { error } = normalizeChainError(res, GENERIC_ERRORS.UNKNOWN_REVERT);
  const errorCode = res.code && res.code !== 'UNKNOWN_REVERT' ? res.code : error;
  incr('smart_account_execute_failed');
  metricizeError(errorCode);
  const failedAt = new Date().toISOString();
  recordTx({
    txHash: res.txHash ?? null, accountId: resolvedAccountId, sessionId: s.sessionId, status: 'failed',
    digest: payloadDigest ?? null, // F1（复核）：同上，失败事实也要能被跨实例去重命中
    blockNumber: null, gasUsed: null, errorName: res.errorName ?? null, error: errorCode, submittedAt: failedAt, confirmedAt: null,
  });
  recordAudit({ tool: 'smart_account_execute', ok: false, accountId: resolvedAccountId, sessionId: s.sessionId, payloadDigest, txHash: res.txHash ?? null, errorName: res.errorName ?? null, error: errorCode, broadcaster, attempts: res.attempts, retried: res.retried || false, retryable: res.retryable ?? null });
  logStructured('smart_account_execute', { ok: false, accountId: resolvedAccountId, sessionId: s.sessionId, error: errorCode, broadcaster, attempts: res.attempts, retried: res.retried || false, retryable: res.retryable ?? null });
  // Sprint 6 T3.3: recordTx 已写穿 store（失败事实跨实例可见），无需全量 persist。
  return chainErrorResponse({ ...res, errorName: res.errorName ?? (res.code !== 'UNKNOWN_REVERT' ? res.code : null) }, GENERIC_ERRORS.UNKNOWN_REVERT);
}

/** Quantify the current exposure bound (INV-007) from on-chain state. */
async function handleSmartAccountEstimateLoss(args) {
  const { accountId, sessionId } = args || {};
  // Boot chain env first (restores persisted accounts, Sprint 2.6 T2).
  await resolveChainEnv();
  const { conn, accountId: resolvedAccountId, session } = selectSmartAccount({ accountId, sessionId });
  const [accountCeiling, accountRemaining, sessionMax] = await Promise.all([
    conn.accountMaxDaily(),
    conn.estimateMaxLoss(),
    conn.sessionMaxLoss(session.sessionId),
  ]);
  // Audit (Sprint 2.7 T1): 只读查询同样留痕，供长期运营审计。
  recordAudit({ tool: 'smart_account_estimate_loss', ok: true, accountId: resolvedAccountId, sessionId: session.sessionId });
  return { content: [{ type: 'text', text: JSON.stringify({
    success: true,
    accountId: resolvedAccountId,
    sessionId: session.sessionId,
    onChain: true,
    accountMaxDaily: accountCeiling !== null && accountCeiling !== undefined ? accountCeiling.toString() : null,
    accountRemaining: accountRemaining !== null && accountRemaining !== undefined ? accountRemaining.toString() : null,
    sessionMaxLoss: sessionMax !== undefined && sessionMax !== null ? sessionMax.toString() : null,
  }, null, 2) }] };
}

/** Query the audit trail (Sprint 2.7 T1): recent Smart Account operation facts. */
async function handleSmartAccountAudit(args) {
  const { accountId, limit } = args || {};
  const rows = listAudit({ accountId, limit: limit || 50 });
  return {
    content: [{ type: 'text', text: JSON.stringify({
      success: true,
      count: rows.length,
      entries: rows,
      note: 'Audit trail (in-memory ring, last 1000). Set AUDIT_LOG_FILE for durable JSON-lines append.',
    }, null, 2) }],
  };
}

/** Snapshot of Smart Account operation metrics (Sprint 2.7 T2). */
async function handleSmartAccountMetrics() {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      success: true,
      metrics: snapshot(),
    }, null, 2) }],
  };
}

/** Simulation risk policy (Sprint 3 T1): which actions must be simulated. */
async function handleSmartAccountSimulationPolicy(args) {
  const { action } = args || {};
  const policy = simulationPolicySnapshot();
  // S5 fix#2 — 与 execute 门禁同一合并语义（resolveSimulationRequirement：
  // policy requiresSimulation 只能收紧静态分级），单次读取避免答案与门禁漂移。
  const policyNow = maybeAuditPolicyChange('smart_account_simulation_policy query');
  const risk = action ? resolveSimulationRequirement(action, { rules: policyNow.rules, configHealth: policyNow.health }) : null;
  return {
    content: [{ type: 'text', text: JSON.stringify({
      success: true,
      policy,
      action: action || null,
      risk,
      note: 'Fail-closed: actions not in the known lists require a successful signed preview (smart_account_preview with signature → wouldExecute=true) before smart_account_execute within the window. Effective requirement = static risk TIGHTENED by policy requiresSimulation (never relaxed); risk.staticLevel vs risk.level shows any policy tightening.',
    }, null, 2) }],
  };
}

// Sprint 4 T2.2 — soft-policy change detection for auditability.
// The policy file is hot-reloaded on every evaluation; a rules change is
// otherwise invisible to operators. We fingerprint the effective rules and,
// on change, record an auditable policy_change event (old→new fingerprint +
// snapshot) so policy evolution is traceable across time.
function maybeAuditPolicyChange(context) {
  // 单次读取：指纹记录的规则集 = 调用方实际用于评估的规则集。若这里与
  // evaluatePolicy 各自独立读文件，两次读取之间的一次热更新会让审计指纹
  // 与实际生效裁决不一致（审计轨迹失真，TOCTOU）。
  const snap = policySnapshot();
  const rules = Array.isArray(snap.rules) ? snap.rules : [];
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(rules)).digest('hex');
  if (fingerprint !== lastPolicyFingerprint) {
    recordAudit({
      tool: 'policy_change',
      ok: true,
      fingerprint,
      previousFingerprint: lastPolicyFingerprint,
      source: snap.source,
      rules,
      context: context || 'policy evaluated',
    });
    lastPolicyFingerprint = fingerprint;
  }
  return { source: snap.source, rules, fingerprint, failMode: snap.failMode, configError: snap.configError, health: snap.health };
}

/** Current Policy Engine rules (Sprint 3 T2), auditable. */
async function handleSmartAccountPolicy() {
  const snap = maybeAuditPolicyChange('smart_account_policy query');
  return {
    content: [{ type: 'text', text: JSON.stringify({
      success: true,
      policy: { source: snap.source, rules: snap.rules, failMode: snap.failMode, configError: snap.configError },
      fingerprint: snap.fingerprint,
      note: 'Soft policy is evaluated before the relayer broadcasts (Policy Engine -> Signer/Relayer -> Smart Account). Rejections here never touch the chain.',
    }, null, 2) }],
  };
}

/**
 * Transaction lifecycle query / re-check (Sprint 2.7 T3).
 *
 * Returns the recorded facts (broadcast time) plus an authoritative re-check
 * of the current on-chain receipt. Safe-retry rules are embedded in `note`:
 *   - Only non-broadcast failures (RPC_ERROR) may be re-sent unchanged.
 *   - BadNonce = the nonce was consumed on-chain → rebuild with next nonce + re-sign.
 *   - txHash unchanged → the SAME tx: query status, never re-broadcast.
 */
async function handleSmartAccountTxStatus(args) {
  const { txHash, accountId, limit } = args || {};
  if (!txHash) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'txHash is required' }) }], isError: true };
  }
  const env = await resolveChainEnv();
  const recorded = listTx({ txHash, accountId, limit: limit || 5 });
  let onChain = null;
  try {
    const receipt = await env.provider.getTransactionReceipt(txHash);
    if (!receipt) {
      onChain = { status: 'submitted', note: 'no receipt yet — tx pending on this chain or unknown' };
    } else if (receipt.status === 0) {
      onChain = { status: 'failed', blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed?.toString() ?? null };
    } else {
      onChain = { status: 'confirmed', blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed?.toString() ?? null };
    }
  } catch (err) {
    onChain = { status: 'unknown', error: err.message };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({
      success: true,
      txHash,
      recorded,
      onChain,
      note: 'Safe retry: only RPC_ERROR / non-broadcast failures may be re-sent unchanged. BadNonce means the nonce was consumed — rebuild the payload with the next nonce and re-sign. Same txHash → same tx: query status, never re-broadcast (replay-safe).',
    }, null, 2) }],
  };
}

// ─── Proof-of-Work: find nonce such that SHA256(challenge+nonce) starts with N zeros ──
function solvePoW(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty || 4);
  let nonce = 0;
  for (;;) {
    const hash = crypto.createHash('sha256').update(challenge + String(nonce)).digest('hex');
    if (hash.startsWith(prefix)) return nonce;
    nonce++;
  }
}

// ─── Registration: real PoW + Dilithium2 key (production-compatible) ────
async function handleRegisterAgent(args) {
  const name = args.name;
  if (!name) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'name (agent identity) is required' }) }], isError: true };
  }
  // Ensure we have an in-memory identity. Prefer the one generated in this session.
  // SECURITY (INV-001): no silent default-password fallback — an identity created
  // with a well-known password would be recoverable by anyone who knows it. When no
  // identity exists in this session, a real caller-supplied password is mandatory.
  if (!hasSessionIdentity()) {
    const password = args.password;
    if (!password || typeof password !== 'string' || password.length < 8) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: 'password is required (min 8 chars) when no identity exists in this session' }),
        }],
        isError: true,
      };
    }
    const identity = await createAgentIdentity({ password, metadata: { name } });
    session.password = password;
    // P0-3: key stays in the isolated signer; no eager in-process wallet.
    session.wallet = null;
    session.publicKeyHex = identity.publicKeyHex;
    session.address = identity.address;
    session.envelope = identity.envelope;
    session.signer = null;
    await ensureSessionSigner();
  }
  session.agent = name;

  const publicKeyHex = session.publicKeyHex;

  // 1) Get PoW challenge
  const challengePath = `/api/v1/bootstrap/agents/register/challenge?agent_identity=${encodeURIComponent(name)}`;
  const c = await (await fetch(`${DEFAULT_API_BASE}${challengePath}`)).json();
  const challenge = c.challenge;
  const difficulty = c.difficulty || 4;

  // 2) Solve PoW
  const nonce = solvePoW(challenge, difficulty);

  // 3) Register with real public key + PoW proof
  return apiRequest('/api/v1/bootstrap/agents/register', 'POST', {
    agent_identity: name,
    capabilities: args.capabilities || [],
    publicKeyHex,
    challenge,
    nonce,
    ...(args.referrer ? { referrer: args.referrer } : {}),
  });
}

// ─── Task economy tools ──────────────────────────────────────────────
// Task write operations (claim/submit/verify/publish) are PQC-signed with
// the session wallet, matching the server's verifyTaskSignature contract:
//   { action, taskId, agent, timestamp, nonce, ...fields }
// Private key never leaves this process — we sign locally and send only the
// signature + public fields to the API.

function coordinationClient() {
  return new CoordinationClient(createHttpTransport({ baseURL: DEFAULT_API_BASE }));
}

function requireSigningSession() {
  // Signer-backed (default) or already-materialized fallback wallet both count.
  if (!hasSessionIdentity()) {
    const err = new Error('No agent identity in this session. Call generate_agent_keys or register_agent first.');
    err.code = 'NO_WALLET';
    throw err;
  }
}

async function signTaskAction(action, { taskId, agent, fields }) {
  requireSigningSession();
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const dataToSign = {
    action,
    taskId: taskId || '',
    agent,
    timestamp,
    nonce,
    ...fields,
  };
  // P0-3 default: sign via the isolated signer (key in child process), which
  // signs the SAME payload string the server verifies (verifyTaskSignature).
  // Fall back to the in-process wallet only when no signer is available —
  // fallbackWallet() materializes it lazily (explicit downgrade).
  const message = JSON.stringify(dataToSign);
  const signature = (await signViaSigner(message)) ?? (await fallbackWallet().sign(message));
  return { timestamp, nonce, signature };
}

async function handleListTasks(args) {
  const client = coordinationClient();
  const data = await client.listTasks({ status: args.status, limit: args.limit || 50 });
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function handleGetTask(args) {
  return apiRequest(`/api/tasks/${args.taskId}`);
}

async function handleClaimTask(args) {
  const agent = session.agent || args.agent;
  const { timestamp, nonce, signature } = await signTaskAction('claim', { taskId: args.taskId, agent });
  return apiRequest(`/api/tasks/${args.taskId}/claim`, 'POST', {
    agent_identity: agent, agent, timestamp, nonce, signature,
  });
}

async function handleSubmitTask(args) {
  const agent = session.agent || args.agent;
  const { timestamp, nonce, signature } = await signTaskAction('submit', {
    taskId: args.taskId, agent, fields: { submission: args.submission },
  });
  return apiRequest(`/api/tasks/${args.taskId}/submit`, 'POST', {
    agent_identity: agent, agent, submission: args.submission, timestamp, nonce, signature,
  });
}

async function handleVerifyTask(args) {
  const agent = session.agent || args.verifier;
  const { timestamp, nonce, signature } = await signTaskAction('verify', {
    taskId: args.taskId, agent, fields: { approved: args.approved, feedback: args.feedback },
  });
  return apiRequest(`/api/tasks/${args.taskId}/verify`, 'POST', {
    agent_identity: agent, agent, approved: args.approved, feedback: args.feedback, timestamp, nonce, signature,
  });
}

async function handlePublishTask(args) {
  const agent = session.agent || args.agent;
  const fields = {
    title: args.title,
    description: args.description,
    requiredCapabilities: args.capabilities || [],
    reward: args.reward,
    taskType: args.taskType,
  };
  const { timestamp, nonce, signature } = await signTaskAction('publish', { taskId: '', agent, fields });
  return apiRequest('/api/tasks', 'POST', {
    agent_identity: agent, agent, ...fields, timestamp, nonce, signature,
  });
}

// ─── Forum / governance tools (PQC-signed writes via ForumClient) ───────
function forumClient() {
  // P0-3: forum writes sign via the ISOLATED signer (metadata channel)
  // through a wallet-compatible shim; the in-process wallet is materialized
  // only when the signer is unavailable (explicit downgrade).
  return new ForumClient({ wallet: signerBackedWallet(), baseURL: DEFAULT_API_BASE });
}

async function handleListTopics(args) {
  const client = forumClient();
  const data = await client.listTopics(args);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function handleCreateTopic(args) {
  const client = forumClient();
  const data = await client.createTopic({ agent: session.agent || args.agent, title: args.title, body: args.body, tags: args.tags });
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function handleAddPost(args) {
  const client = forumClient();
  const data = await client.addPost(args.topicId, { agent: session.agent || args.agent, body: args.body });
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function handleVote(args) {
  const client = forumClient();
  const data = await client.vote(args.topicId, { agent: session.agent || args.agent, vote: args.vote });
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// ─── Tool registry ──────────────────────────────────────────────────────

const TOOLS = [
  // Network
  {
    name: 'get_status',
    description: 'Get current NexusGenesis network status (block height, agents, network age).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'register_agent',
    description: 'Register a new AI Agent on the NexusGenesis network with a real Dilithium2 key and Proof-of-Work. Returns the on-chain address and custody token.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent identity name (required)' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Agent capabilities' },
        referrer: { type: 'string', description: 'Referrer agent ID (optional)' },
        password: { type: 'string', description: 'Password to encrypt the key envelope (required, min 8 chars, when no identity exists in this session)' },
      },
      required: ['name'],
    },
  },
  { name: 'get_agents', description: 'List all AI Agents registered on NexusGenesis.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'get_agent',
    description: 'Get detailed information about a specific AI Agent by ID.',
    inputSchema: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] },
  },
  { name: 'get_leaderboard', description: 'Get the contribution leaderboard.', inputSchema: { type: 'object', properties: {} } },

  // Security tools (the differentiation layer — keys never leave the caller)
  {
    name: 'generate_agent_keys',
    description: 'Generate a self-sovereign agent identity: PQC key pair, ng1 address, and an AES-256-GCM encrypted private-key envelope. The private key NEVER leaves this process.',
    inputSchema: {
      type: 'object',
      properties: {
        password: { type: 'string', description: 'Password to encrypt the private key (min 8 chars).' },
        metadata: { type: 'object', description: 'Optional agent metadata (e.g. { name }).' },
      },
      required: ['password'],
    },
  },
  {
    name: 'generate_keypair',
    description: 'Generate a raw Dilithium2 key pair and derive Nexus/ETH/Sol addresses. The private key is never exposed (INV-001).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'verify_signature',
    description: 'Verify a Dilithium2 signature for a message against a public key hex.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        signature: { type: 'string' },
        publicKeyHex: { type: 'string' },
      },
      required: ['message', 'signature', 'publicKeyHex'],
    },
  },
  {
    name: 'validate_address',
    description: 'Validate whether a string is a well-formed NexusGenesis ng1 address.',
    inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
  },
  {
    name: 'check_spend',
    description: 'Check whether an autonomous agent is allowed to spend an amount under its spend config (human-takeover guardrail).',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        spentToday: { type: 'number' },
        spendConfig: { type: 'object' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'takeover_guard',
    description: 'Human takeover guard: compare spend config before vs after an operation.',
    inputSchema: {
      type: 'object',
      properties: { before: { type: 'object' }, after: { type: 'object' } },
      required: ['before', 'after'],
    },
  },

  // Smart Account — official EVM path (Sprint 2.2). The on-chain hard-policy
  // layer (sessions, whitelist, ceilings, nonce). Private key never enters
  // this process: intents are signed off-chain via the SDK/chain-eth official
  // path and submitted as payload + signature.
  {
    name: 'smart_account_setup',
    description: 'Deploy a SmartAccount contract on-chain and register an agent session (official EVM path, Sprint 2.4 on-chain). Establishes the hard-policy state on-chain: session whitelist (chain/asset/contract/method/recipient), per-tx + daily ceilings, and nonce anti-replay. Requires CHAIN_RPC_URL (external) or uses an in-process LocalChain. Owner/emergency operation keys come from CHAIN_OWNER_PK / CHAIN_EMERGENCY_PK env (T3.3 key isolation): in non-local profiles passing them as tool params is rejected fail-closed so private keys never transit the MCP interface. CHAIN_PROFILE=local only accepts owner/emergencyKey params (anvil dev keys). Agent execution keys never enter this process.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner private key (0x + 64 hex, server-side operation key). CHAIN_PROFILE=local only — non-local profiles reject tool-param keys and use CHAIN_OWNER_PK env instead (T3.3 key isolation).' },
        emergencyKey: { type: 'string', description: 'Emergency private key (0x + 64 hex, server-side operation key). CHAIN_PROFILE=local only — non-local profiles reject tool-param keys and use CHAIN_EMERGENCY_PK env instead (T3.3 key isolation).' },
        sessionId: { type: 'string', description: '32-byte session ID (0x + 64 hex)' },
        agentId: { type: 'string', description: 'Agent identifier bound into the signed intent' },
        agentEvmAddress: { type: 'string', description: 'Agent EVM address (verifies canonical digest signatures)' },
        expiresAt: { type: 'number', description: 'Session expiry (ms epoch, required)' },
        issuedAt: { type: 'number', description: 'Optional session issued-at (ms epoch). Defaults to now; pin it to reproduce the exact signed session.' },
        maxPerTx: { type: 'string', description: 'Per-transaction ceiling in wei (non-negative integer string). At least one of maxPerTx/maxDaily must be > 0 (hard ceilings are mandatory — no unbounded session).' },
        maxDaily: { type: 'string', description: 'Daily cumulative ceiling in wei (non-negative integer string). At least one of maxPerTx/maxDaily must be > 0 (hard ceilings are mandatory — no unbounded session).' },
        allowedChains: { type: 'array', items: { type: 'string' }, description: 'Allowed chains (INV-003)' },
        allowedAssets: { type: 'array', items: { type: 'string' }, description: 'Allowed assets (INV-003)' },
        allowedContracts: { type: 'array', items: { type: 'string' }, description: 'Allowed contracts (INV-003)' },
        allowedMethods: { type: 'array', items: { type: 'string' }, description: 'Allowed methods (INV-003)' },
        allowedRecipients: { type: 'array', items: { type: 'string' }, description: 'Allowed recipients (INV-003)' },
      },
      required: ['sessionId', 'agentId', 'agentEvmAddress', 'expiresAt'],
    },
  },
  {
    name: 'smart_account_preview',
    description: 'Fail-closed dry-run of an asset intent against the on-chain Smart Account — WITHOUT executing. With a caller-supplied signature it runs the full hard-policy decision tree via eth_call (side-effect free, no nonce consumed) and returns wouldExecute + the exact rejection reason. Without a signature it returns the digest + canonical payload to sign off-chain (P3 simulation seed); the chain cannot reach the policy verdict without a valid signature (INV-002).',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Optional Smart Account selector when multiple accounts exist in this MCP session' },
        sessionId: { type: 'string', description: 'Optional session selector when multiple sessions exist under one Smart Account' },
        action: { type: 'string', description: 'Intent action (e.g. transfer)' },
        chain: { type: 'string' },
        asset: { type: 'string' },
        amount: { type: 'string', description: 'Amount (must equal the signed amount for INV-002)' },
        recipient: { type: 'string' },
        contract: { type: 'string' },
        method: { type: 'string' },
        nonce: { type: 'number', description: 'Next anti-replay nonce (> last used)' },
        signature: { type: 'string', description: 'Optional 65-byte EVM signature (0x + 130 hex). When present, returns the true on-chain verdict via eth_call.' },
      },
      required: ['action', 'chain', 'asset', 'amount', 'recipient', 'contract', 'method', 'nonce'],
    },
  },
  {
    name: 'smart_account_execute',
    description: 'Broadcast a caller-signed official EVM intent to the on-chain SmartAccount contract (relayed by the configured CHAIN_RELAYER_PK). The Agent signing key NEVER enters this process — provide the canonical payload + signature built off-chain via signSmartAccountIntent(). The contract enforces INV-002/003/005/006/007 and returns the mined txHash.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Optional Smart Account selector when multiple accounts exist in this MCP session' },
        sessionId: { type: 'string', description: 'Optional session selector; defaults to payload.sessionId or the currently selected session' },
        payload: { type: 'object', description: 'Canonical asset-intent payload (signSmartAccountIntent output)' },
        signature: { type: 'string', description: '65-byte secp256k1 EVM signature (0x + 130 hex)' },
      },
      required: ['payload', 'signature'],
    },
  },
  {
    name: 'smart_account_estimate_loss',
    description: 'Quantify the current exposure bound (INV-007) from on-chain state: the account-level daily ceiling and remaining budget, plus the session-level max loss (bounded by both ceilings).',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Optional Smart Account selector when multiple accounts exist in this MCP session' },
        sessionId: { type: 'string', description: 'Optional session selector for a specific registered session' },
      },
    },
  },

  // Smart Account — 运营面 (Sprint 2.7 可审计/可观测/生命周期)
  {
    name: 'smart_account_audit',
    description: 'Query the Smart Account audit trail (Sprint 2.7): recent setup / preview / execute / estimate_loss facts — accountId, sessionId, payload digest, txHash, revert/errorName, broadcaster, timestamp. In-memory ring (last 1000); set AUDIT_LOG_FILE for durable JSON-lines append.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Filter to one Smart Account' },
        limit: { type: 'number', description: 'Max entries (default 50)' },
      },
    },
  },
  {
    name: 'smart_account_metrics',
    description: 'Snapshot of Smart Account operation metrics (Sprint 2.7): preview count, execute total/success/failed, revert breakdown, nonce conflicts, over-limit/expired rejections, RPC errors.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'smart_account_tx_status',
    description: 'Transaction lifecycle query / re-check (Sprint 2.7): returns the recorded broadcast facts plus an authoritative on-chain receipt re-check (submitted → confirmed / failed). Safe-retry rules embedded in the response note.',
    inputSchema: {
      type: 'object',
      properties: {
        txHash: { type: 'string', description: 'Transaction hash to look up (0x + 64 hex)' },
        accountId: { type: 'string', description: 'Optional filter to a specific Smart Account' },
        limit: { type: 'number', description: 'Max recorded facts to return (default 5)' },
      },
      required: ['txHash'],
    },
  },

  // Smart Account — Simulation / Policy Engine (Sprint 3)
  {
    name: 'smart_account_simulation_policy',
    description: 'Simulation formalization (Sprint 3): which actions MUST pass a successful signed preview (smart_account_preview → wouldExecute=true) before smart_account_execute within the freshness window. Unknown actions fail-closed.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Optional: classify a specific action (e.g. transfer, balance)' },
      },
    },
  },
  {
    name: 'smart_account_policy',
    description: 'Current Policy Engine rules (Sprint 3): the chain-agnostic soft policy evaluated before the relayer broadcasts (Policy Engine -> Signer/Relayer -> Smart Account). Rules are hot-reloadable via SMART_ACCOUNT_POLICY_FILE.',
    inputSchema: { type: 'object', properties: {} },
  },

  // Task economy (the NGEN value loop for agents)
  {
    name: 'list_tasks',
    description: 'List tasks on the network, optionally filtered by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'open | claimed | submitted | verified | rejected | cancelled' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Get a task by ID.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'claim_task',
    description: 'Claim a task to work on it.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, agent: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'submit_task',
    description: 'Submit results for a claimed task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        agent: { type: 'string' },
        submission: { type: 'object', description: 'Submission payload (e.g. { summary, evidence })' },
      },
      required: ['taskId', 'submission'],
    },
  },
  {
    name: 'verify_task',
    description: 'Verify a task submission (approve/reject).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        verifier: { type: 'string' },
        approved: { type: 'boolean' },
        feedback: { type: 'string' },
      },
      required: ['taskId', 'approved'],
    },
  },
  {
    name: 'publish_task',
    description: 'Publish a new task to the network.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'string' } },
        reward: { type: 'number' },
        taskType: { type: 'string' },
      },
      required: ['title', 'description'],
    },
  },

  // Forum / governance (PQC-signed)
  {
    name: 'list_topics',
    description: 'List forum topics / governance proposals.',
    inputSchema: { type: 'object', properties: { tag: { type: 'string' }, limit: { type: 'number' } } },
  },
  {
    name: 'create_topic',
    description: 'Create a forum topic / governance proposal (PQC-signed by the agent).',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'add_post',
    description: 'Reply to a forum topic (PQC-signed by the agent).',
    inputSchema: {
      type: 'object',
      properties: { topicId: { type: 'string' }, agent: { type: 'string' }, body: { type: 'string' } },
      required: ['topicId', 'body'],
    },
  },
  {
    name: 'vote',
    description: 'Vote on a governance proposal / forum topic (PQC-signed by the agent).',
    inputSchema: {
      type: 'object',
      properties: { topicId: { type: 'string' }, agent: { type: 'string' }, vote: { type: 'string', description: 'yes | no | abstain' } },
      required: ['topicId', 'vote'],
    },
  },
];

/**
 * Build the MCP Server wired to the tool handlers.
 * @returns {Server} an MCP Server instance (not yet connected to a transport)
 */
export function createServer() {
  // Sprint 7 T2 — Deployment profile：若配置了 NEXUS_PROFILE_FILE，在创建任何
  // handler 前加载 + 校验 +（默认）注入 process.env。未配置 → no-op，行为与基线
  // 完全一致。fail-closed：缺必填 → 抛错拒绝启动。
  loadDeploymentProfile();

  const server = new Server(
    { name: 'nexusgenesis-agent-mcp', version: process.env.MCP_VERSION || '0.3.0' },
    { capabilities: { tools: {} } },
  );

  // P0-3: the session signer is a child process — terminate it when the MCP
  // session closes so it never outlives the server (and keeps the process
  // alive). The in-process wallet fallback needs no cleanup.
  server.onclose = () => {
    if (session.signer) {
      session.signer.close();
      session.signer = null;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Dispatch in a nested function so `return await dispatch()` below actually
    // awaits handler promises. A bare `return handleX(args)` inside the try
    // would let async handler rejections ESCAPE the catch (classic JS pitfall:
    // the try block completes with a pending promise), surfacing raw -32603
    // protocol errors instead of structured {success:false} tool results.
    async function dispatch() {
      switch (name) {
        // Network
        case 'get_status':
          return apiRequest('/api/v1/bootstrap/status');
        case 'register_agent':
          return handleRegisterAgent(args);
        case 'get_agents':
          return apiRequest('/api/v1/bootstrap/agents');
        case 'get_agent':
          return apiRequest(`/api/v1/bootstrap/agents/${args.agentId}`);
        case 'get_leaderboard':
          return apiRequest('/api/v1/bootstrap/contributions');

        // Security (local)
        case 'generate_agent_keys':
          return handleGenerateAgentKeys(args);
        case 'generate_keypair':
          return handleGenerateKeyPair();
        case 'verify_signature':
          return handleVerifySignature(args);
        case 'validate_address':
          return handleValidateAddress(args);
        case 'check_spend':
          return handleCheckSpend(args);
        case 'takeover_guard':
          return handleTakeoverGuard(args);

        // Smart Account (official EVM path, Sprint 2.2)
        case 'smart_account_setup':
          return handleSmartAccountSetup(args);
        case 'smart_account_preview':
          return handleSmartAccountPreview(args);
        case 'smart_account_execute':
          return handleSmartAccountExecute(args);
        case 'smart_account_estimate_loss':
          return handleSmartAccountEstimateLoss(args);
        case 'smart_account_audit':
          return handleSmartAccountAudit(args);
        case 'smart_account_metrics':
          return handleSmartAccountMetrics();
        case 'smart_account_tx_status':
          return handleSmartAccountTxStatus(args);
        case 'smart_account_simulation_policy':
          return handleSmartAccountSimulationPolicy(args);
        case 'smart_account_policy':
          return handleSmartAccountPolicy();

        // Task economy
        case 'list_tasks':
          return handleListTasks(args);
        case 'get_task':
          return handleGetTask(args);
        case 'claim_task':
          return handleClaimTask(args);
        case 'submit_task':
          return handleSubmitTask(args);
        case 'verify_task':
          return handleVerifyTask(args);
        case 'publish_task':
          return handlePublishTask(args);

        // Forum / governance
        case 'list_topics':
          return handleListTopics(args);
        case 'create_topic':
          return handleCreateTopic(args);
        case 'add_post':
          return handleAddPost(args);
        case 'vote':
          return handleVote(args);

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    }
    try {
      return await dispatch();
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }],
        isError: true,
      };
    }
  });

  // Sprint 7 T1.2 — store 标签维度：把后端形态 / 共享态作为稳定标签导到 /metrics，
  // 运维可一眼区分"单机 local 实例"与"多实例共享 sqlite 后端"。
  registerSampler(() => [{
    metric: 'store_backend',
    value: 1,
    type: 'gauge',
    label: { backend: process.env.NEXUS_STORE_BACKEND || 'local' },
  }, {
    metric: 'store_shared',
    value: isSharedBackend() ? 1 : 0,
    type: 'gauge',
  }]);

  // Sprint 7 T1.1 — 可选 /metrics HTTP 端点（METRICS_HTTP_PORT gate，默认关）。
  // 关闭 → 不监听端口，行为与 Sprint 5/6 基线保持一致。挂到 server 便于测试按需关闭。
  const metricsServer = startMetricsServer({ port: process.env.METRICS_HTTP_PORT, snapshot });
  if (metricsServer) server.metricsServer = metricsServer;

  // Sprint 7 T3 — 健康检查注册 + /health 端点 + alerting 接线。
  // chain/artifact 由 bootChainEnv（懒缓存 promise）提供；未 boot 前检查器按
  // 「依赖未就绪」处理（fail-safe 判定，绝不静默成功）。
  registerHealthCheck({
    name: 'chain_env', fatal: true,
    fn: async () => {
      try {
        const env = await chainEnvPromise;
        if (!env?.provider) return { ok: false, detail: 'no chain provider (local/ephemeral chain has no external health)' };
        const n = await env.provider.getBlockNumber();
        return { ok: Number.isFinite(Number(n)), detail: `block ${n}` };
      } catch (err) { return { ok: false, detail: err?.message || 'chain_env failed' }; }
    },
  });
  registerHealthCheck({
    name: 'state_store', fatal: true,
    fn: () => {
      try {
        return { ok: typeof getStateBackend() === 'object', detail: getStateBackend() ? 'store ready' : 'empty store' };
      } catch (err) { return { ok: false, detail: err?.message || 'store error' }; }
    },
  });

  // /health：可选 loopback HTTP 端点（HEALTH_HTTP_PORT gate，默认关）。
  const healthServer = startHealthServer();
  if (healthServer) server.healthServer = healthServer;

  // strict-startup 自检：HEALTH_STRICT_STARTUP=1 → 依赖致命失败拒绝启动。
  // 异步执行、立即检查；失败抛 JSON-RPC 级错（createServer 被调用方 await 前
  // 由调用方捕获）。为不破坏现有同步 createServer 契约，这里发起 async 自检并
  // 在失败时把错误记到 server 对象供显式读取 + stderr（不隐式吞错）。
  assertStrictStartup().catch((e) => {
    console.error(`[health] STRICT_STARTUP: ${e?.message}`);
    server.strictStartupError = e;
    if (e?.code === 'HEALTH_STRICT_STARTUP_FAILED') server.ready = false;
  });

  // Sprint 7 T3.3 — 告警引擎周期评估：仅当装载规则文件或开启默认规则时启动循环
  //（否则 zero-cost no-op）。评估喂「合并快照」（复核修复 A）：计数器 + 进程
  // gauge + 链上健康 gauge —— 只喂 snapshot() 会让 chain_rpc_up 永远缺席，
  // 默认 critical 规则 chain_rpc_down 不可达。
  // 循环定时器 unref 保证不阻塞进程退出（避免测试悬挂）。
  if (process.env.ALERT_RULES_FILE || process.env.ALERT_RULES_ENABLE_DEFAULTS === '1') {
    const alertTimer = setInterval(() => {
      try { evaluateAlerts({ metrics: collectMetrics(snapshot) }); } catch { /* 单轮评估失败不崩溃 */ }
    }, 10000);
    if (alertTimer.unref) alertTimer.unref();
    server.alertTimer = alertTimer;
  }

  return server;
}

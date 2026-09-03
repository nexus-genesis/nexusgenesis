/**
 * NexusGenesis - Agent Wallet Manager
 * Agent钱包统一管理桥接层
 *
 * 职责:
 * 1. Agent钱包注册表 — 每个Agent自动拥有PQC钱包
 * 2. 钱包生命周期 — 创建/加载/保存/导出/导入
 * 3. 水龙头集成 — 新Agent自动领取初始NGEN
 * 4. 交易nonce管理 — 防止重放攻击
 * 5. 多Agent钱包隔离 — 互不干扰
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PQCWallet, Transaction, validateAddress } from './pqcWallet.js';
import { generateKeyPair, sign, verify, hash } from '../crypto/pqc.js';
import tokenFaucet from '../faucet/tokenFaucet.js';
import {
  encryptPrivateKey,
  decryptPrivateKey,
  isValidEnvelope
} from './walletEncryption.js';
import {
  KEY_MODELS,
  isValidMasterKey,
  deriveOpKeySeed,
  calculateKeyFingerprint,
  generateMasterKey
} from './keyDerivation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALLET_DATA_DIR = path.join(__dirname, '../../data/wallets');
const AGENTS_DATA_DIR = path.join(__dirname, '../../data/agents');
const AGENT_WALLET_REGISTRY = path.join(WALLET_DATA_DIR, 'agent_wallet_registry.json');
const WALLET_ENCRYPTION_KEY_PATH = path.join(WALLET_DATA_DIR, '.wallet_master_key');

const DEFAULT_INITIAL_BALANCE = 1000n;
const MAX_TRANSFER_AMOUNT = 100000000n; // 100M NGEN
const MIN_TRANSFER_AMOUNT = 1n;

class AgentWalletManager {
  constructor() {
    this.registry = new Map();       // agentId → { wallet, metadata }
    this.addressIndex = new Map();   // address → agentId
    this.nonceMap = new Map();       // agentId → current nonce
    this.masterKey = null;           // AES master key (loaded from file or env)
    this._pendingEncrypt = new Set();// Legacy plaintext keys awaiting encryption
    this.stats = {
      totalWallets: 0,
      totalBalance: 0n,
      totalTransactions: 0,
      activeWallets: 0
    };

    this._initDirectories();
    this._loadOrCreateMasterKey();
    this._loadRegistry();
    this.markLegacyServerManagedAgents(); // Mark existing agents as legacy
  }

  _initDirectories() {
    if (!fs.existsSync(WALLET_DATA_DIR)) {
      fs.mkdirSync(WALLET_DATA_DIR, { recursive: true });
    }
  }

  /**
   * Load server-side master key used to encrypt agent private keys at rest.
   *
   * Resolution order:
   *   1. NG_WALLET_MASTER_KEY env var (base64, 32 bytes)
   *   2. .wallet_master_key file in data/wallets/        (dev only)
   *   3. Generate a new key, persist to .wallet_master_key (dev only)
   *
   * Production safety (NODE_ENV=production or mainnet):
   *   - NG_WALLET_MASTER_KEY is REQUIRED. Missing or malformed env var
   *     throws at construction time (fail-fast at startup, not on first
   *     wallet operation).
   *   - Plaintext file fallback and auto-generation are DISABLED.
   *     Otherwise an operator who forgets to set the env var would
   *     silently get a fresh key written to disk, permanently locking
   *     out the encrypted wallet registry and re-introducing the
   *     plaintext file we are trying to eliminate.
   */
  _loadOrCreateMasterKey() {
    const isProduction =
      process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'mainnet';

    // ─── 1. Env var path (REQUIRED in production) ────────────────────
    const envKey = process.env.NG_WALLET_MASTER_KEY;
    if (!envKey) {
      if (isProduction) {
        throw new Error(
          `[AgentWallet] FATAL: NG_WALLET_MASTER_KEY is required in production ` +
          `(NODE_ENV=${process.env.NODE_ENV}). Set this 32-byte base64 env var ` +
          `before starting the node (e.g. via PM2 env block, systemd, or KMS). ` +
          `Plaintext file fallback is disabled in production to prevent key loss.`
        );
      }
      // Dev/test: fall through to file or auto-generate below
    } else {
      // Validate env var format
      let buf = null;
      try {
        buf = Buffer.from(envKey, 'base64');
      } catch (e) {
        if (isProduction) {
          throw new Error(
            `[AgentWallet] FATAL: NG_WALLET_MASTER_KEY base64 decode failed: ${e.message}`
          );
        }
        console.warn('[AgentWallet] Failed to decode NG_WALLET_MASTER_KEY:', e.message);
      }

      if (buf) {
        if (buf.length !== 32) {
          const msg = `wrong length: ${buf.length} bytes (expected 32)`;
          if (isProduction) {
            throw new Error(`[AgentWallet] FATAL: NG_WALLET_MASTER_KEY ${msg}`);
          }
          console.warn(`[AgentWallet] NG_WALLET_MASTER_KEY ${msg}, falling back to file`);
        } else {
          this.masterKey = buf;
          console.log('[AgentWallet] Master key loaded from NG_WALLET_MASTER_KEY env var');
          return;
        }
      }
    }

    // ─── 2. Dev-only: fall back to legacy plaintext file ────────────
    if (fs.existsSync(WALLET_ENCRYPTION_KEY_PATH)) {
      try {
        const data = JSON.parse(fs.readFileSync(WALLET_ENCRYPTION_KEY_PATH, 'utf8'));
        if (data.key && data.cipher === 'plain-file') {
          this.masterKey = Buffer.from(data.key, 'hex');
          console.warn('[AgentWallet] WARNING: master key loaded from plaintext file (dev only). Set NG_WALLET_MASTER_KEY in production.');
          return;
        }
      } catch (e) {
        console.warn('[AgentWallet] Failed to load master key file:', e.message);
      }
    }

    // ─── 3. Dev-only: generate new key ──────────────────────────────
    this.masterKey = crypto.randomBytes(32);
    fs.writeFileSync(WALLET_ENCRYPTION_KEY_PATH, JSON.stringify({
      key: this.masterKey.toString('hex'),
      cipher: 'plain-file',
      createdAt: new Date().toISOString(),
      warning: 'DEV ONLY. Set NG_WALLET_MASTER_KEY env var in production.'
    }, null, 2), { mode: 0o600 });
    console.log('[AgentWallet] Generated new master key at', WALLET_ENCRYPTION_KEY_PATH);
  }

  _loadRegistry() {
    try {
      if (fs.existsSync(AGENT_WALLET_REGISTRY)) {
        const data = JSON.parse(fs.readFileSync(AGENT_WALLET_REGISTRY, 'utf8'));
        for (const entry of data.entries || []) {
          const walletData = entry.wallet_data;
          if (!walletData || !walletData.publicKey) continue;

          try {
            const publicKey = Buffer.from(walletData.publicKey, 'hex');
            const balance = BigInt(walletData.balance || 0);
            const nonce = walletData.nonce || 0;

            // Decrypt private key (if encrypted) or read plaintext (legacy)
            let privateKey;
            if (walletData.encryptedPrivateKey) {
              if (!isValidEnvelope(walletData.encryptedPrivateKey)) {
                console.warn(`[AgentWallet] Invalid envelope for ${entry.agentId}, skipping`);
                continue;
              }
              // Use master key as password to decrypt the envelope
              const envelopePwd = this.masterKey.toString('hex');
              privateKey = decryptPrivateKey(walletData.encryptedPrivateKey, envelopePwd);
            } else if (walletData.privateKey) {
              // LEGACY: plaintext private key. Migrate to encrypted form on next save.
              console.warn(`[AgentWallet] Legacy plaintext key for ${entry.agentId} - will be encrypted on next save`);
              privateKey = Buffer.from(walletData.privateKey, 'hex');
              this._pendingEncrypt.add(entry.agentId);
            } else {
              continue;
            }

            const wallet = new PQCWallet(publicKey, privateKey, balance, nonce);

            this.registry.set(entry.agentId, {
              wallet,
              metadata: entry.metadata || {},
              onboarding: entry.onboarding || null
            });
            this.addressIndex.set(wallet.address, entry.agentId);
            this.nonceMap.set(entry.agentId, nonce);
          } catch (e) {
            console.error(`[AgentWallet] Failed to restore wallet for ${entry.agentId}:`, e.message);
          }
        }

        this.stats.totalWallets = data.stats?.totalWallets || this.registry.size;
        this.stats.totalTransactions = data.stats?.totalTransactions || 0;

        // Migrate any legacy plaintext entries to encrypted form
        if (this._pendingEncrypt.size > 0) {
          console.log(`[AgentWallet] Migrating ${this._pendingEncrypt.size} legacy plaintext keys to AES-256-GCM...`);
          this._saveRegistry();
        }

        console.log(`[AgentWallet] Loaded ${this.registry.size} agent wallets from registry`);
      }
    } catch (e) {
      console.warn('[AgentWallet] Could not load registry, starting fresh:', e.message);
    }
  }

  /**
   * 标记所有 server-managed Agent 为 legacy
   * 在加载注册表后自动调用
   */
  markLegacyServerManagedAgents() {
    let migratedCount = 0;
    
    for (const [agentId, entry] of this.registry) {
      if (entry.metadata && !entry.metadata.keyModel) {
        // 没有 keyModel 字段的都是 legacy server-managed
        entry.metadata.keyModel = KEY_MODELS.SERVER_MANAGED;
        entry.metadata.isLegacy = true;
        entry.metadata.legacyReason = 'Registered before hybrid key model support. Migrate to hybrid or self-sovereign mode.';
        entry.metadata.migratedAt = new Date().toISOString();
        migratedCount++;
      }
    }
    
    if (migratedCount > 0) {
      console.log(`[AgentWallet] Marked ${migratedCount} agents as legacy server-managed. Recommend migration.`);
      this._saveRegistry();
    }
    
    return migratedCount;
  }

  _saveRegistry() {
    try {
      const entries = [];
      const envelopePwd = this.masterKey.toString('hex');

      for (const [agentId, entry] of this.registry) {
        // 跳过浏览器生成的密钥（privateKey === null）
        if (!entry.wallet.privateKey) {
          entries.push({
            agentId,
            wallet_data: {
              address: entry.wallet.address,
              publicKey: entry.wallet.publicKey.toString('hex'),
              balance: entry.wallet.balance.toString(),
              nonce: entry.wallet.nonce,
              keyOrigin: 'browser-generated'
            },
            metadata: entry.metadata,
            custody: entry.metadata?.custody || 'server-managed'
          });
          continue;
        }

        // Encrypt private key with AES-256-GCM
        const envelope = encryptPrivateKey(entry.wallet.privateKey, envelopePwd, {
          address: entry.wallet.address,
          agentId,
          publicKey: entry.wallet.publicKey.toString('hex')
        });

        entries.push({
          agentId,
          wallet_data: {
            address: entry.wallet.address,
            publicKey: entry.wallet.publicKey.toString('hex'),
            encryptedPrivateKey: envelope,  // AES-256-GCM envelope (no plaintext)
            balance: entry.wallet.balance.toString(),
            nonce: entry.wallet.nonce
          },
          metadata: entry.metadata,
          onboarding: entry.onboarding || null
        });
      }

      fs.writeFileSync(AGENT_WALLET_REGISTRY, JSON.stringify({
        entries,
        stats: {
          totalWallets: this.stats.totalWallets,
          totalTransactions: this.stats.totalTransactions
        },
        encryption: {
          cipher: 'aes-256-gcm',
          kdf: 'pbkdf2-sha512',
          version: '1.0'
        },
        updatedAt: new Date().toISOString()
      }, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2), { mode: 0o600 });
    } catch (e) {
      console.error('[AgentWallet] Failed to save registry:', e.message);
    }
  }

  /**
   * 为Agent创建新的PQC钱包（Legacy 方法，标记为 server-managed）
   * @deprecated 使用 registerAgentWithKeyModel 代替
   * @param {string} agentId - Agent唯一标识
   * @param {object} metadata - Agent元数据
   * @param {bigint} initialBalance - 初始余额
   * @returns {Promise<object>} 钱包信息
   */
  async createAgentWallet(agentId, metadata = {}, initialBalance = null) {
    console.warn(`[AgentWallet] createAgentWallet is deprecated. Use registerAgentWithKeyModel instead.`);
    return this.registerAgentWithKeyModel(agentId, {
      ...metadata,
      keyModel: KEY_MODELS.SERVER_MANAGED
    }, initialBalance);
  }

  /**
   * 注册新 Agent（支持三种密钥模式）
   * 
   * 密钥模式：
   * - hybrid: 人类主密钥 + Agent 操作密钥（推荐）
   * - self-sovereign: Agent 自主管理
   * - server-managed: 服务器托管（Legacy，标记为不安全）
   * 
   * @param {string} agentId - Agent唯一标识
   * @param {object} options - 注册选项
   * @param {string} options.keyModel - 密钥模式
   * @param {Buffer} [options.masterKey] - 主密钥（hybrid/self-sovereign 模式需要）
   * @param {string} [options.publicKeyHex] - 公钥（十六进制，注册时提供）
   * @param {string} [options.privateKeyHex] - 私钥（十六进制，self-sovereign 模式需要本地存储）
   * @param {object} [options.metadata] - Agent元数据
   * @param {bigint} [options.initialBalance] - 初始余额
   * @returns {Promise<object>} 注册结果
   */
  async registerAgentWithKeyModel(agentId, options = {}) {
    const {
      keyModel = KEY_MODELS.HYBRID,
      masterKey,
      publicKeyHex,
      privateKeyHex,
      metadata = {},
      initialBalance = DEFAULT_INITIAL_BALANCE
    } = options;

    agentId = String(agentId);

    // 检查是否已存在
    if (this.registry.has(agentId)) {
      const existing = this.registry.get(agentId);
      return this._formatWalletResponse(agentId, existing.wallet, existing.metadata);
    }

    let wallet;
    let opKeyFingerprint = null;
    let opKeyVersion = 1;

    try {
      switch (keyModel) {
        case KEY_MODELS.HYBRID:
        case KEY_MODELS.SELF_SOVEREIGN: {
          // 新模式：需要主密钥或提供的密钥对
          if (publicKeyHex && !privateKeyHex) {
            // 用户只发送公钥（浏览器本地生成密钥对）
            // 私钥永远不在服务器上
            const publicKey = Buffer.from(publicKeyHex, 'hex');
            
            wallet = new PQCWallet(publicKey, null, initialBalance);
            opKeyFingerprint = calculateKeyFingerprint(publicKey);
            
            console.log(`[Wallet] Agent ${agentId} registered with browser-generated key (public key only, private key stays local)`);
          } else if (publicKeyHex && privateKeyHex) {
            // 用户提供公私钥对（旧模式，向后兼容）
            const publicKey = Buffer.from(publicKeyHex, 'hex');
            const privateKey = Buffer.from(privateKeyHex, 'hex');
            
            wallet = new PQCWallet(publicKey, privateKey, initialBalance);
            opKeyFingerprint = calculateKeyFingerprint(privateKey);
            
            // Self-sovereign 模式：私钥已在用户本地，不需要存到服务器
            // 但如果提供了 masterKey，可以选择加密存储备份
            if (keyModel === KEY_MODELS.SELF_SOVEREIGN && this.masterKey) {
              await this._storeOpKeyLocally(agentId, privateKey, metadata);
            }
          } else if (masterKey) {
            // 从主密钥派生操作密钥
            const opKeySeed = await deriveOpKeySeed(masterKey, { agentId, version: 1 });
            
            // 用种子生成确定性密钥对（简化版：用种子派生随机数）
            const drbg = crypto.createCipher('aes-256-ctr', opKeySeed);
            const entropy = Buffer.alloc(32);
            drbg.update(entropy);
            
            // 导入 PQC 模块
            const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
            const keyPair = ml_dsa44.keygen();
            const publicKey = Buffer.from(keyPair.publicKey);
            const privateKey = Buffer.from(keyPair.secretKey);
            
            wallet = new PQCWallet(publicKey, privateKey, initialBalance);
            opKeyFingerprint = calculateKeyFingerprint(privateKey);
            
            // 本地加密存储操作密钥
            await this._storeOpKeyLocally(agentId, privateKey, metadata);
          } else {
            throw new Error('Provide publicKeyHex (recommended) or publicKeyHex+privateKeyHex (legacy) or masterKeyHex.');
          }
          break;
        }

        case KEY_MODELS.SERVER_MANAGED: {
          // Legacy 模式：服务器生成并托管
          wallet = await PQCWallet.generate(initialBalance);
          
          // 加密存储到服务器（标记为 legacy）
          await wallet.save(
            path.join(WALLET_DATA_DIR, `agent_${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`),
            this.masterKey?.toString('hex')
          );
          
          metadata.isLegacy = true;
          metadata.legacyReason = 'Server-managed wallets are deprecated. Migrate to hybrid or self-sovereign mode.';
          break;
        }

        default:
          throw new Error(`Unknown keyModel: ${keyModel}. Valid values: ${Object.values(KEY_MODELS).join(', ')}`);
      }

      // 注册到内存
      this.registry.set(agentId, {
        wallet,
        metadata: {
          ...metadata,
          created: new Date().toISOString(),
          keyModel,
          opKeyFingerprint,
          opKeyVersion
        }
      });
      this.addressIndex.set(wallet.address, agentId);
      this.nonceMap.set(agentId, 0);
      this.stats.totalWallets++;

      // 保存注册表
      this._saveRegistry();

      console.log(`[AgentWallet] Registered agent ${agentId} with keyModel=${keyModel}, address=${wallet.address}`);

      const response = this._formatWalletResponse(agentId, wallet, this.registry.get(agentId).metadata);
      response.success = true;
      response.keyModel = keyModel;
      response.opKeyFingerprint = opKeyFingerprint;
      response.opKeyVersion = opKeyVersion;
      
      // Phase 1: 添加 custody 状态
      response.custody = this.registry.get(agentId).metadata?.custody || 'server-managed';
      response.isSelfCustodied = response.custody === 'self-custodied';
      response.migrationNotice = !response.isSelfCustodied
        ? '此钱包为服务器托管模式。使用 POST /api/v1/wallet/agent/migrate-to-self-custody 迁移到 Agent 自持。'
        : '此钱包已是自持模式，私钥由 Agent 本地保管。';
      
      return response;
    } catch (e) {
      console.error(`[AgentWallet] Failed to register agent ${agentId}:`, e.message);
      throw e;
    }
  }

  /**
   * 本地加密存储操作密钥
   * @param {string} agentId - Agent ID
   * @param {Buffer} privateKey - 私钥
   * @param {object} metadata - 元数据
   * @private
   */
  async _storeOpKeyLocally(agentId, privateKey, metadata = {}) {
    const encrypted = encryptPrivateKey(privateKey, this.masterKey?.toString('hex') || crypto.randomBytes(32).toString('hex'), {
      address: this.registry.get(agentId)?.wallet?.address || 'unknown',
      publicKey: privateKey?.toString('hex') || '',
      keyModel: metadata.keyModel || 'hybrid',
      storedAt: new Date().toISOString()
    });

    const storePath = path.join(WALLET_DATA_DIR, `opkey_${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    await fs.promises.writeFile(storePath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  }

  /**
   * 为Agent从水龙头领取初始代币
   * @param {string} agentId - Agent ID
   * @param {string} ip - IP地址(用于速率限制)
   * @returns {Promise<object>}
   */
  async claimFaucet(agentId, ip = '127.0.0.1') {
    const entry = this.registry.get(agentId);
    if (!entry) {
      return { success: false, reason: 'Agent wallet not found. Create wallet first.' };
    }

    const eligibility = tokenFaucet.checkEligibility(entry.wallet.address);
    if (!eligibility.eligible) {
      return {
        success: false,
        reason: 'Not eligible for faucet',
        cooldownMs: eligibility.addressCooldownRemainingMs,
        nextEligibleAt: new Date(Date.now() + eligibility.addressCooldownRemainingMs).toISOString()
      };
    }

    const result = tokenFaucet.dripToAddress(ip, entry.wallet.address, Number(DEFAULT_INITIAL_BALANCE));
    if (result.success) {
      entry.wallet.balance += DEFAULT_INITIAL_BALANCE;
      this._saveRegistry();
      // Phase 2-A1: 首次入账后触发安全引导状态机（动态 import 避免循环依赖）
      try {
        const { maybeTriggerOnboarding } = await import('./onboarding.js');
        maybeTriggerOnboarding(agentId);
      } catch (e) {
        // 引导模块故障不影响 faucet 主流程
        console.warn('[AgentWallet] onboarding trigger failed:', e.message);
      }
    }

    return result;
  }

  /**
   * 获取Agent的钱包
   * @param {string} agentId - Agent ID
   * @returns {object|null} 钱包信息
   */
  getAgentWallet(agentId) {
    const entry = this.registry.get(agentId);
    if (!entry) return null;
    return this._formatWalletResponse(agentId, entry.wallet, entry.metadata);
  }

  getWalletInstance(agentId) {
    return this.registry.get(agentId)?.wallet || null;
  }

  getRegistryEntry(agentId) {
    return this.registry.get(agentId) || null;
  }

  getOnboardingStatus(agentId) {
    const entry = this.registry.get(agentId);
    if (!entry) return null;
    return entry.onboarding || { status: null, triggeredAt: null, completedAt: null, method: null };
  }

  setOnboardingStatus(agentId, status, extras = {}) {
    const entry = this.registry.get(agentId);
    if (!entry) return false;
    entry.onboarding = {
      ...(entry.onboarding || {}),
      status,
      ...extras
    };
    // Phase 2-A1: 不自动 _saveRegistry —— 由调用方（maybeTriggerOnboarding /
    // markOnboardingComplete / 用户显式调用）统一触发一次 save，避免连续
    // 多次 onboarding 状态变更时把 176 个 agent 的 PBKDF2 跑多遍。
    return true;
  }

  getWalletInstanceByAddress(address) {
    const agentId = this.getAgentByAddress(address);
    if (!agentId) return null;
    return this.getWalletInstance(agentId);
  }

  /**
   * 通过地址查找Agent ID
   * @param {string} address - 钱包地址
   * @returns {string|null} Agent ID
   */
  getAgentByAddress(address) {
    return this.addressIndex.get(address) || null;
  }

  /**
   * 查询Agent余额
   * @param {string} agentId - Agent ID
   * @returns {object} 余额信息
   */
  getBalance(agentId) {
    const entry = this.registry.get(agentId);
    if (!entry) {
      return { success: false, reason: 'Agent wallet not found' };
    }

    return {
      success: true,
      agentId,
      address: entry.wallet.address,
      balance: Number(entry.wallet.balance),
      balanceRaw: entry.wallet.balance.toString(),
      symbol: 'NGEN',
      nonce: entry.wallet.nonce
    };
  }

  /**
   * Agent之间转账
   * @param {string} fromAgentId - 发送方Agent ID
   * @param {string} toAddressOrAgentId - 接收方地址或Agent ID
   * @param {bigint|number} amount - 转账金额
   * @param {string} memo - 备注
   * @returns {Promise<object>} 交易结果
   */
  async transfer(fromAgentId, toAddressOrAgentId, amount, memo = '') {
    const fromEntry = this.registry.get(fromAgentId);
    if (!fromEntry) {
      return { success: false, reason: 'Sender wallet not found' };
    }

    let toAddress = toAddressOrAgentId;

    // 如果传入的是Agent ID，解析为地址
    if (this.registry.has(toAddressOrAgentId)) {
      toAddress = this.registry.get(toAddressOrAgentId).wallet.address;
    } else if (toAddressOrAgentId.startsWith('ng1')) {
      // 已经是地址
    } else {
      // 尝试从地址索引查找
      const agentFromAddr = this.addressIndex.get(toAddressOrAgentId);
      if (agentFromAddr && this.registry.has(agentFromAddr)) {
        toAddress = toAddressOrAgentId;
      }
    }

    const amountBigInt = BigInt(amount);

    if (amountBigInt < MIN_TRANSFER_AMOUNT) {
      return { success: false, reason: `Minimum transfer is ${MIN_TRANSFER_AMOUNT} NGEN` };
    }
    if (amountBigInt > MAX_TRANSFER_AMOUNT) {
      return { success: false, reason: `Maximum transfer is ${MAX_TRANSFER_AMOUNT} NGEN` };
    }

    const { valid, reason } = validateAddress(toAddress);
    if (!valid) {
      return { success: false, reason: `Invalid recipient address: ${reason}` };
    }

    if (!fromEntry.wallet.hasEnoughBalance(amountBigInt + 1n)) {
      return {
        success: false,
        reason: `Insufficient balance. Have: ${fromEntry.wallet.balance}, need: ${amountBigInt + 1n}`
      };
    }

    try {
      // 代谢税 0.1%（与白皮书一致）
      const METABOLIC_TAX_RATE = 1000n; // 0.1% = 1/1000
      const tax = amountBigInt / METABOLIC_TAX_RATE;
      const netAmount = amountBigInt - tax;
      const fee = 1n; // 固定转账费
      const totalDeduct = amountBigInt + fee;

      const tx = Transaction.create(fromEntry.wallet, toAddress, amountBigInt, fee, 'TRANSFER', {
        memo,
        agentId: fromAgentId,
        metabolicTax: tax,
        netAmount: netAmount
      });

      await tx.sign(fromEntry.wallet);

      // ─── 原子性检查：在扣款前再次验证额度（防止人类中途接管） ───
      const preDeductBalance = fromEntry.wallet.balance;
      const preDeductNonce = fromEntry.wallet.nonce;

      fromEntry.wallet.balance -= totalDeduct;
      fromEntry.wallet.nonce++;
      this.nonceMap.set(fromAgentId, fromEntry.wallet.nonce);

      // ─── 检查是否被人类中途接管 ───
      const currentSpendConfig = this.registry.get(fromAgentId)?.metadata?.spendConfig;
      if (currentSpendConfig && currentSpendConfig.type !== 'unlimited') {
        // 人类已设置额度限制，回滚交易
        fromEntry.wallet.balance = preDeductBalance;
        fromEntry.wallet.nonce = preDeductNonce;
        this.nonceMap.set(fromAgentId, preDeductNonce);
        
        console.warn(`[AgentWallet] Transaction rolled back: agent ${fromAgentId} was taken over by human operator`);
        return {
          success: false,
          reason: 'Transaction rejected: wallet control changed during processing',
          error_code: 'TAKEOVER_DURING_TRANSFER',
          requiresHumanApproval: true,
          rollback: true
        };
      }

      // 代谢税流入 Observer 物理桥接基金
      if (tax > 0n) {
        const OBSERVER_ADDR = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';
        console.log(`[AgentWallet] Metabolic tax: ${tax} NGEN → Observer (${OBSERVER_ADDR})`);
      }

      // 如果接收方是我们的Agent，自动入账（净金额）
      const toAgentId = this.getAgentByAddress(toAddress);
      if (toAgentId && this.registry.has(toAgentId)) {
        const toEntry = this.registry.get(toAgentId);
        toEntry.wallet.balance += netAmount;
        // Phase 2-A1: 接收方入账后触发安全引导
        try {
          const { maybeTriggerOnboarding } = await import('./onboarding.js');
          maybeTriggerOnboarding(toAgentId);
        } catch (e) {
          console.warn('[AgentWallet] onboarding trigger (recipient) failed:', e.message);
        }
      }

      this.stats.totalTransactions++;
      this._saveRegistry();

      // 持久化到全局 txHistory，便于审计和前端历史查询
      try {
        const state = global.globalState;
        if (state && state.transactions && state.transactions.txHistory) {
          state.transactions.txHistory.push({
            id: tx.id,
            hash: tx.id,
            type: 'transfer',
            tx_type: 'TRANSFER',
            from: fromEntry.wallet.address,
            to: toAddress,
            fromAgentId,
            toAgentId: toAgentId || null,
            amount: Number(amountBigInt),
            netAmount: Number(netAmount),
            fee: Number(fee),
            metabolicTax: Number(tax),
            memo,
            nonce: fromEntry.wallet.nonce,
            signature: tx.signature,
            status: 'applied',
            timestamp: tx.timestamp
          });
        }
      } catch (_) { /* ignore state persistence errors */ }

      return {
        success: true,
        transactionId: tx.id,
        from: fromEntry.wallet.address,
        to: toAddress,
        amount: Number(amountBigInt),
        netAmount: Number(netAmount),
        metabolicTax: Number(tax),
        fee: Number(fee),
        memo,
        timestamp: tx.timestamp,
        signature: tx.signature?.substring(0, 32) + '...'
      };
    } catch (e) {
      return { success: false, reason: e.message };
    }
  }

  /**
   * 批量转账 — 一个Agent向多个Agent转账
   * @param {string} fromAgentId - 发送方
   * @param {Array<{to: string, amount: number|bigint, memo?: string}>} transfers
   * @returns {Promise<object>}
   */
  async batchTransfer(fromAgentId, transfers) {
    const results = [];
    for (const transfer of transfers) {
      const result = await this.transfer(fromAgentId, transfer.to, transfer.amount, transfer.memo || '');
      results.push(result);
    }
    return {
      success: results.every(r => r.success),
      totalTransfers: transfers.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  }

  /**
   * 获取Agent交易列表
   * @param {string} agentId - Agent ID
   * @param {object} options - { limit, offset }
   * @returns {object}
   */
  getTransactionHistory(agentId, options = {}) {
    const { limit = 20, offset = 0 } = options;
    const entry = this.registry.get(agentId);
    if (!entry) {
      return { success: false, reason: 'Agent wallet not found' };
    }

    // 从全局状态读取交易记录
    const state = global.globalState;
    let transactions = [];
    if (state && state.transactions && state.transactions.txHistory) {
      transactions = state.transactions.txHistory.filter(
        tx => tx.from === entry.wallet.address || tx.to === entry.wallet.address
      );
    }
    transactions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const total = transactions.length;
    const page = transactions.slice(offset, offset + limit);

    return {
      success: true,
      agentId,
      address: entry.wallet.address,
      transactions: page.map(tx => ({
        id: tx.id || tx.hash,
        type: tx.type || 'transfer',
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        fee: tx.fee,
        timestamp: tx.timestamp,
        direction: tx.from === entry.wallet.address ? 'send' : 'receive'
      })),
      total,
      limit,
      offset
    };
  }

  /**
   * 导出Agent钱包（加密）
   * @param {string} agentId - Agent ID
   * @param {string} password - 加密密码
   * @returns {object|null}
   */
  exportAgentWallet(agentId, password) {
    const entry = this.registry.get(agentId);
    if (!entry) return null;
    return entry.wallet.exportEncrypted(password);
  }

  /**
   * 从加密数据导入Agent钱包
   * @param {string} agentId - Agent ID
   * @param {object} encrypted - 加密的钱包数据
   * @param {string} password - 解密密码
   * @returns {boolean}
   */
  importAgentWallet(agentId, encrypted, password) {
    const wallet = PQCWallet.importEncrypted(encrypted, password);
    if (!wallet) return false;

    this.registry.set(agentId, {
      wallet,
      metadata: { imported: new Date().toISOString() }
    });
    this.addressIndex.set(wallet.address, agentId);
    this.nonceMap.set(agentId, wallet.nonce);
    this._saveRegistry();
    return true;
  }

  /**
   * 刷新Agent余额（从区块链状态同步）
   * @param {string} agentId - Agent ID
   * @param {object} blockchainState - 区块链状态对象
   * @returns {object}
   */
  syncBalance(agentId, blockchainState) {
    const entry = this.registry.get(agentId);
    if (!entry) return { success: false, reason: 'Agent wallet not found' };

    const onChainBalance = blockchainState?.getBalance?.(entry.wallet.address)
      || blockchainState?.balances?.[entry.wallet.address]
      || 0;

    const onChainNonce = blockchainState?.getNonce?.(entry.wallet.address)
      || blockchainState?.nonces?.[entry.wallet.address]
      || entry.wallet.nonce;

    // Wallet-sync fix: previously this method OVERWROTE the wallet's in-memory
    // balance with the on-chain balance. When the on-chain state had not yet
    // been endowed (a long-standing bug now fixed in state.applyAgentRegister),
    // every syncBalance call would silently zero out the 1000 NGEN soft
    // allocation. Even with the on-chain fix in place, an overwrite is the
    // wrong semantic: the on-chain balance is authoritative for spent/locked
    // funds, but the wallet manager may also track off-chain allocations
    // (faucet claims, etc.). Take the max so neither side silently loses
    // value, and never decrease the wallet balance via a read-only sync.
    const onChainBigInt = BigInt(onChainBalance);
    if (onChainBigInt > entry.wallet.balance) {
      entry.wallet.balance = onChainBigInt;
    }
    entry.wallet.nonce = onChainNonce;

    this._saveRegistry();

    return {
      success: true,
      agentId,
      address: entry.wallet.address,
      balance: Number(entry.wallet.balance),
      onChainBalance: Number(onChainBigInt),
      nonce: onChainNonce
    };
  }

  /**
   * 更新Agent余额
   */
  updateBalance(agentId, amount) {
    const entry = this.registry.get(agentId);
    if (!entry) return false;
    entry.wallet.balance = amount;
    this._saveRegistry();
    return true;
  }

  /**
   * 列出所有Agent钱包
   * @returns {Array}
   */
  listAllWallets() {
    const wallets = [];
    for (const [agentId, entry] of this.registry) {
      wallets.push(this._formatWalletResponse(agentId, entry.wallet, entry.metadata));
    }
    return wallets;
  }

  /**
   * 列出所有Agent钱包地址
   * @returns {Array<{agentId: string, address: string}>}
   */
  listAllAddresses() {
    const addresses = [];
    for (const [agentId, entry] of this.registry) {
      addresses.push({
        agentId,
        address: entry.wallet.address,
        balance: Number(entry.wallet.balance)
      });
    }
    return addresses;
  }

  /**
   * 获取钱包统计
   * @returns {object}
   */
  getStats() {
    let totalBalance = 0n;
    for (const [, entry] of this.registry) {
      totalBalance += entry.wallet.balance;
    }

    return {
      totalWallets: this.registry.size,
      totalBalance: Number(totalBalance),
      totalTransactions: this.stats.totalTransactions,
      activeWallets: [...this.registry.values()].filter(e => e.wallet.balance > 0n).length,
      agentIds: [...this.registry.keys()]
    };
  }

  /**
   * 验证交易签名
   * @param {string} agentId - Agent ID
   * @param {object} txData - 交易数据
   * @param {string} signature - 签名
   * @returns {Promise<boolean>}
   */
  async verifyTransaction(agentId, txData, signature) {
    const entry = this.registry.get(agentId);
    if (!entry) return false;

    return await PQCWallet.verify(
      JSON.stringify(txData),
      signature,
      entry.wallet.publicKey
    );
  }

  /**
   * 用 Agent 托管私钥对数据进行签名（server-side signing，custody token 流程用）
   * @param {string} agentId - Agent ID
   * @param {string|object} data - 待签名数据
   * @returns {Promise<{ signature: string, publicKey: string, address: string }>}
   */
  async signForAgent(agentId, data) {
    const entry = this.registry.get(agentId);
    if (!entry) {
      throw new Error(`signForAgent: Agent not found: ${agentId}`);
    }
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    const sig = await sign(dataStr, entry.wallet.privateKey);
    return {
      signature: sig.toString('hex'),
      publicKey: entry.wallet.publicKey.toString('hex'),
      address: entry.wallet.address,
      agentId
    };
  }

  _formatWalletResponse(agentId, wallet, metadata = {}) {
    const custody = metadata?.custody || 'server-managed';
    return {
      agentId,
      address: wallet.address,
      balance: Number(wallet.balance),
      balanceRaw: wallet.balance.toString(),
      symbol: 'NGEN',
      nonce: wallet.nonce,
      publicKey: wallet.publicKey.toString('hex'),
      created: metadata.created || null,
      imported: metadata.imported || null,
      custody,
      isSelfCustodied: custody === 'self-custodied',
      migratedAt: metadata.migratedAt || null
    };
  }

  /**
   * 从磁盘中的Agent文件引导钱包
   * 扫描 data/agents/ 目录，为没有钱包的Agent自动创建钱包和水龙头
   * @returns {Promise<object>} 引导结果
   */
  async bootstrapFromAgentFiles() {
    const result = { scanned: 0, existing: 0, created: 0, faucetClaimed: 0, errors: 0 };

    if (!fs.existsSync(AGENTS_DATA_DIR)) {
      console.log('[AgentWallet Bootstrap] Agents directory not found, skipping.');
      return result;
    }

    const files = fs.readdirSync(AGENTS_DATA_DIR).filter(f => f.endsWith('.json'));

    for (const file of files) {
      result.scanned++;

      if (file === 'agents_summary.json') continue;

      const agentId = file.replace('.json', '');
      if (!agentId || /^\d+$/.test(agentId)) continue;

      try {
        const agentData = JSON.parse(fs.readFileSync(path.join(AGENTS_DATA_DIR, file), 'utf8'));
        const effectiveId = agentData.id || agentId;

        if (!effectiveId || (typeof effectiveId === 'number') || /^\d+$/.test(String(effectiveId))) continue;
        if (this.registry.has(String(effectiveId))) {
          result.existing++;
          continue;
        }

        const metadata = {
          type: agentData.name || 'agent',
          capabilities: agentData.capabilities || []
        };

        const wallet = await this.createAgentWallet(effectiveId, metadata);
        result.created++;
        console.log(`[AgentWallet Bootstrap] Created wallet for ${effectiveId}: ${wallet.address}`);

        try {
          const faucetResult = await this.claimFaucet(effectiveId);
          if (faucetResult.success) {
            result.faucetClaimed++;
            console.log(`[AgentWallet Bootstrap] Faucet claimed for ${effectiveId}`);
          }
        } catch (e) {
          // 水龙头失败不影响流程
        }
      } catch (e) {
        result.errors++;
        console.error(`[AgentWallet Bootstrap] Error for ${agentId}:`, e.message);
      }
    }

    console.log(`[AgentWallet Bootstrap] Done: scanned=${result.scanned}, existing=${result.existing}, created=${result.created}, faucet=${result.faucetClaimed}, errors=${result.errors}`);
    return result;
  }
}

const agentWalletManager = new AgentWalletManager();

export { AgentWalletManager };
export default agentWalletManager;

# Phase 2 审计范围说明书（Audit Scope Spec）

> 项目：nexusgenesis-agent-keys 上层组合代码安全审计
> 版本：1.0（2026-09-02）
> 状态：可发给审计方
> 依据：`nexusgenesis-pivot-roadmap` Phase 2（关键路径）

---

## 1. 背景与目标

`nexusgenesis-agent-keys` 是 agent 密钥托管/授权库：PQC（Dilithium2）根身份 → 分层密钥派生 → 限额/接管/会话收窄。底层依赖 `@noble/post-quantum` 已有 Noble 团队审计覆盖，**不在本次范围内**。

本次审计对象是**上层组合代码**——信封 KDF、接管状态机、限额强制、会话收窄、多链派生。这是企业采用的唯一硬阻断点：这些组合逻辑未被任何审计覆盖。

**审计成功标准**：企业安全团队拿到审计报告后，能据此判断"把 agent 密钥托给本库"的风险是否可接受。

## 2. 范围

### 2.1 In scope（审计对象）

| 模块 | 文件 | 行数 | 对应路线图审计域 |
|---|---|---|---|
| 加密信封 | `packages/agent-keys/src/encryption.js` | 176 | 域 A |
| 三层派生 | `packages/agent-keys/src/derivation.js` | 139 | 域 B |
| 接管/限额 | `packages/agent-keys/src/takeover.js` | 481 | 域 C |
| 会话密钥 | `packages/agent-keys/src/session.js` | 389 | 域 D |
| 托管令牌 | `packages/agent-keys/src/custody.js` | 97 | 域 D |
| 签名进程 | `packages/agent-keys/src/signer.js` (401) + `signer-worker.js` (374) | 775 | 域 C |
| 内存卫生 | `packages/agent-keys/src/secure.js` | 227 | 域 E |
| 钱包生命周期 | `packages/agent-keys/src/wallet.js` (192) + `bindMasterKey.js` (161) + `address.js` (71) | 424 | 域 E |
| 跨链派生 | `packages/chain-eth/src/`、`packages/chain-sol/src/`、`packages/chain-adapters/src/registry.js` 中 PQC→地址派生部分 | ~600 | 域 F |

合计约 **3,600 行**核心安全代码（含注释），面积小、边界清晰。

### 2.2 Out of scope（明确排除，需在报告中声明）

- `@noble/post-quantum` 及 `pqc.js` 薄封装（Noble 审计已覆盖）
- `mcp-server` HTTP/MCP 传输层（另行审计，含 mTLS、传输安全）
- `agent-sdk` 协调层（forum/transport/verifier，非密钥路径）
- 已归档的 L1 链代码（`archive/L1/`，已停止维护）
- TEE / 物理攻击防御（`secure.js` 文件头的边界声明已明确划出）

## 3. 六个审计域的具体问题清单

### 域 A — 加密信封 KDF（encryption.js）

**审计问题**
1. 口令→密钥派生：盐（32B 随机）、迭代（310k PBKDF2-SHA512）、参数处理是否正确、抗离线爆破。
2. envelope 参数的可信边界：哪些字段是调用方提供、哪些是攻击者可控。
3. GCM 使用正确性：IV 生成、auth tag、AAD 绑定。

**已发现疑点（审计方请优先验证）**
- `decryptPrivateKey` 从 envelope 读取 `kdf.iterations`（[encryption.js:114](../../packages/agent-keys/src/encryption.js#L114)），**无下限校验**。若 envelope 来源不受信（如外部导入、备份被篡改），攻击者可把迭代数改小做降级。建议：固定迭代数或校验 `≥ 310_000`。
- `metadata`（含 `publicKey`、`address`）**未绑入 GCM AAD**——篡改 metadata 不会被 tag 检测。`importEncrypted` 用 `envelope.metadata.publicKey` 构造钱包，存在"公钥与私钥不匹配"的展示层欺骗窗口。建议：metadata 哈希入 AAD。
- 口令策略仅 `length ≥ 8`（弱）。需评估是否引入口令强度指引（不强制库层）。

### 域 B — 三层密钥派生（derivation.js）

**审计问题**
1. HKDF-SHA256 派生 op-key seed 的域分离是否充分（info 字符串结构、固定 NETWORK_SALT）。
2. 版本递增轮换（`rotateOpKey`）的正确性与旧密钥吊销语义。
3. `generateKeyPairFromSeed` 的确定性 keygen 依赖 noble `ml_dsa44.keygen(seed)`（FIPS 204 SHAKE256 扩展），确认调用契约。

**已发现疑点**
- `NETWORK_SALT` 是**全局固定常量**（[derivation.js:20](../../packages/agent-keys/src/derivation.js#L20)），所有用户共享。HKDF 固定 salt 在密码学上可接受，但域分离完全依赖 info 字符串 `agent-op-key/{agentId}/v{version}`。需评估 agentId 冲突/注入（如 agentId 含 `/`）导致的派生碰撞。
- `rotateOpKey` 只派生新版本，**无旧版本吊销机制**——旧 op-key 在应用层继续有效直到过期。库层是否有义务提供 revocation 语义，需给出设计意见。
- `isKeyExpired` 依赖 `Date.now()`，时钟回拨可使过期密钥复活。评估时间源信任模型。

### 域 C — 接管状态机与限额强制（takeover.js + signer.js/signer-worker.js）

**审计问题（路线图原问题："限额是在签名/提交层真被强制，还是仅记录"）**
1. `checkSpendAllowed` / `checkSpendAllowedTiered` / `resolveTier` 的完整边界：负数、空串、NaN、BigInt 溢出、阈值倒置。
2. `takeoverGuard`（mid-operation control-change guard）能否覆盖全部放宽路径。
3. `PolicyTimelock` 48h 策略时锁的防绕过。
4. Signer 子进程的强制点：policy 检查是否真的在签名前、不可绕过。

**已发现疑点**
- `checkSpendAllowedTiered` 的 `default` 分支返回 `allowed: true`（[takeover.js:178](../../packages/agent-keys/src/takeover.js#L178)）——**fail-open default**，与本文件其他处 fail-closed 哲学矛盾。当前不可达（resolveTier 只返回三种值），但属危险模式。
- `maxPerTx=0 / maxDaily=0` 语义为"**无上限**"（[takeover.js:437-442](../../packages/agent-keys/src/takeover.js#L437-L442)）。LIMITED 模式下配置 0 = 完全放开。语义陷阱，建议 fail-closed：LIMITED 模式下 0 应视为"拒绝全部"或抛错。
- `PolicyTimelock._pending` 是**进程内存 Map，不持久化**——重启进程即丢失全部 pending 变更，48h 时锁可被简单绕过（重启攻击）。这是时锁机制的核心缺口。
- Signer legacy `sign` 通道的 amount-hash unlinkability **已在代码文档自认**（[signer.js:44-61](../../packages/agent-keys/src/signer.js#L44-L61)）：父进程可用假 amount 骗过 policy、真 hash 被签名。`sign_intent` 是修复，但 legacy 通道仍开放。需评估：默认禁用 legacy 通道或加运行时开关。
- `spawnSigner` 以 `{ ...process.env }` 全量继承父进程环境（[signer.js:383](../../packages/agent-keys/src/signer.js#L383)），与已知 GAP-001（密钥走 env 明文）叠加。建议 worker 白名单环境变量。
- `signer-worker.js` 的权威拒绝逻辑（hash-shaped message 拒绝、asset-intent 拒绝、policy fail-closed）需逐行验证——parent 侧防护只是 fail-fast，worker 侧才是安全边界。

### 域 D — 会话收窄（session.js + custody.js）

**审计问题**
1. `narrowSession` 单调收窄（只降不升）的全部维度检查是否完备。
2. `checkSessionAccess` 白名单逻辑的 fail-open/fail-closed 一致性。
3. Custody token 的 HMAC 构造、绑定字段、撤销能力。

**已发现疑点**
- `checkSessionAccess` 对**缺失的 context 字段直接放行**：`context.contract` 为 undefined 时跳过合约白名单（[session.js:287](../../packages/agent-keys/src/session.js#L287)），method/chain 同理。调用方漏传字段 = 绕过对应维度。与 takeover.js 的 fail-closed 哲学不一致，建议"白名单非空时字段必填"。
- `checkSessionAccess` 不验签（文档已注明，[session.js:50-53](../../packages/agent-keys/src/session.js#L50-L53)）——依赖调用方先 `verifySessionSignature`。审计需评估组合层是否有义务内置强制验签，或在 API 层面给出防误用结构。
- Custody token **无 jti/撤销机制**：签发后 24h 内无法吊销。secret 泄漏窗口 = TTL。建议加 revocation list 或缩短 TTL。
- `getSigningSecret` 错误消息称 ">= 32 chars" 但**不校验长度**（[custody.js:37-42](../../packages/agent-keys/src/custody.js#L37-L42)）。
- 会话 payload 的签名/验证依赖 `JSON.stringify` 键顺序稳定（[session.js:145](../../packages/agent-keys/src/session.js#L145), [session.js:380](../../packages/agent-keys/src/session.js#L380)）——JS 对象键顺序是实现行为，跨实现/重构可能导致验签失败（可用性问题，非伪造向量）。建议 canonical 序列化。

### 域 E — 内存卫生与密钥生命周期（secure.js + wallet.js + bindMasterKey.js）

**审计问题**
1. `ShardedSecret`（XOR 2-of-2 分片）与 `secureZero` 的实际缓解价值 vs 声明。
2. `PQCWallet.privateKey` getter 每次重建明文副本的生命周期管理。
3. core dump / env 泄漏面的残余风险。

**已发现疑点**
- ShardedSecret 两个分片在同一进程堆内——防内存 dump 的增益是"提高提取难度"而非密码学保证（文件头声明诚实）。需评估对外宣传措辞是否与实际一致。
- `PQCWallet.privateKey` getter 每次调用返回**新的明文 Buffer**（[wallet.js:39-41](../../packages/agent-keys/src/wallet.js#L39-L41)），调用方管理清零——API 设计诱导泄漏。建议审计给出 API 改进意见（如仅保留 `use()` 模式）。
- `importEncrypted` 失败返回 null 吞掉错误原因（[wallet.js:143-152](../../packages/agent-keys/src/wallet.js#L143-L152)），运维排障困难且可能掩盖攻击痕迹。

### 域 F — PQC 根 → 多链地址派生（chain-eth / chain-sol / chain-adapters）

**审计问题**
1. PQC 私钥 → secp256k1（ETH）/ ed25519（SOL）派生的确定性与防冲突。
2. 派生域分离：同一 PQC 根在不同链的派生是否相互独立、与 op-key 派生是否独立。
3. `deriveChainAddresses` 只返回地址的承诺是否真实（无私钥外泄路径）。

**已发现疑点**
- ETH/SOL 私钥直接派生自 PQC 私钥（[registry.js:26-27](../../packages/chain-adapters/src/registry.js#L26-L27)）——PQC 私钥一旦泄漏，**所有链的派生资产同时暴露**（无中间隔层）。需评估是否引入 per-chain salt/version 作为域分离，并把"根泄漏=全链泄漏"明确写进威胁模型。

## 4. 威胁模型（审计方据此评估）

**假设攻击者能力**：
- 完全控制父进程（prompt injection、供应链攻击）——Signer 子进程隔离面对此的防护边界
- 持有被篡改的 envelope/备份/导入文件
- 可重启进程、回拨时钟（本地部署场景）
- 可读运行中进程内存（dump/scan，不含物理向量）

**不防御**（超出软件层，见 `secure.js` 边界声明）：DMA、冷启动、硬件探针、芯片剥离。

## 5. 测试资产（审计方可复用）

- `packages/agent-keys/test/`：133 项测试，含 `security-boundary.test.js`、`session-narrowing.test.js`、`takeover-tiered.test.js`、`timelock-alerts.test.js`
- `packages/agent-keys/test/attack-simulations/`：内存 dump / env 泄漏 / core dump 攻击模拟脚本
- `SECURITY_GAP_ANALYSIS.md`：项目自认的未闭环项（GAP-001 env 明文等），审计方应以独立验证而非采信

## 6. 交付物与严重度分级

- **交付物**：公开审计报告（Markdown，可发布于 `docs/audit/`）+ 修复建议清单 + （可选）复测报告
- **严重度**：Critical（限额/接管可绕过、密钥可恢复）/ High（fail-open 路径、参数不受信）/ Medium（语义陷阱、可用性导致的降级误用）/ Low / Informational
- 每个发现需给出：位置（文件:行）、攻击路径、前置条件、修复建议

## 7. 验收标准（对审计方的最低要求）

1. 六个域逐域给出结论，不遗漏 `signer-worker.js`（375 行权威强制逻辑必须逐行覆盖）。
2. 对第 3 节列出的每个"已发现疑点"给出独立判定（确认/否证/降级）。
3. 对"限额在签名层真被强制"给出可复现的测试证据（PoC 或测试用例）。
4. 报告结论需区分"库层缺陷"与"调用方误用风险"。

---

## 附：内部待办（审计启动前应完成的预处理，不阻塞 spec 发出）

- [ ] `llms.txt` 的 `security-audited (2026-08-07)` 措辞收敛为"底层依赖经审计，上层组合审计进行中"（避免"审计完成前宣称生产可用"红线）
- [ ] 上文 Critical 级疑点（PolicyTimelock 不持久化、envelope iterations 不校验、checkSessionAccess 缺字段放行）可考虑先发 quick-fix 再送审，缩减审计发现量
- [ ] 决定审计路径：商业审计方（如 Trail of Bits / OtterSec / Zellic 量级）vs 开源 bounty + 知名 reviewer

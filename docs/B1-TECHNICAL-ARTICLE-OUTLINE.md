# B1 技术文章大纲

> **定位**：面向技术社区（HN / LocalLLaMA / X）的深度实战文章
> **核心卖点**：Agent 密钥自托管 + 后量子安全 + 人类随时回收控制权
> **状态**：初稿大纲

---

## 标题方案（选一）

### 方案 A（问题驱动，推荐）
**"Your AI Agent's Private Key Is Someone Else's — Here's How to Fix It"**

### 方案 B（技术硬核）
**"Self-Custody Agent Keys: Post-Quantum Signatures, Memory Sharding, and Process Isolation in Pure JavaScript"**

### 方案 C（争议性）
**"Every AI Agent Framework Gets Key Security Wrong — We Built One That Doesn't"**

---

## 文章结构

### 1. 引言：一个令人不安的事实

**核心论点：** 当前所有主流 AI Agent 框架（LangChain / AutoGPT / CrewAI / ElizaOS）的密钥管理方式存在根本性安全缺陷——**Agent 的私钥以明文形式存在于服务器内存或环境变量中**。

**关键数据点：**
- 主流 Agent 框架中，密钥托管在第三方（服务器/API 提供商），用户不拥有私钥
- 即使是自托管方案，密钥也以明文形式存在于进程内存中，可被核心转储、内存 dump 或 swap 扫描提取
- 绝大多数方案仍使用 ECDSA/Ed25519，未考虑后量子威胁

**问题：**
> "If your agent's private key is on a server you don't control, you don't own your agent."
> — 如果 Agent 的私钥在你不控制的服务器上，你就不拥有你的 Agent。

**过渡：** 本文展示一种纯 JavaScript 方案，在浏览器/Node.js 中实现 PQC 密钥自托管，同时满足内存安全、进程隔离、精细化权限控制三个维度的安全要求。

---

### 2. 选型：为什么是 Dilithium2？

**背景：** NIST FIPS 204 标准在 2024 年 8 月正式发布 ML-DSA（Dilithium）为后量子签名标准。

**基准对比表：**

| 指标 | Dilithium2 (FIPS 204) | ECDSA P-256 | Ed25519 |
|------|----------------------|-------------|---------|
| KeyGen (ms) | 1.68 | 0.06 | 0.05 |
| Sign (ms) | 6.30 | 0.06 | 0.05 |
| Verify (ms) | 1.68 | 0.01 | 0.13 |
| 公钥大小 | 1,312 B | 91 B | 44 B |
| 签名大小 | 2,420 B | 64 B | 64 B |
| 量子安全 | ✅ 是 | ❌ 否 | ❌ 否 |

**关键结论：** Dilithium2 签名比 ECDSA 慢约 100 倍，但 6.3ms 在绝大多数 Agent 场景中仍然可接受（Agent 的瓶颈在 LLM 推理，不在签名）。**性能差异被过度夸大——真正的瓶颈在别处。**

**信任链说明：** 底层使用 `@noble/post-quantum`（FIPS 204 实现），上层包装代码尚未经独立审计——区分"已审计原语"和"未审计组合层"。

---

### 3. 内存安全：私钥在内存中不留痕迹

**问题：** JavaScript 的垃圾回收机制不会主动清零敏感数据，私钥在内存中可能残留数秒甚至数分钟，可被核心转储（core dump）、`/proc/mem` 扫描或 swap 分区提取。

**方案：ShardedSecret 内存分片**

```
私钥  =  Shard₁ ⊕ Shard₂
         (256 字节)    (256 字节)
```

- 私钥被拆分为两个非连续分片，分别存储于堆的不同位置
- 签名时临时 XOR 拼接，签名完成后立即清零
- `secureZero()` 用 Buffer.fill(0) 确定性覆盖，不依赖 GC

**代码示例（精简）：**

```javascript
import { ShardedSecret } from 'nexusgenesis-agent-keys';

const sharded = new ShardedSecret(privateKey);
// 此时 privateKey 缓冲区已被清零

// 签名：临时拼接，用完即焚
const sig = sharded.use(pk => signSync(hash, pk));
// 签名后 pk 缓冲区被清零，分片各自独立存在
```

**实证验证：** 在 ShardedSecret.use() 执行后，触发 5 轮 V8 全 GC，导出完整堆快照（~30MB），扫描二进制明文和 hex 两种形态——**均未发现残留的连续私钥**。

**已知边界：** 纯软件方案无法防御 DMA 攻击、冷启动攻击或硬件调试接口。这些需 TEE（如 Intel SGX / AMD SEV）或硬件钱包。

---

### 4. 进程隔离：私钥关进"子进程保险箱"

**问题：** 如果父进程被攻陷（例如通过依赖库漏洞或 prompt injection），攻击者可以读取父进程内存中的任何数据。

**方案：** 将私钥隔离在专用子进程中，父进程仅通过 stdio IPC 发送待签名的 hash 并接收签名结果。

```
┌──────────────┐     JSON-line IPC (stdin/stdout)     ┌──────────────────┐
│  父进程       │ ──────────────────────────────────→  │  Signer 子进程    │
│  (Agent)      │     { type: "sign", hash: "0x..." }  │  (私钥持有者)     │
│              │ ←──────────────────────────────────  │                  │
│              │     { type: "signature", sig: ... }   │  ShardedSecret   │
└──────────────┘                                      │  no network      │
                                                       │  no file access  │
                                                       │  idle timeout    │
                                                       └──────────────────┘
```

**安全设计：**
- 子进程永不知道明文交易金额（amount），只签名 hash——防止泄露
- 1MiB 消息上限，防止注入攻击
- 空闲超时（默认 5 分钟）自动退出，缩短密钥驻留窗口
- 密码通过 stdin 传入，不暴露于环境变量或命令行参数
- 支持 `NGX_SIGNER_DOWNGRADE=1` 自动降级为 nobody 用户
- 配套 seccomp 白名单 profile（`defaultAction: SCMP_ACT_ERRNO`）

**已知限制：** amount-hash 不可链接性——子进程无法验证被签名的 hash 是否与声称的金额一致。缓解策略：（1）session key 层验证金额范围；（2）大额交易人工核实原始数据；（3）未来 ZK 方案。

---

### 5. 精细化权限：Session Key 五维权限模型

**问题：** 一个被攻陷的 Agent 可以做任何事——没有权限边界。

**方案：** Session Key 五维权限模型——在"额度"之外增加"范围"限制。

```javascript
const session = createSessionKey(masterKey, {
  agentId: 'my-agent',
  allowedContracts: ['0xA1b2...', '0xC3d4...'],  // 限定合约
  allowedMethods: ['swap', 'transfer'],            // 限定方法
  allowedChains: ['ethereum', 'polygon'],          // 限定链
  maxPerTx: '100',                                 // 单笔上限
  maxDaily: '1000',                                // 日累计上限
  ttl: 24 * 60 * 60 * 1000,                       // 24 小时过期
});
```

**核心设计：**
- 权限**只降不升**：`narrowSession()` 派生会话只能收窄，不能放宽
- 省略维度继承父作用域，显式空数组/`'0'`（无限制）在受限父会话下视为提权并拒绝
- 非法输入 fail-closed：异常值默认拒绝，而非"碰巧通过"

**使用案例：**
```javascript
// 给子任务一个更窄的会话
const narrow = narrowSession(parentSession, {
  allowedContracts: ['0xA1b2...'],  // 只允许一个合约
  maxPerTx: '10',                    // 单笔限额更低
  ttl: 60 * 60 * 1000,             // 1 小时
}, masterKey);
```

---

### 6. 策略弹性：三级梯度授权 + 时间锁

**问题：** Agent 的全自动运行和人类的安全监管之间存在根本矛盾——要么完全放开（有风险），要么每笔审批（不可用）。

**方案：** 三级梯度授权

| 金额范围 | 档位 | 行为 | 延迟 |
|---------|------|------|------|
| < 10 NGEN | 小额自动放行 | 自动签名，零延迟 | 0 |
| 10-100 NGEN | 中额时间锁 | 24h 可撤销延迟，到期后自动生效 | 24h |
| ≥ 100 NGEN | 大额人工审批 | 需要人类私钥签名 | 无限 |

**策略变更时间锁：** 任何策略变更（如降级安全级别、上调限额）强制 48h 延迟生效，配套 Webhook 通知（`POLICY_WEBHOOK_URL`），形成"检测→延迟→处置"闭环。

**架构意义：** 即使攻击者完全攻陷了 Agent，也无法在 48 小时内转走大额资产——足够人类介入撤销。

---

### 7. 完整示例：从零到安全签名

```javascript
import { generateKeyPair, createSessionKey, checkSessionAccess, spawnSigner } from 'nexusgenesis-agent-keys';

// 1. 生成 PQC 密钥对
const { publicKey, privateKey } = await generateKeyPair();

// 2. 创建会话密钥
const session = createSessionKey(privateKey, {
  agentId: 'demo-agent',
  maxPerTx: '50',
  ttl: 86400000,
});

// 3. 验证权限
if (checkSessionAccess(session, { amount: '30' }).allowed) {
  // 4. 启动隔离 signer
  const signer = await spawnSigner({ privateKey, policy: { type: 'limit', maxPerTx: '50' } });
  const sig = await signer.sign({ hash: '0x' + 'ab'.repeat(32), amount: '30' });
  console.log('签名:', sig);
  signer.close();
}
```

---

### 8. 与现有方案对比

| 维度 | NexusGenesis | LangChain + Wallet | Lit Protocol | Web3Auth |
|------|-------------|-------------------|-------------|----------|
| 密钥所有权 | **用户自托管** | 托管方持有 | MPC 碎片 | 托管方持有 |
| 密码学 | **PQC (Dilithium2)** | ECDSA | ECDSA | ECDSA |
| 内存安全 | **ShardedSecret + GC 实证** | 无 | 无 | 无 |
| 进程隔离 | **Signer 子进程** | 无 | MPC 节点 | 无 |
| 权限粒度 | **五维（合约+方法+链+双限额）** | 仅限额 | 合约级 | 用户级 |
| 策略时间锁 | **48h 延迟 + Webhook 告警** | 无 | 无 | 无 |
| 人类接管 | **三级梯度 + 只降不升** | 无 | 需改 MPC 配置 | 无 |
| 审计状态 | 组合层待审计 | 已审计 | 已审计 | 已审计 |

---

### 9. 结语

**核心论点回顾：** Agent 密钥自托管不仅是"应该"做的，而且是"可以"在纯 JavaScript 中做好的——通过内存分片、进程隔离、精细化权限和策略时间锁的组合。

**下一步：**
- 试用：`npm i nexusgenesis-agent-keys`
- 命令行：`npx nexusgenesis-agent-keys-cli tier 50`
- Claude Desktop/Cursor 集成：`npm i nexusgenesis-agent-keys-mcp`
- 贡献/反馈：GitHub Issues
- 漏洞报告：Immunefi（Critical 50K NGEN 赏金）

**技术社区讨论点（抛砖引玉）：**
- Dilithium2 的签名大小（2.4KB）在链上交易中的 gas 成本优化
- 纯 JS 密码学 vs WASM/native binding 的性能-安全性权衡
- 进程隔离在 serverless 环境下的适用性

---

## 发布计划

| 渠道 | 建议形式 | 时间 |
|------|---------|------|
| Hacker News | 纯文本帖，直接贴文章链接 | 发布日 |
| r/LocalLLaMA | 技术分享帖 + 代码示例 | 发布日 |
| X / 𝕏 | 简短线程（5-7 条），突出对比表 | 发布日 + 每周 |
| dev.to | 完整转载 | 发布日 |
| 项目 README | 末尾加文章链接 | 发布后 |

---

## 待办

- [ ] 核对代码示例与 0.3.1 API 一致
- [ ] 生成可运行的配套仓库示例
- [ ] 截取关键截图（CLI 运行、测试结果、堆快照扫描结果）
- [ ] 检查引用/数据准确性
# Sprint 6 任务单 — 分布式 / 多实例运行能力

> 前置：Sprint 3/4/5 已落地，Transport Security P1 全部闭环（`feat/sprint4-transport-security` 分支，5 commits：`f03595d8` `bbd8068f` `64d53da8` `d5ccb22b`）。
> Sprint 1-5 交付的都是**单进程**能力。Sprint 6 把白皮书主线从"单机可跑"推进到"**可部署、可扩展、可多实例运营**"。
> 主线：把 4 个"进程内 Map + 本地 JSON 文件"形态的分布式状态，升级为**跨实例可见 + 并发安全**，且不破坏既有 fail-closed 语义。
>
> 分支建议：从 `feat/sprint4-transport-security` 新建 `feat/sprint6-distributed`（Sprint 6 独立性更强；若不新建可直接续用）。
> 结构沿用"实现 → 独立复核 → 修复 → 回归"闭环，每 T 完成即全量回归。

## 0. 复核对齐（防重复规划）— 已完成

现状（4 个待分布式化的组件，均为单机/本地文件态）：

| 状态对象 | 现状形态 | 文件 | 分布式缺口 |
|---------|---------|------|-----------|
| **replay guard** | 进程内 Map + 本地 JSON 原子写，无锁假设 | `packages/agent-sdk/src/transport-security.js`（`createReplayStore`，L17-72） | 多实例各自持有独立 replay 窗口 → 同一信封可被多实例各自放行一次（重放窗口不共享） |
| **simulationLog / arming** | 进程内 Map，随状态文件落盘 | `mcp-server/src/server.js`（L160-174） | 实例 A 模拟 arm 的 digest，实例 B 看不到 → B 对该请求 fail-closed（arm 不跨实例可见） |
| **chain state / tx ledger** | 全量 JSON 一笔写，原子写退化 double-write | `mcp-server/src/chain-state-store.js`（`loadChainState`/`saveChainState`，L65-111） | 多实例并发 `save` → **last-write-wins 互相覆盖**（丢账号/丢台账）；`save` 的 tmp 写 + 已存在目标 rename 在 Windows 退化为二次 writeFileSync → 无真正原子性 |
| **dailyCumulative（maxDaily）** | 进程内 Map，单机语义 | `mcp-server/src/policy-engine.js`（`createDailyCumulativeStore`，L130-189） | 实例各自累计 → 多实例可绕过程序内 maxDaily（链上 `accountMaxDaily` 仍兜底真实损失，但软层账目漂移） |
| **relayer nonce** | 从节点 `getTransactionCount()`（pending）带重试 | `mcp-server/src/relayer-operations.js`（`executeWithRelayerResilience`，L31-69）+ `chain-connection.js` | 两实例同时取同一 nonce 各自 `sendRawTx` → **nonce 冲突**：一个必失败重试（能恢复），但在 pending 未及时反映时会重复广播、gas 竞争 |

**非分布式（保持单机语义，明确不发生共享）**：
- **policy 规则文件**：`policy-engine.js` 的 `loadPolicyWithHealth` 每请求单次读 `SMART_ACCOUNT_POLICY_FILE`。多实例若挂载同一共享卷即天然一致（同一文件 + 每请求重读）；不同卷则各实例独立策略。**Sprint 6 只保证"同一份文件对多实例一致可见"，不做多主写入/最终一致传播**（策略写入口单一：运维更新共享文件，非运行时多写）。
- **long-term keys / signer**：INV-001 隔离签名子进程仍是单机单进程；多实例下各实例持各自 signer 副本。密钥分发属 Sprint 7/后续。

---

## 关键设计约束

1. **fail-closed 语义不因分布式而放松**。任何共享化都必须：单实例时行为 === 现基线测试；多实例时"宁可拒、不可错放"。共享后端不可用时 → 显式降级策略（fail-closed 或拒绝启动），绝不静默退化为"各自独立窗口"把安全性放低。
2. **共享后端可插拔，零隐式依赖**。默认用**可落地的本地基础能力**（SQLite `node:sqlite` / 单文件 WAL / 文件锁），把 Redis / 集中服务 / 链上注册表定义为**可选 SPI**，CI 无外部服务也能全绿。避免为"也许需要 redis"引入运维依赖。
3. **并发正确性优先顺序**：atomicity（原子读改写）> serializability > availability。state store 保存从"全量覆盖"改为"**按 key 的带版本合并**（optimistic concurrency / CAS）"，杜绝 last-write-wins 丢数据。
4. **跨实例一致性应是"最终一致 + 审计可对账"**，而非强同步长事务。每处共享临界区都落审计 `instanceId`，重启/恢复后能对账谁改了什么。
5. **先隔离后共享**：先把 4 个进程内状态从 `server.js` 大泥球中**抽成独立 store 模块**（可注入后端），再逐个接共享后端。防止一次改造动判断逻辑。

---

## T1 共享抽象：把状态抽成可注入 store 接口（基建，无外部依赖）

**目标**：确立统一的后端抽象，后续 T2-T4 复用同一套接口，一次设计多组消费。

- T1.1 新建 `packages/agent-sdk/src/store-interface.js`（共享 type 约定 + 后端判空 fail-closed 辅助）：
  - `createLocalStore({ file, defaults })`：现"进程内 Map + 本地 JSON"的封装，作为**默认后端**（Type: local），单实例语义与现基线逐字节一致（回归保底）。
  - `createSqliteStore('./shared.sqlite')`：基于 `node:sqlite` 的单文件 WAL 后端（Type: sqlite）——多进程可打开同一文件，提供**原子 read-modify-write / UPSERT / 事务**，作为本 Sprint 的共享默认。（`node:sqlite` 于 Node 22.5+ 内置实验性；需在方案中确认可用版本，不可用则回退 `better-sqlite3` 可选依赖或文件锁。）
  - `createRedisStore(url)`：仅定义 SPI 契约（`get/put/compareAndSet/scan`），作为可选后端占位——**不在本 Sprint 实现/依赖**，仅留接口与文档，避免未用依赖。
  - 所有后端统一暴露：`read(schema) / writeAtomically(key, mutate, {cas}) / list(schema) / instanceFamilyId()`。
- T1.2 后端选择解析 `resolveStateBackend(kind)`，kind ∈ `auto|local|sqlite`（auto=有共享文件路径则 sqlite，否则 local）。
- 验收：同一套 store 语义测试（read/write/atomic readModifyWrite/并发双进程）在 local 与 sqlite 后端都跑通；后端不可用（文件只读/损坏）→ 显式报错或 fail-closed，不静默回退空态放行。
- 复核关注点：接口是否过度设计（保持 3-4 个方法）；sqlite 后端是否真原子（WAL 并发写是否串行化）；local 后端是否与现基线行为完全一致。

## T2 replay guard 共享化（防重放窗口跨实例统一）

**目标**：同一 `(sender:nonce)` 只被整个服务族放行一次，多实例各自持有窗口的漏洞关闭。

- T2.1 把 `createReplayStore` 重构为基于 T1 store 接口的**可注入后端**：默认 local（现行为）；sqlite 后端提供跨进程 `INSERT OR IGNORE (sender,nonce)` 原子 claim——验签通过后仅首个实例能 `record` 成功，其余 `exists` 判定为重放。
- T2.2 **并发正确性**：防重放的关键是在"验签通过后"原子登记 nonce（INV-009 已有：verifyMessageEnvelope 验签后才 record）。sqlite 后端用 `INSERT OR IGNORE` 唯一约束 (sender,nonce) 保证**恰好一次登记**——T1 的 `writeAtomically` + encryption/claim 语义在此落地。登记成功者后续可消费，失败者即重放。
- T2.3 窗口清理：共享端按 timestamp 定期 purge 过期窗口（单实例 leader 或 lazy purge），避免共享表无限增长；窗口时长与单机保持一致（绝对值时间，重启不丢）。
- 验收：
  - 双实例共享 sqlite：实例 A record (s,n) → 实例 B `has(s,n)`=true（重放拒绝）；未过窗口跨实例可见。
  - 重启共享表不丢窗口（与 T5.2 已有"重启后重放仍拒"一致，但跨实例）。
  - 后端降级（sqlite 不可写）→ 显式告警 + fail-closed 拒绝启用（不静默退回各自窗口）。
- 复核关注点：INSERT OR IGNORE 后是否需在"record 成功"才返回 200（防"记录失败但当成功"）；窗口 expired 清理与窗口延长边界的并发。

## T3 simulationLog / chain state / tx ledger 持久层升级 + 跨实例可见

**目标**：arming 与状态跨实例可见 + 并发不丢数据。

### T3 设计定稿（CAS 合并策略，规划校订）

**核心洞察：不是所有状态都该 CAS。** 按数据本质分三类语义，各配正确原语：

| 数据类别 | 本质 | 并发冲突语义 | 原语（T1 store） |
|---------|------|-------------|-----------------|
| account 注册（新 accountId 行） | 注册表插入 | 恰好一次 | `claim` |
| account 可变字段（sessions/txHashes append、currentSessionId） | append-union | 并集合并，无胜负 | `writeAtomically` RMW（mutate 内 union） |
| account 不变量（owner/contractAddress/emergencyKey/chainUrl） | 创建后不可变 | **不允许冲突** | 冲突检测 → 显式 `CONFIG_CONFLICT`（fail-closed + 审计），绝不静默取一方 |
| simulationLog arm | 最新意图覆盖 | **LWW 是正确语义**（见下） | `write`（覆盖，无需 CAS） |
| txLedger 事实 | append-only 不可变 | 无冲突 | 首条 `claim` + 演进 append |
| chainUrl/profile 单例 | 首写定环境 | 首者胜 | `claim`；后到者读到不符 → 沿用现 chain-environment guard 拒绝恢复 |

**"LWW 语义正确"论证**（规划要求显式论证）：
- **arm 的 LWW 是功能语义而非缺陷**：arm 表示"该账户最近一次成功 preview 的意图"，execute 必须带匹配 digest 才放行。两实例并发对同一 account 各 arm 不同 digest → 后写者胜出 → 先写实例 execute 时 digest 不匹配 → fail-closed 重新 preview。**安全性由 digest 匹配保证，与写入顺序无关**——覆盖即正确。
- **accounts/txLedger 的 LWW 才是缺陷**：全量覆盖下 append 丢行（实例 A 注册 acc1、实例 B 注册 acc2 → 后写覆盖前写）。修法**不是给全量文件加版本号 CAS**（那只是把"丢数据"换成"丢更新"——CAS 失败重试仍要全量重算，且所有实例竞争同一版本号，吞吐塌缩），而是**分片到行级**：`state:account:<accountId>` 一行一 key。行级分片后不同行天然不竞争（并发写不同 accountId 零冲突），同行冲突按上表原语处理。
- **全文件 CAS 是反模式**（显式排除）：单 key `writeAtomically` 承载整个状态文件 = 任何实例写任何账户都串行竞争同一版本，重试风暴，且未解决合并语义。

**分片 schema**：
```
chain:meta                 → { chainUrl, profile }                      claim 一次（环境单例）
state:account:<accountId>  → serializeEntry 输出                        claim（新）/ RMW（更新）
sim:arm:<accountId>        → { digest, at }                             write（LWW 正确）
ledger:tx:<txHash>         → { records: [rec...] }（生命周期演进追加）    claim（submitted 首条）+ RMW append
```

**RMW mutate 内合并规则**（`state:account` 行）：
- `sessions`：`unionBy(existing, incoming, 'sessionId')`（sessionId 幂等去重——两实例并发开不同 session → 两条都保留）
- `txHashes`：union + 环形裁剪至 `MAX_TX_HASHES_PER_ACCOUNT`(20)
- `currentSessionId`：incoming 非空取 incoming（与单机顺序 set 语义一致）
- 不变量字段：existing 存在且 ≠ incoming → throw `STATE_CONFIG_CONFLICT`（同 accountId 两实例 setup 参数不同 = 配置漂移，必须显式失败并审计，绝不静默取任何一方）
- 台账环形：`evictOldest('ledger:tx:', MAX_TX_RECORDS=200)`

**接线与兼容**（对外行为不破坏基线）：
- [chain-state-store.js](mcp-server/src/chain-state-store.js) 内部实现换 T1 store（`resolveStateBackend`：`SMART_ACCOUNT_STATE_FILE` 以 `.sqlite` 结尾 → sqlite 共享；`.json`/缺省 → local 单机）；**对外 API 签名不变**（`loadChainState`/`saveChainState`/`recordTx`/`listTx`/`recordBroadcast`/`serializeEntry`）
- server.js：`persistSmartAccountState()` → `persistAccount(accountId)` 按行写（不再全量）；arm 点（L902）写 `sim:arm:<accountId>`；`restoreSmartAccounts` 从分片读回 + 保留 chain-environment guard
- 旧 JSON 格式检测迁移：启动发现旧格式（顶层 `accounts` 数组）→ 一次性迁入 store，原文件留 `.bak`
- 纯内存模式（无状态文件）：`createLocalStore()` 内存态——现回归行为不变
- Windows 原子性：local 后端沿用 tmp+rename（Windows 退化覆盖，单实例低风险接受）；sqlite 后端天然事务原子

**降级（fail-closed 决策显式化）**：
- 显式配置 sqlite（`.sqlite` 后缀 / `NEXUS_STORE_BACKEND=sqlite`）但构造失败 → **启动失败**（状态丢失比不可用更危险，绝不静默降级 local）
- auto/local：与现基线一致

### 任务分解（沿原 T3.1-T3.3，按上述设计执行）

- T3.1 simulationLog 迁 store：arm 写共享后端 → 实例 A arm 的 digest 实例 B 同族可命中（**Simulation gate 分布式化核心**）。
  - arm 写入仍只在 preview 成功（wouldExecute=true）后；跨实例命中仍须 digest 精确 + 60s 绝对窗口 + 同 `accountId`。共享不可用 → 视为未 arm（拒绝），不变软。
- T3.2 state store 行级分片 + 语义原语（上表）：修 last-write-wins 丢行；不变量冲突显式失败。
- T3.3 txLedger 分布式：各实例广播后写共享台账，relayer 对账跨实例可见已落账 txHash（T4.2 的基础）。

### 验收（更新为设计对应的可测断言）
- 实例 A arm → 实例 B（共享 sqlite）同 digest 放行、异 digest 仍 `SimulationRequired`。
- 两实例并发写不同 accountId → 两行都保留（行级分片零冲突）。
- 并发同 accountId 各开不同 session → RMW union 两条都在。
- 同 accountId 不同 owner setup → `STATE_CONFIG_CONFLICT` 显式失败 + 审计（不静默取一方）。
- 实例 A 广播 tx → 实例 B `listTx` 可见（跨实例台账）。
- 旧 JSON 状态文件 → 自动迁移 + `.bak` 保留；纯内存模式 mcp-server 基线回归不变。
- 复核关注点：跨实例时钟偏差（≤ 几秒）对 60s 绝对窗口的容忍；RMW 冲突重试风暴上限（T1 已有 retries=25）；`CONFIG_CONFLICT` 后执行流安全降级（拒绝服务该 accountId + 告警，不影响其他行）。

## T4 relayer 多实例 nonce 协调 + 对账

**目标**：多 relayer 并发广播不因 nonce 竞争白付 gas / 重复广播。

- T4.1 **事务级 nonce 分配**：引入 `createNonceSequencer`（T1 store 上实现）——为每个 (chainUrl, broadcaster) 工作队列分配单调递增 nonce（原子 `getNextNonce`），而非全靠节点 `getTransactionCount`。
  - 保留对链上的重读 `getTransactionCount(pending)` 作为兜底（发现自己 nonce 落后 → 重新同步），BadNonce 分类逻辑复用现 `classifyRelayerFailure`（`relayer-operations.js`）。
- T4.2 **广播对账去重**：广播前先查共享 txLedger（T3.3）——若该 (accountId,payloadDigest) 已被本族的别实例以某 nonce 落账 → 直接返回已确认结果，不重复广播（与现"退避后对账"同向，但跨实例）。
- T4.3 **锁租约防惊群**：对同一 (chainUrl, broadcaster, nonce) 组合用后端原子 claim（谁先拿到归谁广播），失败方 enter 短退避重读 nonce——避免两实例同 nonce 各自 `sendRawTx` 竞争。
- 验收：
  - 双实例并发各 10 笔 → 无 nonce 冲突/重复广播；每笔恰好广播一次、对账一致；gas 不浪费。
  - BadNonce（合约重放）仍精确不重试；EOA nonce 冲突（节点 pending 滞后）仍可重试恢复（现语义保持）。
  - sqlite 后端不可用（降级 local 单机）→ 退化为现基线行为（单实例安全，不静默多实例不安全）。
- 复核关注点：nonce sequencer 的原子性与白皮书"交易单次有效"（nonce 签入载荷）如何兼容——**注意**：intent nonce（载荷内，签入）与 EOA nonce（广播层）是两个层次，本 T 只改 EOA 层分配，**绝不动 intent nonce 签入语义（INV-007）**。

## T5 分布式安全回归 + 文档闭环

- T5.1 **新增分布式测试**：
  - `packages/agent-sdk/test/store-interface.test.js`（T1 local/sqlite 双后端语义一致性 + 原子 readModifyWrite + 双进程并发）。
  - `packages/agent-sdk/test/transport-distributed.test.js`（T2 双实例共享 replay store：首 200 / 次 403 / 重启不丢 / 后端降级 fail-closed）。
  - `mcp-server/test/smart-account-distributed.test.js`（T3：跨实例 arm 放行/异 digest 拦截；并发 state 不丢；T4：非并发 nonce / 对账去重）。
  - 双实例测试方式：`node --test` 内 `spawn` 两个独立的 mcp 实例连同一 sqlite，或同进程两个 store 实例共享 sqlite 文件（优先；最省 CI）。
- T5.2 **更新文档**：
  - [TRANSPORT_SECURITY_P1_PLAN.md](docs/TRANSPORT_SECURITY_P1_PLAN.md) 或新 RFC：共享防重放窗口设计（INSERT OR IGNORE 恰好一次、窗口清理、降级 fail-closed）。
  - [SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md)：INV-007/009 补"多实例共享窗口下仍 fail-closed"注记；§4.1 测试入口补 distributed 测试文件。
  - [Sprint6计划.md](Sprint6计划.md)：收尾状态表 + 变更记录。
- 全量回归（门槛）：agent-sdk 62/62 + mcp-server 73/73 保持，新增文件全绿。

---

## 优先顺序与验收

1 → T1（store 抽象基建）；2 → T2（replay 共享，最高安全优先）；3 → T3（state/simulation 可见）；4 → T4（nonce 协调）；5 → T5（回归 + 文档）。

关键验收口径（每 T）：**多实例时 fail-closed 不放松** + **单实例行为与现基线逐字节一致** + 有可引用测试证据。共享后端降级路径必须**显式**（告警 + fail-closed 或拒绝启用），绝不静默退化为"各自独立窗口"而放低安全。

## 收尾状态表（2026-08-23，全部落地）

| 任务 | 状态 | 落地 commit | 关键交付 |
|------|------|------------|---------|
| T1 store 抽象基建 | ✅ | `14785c06` | `packages/agent-sdk/src/store-interface.js`（createLocalStore/createSqliteStore：claim 恰好一次、writeAtomically RMW+重试、purgeExpired/evictOldest）；`store-interface.test.js` |
| T2 replay 共享化 | ✅ | `14785c06` | `createReplayStore` 迁 store 接口：注入 sqlite → 全实例族恰好一次（INSERT OR IGNORE）；共享降级 fail-closed；`transport-distributed.test.js` |
| T3 state/simulation/ledger 迁 store + 行级分片 | ✅ | `6810d597` | `chain-state-store.js` 行级分片 + CAS 合并策略（claim/RMW-union/LWW/CONFIG_CONFLICT）+ 旧 JSON 自动迁移；`smart-account-distributed.test.js` |
| T4 relayer nonce 协调 | ✅ | `e6049dc0` + 复核修复 `ba0cb921` | `relayer-coordinator.js`（原子 sequencer + 租约 + 对账去重 + 链上重同步 syncAtLeast）；`executeWithRelayerResilience` 可选 coordinator 接线；server.js 仅共享后端激活；`relayer-coordinator.test.js` |
| T5 分布式回归 + 文档 | ✅ | 本次 | smart-account-distributed.test.js 补 T4 双实例验收（20 nonce 唯一 + 租约归因 + digest 写穿去重）；TRANSPORT_SECURITY_P1_PLAN.md §4 共享防重放设计；SECURITY_INVARIANTS.md INV-007/009 多实例注记 + §4.1 补 distributed 入口 |

**全量回归（收尾）**：agent-sdk 94/94、mcp-server 104/104（原 73 基线 → 新增 store/distributed/coordinator 全绿）、chain-eth 78/78。

**T4 复核修复（F1-F6）摘要**：F1 recordTx 写穿 digest（否则跨实例去重永不命中）；F2 计划要求的链上 getTransactionCount(pending) 重同步兜底（syncAtLeast 原子 max 只升不降）；F3 nonce 冲突正则单一真源（classifyRelayerFailure 复用 isNonceConflict）；F4 RELAYER_DEDUPE_SCAN=0 显式禁用（防 slice(-0) 全量反转）；F5 acquireNonce CAS 重试上限 10 次 + 退避；F6 instanceId 缺省 hostname:pid 可归因。

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-23 | v1.0 | 初次生成（基于 Sprint 5 收尾 + 四组件接口探查：replay store / simulationLog+state store / dailyCumulative / relayer nonce） |
| 2026-08-23 | v1.1 | Sprint 6 全量落地收尾：T1-T5 状态表补全；T4 复核修复 F1-F6 记录；文档闭环（TRANSPORT_SECURITY_P1_PLAN §4 + SECURITY_INVARIANTS 多实例注记）；回归 agent-sdk 94 / mcp-server 104 / chain-eth 78 |

## 备注：与后续 Sprint 关系
- **Sprint 7（生产部署与运维面）**：证书与密钥注入规范、deployment profile、metrics/dashboard/告警面板、testnet/staging/prod 发布流程。Sprint 6 的 sqlite/文件后端与降级路径即为其部署边界输入。
- **Sprint 8+（下一阶段能力）**：allowance/approve 可量化模拟 + owner opt-in、HSM/KMS/短期凭证、集中式 anti-replay、多链扩展（chain-sol hard-policy）、更完整 Agent-to-Agent transport protocol。
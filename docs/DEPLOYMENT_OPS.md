# DEPLOYMENT_OPS — 生产部署与运维手册

版本：v1.0（Sprint 7 T6.1）
适用：nexusgenesis-agent-keys / agent-sdk / chain-* / mcp-server 的**多环境部署与运维面**。
上游：[Sprint7计划.md](../Sprint7计划.md)（T1 可观测 / T2 profile / T3 健康告警 / T4 发布流程 / T5 证书密钥 / T6 本文档）。
配套安全规范：[SECURITY_INVARIANTS.md](../SECURITY_INVARIANTS.md)、[SECURITY_GAP_ANALYSIS.md](../SECURITY_GAP_ANALYSIS.md)。

本手册与实现一致：文末每一项 env / 端点 / 规则文件 / 脚本都真实存在于仓库（可引用），可作为
**"从零部署 staging 环境"** 的按步依据（T6.3）。

---

## 1. 环境矩阵

| 维度 | local（开发/测试） | testnet | production |
|------|------|---------|------------|
| CHAIN_PROFILE | `local` | `testnet` | `production` |
| 外部 RPC | 可选（缺省进程内 LocalChain，`CHAIN_ALLOW_LOCAL=1`） | 必填 `CHAIN_RPC_URL` | 必填 `CHAIN_RPC_URL` |
| 操作私钥 | 允许 anvil 默认键（仅 local） | 必填 relayer 键 | 必填 owner/emergency/relayer 三键 |
| anvil 默认私钥 | 允许 | **拒绝** | **拒绝** |
| SMART_ACCOUNT_ARTIFACT | 可选 | 可选 | **必填** + solc 版本绑定（`0.8.24`） |
| 共享 store | 可选 | 建议 `NEXUS_STORE_BACKEND=sqlite` | **建议 sqlite**（多实例协调/去重必需） |
| 健康/指标/告警 | 可选开启 | 建议开启 | 建议开启 + `HEALTH_STRICT_STARTUP=1` |

> fail-closed 总则：**production/testnet 缺任一必填项、或命中明知危险值（anvil 默认键）→ 启动即抛带 `code`
> 的错误**（复现 `chain-config.js` 的 `fail()` 模式），绝不带病服务。低配任何档位都不会静默放宽安全约束。

### 1.1 profile 文件

三档内建 profile 必填项由 `mcp-server/src/deployment-profile.js` 的 `PROFILE_REQUIRED` 定义：

| profile | 必填 env |
|---------|---------|
| local | （无） |
| testnet | `CHAIN_RPC_URL`、`CHAIN_RELAYER_PK` |
| production | `CHAIN_RPC_URL`、`CHAIN_OWNER_PK`、`CHAIN_EMERGENCY_PK`、`CHAIN_RELAYER_PK` |

示例文件（可整份复用）：
- `mcp-server/examples/profile.local.env`
- `mcp-server/examples/profile.testnet.env`
- `mcp-server/examples/profile.production.env`

---

## 2. 配置面（env 总表）

> 原则（Sprint 7 关键约束 1/2/4）：`/metrics`、`/health`、KMS、集中告警全部**可选开启（env gate）**，
> 默认关闭时行为与基线逐字节一致；stdout 只留给 MCP 协议；私钥（`CHAIN_*_PK`）绝不进 MCP 工具参数 / 日志 / profile 文件明文。

| env | 用途 | 档位 | 默认 |
|-----|------|------|------|
| `NEXUS_PROFILE_FILE` | 外部 profile 文件（`.env` / `.json`） | 任意 | 未设 → 不加载 |
| `NEXUS_PROFILE_DRY_RUN=1` | 仅加载+校验，不注入 env（preflight 用） | 任意 | 关闭 |
| `CHAIN_PROFILE` | local/testnet/production | 任意 | `local` |
| `CHAIN_RPC_URL` | 外部 EVM RPC | testnet/production 必填 | 未设 → 本地链（仅 local） |
| `CHAIN_OWNER_PK` / `CHAIN_EMERGENCY_PK` / `CHAIN_RELAYER_PK` | 操作私钥 | 见矩阵 | local 允许 anvil 键 |
| `CHAIN_ALLOW_LOCAL=1` | local 用进程内 LocalChain | local | 关闭 |
| `SMART_ACCOUNT_ARTIFACT` | 合约 artifact JSON 路径 | production 必填 | 缺省仓库 out/ 默认路径 |
| `SMART_ACCOUNT_SOLC_VERSION` | 期望 solc 版本前缀 | | `0.8.24` |
| `SMART_ACCOUNT_STATE_FILE` | 状态落盘路径 | | 内存/local |
| `NEXUS_STORE_BACKEND` | `sqlite` 启用共享后端 | 多实例必填 | local |
| `NEXUS_INSTANCE_ID` | 实例唯一标识（租约/归因） | 多实例 | 无 |
| `METRICS_HTTP_PORT` | 开启 `/metrics`（loopback） | 可选 | 未设 → 不监听 |
| `HEALTH_HTTP_PORT` | 开启 `/health`（loopback） | 可选 | 未设 → 不监听 |
| `HEALTH_STRICT_STARTUP=1` | 启动依赖 fatal 失败 → 拒绝启动 | production 建议 | 关闭 |
| `ALERT_RULES_FILE` | 告警规则 JSON | 可选 | 未设 → 无规则 |
| `ALERT_RULES_ENABLE_DEFAULTS=1` | 启用内置默认告警规则 | 可选 | 关闭 |
| `AUDIT_LOG_FILE` | 审计落盘（JSON lines） | 可选 | 仅 stderr + 内存 |
| `AUDIT_LOG_MAX_BYTES` | 审计日志体积上限（超限滚动 `.1`） | 可选 | 无限制 |
| `AUDIT_HTTP_PORT` | 开启集中式审计收集（loopback，§6.4） | 可选 | 未设 → 不监听 |
| `AUDIT_ANCHOR_INTERVAL_MS` | 开启外部锚定上链周期（§6.5） | 可选 | 未设 → 不启动 |
| `AUDIT_ANCHOR_CONTRACT` | 已部署 AuditAnchor 合约地址 | 锚定必填 | 未设（interval 已设 → 拒启） |
| `AUDIT_ANCHOR_ARTIFACT` | AuditAnchor artifact JSON 路径 | 可选 | 缺省仓库 out/ 默认路径 |

> 显式 env 优先级最高，profile 文件是**默认层**：`loadDeploymentProfile` 只注入当前未显式设置的键。

---

## 3. 多实例共享后端 + 降级矩阵

Sprint 6 交付的分布式状态层（`NEXUS_STORE_BACKEND=sqlite` + `NEXUS_INSTANCE_ID`）让多实例共享同一状态，
实现跨实例防重放、relayer nonce 原子排序、广播对账去重。**部署边界约束（fail-closed）**：

| 场景 | 行为 |
|------|------|
| 多实例 + 共享 sqlite store，正常 | 跨实例可见：共享防重放窗口、全局唯一 nonce 序列、对账去重（首广播一单，余实例复用） |
| 共享后端构造/操作错误 | **直接传播（fail-closed）**，绝不静默退化为"各实例独立窗口"（否则同 (sender,nonce) 可跨实例各放行一次） |
| local/单机 store | 各实例独立，状态可写性仅运维告警（重启自愈重建），不阻断 |
| dedupe 对账 | 广播前查共享台账：同 `(accountId,digest)` 已落账 → 直接返回，不重复广播 |

生产多实例部署**必须**：
1. 每个实例独立 `NEXUS_INSTANCE_ID`；
2. `SMART_ACCOUNT_STATE_FILE` 指向共享 sqlite（或 `NEXUS_STORE_BACKEND=sqlite`）；
3. 所有实例用同一受控 CA 签发的 mTLS 证书（§5）；
4. 指标就绪（§6）以确认非零 relayer 冲突 / 去重率。

---

## 4. 发布流程（环境分批 + 门禁）

所有发布前都过 **preflight**（`scripts/release-preflight.mjs`，可与 CI 共用同一入口）：

| 检查 | 失败即阻断（exit 1）？ | 说明 |
|------|------|------|
| `[A]` profile 校验 | ✅ | `loadDeploymentProfile({dryRun:true})` 缺必填 fail-closed |
| `[B]` chain 配置面 + artifact 绑定 + 占位符检测 | ✅ | 外部 RPC/relayer 键必填、拒 anvil、production artifact 必填 + solc 绑定；`REPLACE_*`/`example.org` 占位密钥/RPC 直接 FAIL |
| `[C]` 共享 store 可写 | ✅（共享）；⚠（单机） | 多实例协调/去重依赖，不可写即 fail；绝对路径 state 文件探测真实目录 |
| `[D]` 链上可达性 / nonce 池 | ⚠（`--strict-chain` 才阻断） | 保证无外部服务也能全绿 |
| `[E]` 6 包版本 lockstep | ✅ | 防「发布断层」P0 |

用法：
```bash
NEXUS_PROFILE_FILE=examples/profile.testnet.env node scripts/release-preflight.mjs
NEXUS_PROFILE_FILE=examples/profile.testnet.env node scripts/release-preflight.mjs --strict-chain
```

CI 接线（`.github/workflows/npm-publish.yml`）：
- 触发器：`workflow_dispatch`（一键 npm 0.x.y 发布 + Sepolia 部署）；
- 环境矩阵：`testnet → staging → prod`，发布 job `environment:` 门禁 + 人工审批收敛；
- 顺序：`preflight` job → 全量回归 `npm run test:release-packages` → `publish`（tag 固定版本）→ registry smoke（`scripts/release-smoke.mjs`）。

发布命令（根仓库）：
```bash
npm run release:bump           # 预览 6 包 cross-dep version bump
npm run release:preflight      # preflight 校验
npm run test:release-packages  # 全量回归
npm run smoke:release          # tag 版本 registry smoke
```

---

## 5. 证书 / 密钥注入

### 5.1 secret-store SPI（零隐式依赖，Sprint 7 T5.2）

`mcp-server/src/secret-store.js` 提供 `createSecretResolver()`，统一密钥读取抽象：

| 引用形式 | 解析目标 |
|---------|---------|
| 裸值 | 按原样返回（直接 env 注入的密钥） |
| `env:FOO` | 读 `process.env.FOO` |
| `file:/path` | 读文件内容（trim） |
| `kms` 后端 + provider | 可插拔对接 KMS（需传 provider 函数，否则 fail-closed `SECRET_KMS_NOT_CONFIGURED`） |

`chain-config.js` 的密钥解析缺省走该 resolver（env 直读为默认实现），行为与 Sprint 5/6 完全一致；
**不引入任何具体 KMS 依赖**（默认仍是 env），只是把"读取抽象"留出接缝。

### 5.2 生产 mTLS 证书（Sprint 7 T5.1）

`scripts/gen-mtls-certs.mjs --mode production`：
- 证书由**受控 CA**（通过 secret-store 引用 `--ca-cert` / `--ca-key`）签发，**绝不自签随机 CA**；
- 客户端身份 `CN` 绑定 agent identity（`--identity`，对应 `service-identity.js` 目录条目）；
- CA 私钥**不落盘**（保持在 secret store），仅写出叶子证书与密钥 + `ca.pem`（信任锚点）；
- 缺 CA 引用 / 无法解析 → 拒绝生成（fail-closed），绝不回退自签。

```bash
node scripts/gen-mtls-certs.mjs --mode production \
  --ca-cert 'env:MTLS_CA_CERT' --ca-key 'file:./certs/prod-ca-key.pem' \
  --identity 'agent-service' --cn 'svc.prod.example.org' [--out ./certs/mtls-prod]
```

默认 `dev` 模式仍是本地自签随机 CA（`certs/mtls/`），仅开发/测试。

> 安全边界：私钥始终 env/secret-store 注入（INV-001），绝不进 profile 文件明文 / MCP 工具参数。生产证书
> 身份随 mTLS 握手落审计（`mtls_handshake`，INV-008/INV-009）。

---

## 6. 指标与健康检查

### 6.1 Prometheus `/metrics`（`METRICS_HTTP_PORT`，loopback，可选）

`node:http` 内置，Prometheus text 格式，只读 GET。开启后 `http://127.0.0.1:${METRICS_HTTP_PORT}/metrics`。

- **计数器**（`smart_account_*` 命名空间，含 observability 与 relayer/coordinator 计数）：`smart_account_setup_count`、`smart_account_preview_count`、`smart_account_execute_total/success/failed`、`smart_account_revert_{errorName}`、`smart_account_nonce_conflict`、`smart_account_limit_rejected`、`smart_account_rpc_error`、`smart_account_execute_retried`、`smart_account_policy_rejected`、`smart_account_relayer_nonce_acquired`、`smart_account_relayer_nonce_conflict`、`smart_account_relayer_nonce_resynced`、`smart_account_relayer_broadcast_deduped`、`smart_account_relayer_lease_failed`。
- **采样 gauge**：`process_start_time_seconds`、`process_heap_bytes`、`process_heap_total_bytes`、`process_rss_bytes`；链上健康：`chain_rpc_up`（成功/失败比）、`chain_last_block_ts`、`chain_last_block_number`；store：`store_backend{backend=...}`、`store_shared`。

无需外部链路也能全绿（未绑定 provider → `chain_rpc_up=0`）。

### 6.2 `/health`（`HEALTH_HTTP_PORT`，loopback，可选）

| 端点 | 语义 | 返回 |
|------|------|------|
| `/health/live`（或 `?live=1`） | 进程存活 | 恒 200 |
| `/health` / `/health/ready` | readiness：依赖自检 | 全 ok → 200；任一依赖失败 → **503**（LB 摘流） |

readiness 检查器（`mcp-server/src/health.js` + `server.js` 注册）：`chain_env`（RPC 可达）、`state_store`（store 可用）。
任一检查失败 → 结构化 `health_unready` 事件落 stderr（stdout 不受污染）。
`HEALTH_STRICT_STARTUP=1` 且 `fatal` 检查失败 → 拒绝启动（与配置 fail-closed 同向，`HEALTH_STRICT_STARTUP_FAILED`）。

### 6.3 告警规则引擎（`ALERT_RULES_FILE` / `ALERT_RULES_ENABLE_DEFAULTS=1`）

`mcp-server/src/alerting.js`：JSON 规则（指标 + op + threshold + 窗口 + 严重级）→ 命中写结构化告警事件
到 stderr `/audit`（`alert_fired`）。内置默认规则（`ALERT_RULES_ENABLE_DEFAULTS=1` 启用）：

| 规则 | 指标 | 条件 | 严重级 |
|------|------|------|--------|
| `chain_rpc_down` | `chain_rpc_up` | `< 0.5` 持续 30s | critical |
| `relayer_nonce_conflicts` | `relayer_nonce_conflict` | `>= 5` | warning |
| `execute_failure_rate` | 派生 `fail/total` | `> 0.5` 持续 30s | warning |

> 告警 engine 消费 `collectMetrics(snapshot)` **合并快照**（计数器 + 进程/链上健康 gauge，按裸名寻址，
> 如 `relayer_nonce_conflict` / `chain_rpc_up`，非 /metrics 渲染的 `smart_account_` 前缀名）；未绑定外部
> provider 时 `chain_*` gauge 不进告警面（local/进程内链部署不会被 `chain_rpc_down` 误报 critical）。
> 告警开启才循环评估（`setInterval` `unref`，不阻塞进程退出）。
>
> 可选观测端口（`METRICS_HTTP_PORT` / `HEALTH_HTTP_PORT` / `AUDIT_HTTP_PORT`）故障（如端口占用）→ 结构化
> 错误事件（`metrics_http_error` / `health_http_error` / `audit_collector_http_error`，stderr）并降级为
> 「观测缺席」—— 绝不拖垮 MCP 协议进程。

### 6.4 集中式审计收集（`AUDIT_HTTP_PORT`，loopback，可选）· Sprint 8 GAP-002 Ⅱ

`mcp-server/src/audit-collector.js`：复用 audit-log 的 **hash-chain**（`verifyAuditHashChain`），
输出前做无篡改校验，让"收集到的审计数据"本身可独立复验。开启后
`http://127.0.0.1:${AUDIT_HTTP_PORT}`：

| 端点 | 语义 | 返回字段 |
|------|------|----------|
| `GET /` | 审计流摘要 | `exists / volumes / verified / tampered / chainOk / chainError / tailHash` |
| `GET /tail` | 链尾锚定摘要（轻量轮询锚定） | `count / tailHash / chainOk / tampered` |
| `GET /entries?afterHash=&limit=` | 审计行（跨卷合并、**游标增量**、分页） | `count / totalAfterCursor / hasMore / nextCursor / stale / entries[]`（每条含 `hash`/`prevHash` 可复验）|
| — | 篡改检测 | `tampered=true` / `chainOk=false` 但不静默丢弃数据 |

关闭 gate → 不监听端口，基线不变。审计行 hash-chain 固化见 §7。

- **重启续链**：链尾跨进程持久（首次写盘前从文件尾惰性初始化）——重启续写不断链、不误报。
- **轮转跨卷**：新卷以旧卷链尾锚定校验；多次轮转后旧卷为链中段（更旧卷已删，首行以
  continuation 语义接受、卷内仍严格串联），当前卷始终严格锚定。
- **增量收集（游标契约，本仓库只提供端点、收集方在外部）**：收集方持久化 `nextCursor`/
  `tailHash` 作为游标 → `?afterHash=` 仅拉增量（`limit`+`hasMore` 续拉分页）；游标失配
  （两次拉取间头部被截/整链重写）→ `stale=true` + 全量返回供重同步 —— **集中式架构下的
  截断检测面**：单文件本地视角无法察觉的尾部删除/重写，由收集方持久化游标暴露并告警。
  非法 `afterHash`/`limit` → 400（操作员错误要响亮）。
- 边界（如实）：`stale` 检测依赖收集方持久化游标（外部）；攻击者重算整链且收集方从未拉过 →
  仍无法防 —— **外部锚定上链已落地（§6.5）**，与游标互补；多进程并发
  append 同一文件不支持（per-process）。

### 6.5 外部锚定上链（`AUDIT_ANCHOR_INTERVAL_MS`，可选）· Sprint 8 GAP-002 Ⅲ

审计链尾 hash 定期锚到链上 **append-only** 合约（`contracts/solidity/src/AuditAnchor.sol`），
使"整链重写/截断"在链上留证（hash 链传递性 → 每锚承诺整个前缀）。

**启用三步**：
1. 编译：`contracts/solidity` 下 `forge build --use 0.8.24`（产物
   `out/AuditAnchor.sol/AuditAnchor.json`；`AUDIT_ANCHOR_ARTIFACT` 可覆盖路径）。
2. 部署（广播者即链上 anchoringKey，**用 relayer 运营密钥**广播）：
   `forge script script/DeployAuditAnchor.s.sol:DeployAuditAnchor --rpc-url <rpc> --broadcast --private-key <relayer_pk>`
3. mcp-server env：`AUDIT_ANCHOR_CONTRACT=<地址>` + `AUDIT_ANCHOR_INTERVAL_MS=<毫秒>`
   （如 60000；未设 → 服务不启动，基线不变）。

**行为**：周期 tick 重放本地审计链 → 链尾/计数有变化才广播
`anchor(tailHash, entryCount)`（无新条目不发 tx；重启先 `latest()` 对齐不重锚）；
本地链被篡改 → **拒锚**并结构化告警（fail-closed）；`CHAIN_ALLOW_LOCAL` 进程内
ephemeral 链 → 自动停用（锚随进程消失无意义）；单轮广播失败下轮重试。锚定成功
只写 stderr 结构化事件 + 链上 `Anchored` 事件（不写审计链，避免无限自举）。

**验证（运维/收集方职责）**：`mcp-server/src/audit-anchor.js` 导出
`replayAuditTrail(file)`（跨卷重放 running hash）+ `readOnChainAnchors({contract})` +
`verifyAuditAgainstAnchors({trail, anchors})`——位置绑定校验：第 `entryCount` 行
running hash 必须等于锚 `tailHash`；`entryCount` 回退或链上索引跳变 = 重写后重锚
告警。间隔窗口内的尾部截断由下一次锚定或收集方游标（§6.4 `stale`）暴露。

---

## 7. 日志

- 结构日志：`logStructured` 写 **stderr JSON line**（stdout 保留给 MCP 协议）。
- 审计：`recordAudit` 双写 stderr + `AUDIT_LOG_FILE`（JSON lines，原子追加）；`AUDIT_LOG_MAX_BYTES` 超限 →
  重命名 `.1` 滚动（保留上一卷）。
- **审计 hash-chain（Sprint 8）**：每条审计记录注入 `prevHash`（=上一哈希链尾）与 `hash`
  （**整条记录** canonical 序列化 sha256，任何字段含告警明细被改即失配）；链尾跨重启续链；
  `verifyAuditHashChain(file, { anchorHash })` 逐行无篡改检测（anchor 支持轮转跨卷）。集中式收集
  见 §6.4。`AUDIT_LOG_FILE` 为 per-process 文件（多进程并发 append 不支持）。
- 审计字段机器可读契约：`tool/accountId/sessionId/payloadDigest/txHash/errorName/broadcaster/timestamp`。

---

## 8. 回滚

- **artifact 版本绑定**：生产部署的 `SMART_ACCOUNT_ARTIFACT` 绑定 `SMART_ACCOUNT_SOLC_VERSION`（缺省 `0.8.24`），
  preflight `[B]` 校验 solc 版本/合约身份，防止部署与合约不匹配。
- **release 版本绑定**：npm 包按 tag 固定版本发布；回滚 = 切回上一 tag + registry smoke 验证（`scripts/release-smoke.mjs`）。
- **链上可回退**：Emergency 刹车 / 会话撤销（INV-005/006/007），`revokeSession` 链上强制。
- **状态可恢复**：共享 store（sqlite）+ `AUDIT_LOG_FILE` 提供操作事实；preflight `[C]` 校验可写性。

---

## 9. 从零部署 staging 环境（逐步）

1. 建分支 / 配环境：`CHAIN_PROFILE=testnet`，从 `mcp-server/examples/profile.testnet.env` 复制并替换占位符
   （真实 RPC + 真实 relayer 键 —— 键走 env 注入，不放平文件明文）。
2. 生成生产 mTLS 证书（§5.2，受控 CA）并分发到各实例 `certs/`。
3. `NEXUS_PROFILE_FILE=./profile.testnet.env node scripts/release-preflight.mjs --strict-chain` → 全 PASS。
4. `npm run test:release-packages` → 回归绿。
5. `npm run smoke:release` → 从 registry 全新安装 tag 固定版本验证 6 包。
6. 多实例启动（每个实例独立 `NEXUS_INSTANCE_ID` + 共享 sqlite store）。
7. 打开 `METRICS_HTTP_PORT` / `HEALTH_HTTP_PORT`，配置 LB 探活 `/health/ready` + Prometheus 抓取（生产建议
   `HEALTH_STRICT_STARTUP=1` + `ALERT_RULES_ENABLE_DEFAULTS=1`）。
8. 观察 `/metrics`：`chain_rpc_up` 趋近 1、relayer 冲突/去重率健康、无 `relayer_lease_failed`。
9. CI `workflow_dispatch` → preflight 门禁 → 审批 → 发布 + registry smoke 收口。

---

## 10. 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-25 | v1.0 | 初稿：环境矩阵 / profile / 多实例降级 / 发布流程 / 证书密钥 / 指标健康告警 / 日志 / 回滚 / 从零部署 staging |
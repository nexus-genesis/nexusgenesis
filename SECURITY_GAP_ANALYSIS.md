# SECURITY_GAP_ANALYSIS — 安全差距跟踪

版本：v1.0（Sprint 7 收尾）
作用：记录 SECURITY_INVARIANTS.md 中**已知未闭环的差距**及其边界与承接计划。实现与差距分离维护——
本文件跟踪"还没做 / 只做到半程"的项，不污染不变量长期规范。

---

## 打开差距（Open / Partially closed）

### GAP-001 — 密钥仍以 env 明文为主注入渠道（Partially closed，Sprint 7）

- 声明：`CHAIN_OWNER_PK / CHAIN_EMERGENCY_PK / CHAIN_RELAYER_PK` 等操作密钥默认仍走 **env 明文**注入
  （进程运行时可经 `/proc`/env 读取），未强制落在 HSM/集中式 KMS。
- 现状（Sprint 7 半程，INV-001 增强）：
  - 新增 **secret-store SPI**（`mcp-server/src/secret-store.js`）：`createSecretResolver()` 统一抽象
    密钥读取，支持 `env:` / `file:` 引用、可插拔 `provider`（对接 KMS）。默认实现仍是 env 直读
    （零隐式依赖，不引入基础运维依赖）。
  - `chain-config.js` 的密钥解析走 resolver（缺省 env 路径与 Sprint 5/6 行为逐字节一致）。
  - 生产 mTLS（`gen-mtls-certs.mjs --mode production`）由受控 CA 签发，CA 私钥不出 secret store、
    绝不落盘。
  - 门禁保持不变：操作密钥绝不进 MCP 工具参数 / 日志 / profile 文件明文（INV-001 / T3.3 key isolation）。
- 边界（未闭环部分）：默认路径仍可接受 env 明文；KMS 具体实现（云 KMS/HashiCorp Vault 等）未随包发货——
  仅提供接口 + 示例占位 provider，不引入具体依赖。
- 承接（Sprint 8+）：把 `createSecretResolver` 接入具体 KMS/secret manager，并把 `production` profile
  缺省切换为"非 env-明文解析失败"的严格模式（fail-closed）。

### GAP-002 — 审计缺防篡改固化（hash-chain）（Closed in Sprint 8）

- 声明：审计事件当前为 **stderr JSON line + `AUDIT_LOG_FILE`（JSON lines 原子追加）**，附内存环形缓冲；
  Sprint 6/7 补充了对账不重发、relayer attempts/retried/reconciled 进审计。但**日志可被就地篡改，
  无链式校验，无集中式收集/面板**（INV-008 已知限制）。
- 现状（Sprint 7 半程）：补齐**可观测面**——
  - `/metrics`（`METRICS_HTTP_PORT`）：Prometheus text，进程/链上健康/store 标签 + 全部计数器
    （含 relayer 协调维度 relayer_nonce_*/relayer_broadcast_deduped/relayer_lease_failed）。
  - `/health`（`HEALTH_HTTP_PORT`）：liveness 恒 200、readiness 失败 503（LB 摘流）；`HEALTH_STRICT_STARTUP=1`
    致命依赖失败拒绝启动。
  - 告警引擎（`ALERT_RULES_FILE` / `ALERT_RULES_ENABLE_DEFAULTS=1`）：命中写 `alert_fired` 结构化事件。
  - 日志体积上限 + 滚动（`AUDIT_LOG_MAX_BYTES` → `.1`）。
- 关闭（Sprint 8，承接落点）：
  - **hash-chain 固化**（`audit-log.js`）：`recordAudit` 按写序注入 `prevHash`（=上一哈希链尾）与
    `hash`（**整条记录** canonical 序列化 sha256——复核修复 R3：非固定字段子集，否则
    broadcaster/告警明细等字段被篡改将漏检）；新增 `auditHash()`（递归键排序、跨进程可复算）与
    `verifyAuditHashChain(file, { anchorHash })`（逐行校验 prevHash 串联 + hash 复算）。
    **复核修复 R1（重启续链）**：链尾跨进程持久——首次写盘前从现有文件尾惰性初始化，重启后
    续写不断链、不误报篡改。
  - **集中式审计收集端点**（`audit-collector.js`）：`AUDIT_HTTP_PORT` gate（默认关、loopback、只读 GET），
    `GET /` 摘要 + `GET /tail` 链尾锚定（`tailHash`/`count`/校验状态，供收集方轻量锚定）+
    `GET /entries` 审计行（**跨卷合并**，每条含 hash/prevHash 可独立复验）；输出前跑
    `verifyAuditHashChain`，篡改 → `tampered=true`/`chainOk=false` 但**不静默丢弃数据**。接线
    server（`server.auditCollector`）。
    **复核修复 R2（轮转 anchor）**：轮转后新卷以旧卷链尾锚定（anchorHash）校验、`/entries` 合并
    `.1` 旧卷 + 当前卷；连续多次轮转后旧卷为"链中段"（更旧卷已按保留策略删除）→ 旧卷首行以
    `continuation` 语义接受（卷内仍严格串联），当前卷始终严格锚定。
    **增量收集（游标契约）**：`GET /entries?afterHash=&limit=`——收集方持久化 `nextCursor`/`tailHash`
    作游标仅拉增量（`hasMore` 续拉分页）；游标失配（两次拉取间截断/重写）→ `stale=true` + 全量
    重同步。这是残留边界"尾部删除/整链重写"在集中式架构下的检测面：本地单文件视角无法察觉的
    删除，由收集方持久化游标暴露（收集方实现属本仓库之外，本仓库只提供契约）。
  - 测试证据：`mcp-server/test/audit-hashchain.test.js`（11 例，含重启续链/非 schema 字段篡改/
    轮转 anchor 三组复核回归）+ `audit-collector.test.js`（16 例，含真实轮转跨卷端到端、游标
    增量/失配/分页/跨卷游标、`/tail` 锚定与篡改、参数校验 400），Node 24 与 Node 18 均全绿；
    mcp-server 全套 189/189。
  - **外部锚定上链（Ⅲ）**（`audit-anchor.js` + `contracts/solidity/src/AuditAnchor.sol`）：
    `AUDIT_ANCHOR_INTERVAL_MS` gate（默认关）+ `AUDIT_ANCHOR_CONTRACT`（已部署 AuditAnchor 地址）；
    周期把审计链尾 hash 锚到链上 **append-only** 锚账本（`anchor(tailHash, entryCount)` 仅部署
    anchoringKey 可追加；无删除/更新路径，`count` 单调 + `Anchored` 事件）。hash 链传递性 →
    每个锚承诺整个前缀；验证为**位置绑定**（`replayAuditTrail` 跨卷重放 running hash →
    `verifyAuditAgainstAnchors`：对仍在本地的已锚前缀做位置绑定校验——第 entryCount 行的
    running hash 必须等于锚 tailHash（重写/插入/断链均失配）；覆盖数超本地（已轮转删除）记
    dropped 信息性；链上索引跳变 = 重写后重新锚定的告警（见复核修复 R4）。
    服务语义：本地链被篡改 → **拒锚**（fail-closed，绝不把坏链锚上链合法化）；ephemeral 本地链
    自动停用；无新条目不发 tx；重启先 `latest()` 对齐；单轮失败下轮重试，绝不影响 MCP 协议进程。
    广播用 relayer 运营密钥（部署脚本 `DeployAuditAnchor.s.sol` 需同密钥广播 → anchoringKey）。
    测试证据：`audit-anchor.test.js` **21 例**（replay 跨卷/篡改/断链、verify 位置绑定失配 +
    轮转 dropped 语义、gate/fail-closed、tick 全路径 stub：锚定成功/幂等跳过/拒锚/localChain
    停用/失败重试/重启 latest 对齐、锚定后重算整链 → 链上锚失配端到端）+ foundry
    `AuditAnchor.t.sol` **7 例**（权限/单调/读取/事件）；mcp-server 全套 **210/210**，foundry **38/38**。
    复核修复 R4（轮转深度绑定）：`AUDIT_LOG_MAX_BYTES` 轮转合法裁剪本地 `trail.count`，绝对
    `entryCount` 回退/超本地数不得再自动判篡改（会误报）——只有"已锚且仍在本地的前缀"做位置
    绑定校验（重写/插入/断链仍失配告警）；覆盖数超本地 → `dropped` 信息性（链上仅存证据）。
- 残留边界（如实记录）：
  - **锚定间隔窗口**：两次锚定之间的尾部截断/重写，要等下一次锚定（锚将失配或 dropped）
    或集中式收集方游标失配（`stale`）才暴露 —— 间隔越短窗口越小，但每 tx 有链上成本。
  - **活动尾截断 vs 合法轮转（R4 后语义迁移）**：位置校验只覆盖"仍在本地的已锚前缀"；攻击者
    删除**当前卷**尾部导致的截断，与 `AUDIT_LOG_MAX_BYTES` 轮转在绝对计数上无法由锚定单方区分。
    该检测责任明确移交：集中式收集游标失配（§6.4 `stale`）+ anchoringKey 托管（GAP-001）。
  - 攻击者同时攻陷 server **并持有 anchoringKey**：可重写审计 + 重新锚定"洗白"。链上锚账本
    append-only 使重锚**可见**（index 跳变/覆盖失配 → verify 判告警），但需验证方在跑
    `verifyAuditAgainstAnchors`（收集方/运维任务）。anchoringKey 托管在 KMS 进一步抬高门槛。
  - 多次轮转后 `.1` 旧卷**头部不可验**（更旧卷已删除，保留期边界）；当前卷（活跃审计面）始终严格校验。
  - 多进程并发 append 同一 `AUDIT_LOG_FILE` 不支持（per-process 文件语义，见 DEPLOYMENT_OPS §7）。

---

## 已关闭差距（Closed in Sprint 7）

- 无独立 HTTP 可观测端点（指标/健康）→ 已由 T1/T3 关闭（可选开启、loopback、不碰 MCP stdout）。
- profile 散落 env、无 schema 校验 → 已由 T2 关闭（`NEXUS_PROFILE_FILE` + 三档内建 + fail-closed 校验）。
- 发布无 preflight/环境门禁 → 已由 T4 关闭（`release-preflight.mjs` + `npm-publish.yml` preflight job + 环境矩阵）。
- 生产证书/密钥无接入路径 → 已由 T5 关闭（secret-store SPI + `--mode production` 受控 CA）。

---

## 修订与豁免

- 任何差距的关闭必须附对应测试文件与断言（§4.1 映射）。
- 豁免须安全评审书面批准；本文件不允许默认豁免。
- 每条差距含：声明 / 现状（半程边界）/ 承接计划，供 Sprint 8+ 直接续接。
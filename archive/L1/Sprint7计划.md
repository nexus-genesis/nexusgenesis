# Sprint 7 任务单 — 生产部署与运维面

> 前置：Sprint 1-6 已落地全量闭环（`feat/sprint4-transport-security` 分支，已同步远端）。
> Sprint 6 把状态层升级为**跨实例可见 + 并发安全**（store 抽象 / 共享防重放 / 行级分片 / relayer nonce 协调）。
> Sprint 7 把白皮书主线从"能在单机多实例跑"推进到"**可部署、可运维、可多环境运营**"——生产部署与运维面。
>
> 主线：补齐 6 大运维面缺口——部署可观测（指标/日志）、配置封装（deployment profile）、健康检查 + 告警、环境发布流程、生产证书/密钥接入、运维手册 + 文档闭环。
> 分支建议：从 `feat/sprint4-transport-security` 新建 `feat/sprint7-deploy-ops`。
> 结构沿用"实现 → 独立复核 → 修复 → 回归"闭环，每 T 完成即全量回归。

## 0. 现状盘点（防重复规划）— 已完成

| 运维面 | 现状形态 | 生产缺口 |
|--------|---------|---------|
| **指标** | `mcp-server/src/observability.js`：内存计数器（setup/preview/execute/revert 分类）+ `smart_account_metrics` **MCP 工具**（stdio JSON-RPC） | 无 HTTP `/metrics` 端点（Prometheus 抓取无法引入）；指标不全（缺部署/链上健康/协调器维度） |
| **日志** | `logStructured` 写 stderr JSON line；`audit-log.js` 双写 stderr + `AUDIT_LOG_FILE`（JSON lines 原子追加） | 无日志轮转/体积上限；无统一字段 schema 的对外稳定规范 |
| **配置/密钥** | `chain-config.js` 的 `CHAIN_PROFILE`（local/testnet/production）+ 散 env（`CHAIN_RPC_URL`/`CHAIN_OWNER_PK`/`CHAIN_EMERGENCY_PK`/`CHAIN_RELAYER_PK`/`SMART_ACCOUNT_POLICY_FILE`/`SMART_ACCOUNT_STATE_FILE`…） | 无 deployment profile 文件封装（`.env`/profile.json）与 schema 校验；无密钥注入规范（KMS/secret store SPI） |
| **健康检查** | 无 | 无 `/health`（liveness/readiness）；无启动时依赖自检（RPC/store/state 文件可写/artifact 绑定） |
| **告警** | 无（仅 `logStructured` 事件，不消费） | 无指标阈值 → 结构化告警事件面 |
| **发布流程** | `.github/workflows/ci.yml` + `npm-publish.yml`（6 包 + registry smoke） | 无 testnet/staging/prod **环境分批发布**门禁；无 preflight 检查 |
| **生产证书/密钥** | `scripts/gen-mtls-certs.mjs`（仅**开发/测试自签 CA**）；Sprint 5 明确预留"生产 mTLS 证书对接 service identity / KMS 属 Sprint 7" | 无生产证书签发路径；无 KMS/secret store SPI（密钥仍走 env 明文） |
| **运维手册** | 无 | 无多实例部署/降级矩阵运行手册；`SECURITY_INVARIANTS.md` 实例已含 distributed 入口，但无部署边界文档 |

**Sprint 6 交付即为 Sprint 7 输入**：共享后端 + 降级路径（显式 fail-closed / 拒绝启用）成为部署边界约束；`NEXUS_STORE_BACKEND` / `isSharedBackend` / `SMART_ACCOUNT_STATE_FILE` 等 env 需要纳入 profile 规范。

---

## 关键设计约束（贯穿全部 T）

1. **默认关 / 可选 SPI，零隐式依赖**：`/metrics`、`/health`、KMS、集中告警全部是**可选开启**（env gate），默认关闭时行为与 Sprint 5/6 基线逐字节一致。CI 无外部服务（Prometheus/KMS/secret store）也能全绿，延续 Sprint 6 "SQLite 而非 Redis" 的零隐式依赖原则。
2. **监控/审计通道不碰协议通道**：stdout 保留给 MCP 协议，`/metrics`、`/health`、审计告警全部走 stderr JSON line 或**独立 loopback HTTP 端口**（gate 开启后），绝不污染 JSON-RPC stdout。
3. **fail-closed 不因部署面放松**：health 自检失败 → 拒绝成为 ready（load balancer 摘流）而非带病服务；生产 profile 配置缺项 → 启动即报错（复用 `chain-config.js` 的 `fail()` 模式）。
4. **密钥最少接触面（INV-001）**：私钥仍只走 env 注入，绝不进 MCP 工具参数/日志/profile 文件明文；KMS SPI 只做**可插拔读取抽象**，默认仍是 env，避免引入基础运维依赖。
5. **每 T 完成即全量回归**：agent-sdk 94 + mcp-server 105 + chain-eth 78 基线保持，新增全绿。

---

## T1 部署可观测（指标 + 日志）

- T1.1 `/metrics` 端点（可选开启，`METRICS_HTTP_PORT` gate）：`node:http` 内置，输出 **Prometheus text 格式**（`# TYPE` + 计数器行），复用 `observability.js` 的 `snapshot()` + 新增维度；gate 关闭 → 不监听端口，行为与现在完全一致。
- T1.2 **指标维度扩充**（进 `observability.js` 计数器面，命名对运维稳定）：
  - 进程级：`process_start_time` / `heap_used_bytes` / `heap_total_bytes` / `rss_bytes`（采样，非计数器）。
  - 链上健康：`chain_last_block_ts`（`provider.getBlockNumber` 采样）/ `chain_rpc_up`（成功/失败比）。
  - 协调器（Sprint 6 T4）：`relayer_nonce_acquired` / `relayer_nonce_conflict` / `relayer_nonce_resynced`（`syncAtLeast` 触发）/ `relayer_broadcast_deduped` / `relayer_lease_failed`。
  - store：`store_backend`（local/sqlite 标签）/ `store_shared`（bool）。
- T1.3 **日志体积上限 + 轮转**：`AUDIT_LOG_FILE` 增加可选 `AUDIT_LOG_MAX_BYTES`（超限 → 重命名 `.1` 滚动）；补充**对外稳定字段 schema 文档**（审计字段机器可读契约）。
- T1.4 验收：`METRICS_HTTP_PORT` 开启 → 抓取 `/metrics` 断言 Prometheus 格式与计数正确；关闭 → 端口不监听（基线不回归）。

## T2 Deployment profile（配置封装）

- T2.1 **profile 加载器**：`NEXUS_PROFILE_FILE`（JSON/`.env`）+ 现 `CHAIN_PROFILE` 合并；解析并做 **schema 校验**（未知字段告警、缺必填项 fail-closed）。profile 内含 chain/state/policy/metrics/health 全部 env 的默认与必填约束。
- T2.2 内建三档 profile 文档 + 示例文件：`local`（开发，anvil 默认键允许）/ `testnet`（显式 RPC + relayer 键，禁 anvil）/ `production`（显式 RPC + 全操作键 + artifact 绑定 + **多实例 store 约束**）。复用并扩展 `chain-config.js` 的校验（owner/relayer 分离、anvil 拒绝、artifact solc 绑定）。
- T2.3 校验器：`NEXUS_PROFILE_DRY_RUN=1` → 只加载校验不启动（发布前 preflight 也用它）。
- T2.4 验收：`local` 缺 RPC 不报错；`production` 缺任一操作键/artifact/共享 store 配置 → 启动报 `code`（fail-closed）；dry-run 不监听任何端口。

## T3 健康检查 + 告警

- T3.1 `/health` 端点（可选，`HEALTH_HTTP_PORT` gate）：`liveness`（进程存活）+ `readiness`（依赖自检：RPC 可连 / state store 可写 / policy 文件可读 / artifact 绑定）。readiness 失败 → HTTP 503（LB 摘流）。
- T3.2 **启动时依赖自检**：`createServer` 时（`HEALTH_STRICT_STARTUP=1` production 默认）对核心依赖健康检查，失败即抛错拒绝启动（与配置 fail-closed 同向）。
- T3.3 **告警规则引擎**（`mcp-server/src/alerting.js`，可选 `ALERT_RULES_FILE`）：JSON 规则（指标阈值 + 窗口 + 严重级）→ 命中写结构化告警事件到 stderr/AUDIT（复用 `logStructured`+`recordAudit`）。内置默认规则：`chain_rpc_up` 持续低、`relayer_nonce_conflict` 突增、execute 失败率超阈值。
- T3.4 验收：readiness 自检失败 → 503；告警规则命中 → 结构化事件落审计；关闭 gate → 无行为变化。

## T4 环境发布流程

- T4.1 **preflight 脚本** `scripts/release-preflight.mjs`：对目标环境跑 T2 的 profile dry-run + 链上 nonce 池检查 + 共享 store 可写性 + artifact 绑定 + registry smoke 前的 6 包版本一致检查（复用 `release-smoke.mjs`）。
- T4.2 **工作流环境门禁**：`npm-publish.yml` 增加环境矩阵（testnet → staging → prod 手动静默收敛）；发布前必过 preflight 与全量回归；release 打 tag 触发（沿用现 tag 固定版本 registry smoke）。
- T4.3 验收：对 `staging` 盘 preflight 缺密码/缺 artifact → 拒绝进入发布；满足 → 通过；`npm run test:release-packages` 仍绿。

## T5 生产证书/密钥接入（Sprint 5 预留闭环）

- T5.1 **生产 mTLS 证书签发对接 service identity**：`scripts/gen-mtls-certs.mjs` 增加 `--mode production`——证书由**受控 CA/secret store SPI** 签发（不再自签随机 CA），证书身份绑定 agent identity 目录（`service-identity.js`）；默认仍是开发自签（可选开启，零隐式依赖）。
- T5.2 **KMS/secret store SPI**（`mcp-server/src/secret-store.js` 或 agent-sdk）：`createSecretResolver` 抽象 `{ resolveRef(ref) }`——默认实现读 env；可插拔实现对接 KMS/secret 文件（**不引入具体依赖**，仅接口 + 示例实现）。`chain-config.js` 密钥解析走 resolver（现有 env 直读路径为默认 resolver）。
- T5.3 验证：生产 mode 证书 → mTLS 握手双方身份落审计（复用 Sprint 5 `mtls_handshake`）；默认 env resolver 行为与 Sprint 5/6 完全一致。

## T6 运维手册 + 文档闭环

- T6.1 **部署运行手册** `docs/DEPLOYMENT_OPS.md`（新 RFC 或并入既有 docs）：环境矩阵、profile 配置表、多实例共享后端 + 降级矩阵、证书/密钥注入、指标/健康端点、告警规则、回滚（artifact 版本绑定）。
- T6.2 **文档闭环**：
  - [SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md)：§4.1 测试入口补 T1-T5 新增测试；INV-008 补"指标/健康/告警可观测"注记。
  - [SECURITY_GAP_ANALYSIS.md](SECURITY_GAP_ANALYSIS.md)：密钥 env 明文 / 审计 hash-chain 未闭环 → 标注 Sprint 7 半程与边界。
  - [Sprint7计划.md](Sprint7计划.md)：收尾状态表 + 变更记录。
- T6.3 验收：手册可依据性地指导"从零部署 staging 环境"；文档与实现一致（每 T 提及的 env/端点/规则文件真实存在）。

---

## 优先顺序与验收

1 → T1（可观测，最高优先——运维无观测等于盲部署）；2 → T2（配置封装，发布前置）；3 → T3（健康/告警）；4 → T4（发布流程）；5 → T5（证书/密钥生产接入，Sprint 5 预留）；6 → T6（手册 + 文档闭环）。

关键验收口径（每 T）：**默认关/可选开启，关闭时与基线逐字节一致** + **生产 profile fail-closed 不放松** + **指标/健康/告警/审计不碰 MCP stdout 协议通道** + 有可引用测试证据。可选项（metrics/KMS/告警）保持「无外部服务也能全绿」。

## 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-23 | v1.0 | 初次生成（基于 Sprint 6 收尾 + 运维面六缺口盘点；范围经用户确认：T1-T6 全量） |
| 2026-08-25 | v1.1 | **Sprint 7 收尾**：T1-T6 全量落地并回归全绿（mcp-server 142 测试通过）；补收尾状态表 |

## 收尾状态表（v1.1）

| 任务 | 交付 | 状态 | 证据 |
|------|------|------|------|
| T1 可观测 | `mcp-server/src/metrics.js`（`/metrics` Prometheus text，`METRICS_HTTP_PORT` gate）+ 计数器扩展（进程/链上健康/store 标签/relayer 协调）+ 审计日志体积滚动 | ✅ | `mcp-server/test/metrics-sprint7.test.js`；关闭 gate 不监听端口、基线不回归 |
| T2 Deployment profile | `mcp-server/src/deployment-profile.js`（`NEXUS_PROFILE_FILE` + 三档内建 + schema 校验 fail-closed + dry-run）+ 示例 `mcp-server/examples/profile.{local,testnet,production}.env` | ✅ | `mcp-server/test/deployment-profile.test.js`；production 缺键抛 `code`、local 缺 RPC 不报错 |
| T3 健康检查 + 告警 | `mcp-server/src/health.js`（`/health` liveness/readiness + `HEALTH_STRICT_STARTUP`）；`mcp-server/src/alerting.js`（`ALERT_RULES_FILE`/默认规则） | ✅ | `mcp-server/test/health-alerting.test.js`；readiness 失败 503、strict-startup 拒绝启动、`alert_fired` 落审计 |
| T4 环境发布 | `scripts/release-preflight.mjs`（[A]profile/[B]chain+artifact/[C]store 可写/[D]链可达/[E]6 包 lockstep）；`npm-publish.yml` 增 preflight job + 环境矩阵 + 审批门禁 | ✅ | `mcp-server/test/release-preflight.test.js`；缺键/缺 artifact → exit 1；`npm run test:release-packages` 绿 |
| T5 生产证书/密钥 | `mcp-server/src/secret-store.js`（`createSecretResolver` env:/file:/KMS provider SPI）；`chain-config.js` 走 resolver；`gen-mtls-certs.mjs --mode production` 受控 CA + 身份绑定 | ✅ | `mcp-server/test/secret-store.test.js`；缺受控 CA 拒绝（不回退自签）；不写 ca-key.pem |
| T6 手册 + 文档闭环 | `docs/DEPLOYMENT_OPS.md`（部署运行手册）；`SECURITY_INVARIANTS.md` v1.4（§4.1 补 T1-T5 入口、INV-008 可观测注记）；`SECURITY_GAP_ANALYSIS.md`（GAP-001 密钥 env 明文 / GAP-002 审计 hash-chain 边界）；本计划收尾 | ✅ | 手册与实现一致（每 T 提及 env/端点/规则文件真实存在）；mcp-server 142 测试全绿 |

### 已知边界（延续到 Sprint 8+，见 SECURITY_GAP_ANALYSIS.md）

- **GAP-001**：密钥默认仍 env 明文注入；secret-store SPI 已就绪，KMS 具体实现未随包发货（零隐式依赖设计）。
- **GAP-002**：审计未做 hash-chain 固化、无集中式审计面板；本轮仅补齐可观测面（/metrics /health /告警）。

## 备注：与后续 Sprint 关系

- **Sprint 8+（下一阶段能力）**：allowance/approve 可量化模拟 + owner opt-in、集中式 anti-replay、多链扩展、更完整 Agent-to-Agent transport。Sprint 7 的 secret-store SPI / 指标面即为其部署底座。
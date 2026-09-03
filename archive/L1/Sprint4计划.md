# Sprint 4 任务单 — Transport / Message Security P1 + 运营化落地

> 前置：Sprint 3 已落地、PR #13（feat/sprint3-simulation-policy-transport）**未合并**。
> Sprint 4 基线与后续新代码一律基于该分支（勿从 master 另起，否则缺 Sprint 3 上下文）。
> 主线：接通白皮书「传输安全 + 消息安全 + 执行安全」三层。
> 范围：只做 **transport + operator 能力**，不做多链扩展。

## 0. 复核对齐（防重复规划）— 已完成项
- message-security 参考实现（Sprint 3 T3）→ T1 在此**升级为默认能力**，非另起炉灶。
- 持久化 / 审计 / 交易台账（Sprint 2.6/2.7）：chain-state-store.js 已含
  `SMART_ACCOUNT_STATE_FILE` 持久化 + txLedger `submitted→mined→confirmed→failed`；
  audit-log.js + observability.js 已落审计/指标。
  → T2/T3 是**补缺口**，不是新建。

## T1 Message Security 默认化（核心，最高优先）✅ 已落地
- T1.1 `createHttpTransport` 加 `messageSecurity` 选项（默认关；显式开启后 fail-closed）✅
- T1.2 统一信封 `sender/identity/nonce/timestamp/payload/signature`（复用 message-security.js）✅
- T1.3 服务端 inbound 验签中间层 `createInboundVerifier`（缺信封/未知身份/篡改/重放/过期 → fail-closed）✅
- T1.4 anti-replay 运行时化：`createReplayStore`（JSON 持久化 + 上限淘汰，重启不丢）✅
- T1.5 service identity 目录 `createIdentityDirectory`（did/agentId → 公钥+verifier，resolve 失败 fail-closed）✅
- T1.6 E2E：CoordinationClient → signed transport → 本地 HTTP 服务 inbound 验签 → 处理 ✅
- 新模块：service-identity.js / transport-security.js；index + package.json 子路径导出
- 测试：transport-security.test.js（新增 9 用例）；agent-sdk 47/47、mcp-server 42/42 全绿

## T2 持久化 / 审计补缺口（在已有状态层闭合）✅ 已落地
- T2.1 simulationLog 持久化 ✅：arming 随 SMART_ACCOUNT_STATE_FILE 落盘（simulations 字段），
      恢复时 restoreSimulationLog 重建——窗口为绝对时间，重启不改变门禁语义
- T2.2 policy 版本快照落审计 ✅：`maybeAuditPolicyChange` 指纹规则集（sha256），变化即记
      `policy_change` 审计（旧→新指纹 + 快照 + context），execute 门禁与 smart_account_policy 均接入
- T2.3 audit schema 校验 ✅：audit-log.js 新增 AUDIT_SCHEMA + validateAuditEntry，
      recordAudit 违规 → stderr `[audit] SCHEMA VIOLATION`（不静默、不中断）
- 测试：mcp-smart-account-t2.test.js（7 用例：schema/roundtrip/TOCTOU 回归/arming 落盘/policy_change×2/稳定字段）
      + smoke T2.1 重启窗口恢复（外部链 E2E：arm→重启→同 digest 放行/异 digest 仍拦截）
- 回归：mcp-server 50/50 全绿（agent-sdk 48/48 未受影响）
- 复核修复（v1.2.1）：execute 门禁单次读取策略文件——指纹与裁决同一份规则
      （消除热更新 TOCTOU 致审计失真 + 每次执行 2 次读盘）；补 restoreSimulationLog 端到端回归
- 已知限制：LocalChain 模式 arming 落盘但不恢复（与 accounts/txLedger 既有行为一致，临时链）

## T3 Relayer 运营化（在已有 txLedger 上补）✅ 已落地
- T3.1 nonce 冲突恢复 ✅：classifyRelayerFailure 区分「合约意图 BadNonce 重放」（确定性，
      fail-closed 不重试）与「relayer EOA nonce 冲突」（NONCE_CONFLICT，重试即重读 fresh
      nonce —— ethers cacheTimeout:-1 已保证每次 populate 重读）
- T3.2 RPC 抖动重试 ✅：executeWithRelayerResilience 指数退避重试（RELAYER_MAX_RETRIES /
      RELAYER_RETRY_BACKOFF_MS）；广播后 wait 失败先对账 receipt（已落账复用结果，
      绝不盲目重发）；重试/对账次数进审计+日志+指标（smart_account_execute_retried）
- T3.3 密钥隔离 ✅：非 local 配置面禁止经工具参数直传 owner/emergency 私钥（fail-closed），
      一律 CHAIN_OWNER_PK / CHAIN_EMERGENCY_PK env 注入；local 保留 anvil 开发便利
- T3.4 testnet 冒烟 ✅：smoke 套件 setup 改为 env 注入（proof of T3.3），完整生命周期在
      testnet 配置面 + 外部链进程上跑（含 T2.1 重启窗口）
- 新模块：relayer-operations.js（分类 + 韧性广播）；chain-connection.js executeFromAgent
      增强（wait 对账 + status-0 语义化）
- 测试：relayer-operations.test.js（10 用例：分类 5 + 韧性 5，含对账不重发）
- 回归：mcp-server 60/60、chain-eth 74/74、agent-sdk 48/48 全绿
- 复核修复（v1.3.1）：分类顺序先合约错误后 reason —— estimateGas 路径 reason 常含
      "eth_call"/"network"，先匹配会把合约拒绝误判为可重试 RPC_ERROR（白等退避 + 审计码失真）
- 复核修复（v1.3.2）：ops-smoke-demo.mjs setup 改 env 注入（T3.3 后工具参数会被拒绝，
      脚本已损坏——env 早已注入，参数纯属冗余）；退避后重查 receipt（pendingWaitFailedHash
      原为死变量，退避期间落账的 tx 会被白付 gas 重发）；provider null 守卫；
      reconciled 进审计；demo 断言 10→11 行（T2.2 policy_change 初始事件）
- 新增覆盖：chain-connection-resilience.test.js（status-0 语义 / wait 对账恢复 /
      wait 未恢复 / 无 provider 软失败）+ relayer-operations 退避期间落账用例

## T4 文档 / 规范闭环
- T4.1 更新 SECURITY_INVARIANTS.md（message-security / simulation gate / policy engine 不变式）✅
- T4.2 更新 TRANSPORT_SECURITY_P1_PLAN.md（进度状态 → 已落地项标注）✅
- T4.3 测试入口映射表（message-security / sim-policy / policy / smoke → 测试文件）✅（纳入 INV-008/009 §4.1 映射行 + §0.5 P1 进度表）

## 优先顺序与验收
1 → T1.1~T1.6；2 → T2.1~T2.3；3 → T3.1~T3.4；4 → T4.1~T4.3。
每 T 完成即跑全量回归：mcp-server + agent-sdk 全绿（当前基线 42/42 + 38/38）。
T1 全部完成后提交一版（先落 message security 主线），T2-T4 再各自提交。

## 变更记录
| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-22 | v1.0 | 初次生成（基于 Sprint 3 复核对齐） |
| 2026-08-22 | v1.1 | T1 全部落地（transport-security.js / service-identity.js / coordination 接线 / E2E） |
| 2026-08-22 | v1.2 | T2 全部落地（simulationLog 持久化 / policy_change 审计 / audit schema 校验） |
| 2026-08-22 | v1.2.1 | T2 复核修复：策略单次读取消 TOCTOU + 重启窗口恢复 E2E 回归 |
| 2026-08-22 | v1.3 | T3 全部落地（relayer-operations / chain-connection 增强 / 密钥隔离 / smoke env 注入） |
| 2026-08-22 | v1.3.2 | T3 复核修复：demo env 化 / 退避后对账 / 守卫 / reconciled 审计 / 新增 5 个韧性路径用例 |
| 2026-08-23 | v1.4 | T4 全部落地（SECURITY_INVARIANTS v1.2 / P1_PLAN 进度标注 / 测试入口映射）；P1.3 TLS·mTLS 如实标注未落地 |

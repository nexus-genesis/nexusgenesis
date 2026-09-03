# Sprint 3 白皮书落地下一层 — 任务单

> 生成日期：2026-08-22
> 前置：Sprint 2.6 生产化收口（配置/分层/持久化/错误归一化/冒烟）+ Sprint 2.7 可审计可运营（审计/指标/生命周期）均已完成
> 目标：从"链上执行安全"走向"完整 Agent 交易系统安全"，对齐白皮书目标架构
> `Policy Engine -> Signer/Relayer -> Smart Account`（链下软策略 → 广播层 → 链上硬策略最终裁决）

---

## T1 Simulation 正式化

**现状**：`smart_account_preview` 已有雏形三态（wouldExecute true/false/null）。缺：哪些 action 必须模拟、模拟失败如何 fail-closed。

**设计**（新模块 `mcp-server/src/simulation-policy.js`）：
- `SIMULATION_REQUIRED_ACTIONS`：资金/特权类（transfer / transferFrom / approve / withdraw / raise-limit / add-owner / upgrade / grant-role…）→ 必须经成功模拟
- `SIMULATION_SKIPPABLE_ACTIONS`：只读/无害类（balance / view / getBalance…）→ 可跳过
- `classifySimulationRisk(action)` → `{ level: required|skippable, requiresSimulation, rationale }`；**未知 action 一律 required（fail-closed）**
- `SIMULATION_WINDOW_MS = 60_000`：成功模拟的有效窗口（链上状态可能漂移，过期须重模拟）

**接线**（server.js）：
- preview 成功（带签名 wouldExecute=true）→ 记录 per-account `{ digest, at }`（内存 `simulationLog`）
- preview 返回追加 `simulation` 风险判定字段
- execute 广播前：若 action `requiresSimulation` 且无匹配且未过期的成功模拟 → **fail-closed 拒绝**，错误码 `SimulationRequired`（不消耗 nonce、不走链）
- 新工具 `smart_account_simulation_policy`：查策略表 + 任意 action 的模拟要求

---

## T2 Policy Engine 外置化

**现状**：策略写死在 [smart-account.js](packages/chain-eth/src/smart-account.js)（JS 引擎）与 [SmartAccount.sol](contracts/solidity/src/SmartAccount.sol)（链上硬策略）。无外置可配置层。

**设计**（新模块 `mcp-server/src/policy-engine.js`）：
- 规则表：action → `{ enabled, requiresSimulation, maxPerTx, maxDaily }`
- `loadPolicy()`：优先读 `SMART_ACCOUNT_POLICY_FILE`（JSON，可热更新：每次调用重读）；否则默认规则（空 = 软策略放行，链上硬策略仍兜底，**默认行为不变**）
- `evaluatePolicy({ action, amount })` → `{ allowed }` 或 `{ allowed:false, reason, code }`

**接线**（server.js）：
- execute：模拟门禁之后、relayer 广播之前调用 `evaluatePolicy`；软策略拒绝 → `PolicyRejected`（省 gas，不浪费链上调用）
- 分层语义固化：**Policy Engine（链下软策略，可热更新）→ Signer/Relayer（relayer 广播）→ Smart Account（链上硬策略最终裁决）**
- 新工具 `smart_account_policy`：列出当前生效规则表（可审计）

---

## T3 Transport / Message 安全 RFC

**现状**：`CoordinationClient`（[coordination.js](packages/agent-sdk/src/coordination.js)）是纯 HTTP 客户端，`agent_identity` 仅字符串，无签名/nonce/anti-replay；SECURITY_SPEC 有通信安全目标但无具体协议。

**交付**（以 RFC 为主，不急着大开发）：
1. RFC 文档 `docs/SMART_ACCOUNT_TRANSPORT_SECURITY_RFC.md`：目标与威胁模型、消息信封规范（version / payload / sender / target / nonce / timestamp / signature）、anti-replay 滑动窗口、service identity / mTLS、演进路线
2. 最小参考实现 `packages/agent-sdk/src/message-security.js`：`createMessageEnvelope` / `verifyMessageEnvelope`（注入式 signer/verifier + nonce/timestamp 校验 + anti-replay LRU 窗口）+ 导出
3. 参考实现不绑定具体签名后端（生产可注入 Dilithium2 / Ed25519 / EVM），纯函数、可测

---

## T4 测试与全量回归

- 新增 `mcp-server/test/mcp-smart-account-sim-policy.test.js`：模拟门禁（必经 preview）、policy 拒绝、`simulation_policy`/`policy` 工具
- 新增 `packages/agent-sdk/test/message-security.test.js`：签名/篡改/过期/重放四类用例
- 全量回归：`npm test`（mcp-server）+ agent-sdk 测试全绿
- 确认新增为附加性，不改动既有 33 条断言语义

---

## 变更记录

| 日期 | 版本 | 变更内容 |
|------|------|---------|
| 2026-08-22 | v1.0 | 初次生成 Sprint 3 任务单 |

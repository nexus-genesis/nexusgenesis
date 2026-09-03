# Sprint 2.7 可审计与可运营任务单

> 生成日期：2026-08-22
> 前置：Sprint 2.6 生产化收口已完成（T1 配置标准化 / T2 Relayer-Owner 分层+持久化 / T3 错误归一化 / T4 独立进程冒烟）
> 目标：让 Smart Account 链上链路适合长期运行 —— 可审计、可观测、交易生命周期可查询、重试规则安全。

---

## T1 审计日志（audit log）

**目标**：记录每次 `setup / preview / execute / estimate_loss` 的操作事实。

**关键字段**（调用方拿到完整审计事实）：
- `accountId` / `sessionId` / `payloadDigest` / `txHash` / `revert·errorName` / `broadcaster` / `timestamp`

**落地**：
- 新模块 `mcp-server/src/audit-log.js`：内存环形缓冲（上限 1000 条）+ JSON lines 双写（stderr + `AUDIT_LOG_FILE` 可选落盘，原子追加）。
- 各 handler 在关键点写入：setup（部署/注册失败与成功）、preview（三态：wouldExecute true/false/null）、execute（成功带 txHash+broadcaster=relayer 地址；失败带 errorName+broadcaster）、estimate_loss。
- 新工具 `smart_account_audit`：按 accountId 过滤 + limit 查询最近审计记录。

**验收**：对 setup→preview→execute(成功+失败)→estimate_loss 各触发一次后，audit 记录包含全部关键字段；`smart_account_audit` 可查回。

---

## T2 可观测性（metrics + 结构化日志）

**目标**：无需外部依赖的最小指标面，至少能看：
- preview 次数、execute 成功率、revert 分类、nonce 冲突次数、超限/过期拒绝次数、RPC 错误次数。

**落地**：
- 新模块 `mcp-server/src/observability.js`：内存计数器（`incr/snapshot/reset`）+ `logStructured(event, fields)`（stderr JSON lines，stdio 安全）。
- 指标接入：
  - preview → `smart_account_preview_count`；revert → `smart_account_revert_{errorName}`；限流/过期 → `smart_account_limit_rejected`
  - execute → `smart_account_execute_total/success/failed`；`BadNonce` → `smart_account_nonce_conflict`；`RPC_ERROR` → `smart_account_rpc_error`
- 新工具 `smart_account_metrics`：返回计数器快照。

**验收**：一轮成功 execute + 一次超限拒绝 + 一次重放后，计数器：preview≥1、execute_total≥2、success=1、failed≥1、nonce_conflict≥1、limit_rejected≥1、revert 分类出现。

---

## T3 交易生命周期管理 + 安全重试规则

**目标**：
- 状态机 `submitted → mined → confirmed → failed`。
- 对外返回不止 txHash，还有状态查询/重查能力。
- 明确重放保护下的安全重试规则（策略落文档 + 代码护栏）。

**落地**：
- [chain-state-store.js](mcp-server/src/chain-state-store.js) 扩展交易台账：`transactions` 数组（环形 200 条）随状态文件持久化；`recordTx / listTx / getTxLedger`。
- execute 返回追加 `status`；成功记录 `confirmed`（receipt.status=1）带 blockNumber/gasUsed，失败记录 `failed` 带 errorName。
- 新工具 `smart_account_tx_status({ txHash })`：查本地台账 + 重查链上 receipt（无 receipt → `submitted/pending`；status=1 → `confirmed`；status=0 → `failed`）。
- **安全重试规则**（写入工具 note 与本文档）：
  - 唯一可安全重试的失败是 `RPC_ERROR`（广播未上链，nonce 未消耗）——可在 `smart_account_tx_status` 确认无 receipt 后重发同 payload。
  - `BadNonce`（revert 后 nonce 已消耗）**禁止自动重发**同 payload —— 必须用下一 nonce 重建 payload 重签（签名绑定 nonce）。
  - 节点超时/RPC 抖动 → 一律先 `smart_account_tx_status(txHash)` 判明 submitted/pending 再决定，绝不明文重发（防双花语义）。
  - 重发保护：`txHash` 不变则视为同一笔，仅查状态，不重复广播。

**验收**：execute 成功返回 `status:'confirmed'`；`smart_account_tx_status` 对已广播 txHash 重查返回 confirmed + blockNumber；对未上链 hash 返回 pending/submitted；Failed 分类正确。

---

## T4 测试与全量回归

- 新增 `mcp-server/test/mcp-smart-account-ops.test.js`：审计字段、指标计数、tx 生命周期/状态重查。
- 全量回归：`npm test`（mcp-security + smart-account + smoke + ops）全绿。
- 确认新增字段为**附加性**，不改动既有 28 条断言语义。

---

## 变更记录

| 日期 | 版本 | 变更内容 |
|------|------|---------|
| 2026-08-22 | v1.0 | 初次生成 Sprint 2.7 任务单 |
| 2026-08-22 | v1.1 | **全部完成**：T1 审计日志（audit-log.js + 埋点 + smart_account_audit）、T2 可观测性（observability.js + smart_account_metrics）、T3 生命周期（chain-state-store 台账 + smart_account_tx_status + 安全重试规则）、T4 测试（ops 专项 5/5，全量回归 33/33） |

### 交付产物

| 任务 | 产物 |
|------|------|
| T1 审计日志 | `mcp-server/src/audit-log.js`（stderr + `AUDIT_LOG_FILE` JSON lines + 内存环 1000）+ 四 handler 埋点 + `smart_account_audit` |
| T2 可观测性 | `mcp-server/src/observability.js`（零依赖计数器 + 结构化日志）+ `smart_account_metrics` |
| T3 交易生命周期 | [chain-state-store.js](mcp-server/src/chain-state-store.js) 交易台账（随状态文件持久化）+ execute 返回 `status` + `smart_account_tx_status` 重查链上 receipt + 安全重试规则 note |
| T4 测试 | `mcp-server/test/mcp-smart-account-ops.test.js`（5 用例） |

### 安全重试规则（随 `smart_account_tx_status` 下发）

- 唯一可安全重发的失败是 `RPC_ERROR`（广播未上链、nonce 未消耗）——先用 `tx_status` 确认无 receipt 后再重发同 payload。
- `BadNonce`（nonce 已被链上消耗）**禁止自动重发**同 payload —— 必须用下一 nonce 重建 payload 并重签（签名绑定 nonce）。
- 节点超时 / RPC 抖动 → 一律先 `tx_status(txHash)` 判明 submitted/pending 再决定，绝不明文重发（防双花语义）。
- 重发保护：txHash 不变视为同一笔，仅查状态，不重复广播。

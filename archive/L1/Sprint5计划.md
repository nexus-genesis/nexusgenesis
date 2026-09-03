# Sprint 5 任务单 — Transport Security P1 收尾（TLS/mTLS + Policy 遗留闭合）

> 前置：Sprint 3/4 已落地，分支 `feat/sprint4-transport-security`。
> Sprint 4 已经把 message security **运行时化**（INV-009）：签名信封 + inbound verifier + 持久化 replay store + service identity。
> Sprint 5 只做 [TRANSPORT_SECURITY_P1_PLAN.md](docs/TRANSPORT_SECURITY_P1_PLAN.md) 的 **P1.3 + P1.4 收尾**，不动 INV-009 既有语义。
> 主线：把消息安全从"应用层签名"补成"部署级 transport security"——传输加密（TLS/mTLS）+ 链下软策略字段闭合 + 严格失败模式 + 迁移清理。
> 结构仍沿用"实现 → 独立复核 → 修复 → 回归"闭环，每 T 完成即全量回归。

## 完成状态（Sprint 5 收尾确认）
| T | 内容 | 状态 | commit | 回归证据 |
|---|------|------|--------|---------|
| T1 | TLS 1.3 / mTLS（P1.3） | ✅ 闭环（含 8 验收用例） | `f03595d8` | `transport-mtls.test.js` 8/8 |
| T2 | Policy 字段 `maxDaily`/`requiresSimulation`（P1.4） | ✅ 闭环（含 3 复核修复） | `bbd8068f` | mcp-server 64→67 |
| T3 | Strict Fail Mode（P1.4） | ✅ 闭环（含 5 复核修复） | `64d53da8` | mcp-server 67→72 |
| T4 | 移除 `SMART_ACCOUNT_SIMULATION_GATE=0`（P1.4） | ✅ 闭环（复核无缺陷） | `64d53da8` | mcp-server 72→73 |
| T5.1 | `transport-mtls.test.js` | ✅（随 T1 落地） | `f03595d8` | agent-sdk 8/8 |
| T5.2 | signed transport + mTLS + replay guard E2E | ✅ 闭环 | （随 T5.3 提交） | `transport-mtls-e2e.test.js` 6/6 |
| T5.3 | 文档闭环（本文件 / P1_PLAN / INVARIANTS） | ✅ | （随 T5.2 提交） | — |

**Sprint 5 收尾全量回归**：agent-sdk **62/62**、mcp-server **73/73**（chain-eth 78/78、demo 39/39 基线未变）。

## 0. 复核对齐（防重复规划）— 已完成
- P1.1 Service Identity ✅（Sprint 4 T1，`packages/agent-sdk/src/service-identity.js`）
- P1.2 CoordinationClient 信封接线 ✅（Sprint 4 T1，`createHttpTransport` messageSecurity + `createInboundVerifier`/`createReplayStore`）
- P1.5 中 message-security 部分 ✅（`transport-security.test.js` / `message-security.test.js`）
- 未完成、需 Sprint 5 处理：**P1.3（TLS/mTLS）** + **P1.4 剩余项**（`maxDaily`/`requiresSimulation`/`fail-mode: strict`/移除 `SMART_ACCOUNT_SIMULATION_GATE=0`）

**当前基线（Sprint 4 收尾时全量回归）**：agent-sdk 48/48、mcp-server 61/61、chain-eth 78/78、demo 39/39。
新增覆盖后基线随之抬高，以实际跑通为准。

---

## 关键设计约束（P1.3 与 INV-009 正交）
- **INV-009 管应用层认证**（签名信封 / 防重放 / 身份），**P1.3 TLS 管传输层机密性**（加密 / 双向证书 / 证书链）。两者可独立演进，P1.3 不修改 `verifyMessageEnvelope` 语义。
- `maxDaily` 链下软策略依赖"日累计状态"。**本 Sprint 只做单机进程内累计 + 审计对账**；多实例共享状态留待 Sprint 6（避免在单机上提前引入分布式基础设施）。
- 证书只用于**开发/测试 CA**（`scripts/gen-mtls-certs.mjs`），生产 mTLS 证书签发对接 service identity / KMS 属 Sprint 7，不在本范围。

---

## T1 TLS 1.3 / mTLS 落地（P1.3，最高优先）
- T1.1 **开发证书脚本** `scripts/gen-mtls-certs.mjs`：自签 CA（server + client SAN），签发服务端/客户端证书；输出路径与 UID/有效期元数据可复现。
- T1.2 **TLS 1.3 服务端**（reference server，`mcp-server` 或独立样例）：`minVersion: 'TLSv1.3'`（禁用 TLS 1.2 及以下）、`requestCert/ca/rejectUnauthorized` 做双向证书校验、证书链校验；**握手双方身份落审计日志**（复用 `logStructured` 的 `[audit]` 通道）。
- T1.3 **TLS 客户端**：fetch/undici 配 `rejectUnauthorized` + 客户端证书；可选在 `createHttpTransport` 增加 TLS 选项（不改变未开启时行为）。
- T1.4 验收：
  - 明文 HTTP 请求 → 被拒（fail-closed）。
  - 证书过期 / 伪造 / 不受信任 CA → 握手失败（fail-closed）。
  - mTLS 握手双方身份落审计日志（关键行为可审计，INV-008）。
- 复核关注点：TLS 1.3 是否真的被强制（1.2 客户端握手是否被拒）；双向认证是否双方缺一即失败；证书轮换后旧证书是否立即失效。

## T2 Policy Engine 遗留字段闭合（P1.4）
- T2.1 **`maxDaily` 消费**：在 [mcp-server/src/policy-engine.js](mcp-server/src/policy-engine.js) 增加进程内日累计（滚动窗口，链下软策略层），超限 → `PolicyRejected`；累计命中/重置进审计（`policy_change`/execute 审计对账）。**单机进程内**，多实例共享状态显式延后到 Sprint 6。
- T2.2 **`requiresSimulation` 消费**：策略文件可覆盖静态风险表（[simulation-policy.js](mcp-server/src/simulation-policy.js#L49-L61)），方向**只能收紧不能放宽**——策略要求模拟而静态表标 skippable → 以策略为准（要求模拟）；策略标 skippable 而静态表要求 → 仍要求模拟（保守取并集）。
- 验收：命中 `maxDaily` 规则超限 → 链下拒绝（省 gas，不浪费链上调用）；`requiresSimulation` 覆盖方向只收紧、不出现放宽反例。
- 复核关注点：BigInt 精确比较（复刻 `amountExceeds`，杜绝 `Number()` 精度丢失，见 Sprint 3 复核缺陷 #2）；日累计窗口边界与链上 Smart Account 语义是否一致（INV-007）。

## T3 Strict Fail Mode（P1.4）
- `loadPolicy` 增加可选 fail mode：`SMART_ACCOUNT_POLICY_FILE` 损坏 / 加载失败 / 无 `rules` 数组时——
  - **默认（宽松）**：回退空表放行（软层不拦截、链上硬策略兜底），stderr 告警（现行为，保持）。
  - **strict**：`fail-mode: strict`（如 `SMART_ACCOUNT_POLICY_STRICT=1`）→ 拒绝所有匹配 action（fail-closed），不静默放行。
- 验收：损坏文件下 strict 模式拒绝执行（或软策略显式报错），默认宽松行为不变。
- 复核关注点：strict 与执行门禁的交互——拒绝粒度是"单条 action"还是"整笔 execute"，语义必须明确定义并有测试断言。

## T4 迁移清理（P1.4）
- **移除旧测试 / 旧流程里 `SMART_ACCOUNT_SIMULATION_GATE=0` 兼容路径**：改为走 preview-first（先成功模拟再广播）路径。
- 逐一扫描 `packages/agent-sdk/test/`、`mcp-server/test/`、`examples/` 中对该 env 的依赖。
- 验收：全量回归无任何测试依赖该 env 跳过模拟门禁；删除相关兼容分支后代码路径无死代码。
- 复核关注点：确认没有"靠关掉门禁才变绿"的测试——删兼容口后必须仍全绿（门禁是真生效，而非被绕过）。

## T5 回归与文档闭环
- T5.1 **`transport-mtls.test.js`**（`packages/agent-sdk/test/`）：本地自签 CA 起 TLS 1.3 server + 双向证书，不起真实网络——明文拒 / 过期拒 / 伪造拒 / mTLS 握手成功四态。
- T5.2 **E2E 完整验证链**：`signed transport + mTLS + replay guard`——Agent 签名的 envelope 经 TLS 通道到达服务端，inbound verifier 验签 + 防重放 + 身份落审计全链路通过。
- T5.3 **文档闭环**：
  - 更新 [SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md)（INV-009 补 TLS 传输层、INV-003/007 补 policy 字段、INV-008 补 mTLS 握手审计；§4.1 测试入口补 `transport-mtls.test.js`）。
  - 更新 [TRANSPORT_SECURITY_P1_PLAN.md](docs/TRANSPORT_SECURITY_P1_PLAN.md)（P1.3/P1.4 → 标注已落地）。
- 全量回归：mcp-server + agent-sdk 全绿为门槛（当前基线 61/61 + 48/48）。

---

## 优先顺序与验收
1 → T1（P1.3 TLS/mTLS）；2 → T2（policy 字段）；3 → T3（strict）；4 → T4（迁移清理）；5 → T5（回归 + 文档）。
T1 完成即提交一版（先落 TLS 主线），T2-T5 再各自提交。
每 T 验收口径：**所有攻击路径 fail-closed** + 有可引用测试证据（`Architecture → Threat → Invariant → Control → Test → Evidence`）。

## 变更记录
| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-23 | v1.0 | 初次生成（基于 [TRANSPORT_SECURITY_P1_PLAN.md](docs/TRANSPORT_SECURITY_P1_PLAN.md) §0.5 未落地项 + Sprint 4 基线） |
| 2026-08-23 | v1.1（收尾） | T1-T5.3 全部闭环；回归基线更新为 agent-sdk 62/62、mcp-server 73/73；T5.2 新增 `transport-mtls-e2e.test.js`（6 用例）；T5.3 同步 P1_PLAN / SECURITY_INVARIANTS |

## 备注：与后续 Sprint 关系
- **Sprint 6（分布式/多实例）**：replay guard 共享化、simulation/state store 持久层升级、policy 热更新多进程传播、relayer 多实例 nonce 协调——其中 `maxDaily`/simulation 的单机实现（T2/Sprint 5）即为其边界与输入。
- **Sprint 7（生产部署）**：TLS 证书签发对接 service identity/KMS、证书与密钥注入规范、dashboard/metrics/告警面板、testnet/staging/prod 发布流程。
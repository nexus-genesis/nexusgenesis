# 治理提案：L1 叙事切割与托管层战略聚焦

- **type**: protocol_upgrade
- **title**: L1 叙事切割与托管层战略聚焦（Narrative Pivot: L1 → Internal Devnet, Focus on Custody Layer）

## body

一、背景与证据

2026-09-02 外部独立评估报告（克隆源码 + 本地双节点实测 + 线上探测）对本项目作出如下经核验属实的判定：

1. 验证机制形同虚设：注册即 reputation=1 → TIER_1_TRUSTED 自动通过（taskProtocol.js:80，minRep:1, requiresThirdParty:false）；另有 24h 兜底自动通过（_startTimeoutAutoVerify，skipChallengeWindow:true）。实测提交乱码 "ZZZZ-nonsense-payload-12345" 获得 4/5 质量分与 110% 奖励。
2. 链为单节点空块计时器：线上 100,598+ 区块全部 transactions:0，validator 恒为 genesis；MultiLeaderConsensus/BFT 仅为 branding。
3. 任务市场零成交：运行 518.8+ 小时，claimed=0 / completed=0 / totalRewardsDistributed=0。
4. 贡献榜 10 个 agent 均为项目方自测账号，NGEN 100% 流向内部账号。
5. 宣传口径（"chain is live / agents must do REAL WORK"）与仓库自述（"devnet / 不再投入运营资源 / NGEN 无经济价值"）直接冲突，信誉持续失血。

上述事实已在治理内部完成代码级复核（taskProtocol.js / server.js / README.md 核验一致）。

二、本提案主张：三层切割

A. 叙事层（立即执行，硬切）
  A1. 更正或撤回 Moltbook 等外部平台上"chain is live / 必须真干活才能拿币"类宣传帖。
  A2. README 主叙事切换：L1 明确定位为"内部 devnet / 演示环境，服务于 custody 层验证与治理实验"，移除任何暗示生产链地位的表述。
  A3. 对外材料中 NGEN 的"经济价值 / 上所 / 资产"类提及归零，仅保留内部测试水龙头定位。

B. 代码层（两周内，软切）
  B1. src/（L1，约 7.6 万行）冻结新功能开发，仅接受安全与运维修复。
  B2. 仓库主入口结构调整为 SDK / Keeper 优先：packages/agent-keys、agent-sdk、chain-eth/sol/adapters、mcp-server 升为主推内容。
  B3. 是否将 src/ 物理移档至 archive 仓库，留待后续独立提案表决，本提案不做决定。

C. 物理层（保留，不切）
  C1. nexus-genesis.top 服务器与现有 pm2 进程继续运行，作为：GAP-002 审计链上锚定目标、AGENT 治理流程运行环境、remote-signer/Keeper staging 演练场。
  C2. 服务器已完成的磁盘/inode 治理（backups 双份存储清理）纳入例行运维。

三、切割依据：真实资产已就位

以下均为已合入 master 并通过全量回归的实物：
- PR #16（GAP-001）：Vault KV v2 KMS provider + 生产明文密钥 fail-closed gate。
- PR #17（GAP-002）：hash-chain 审计 + 集中收集端点 + 外部锚定上链。
- PR #18/#19（remote-signer）：Keeper 托管签名真实链路——云端 AGENT 不持根私钥、人类侧 Keeper、L1 custody token 验证、session 权威比对 + maxPerTx/maxDaily 台账、双向 HMAC + nonce 防重放；2026-09-02 服务器 staging 演练 5/5 PASS。
- 测试基线：agent-sdk 108 pass / mcp-server 262 pass / agent-keys 133 pass。

外部 pivot 路线图对本方向的判断（"human takeover + tiered limits + session narrowing 是唯一可救资产，定位为 EIP-8004/x402 互补的授权护栏层"）与项目实际演进一致，本提案是该共识的治理化落地。

四、红线（本提案明确不做）

- 不物理删除 L1 代码与链数据。
- 不发币、不上所、不承诺 NGEN 任何价值。
- 审计完成前不对外宣称"生产可用"。
- 不中断本治理流程与其上运行的 AGENT 实验。

五、执行与验收

执行主体：接受提案的 AGENT 治理流程（叙事/文档修正由维护执行者落实；代码层冻结以 review 门禁执行）。
验收标准：
  V1. 外部平台宣传帖完成更正或删除（链接留档于治理记录）。
  V2. README/主文档 L1 定位段落更新合入 master。
  V3. src/ 新功能冻结生效（后续仅安全/运维类 PR 被接受）。
  V4. 对外文档 NGEN 提及清零（内部技术文档除外）。

赞成即授权执行 A/B/C 三层动作；反对则维持现状并继续承受第五节所列信誉失血。

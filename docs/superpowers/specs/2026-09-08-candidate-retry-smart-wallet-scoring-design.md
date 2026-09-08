# 普通候选复查与聪明钱加分设计

## 背景

普通候选当前只分析一次。首次分析时，即使 V2 卖出证据仅因真实卖家不足而保持 `unknown`，候选仍会写入 `seen`；链上游标不会回退，Gecko 后续发现也会被 `seen` 拒绝，因此该币之后积累出足够卖出证据也不会重新评分。`MIN_SCORE=70` 时，运行数小时没有普通评分推送是这一状态流与严格卖出门槛共同造成的结果。

同时，评分尚未识别已知 KOL 或聪明钱钱包。DeBot 官方支持监控钱包的批量导入导出，但没有文档化的公开钱包标签 API；OKX 提供经过认证的 Smart Money/KOL 排行榜和信号 API，不过当前 Signal 支持链不包含 Robinhood Chain `4663`。本次以本地标签文件作为唯一运行时真相源，不抓取页面，不引入新的在线依赖。

## 目标

- 对已经进入深度卖出检查、但卖出状态仍为 `unknown` 的普通 Uniswap V2 候选执行有上限、可跨重启恢复的复查。
- 首次分析后的第 2、5、10 分钟各最多复查一次；超过 30 分钟停止。
- 继续让明确的卖出阻断风险立即推送；只有卖出安全确认且最终分数达到配置门槛时才推送普通评分报告。
- 从本地标签文件识别实际持有本币的 KOL/聪明钱买家：一个加 5 分，两个及以上加 8 分，最高加 8 分。
- 复用现有 Transfer 证据和读取结果，不为聪明钱识别增加 RPC 请求，不放宽当前 60 分预筛线。

## 非目标

- 不自动交易，不增加私钥或签名逻辑。
- 不调用 DeBot 未公开接口，不抓取 DeBot/GMGN 页面。
- 不实时接入 OKX；OKX 当前不支持 Robinhood Chain 信号，跨链地址只允许人工筛选后导入本地文件。
- 不让聪明钱标签绕过卖出安全门槛、年龄门槛或明确风险。
- 不改变 Pons 生命周期通知白名单及 Pons pending check 语义。

## 方案比较

### 方案 A：本地标签 + 复用现有持久化检查队列（采用）

标签完全本地读取，聪明钱匹配复用 V2 卖出检查已经收集的买家和余额。普通候选复查作为新类型写入现有 `pendingChecks`，复用原子状态写入、到期排序及跨重启恢复能力。

优点是没有新增在线依赖和 RPC 请求，也不需要新增状态文件顶层结构。缺点是标签质量由用户维护，DeBot/OKX 更新不会自动同步。

### 方案 B：独立普通候选重试存储

新增 `candidateRetries` 顶层状态和专用循环，职责更独立，但需要升级 `state.json` schema、迁移旧状态并复制 pending check 已有的排序与重试逻辑，当前收益不足以覆盖复杂度。

### 方案 C：实时 OKX/DeBot 集成

OKX 有正式 API，但需 API Key、Secret、Passphrase，且 Signal 支持链没有 `4663`；DeBot 没有文档化的钱包标签 API。此方案会引入第三方可用性、凭据和跨链误标风险，本次不采用。

## 本地标签格式

默认读取 `data/wallet-labels.json`。文件不存在表示功能未配置，返回空标签集合；文件存在但 JSON、地址、类型或重复项非法时，启动明确失败，不能静默忽略错误标签。

标准格式为数组：

```json
[
  {
    "address": "0x0000000000000000000000000000000000000001",
    "label": "example-wallet",
    "type": "smart_money",
    "source": "manual"
  }
]
```

- `address` 必须是合法 EVM 地址。
- `label` 必须是非空短文本。
- `type` 只允许 `kol` 或 `smart_money`。
- `source` 允许 `manual`、`debot` 或 `okx`，仅用于报告溯源。
- 同一地址重复出现视为配置错误，避免冲突标签被顺序覆盖。

同时接受 DeBot 导出的嵌套对象。解析器递归查找合法 EVM 地址键，并使用其 `mark` 作为 `label`、`debot` 作为 `source`；非 EVM 地址忽略。DeBot 数据没有可靠类型时统一记为 `smart_money`，用户可以转换为标准格式后手动改成 `kol`。

提供不含真实地址的示例文件；真实标签文件继续由用户自行维护，不提交到仓库。

## 聪明钱识别与评分

V2 卖出检查完成 Transfer 解析、EOA 买家筛选和固定区块余额读取后，在最多五个近期有效买家中优先保留已标记地址。只有分析区块时余额至少为一个完整 token 的已标记买家才算“已进入”；已卖空、合约、Router、池地址和销毁地址不计数。

检查结果增加规范化的 `walletSignals`：`status`、唯一命中数、最多三个用于展示的标签及类型，不输出地址。标签文件缺失时状态为 `unconfigured`，合法文件完成匹配后为 `known`；只有 `known` 状态的合法命中可以加分。畸形输入不能凭默认值获得奖励。

评分增加 `smart_money` 检查项：

- 0 个：0 分。
- 1 个唯一命中：5 分。
- 2 个及以上：8 分。

总分仍限制在 0–100。聪明钱是辅助信号，不能抵消红旗，也不改变 `sellability === confirmed` 的普通推送硬门槛。

为控制 Alchemy 消耗，预筛仍使用不包含卖出安全和聪明钱奖励的原有事实。`MIN_SCORE=70` 时只有原始预评分至少 60 的候选进入深检；本地标签不会让低于 60 分的候选触发额外 RPC。

Telegram 评分报告增加一行聪明钱命中数量和最多三个标签。文件缺失显示“标签未配置”，合法文件零命中显示“未命中”，两者不能混为一谈。

## 普通候选复查状态流

只为已经通过 Pons 身份分类的非 Pons、`venue=uniswap-v2` 普通候选创建 `candidate_recheck`：

1. 首次分析低于预筛线，结果为 `unknown:prefilter-score`：完成，不复查。
2. 首次分析为 `blocked`：立即推送风险，完成，不复查。
3. 首次分析为 `confirmed`：按最终分数决定是否推送，完成，不复查。
4. 首次分析进入过深检但仍为其他 `unknown`：把完整的规范化候选事件、首次分析时间和最大三次复查配置写入 `pendingChecks`，第一次到期时间为首次分析后 2 分钟。

复查到期时间锚定首次分析的绝对偏移，而不是逐次等待：`+2m`、`+5m`、`+10m`。进程离线错过到期点时在恢复后的下一轮执行，不重置锚点。每次复查把 `observedAt` 更新为当前时间，使年龄继续增长：

- 得到 `blocked`：立即推送并完成检查。
- 得到 `confirmed`：达到 `MIN_SCORE` 才推送，然后完成检查。
- 仍为 `unknown`：若还有偏移槽且候选未超过 `MAX_AGE_MINUTES`，原子更新下一到期时间；否则完成并保持静默。
- 分析或 Telegram 调用抛出错误：记录清洗后的错误上下文并消耗当前复查槽；有剩余槽则进入下一绝对偏移，没有则标记失败，让调用方和日志可见。

首次分析仍写入 `seen`，用于阻止发现源重复入队；持久化 `candidate_recheck` 直接执行保存的候选，不经过发现去重。检查完成后保留既有 `seen` TTL 行为。

普通候选首次分析和复查共享 watch 级串行执行器，避免链上源、Gecko 和复查同时执行深检。Pons 状态检查保持现有循环，但所有底层 RPC 继续受全局 CU 调度器限制。

## 存储与兼容性

沿用 `state.json` schema v4 和现有 `pendingChecks` 顶层对象。新增检查项只使用该对象已经允许的开放字段：

- `type: candidate_recheck`
- `event`: 规范化候选事件
- `firstAnalyzedAt`
- `attempts`、`nextAttemptAt`、`status`、`lastError`
- `retryOffsetsMs: [120000, 300000, 600000]`

Store 新增原子 `scheduleCheck` 方法；同一候选键重复调度时保持原检查，不重置次数。`runPendingChecks` 增加可识别的业务重排结果，不使用异常表示“证据尚不足”。现有 Pons handlers 返回值与错误重试行为保持兼容。

## 错误处理

- 标签文件缺失：视为未配置，不影响扫描。
- 标签文件存在但无效：启动失败并指出字段，不输出整个文件内容。
- 标签加载或命中计算出现非预期错误：保留上下文并向上抛出，不能静默改成零命中。
- 普通候选持久化调度失败：向上抛出，保留调用链；不得把未持久化的候选假装成已安排复查。
- 到期检查缺失事件或字段非法：标记失败并记录可识别错误，不吞掉。

## 测试与验收

- 标准标签数组、DeBot 嵌套导出、缺失文件、非法地址和重复地址均有测试。
- 一个有效持仓标签加 5 分，两个及以上加 8 分，已卖空和畸形证据不加分。
- 聪明钱不会让原始预评分低于 60 的候选进入深检。
- 首次深检得到 `unknown` 时持久化 `+2m` 检查，不被 `seen` 阻止。
- 三次复查的持久化到期点严格锚定首次分析后的 `+2m/+5m/+10m`；跨重启可恢复且不会重复调度。
- 复查得到 blocked 时无视分数推送；confirmed 只有达到门槛才推送；第三次仍 unknown 时静默完成。
- 超过年龄窗口不再分析；`prefilter-score` 与非 V2 不调度。
- 普通来源分析和 candidate recheck 全局串行。
- 现有 Pons pending checks、通知白名单、RPC CU 调度和只推送边界测试保持通过。
- 完整运行 `npm test` 与 `git diff --check`。

## 外部数据结论

- DeBot 钱包导入导出文档：<https://docs.debot.ai/basic-features/dao-ru-dao-chu-jian-kong-qian-bao-di-zhi>
- OKX Signal API 支持链：<https://web3.okx.com/zh-hans/onchainos/dev-docs/market/market-signal-chains>
- OKX Smart Money 排行榜：<https://web3.okx.com/pl/onchainos/dev-docs/market/market-signal-leaderboard-list>

只有官方文档将来明确支持 Robinhood Chain `4663`，并由用户提供专用只读 API 凭据后，才重新评估实时 OKX 同步。

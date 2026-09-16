# Robinhood 扫描器无推送恢复设计

## 目标

恢复 Robinhood 扫描器的实时发现与告警能力，同时保留现有审计状态，不删除生产 `data`。修复范围仅包括历史检查积压、普通链上游标无法建立、运行状态不可观测三个直接原因；不调整评分、年龄、告警门槛或交易能力。

## 已确认事实

- VPS 运行 `main` 的 `6d5e71c`，与 `origin/main` 一致。
- `data/robinhood/state.json` 中 `cursors.onchain` 为 `null`，普通链上扫描没有成功提交过区间。
- 状态中有 1817 个 pending check；其中 1812 个已尝试 3–4 次。
- 509 个 Pons 代币分别创建了 `curve_flow`、`holders`、`deployer_24h`、`line_a`，但六种 Pons 检查类型共用同一个完整 `inspectToken` 处理器。因此同一事件会重复执行相同的完整 RPC 检查。
- `listDueChecks` 只按最早 `nextAttemptAt` 取前 20 项，历史 Pons 积压会持续占用执行槽位。
- outbox 的 538 条 delivered 全部发生在 9 月 7 日，不能证明 9 月 10 日后的实时告警链路正常。
- screen 没有启用日志，生产环境首次链上扫描失败的具体异常已经无法追溯。本地只读复现显示首次 30 分钟区间扫描超过 120 秒仍未完成。

## 方案选择

采用“状态可审计迁移 + 单一 Pons 检查 + 公平调度 + 分段游标提交”。

不采用直接删除 state：删除会丢失游标、去重记录和审计信息，并可能造成漏报或重复报警。不采用仅重启：当前版本会重新加载同一批积压任务，不能消除根因。

## 状态模型与启动整理

状态版本从 5 升级为 6。pending check 的终态增加：

```js
{
  status: "expired",
  expiredAt: 1758000000000,
  expirationReason: "outside-alert-window"
}
```

合法状态为 `pending`、`completed`、`failed`、`expired`。`expired` 只表示任务已经失去告警时效或被新的等价任务替代，不表示检查成功；原记录、尝试次数和最后错误继续保留。

`createStore` 完成 v5 → v6 结构迁移后，由 Robinhood live 启动路径调用一次原子 `reconcilePendingChecks`：

1. 只处理状态为 `pending`、类型属于 `curve_flow / holders / deployer_24h / line_a / market / line_c` 的旧 Pons 检查。
2. token 状态不存在时标记 `expired`，原因为 `token-state-missing`。
3. token 地址、event ID、`birthAt` 或任务时间字段无效时标记 `expired`，原因为 `invalid-pending-check`，不猜测缺失数据。
4. token 的 `birthAt` 已超过 `MAX_AGE_MINUTES` 时标记 `expired`，原因为 `outside-alert-window`。
5. 对仍在年龄窗口内的检查按标准化 token 地址分组。选择 `createdAt` 最新、ID 字典序最大的检查作为来源，创建一个 `${eventId}:pons_inspection` 的 `pons_inspection` 任务；该任务继承组内最大 `attempts`、最早 `nextAttemptAt` 和所选来源的事件信息。
6. 旧任务全部标记 `expired`，原因为 `superseded-by:<canonical-id>`。如果 canonical ID 已存在，则只做旧任务终结，不重复创建。
7. 整理和 canonical 创建在一次状态写入中完成；写盘失败时内存状态也不得改变。

新 Pons launch 和 graduation 事件不再创建四个或两个同质任务，而是各创建一个 `pons_inspection`。提交同一 token 且带 replacement inspection 的更新生命周期事件时，原子地把该 token 仍在 pending 的旧 `pons_inspection` 标记为 `expired/superseded-by:<new-id>`，避免启动后再次形成重复积压。对于 `launch_swept`、`tokens_locked` 等不创建 replacement inspection 的更新，inspection 写回使用完整 token 快照 CAS；状态已经变化时丢弃旧结果并保留任务，下一轮基于最新生命周期状态重新检查。生命周期区间提交也携带预览开始时的 token 快照并原子校验；如果并发 inspection 已改变任一相关 token，则整个区间不落盘、不推进 Pons 游标，下一轮基于最新状态重放。

`activeCandidateRecoveryKeys` 只把 `status === "pending"` 的 candidate recovery 视为活跃任务，避免 `failed` 或 `expired` 记录阻止未来合法恢复。
watch pending worker 每轮结束后从持久状态重新同步内存 recovery key，保证任务在同一进程内进入终态后也能释放去重键。

## Pending check 执行与公平性

`createInspectionCheckHandlers` 只注册 `pons_inspection`；一次处理执行一次完整 `inspectToken`，然后使用现有原子 token/outbox 更新路径完成该任务。超时和可重试异常继续保留上下文并按现有最多五次策略退避；非预期、不可重试错误继续向上抛出。

`listDueChecks(at, limit)` 将 due 任务分成三个桶：

1. 实时候选：`candidate_recovery`、`candidate_recheck`；
2. Pons 生命周期：`pons_inspection` 以及尚未经过启动整理的旧 Pons 类型；
3. 其他类型。

每个桶内部仍按 `nextAttemptAt`、`createdAt`、`id` 排序。`listDueChecks` 接受起始桶游标，选择结果从该桶开始按三个桶轮询填充，空桶自动跳过，直到达到 limit。watch worker 在内存中保存并逐轮推进起始桶游标；即使 limit 小于活跃桶数量，下一轮也会从后续桶开始。这样每一类任务都有执行机会，同时不把调度游标写进生产 state。

## 普通链上扫描与游标

保留“首次启动覆盖最近 `MAX_AGE_MINUTES`”的现有产品行为，但把一个大区间拆成最多 200 个区块的提交单元：

1. 当 `cursors.onchain` 为 null 时，继续用区块时间二分找到年龄窗口边界。
2. 当边界大于 0 时，立即把“边界前一块”作为 bootstrap cursor 原子持久化；这不会跳过窗口内区块，重启后也无需重复二分。若边界为创世块 0，则直接从 0 扫描，首次成功后再提交非负游标。
3. 每轮只扫描 `[cursor + 1, min(safeHead, cursor + 200)]`。
4. 该段所有候选处理成功后，把游标提交到段尾；处理失败时游标保持原值，下轮重试同一段。
5. 追平后仍使用相同分段逻辑处理新增已确认区块。

200 区块是 Robinhood 当前 `getLogsChunked` 每个 RPC 子请求最多 10 区块约束下的上层工作单元，不新增配置开关。它限制单轮失败半径，并允许每个成功小段形成恢复点。

## 可观测性

日志不得包含 RPC URL、Telegram token、chat ID 或其他凭据。新增以下结构化单行日志：

- 启动整理：扫描任务数、expired 数、canonical 创建数、按原因计数。
- 链上轮次：`from/to/safeHead/cursorLag/durationMs/events/accepted/failed`。
- 链上错误：失败区间、阶段和保留 cause 的安全错误文本；不推进游标。
- pending worker：本轮 selected/completed/retried/failed，以及当前各状态和类型计数。
- outbox worker：本轮 delivered/retried/failed；只有发生状态变化时输出。
- 每小时健康摘要：onchain/Pons 游标、pending 各状态计数、最老 pending 年龄、outbox 各状态计数。

本次不新增 Telegram 运维报警，避免把“运行状态通知”混入交易候选频道。screen 部署必须启用 `-L` 和固定日志文件，使后续异常可追溯。

## 错误处理

- 启动整理写盘失败：启动失败并保留原文件，不带病运行。
- bootstrap cursor 写盘失败：普通链上 worker 报错，不扫描、不修改内存游标。
- 某个链上分段失败：记录范围和 cause，其他独立来源继续运行，该段游标不推进。
- Pons inspection 超时：保留 unfinished source，按现有退避重试；达到上限进入 `failed`。
- 超龄或被替代任务：进入 `expired`，不再调用任何外部数据源。
- Telegram 发送失败：保留现有 outbox 可靠重试语义，不回滚已经确认的链上游标。

## 配置加载

`createApp` 从实际 `projectRoot/.env` 读取文件配置，再用调用方显式传入的 `env`（默认 `process.env`）覆盖同名键。这样标准 `npm run watch -- --chain robinhood` 能读取 Telegram 与链级配置，同时保留容器、systemd 和测试通过进程环境覆盖 `.env` 的能力。`loadChainConfig` 继续保持纯解析函数，不自行访问文件系统；日志和测试不得输出凭据值。

## 测试设计

使用测试驱动方式覆盖：

1. v5 → v6 保留全部历史字段，并支持 `expiredAt/expirationReason`。
2. 生产形态的 509 × 4 旧任务在一次原子整理后全部退出 pending，超龄任务不调用 inspect。
3. 年龄窗口内同 token 的多个旧任务只生成一个 canonical inspection，重复启动幂等。
4. 新 Pons 事件只创建一个 inspection；较新的生命周期事件会 supersede 旧 pending inspection。
5. pending 三桶轮询不会让 candidate recovery 或 Pons inspection 饥饿。
6. 单次完整 inspection 只调用一次 inspect，并原子更新 token、任务和可选 outbox。
7. null onchain cursor 先提交 bootstrap cursor，再按 200 区块分段；成功逐段推进，失败段不推进并被重试。
8. 日志包含区间、延迟和任务计数，但不包含环境变量中的凭据。
9. 运行全部 `npm test`，基准是 709 项通过、0 失败。

## 部署与验收

部署前复制保存 VPS 的 `data` 目录，禁止删除或手工编辑生产 state。部署代码后首次启动会自动执行 v6 整理并打印统计。

验收条件：

- 启动后旧 Pons pending 不再持续占用队列，记录以 `expired` 保留。
- `cursors.onchain` 从 null 变为 bootstrap cursor，并在日志中逐段单调推进。
- `cursors.ponsV2` 能继续追随已确认链头，不被普通链上或 pending worker 阻塞。
- 连续观察至少 30 分钟，pending 数不会无界增长，失败区间能够从日志定位。
- Telegram 启动通知能够收到；候选通知仍严格服从现有年龄、可卖性和最低分规则。没有符合规则的候选时，不把“无候选推送”判为故障。

## 明确不做

- 不修改 `MIN_SCORE`、`MAX_AGE_MINUTES` 或告警真值表。
- 不增加交易、自动买卖或宽松兜底。
- 不升级依赖、不处理 npm audit 的既有问题。
- 不清空 seen、tokens、outbox、历史 pending 或游标。
- 不重构多链架构，不改 Base、BSC、Ethereum、Solana 的扫描策略。

# Telegram 推送降噪设计

## 目标

将 Telegram 保持为高价值报警通道：继续发送普通候选的完整 0–100 分报告，以及 `hard_kill`、`rescued`、`green`、`market_ready` 四类关键状态；停止发送 Pons 原始生命周期和市场热度消息，且首次补扫只恢复本地状态。

本次不改变扫描来源、评分公式、`MIN_SCORE`、Pons 合约识别、交易安全边界或 schema 版本。

## 最终推送策略

允许发送：

- 普通 Gecko/链上候选的完整评分报告。沿用现有规则：默认 `MIN_SCORE=55`，`review`、`green` 或蜜罐风险命中时发送。
- `hard_kill`：实时检查确认硬性淘汰。
- `rescued`：已观察代币的 Factory 权威状态变为 rescued。
- `green`：评分或状态检查形成绿色结论。
- `market_ready`：Hook 和双向市场证据确认。
- 机器人启动成功提示。

禁止发送：

- `new_launch`
- `swept`
- `graduated`
- `heat_changed` / `heat_change`
- `phase_changed`

禁止项仍可写终端日志和状态事实，但不能调用 Telegram。

## 数据流

### 首次补扫

`watch` 启动时若 `cursors.ponsV2` 为空，按既有 20 分钟窗口定位起点并扫描到安全区块。该范围以恢复模式提交：

- 保存 token 状态、生命周期事实、`appliedEvents` 和 Pons 游标。
- 不创建生命周期 outbox。
- 不创建会立即执行并产生历史结论的 pending checks。

因此全新部署或丢失游标后不会把历史 `new_launch`、毕业事件或历史检查结果集中发送到 Telegram。

### 实时 Pons 事件

游标建立后的新区块按实时模式处理：

- `token_launched`、`launch_swept`、`pool_graduated` 只更新权威状态，不直接生成生命周期消息。
- 仍按现有规则创建实时 pending checks。
- 检查只有形成允许的关键状态时才生成 outbox；普通未达标或资料未知不推送。
- `reconcilePonsWatchlist` 只允许为 `rescued` 生成消息；毕业或其他普通阶段变化只恢复状态。

普通候选的 `analyze → alertReport` 路径不经过生命周期 outbox，保持完整评分报告格式和现有阈值。

### 市场热度

市场热度继续计算、记录并输出终端日志，用于准入上限判断，但不再创建 Telegram outbox。

## 旧积压消息

仅停止生成新消息不足以阻止升级前已经存在于 `data/state.json` 的噪音。outbox worker 在真正调用 Telegram 前执行类型白名单：

- 允许类型正常发送并沿用现有重试。
- 禁止类型不调用 Telegram，原子标记为 `suppressed` 并记录 `suppressedAt`。
- `suppressed` 条目不再进入待发送查询，不删除历史记录。

该状态扩展沿用 schema v4，不迁移或删除用户数据，也不改变已投递消息。

## 错误处理

- 类型缺失或未知的生命周期 outbox 默认抑制，避免未来新增类型意外刷屏。
- 允许类型发送失败仍按现有有限指数退避重试；抑制动作不计为发送失败。
- 首次补扫若链上扫描、Factory getter 或原子提交失败，不推进游标，也不产生部分消息。
- 普通完整评分报告的发送错误处理保持不变。

## 测试与验收

自动化测试必须证明：

1. 空 Pons 游标的首次补扫会提交 token、事实、事件和游标，但 outbox 与 pending checks 均为空。
2. 已有游标后的实时 `token_launched` 不生成 `new_launch`，但仍创建必要 checks。
3. 实时 `swept`、`graduated` 和 reconcile 普通阶段变化不生成 Telegram 消息。
4. `hard_kill`、`rescued`、`green`、`market_ready` 通过白名单并正常投递。
5. `new_launch`、`swept`、`graduated`、`heat_change`、`phase_changed` 旧积压条目被标记为 `suppressed`，send 回调调用次数为零。
6. 市场热度继续落盘但不创建 outbox。
7. 普通候选达到 `MIN_SCORE` 后仍发送原有完整评分报告，低于阈值仍安静跳过。
8. 完整 `npm test` 和 `git diff --check` 通过，静态扫描仍确认没有签名或交易广播路径。

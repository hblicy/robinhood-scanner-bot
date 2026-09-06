# Robinhood Scanner Bot 遗留缺陷修复设计

## 目标与范围

修复复审报告确认的十项遗留问题，同时保持现有命令和默认安全策略不变：`watch` 只监听告警，`paper` 模拟交易，`live` 仍受多重开关和 `tradeReady` fail-closed 门控。此次不启用当前尚未满足安全条件的实盘交易，也不扩展到 Uniswap V3/V4 实盘路由。

范围包括：链上事件不漏扫、V4 池唯一标识、一次性扫描真正只读、pending 交易可恢复、成交量按交易回执核算、仓位与流水原子提交、配置范围校验、paper 入场价格校验、IPv6 URL 完整脱敏、Telegram 有界重试。

## 设计原则

- 默认失败关闭：无法证明交易结果时进入 `needs_review`，不猜测成交、不重复签发新交易。
- 同一笔签名交易可安全重播：恢复阶段只允许广播完全相同的 raw transaction。
- 状态一次提交：仓位变化和对应交易流水必须在同一个原子文件替换中完成。
- 扫描游标只表示“已完整消费”：候选尚未进入处理队列时不得推进区块 checkpoint。
- `scan` 无持久化和外部写副作用：不创建 `data/`、不读写 seen/positions/trades、不发送 Telegram。

## 扫描路径

### 链上事件与背压

`scanOnchain(from, to)` 返回区间内全部解析成功的事件，不再按 `maxQueueSize` 截断。`index.js` 增加按队列容量消费的 helper：队列满时先 drain，再重试当前事件；所有事件成功入队并处理后，watch 才把 `lastBlock` 推进到 `head`。这样容量只控制内存，不再成为丢弃策略。

若分析单个候选失败，现有行为继续记录错误并处理后续候选；区块日志已经成功获取和解析，因此不回退整个区间。Telegram 的短暂错误由通知层内部重试。

### V4 池身份

V4 `Initialize` 事件的 `id` 保存到事件 `pool` 字段。候选键继续使用 `venue|pool|token`，因此同一 token 的多个 V4 池不会碰撞。V4 仍只参与发现和告警，不进入实盘交易。

### 真正只读的一次性扫描

`scanOnce` 创建局部 `CandidateQueue`，其 `hasSeen` 恒为 false；处理依赖使用 no-op `markSeen`、控制台告警器和 `allowTrading:false`。该路径不会触发默认 store 的延迟初始化，也不会调用 Telegram。`watch/paper/live` 继续使用持久队列和正常通知。

## 交易状态机

### Durable pending

`prepareSignedCall` 返回 `{ hash, rawTx, nonce, broadcast }`。在首次广播前，pending 仓位原子落盘以下字段：

```json
{
  "txHash": "0x...",
  "rawTx": "0x...",
  "nonce": 12,
  "preparedAt": 1788690000000,
  "balanceBefore": "...",
  "amount": "...",
  "stage": "tp1"
}
```

买入只使用适用字段；卖出额外保存 `amount/stage/reason/price`。raw transaction 只能重放已签名的同一笔调用，不暴露私钥，也不能被修改为另一笔付款。

恢复顺序固定为：

1. 按 `txHash` 查询 receipt；存在则验证状态并结算。
2. receipt 不存在时查询 transaction；节点仍能看到该交易则保留 pending。
3. 节点看不到交易时，比较钱包最新 nonce。nonce 已被消费则转 `needs_review`，避免错误重签。
4. nonce 未消费且 raw transaction/nonce 完整时，重播同一 raw transaction并保持 pending。
5. 旧 pending 缺少 raw transaction 或 nonce 时转 `needs_review`，不永久等待。

广播或查询的非预期错误向调用方抛出并保留上下文；不会用宽泛 catch 把失败伪装成成功。

### 按 receipt 核算成交量

新增纯函数解析指定 token 合约在指定 receipt 中的 ERC-20 `Transfer` 日志：

- 买入量 = 流入钱包数量减流出钱包数量，必须大于零。
- 卖出量 = 流出钱包数量减流入钱包数量，必须大于零且最多为仓位剩余量。
- 只接收日志地址等于仓位 token、topic/参数可正确解析的事件。

这消除重启期间无关转账或 rebase 对余额差的污染。无法从目标交易日志得到正数成交量时转 `needs_review`。

## 原子状态存储

新状态文件为 `data/state.json`：

```json
{
  "schemaVersion": 3,
  "seen": {},
  "positions": {},
  "trades": []
}
```

store 对每次变更创建内存 draft，先把完整 draft 写入 `state.json.tmp`，再 rename 覆盖正式文件；只有文件替换成功后才更新进程内状态。新增原子 API 同时提交 position 变化和 trade：开仓、部分退出、完全退出均只进行一次状态文件替换。原有查询 API 保持不变，减少调用方变化。

首次非只读运行若不存在 `state.json`，读取旧 `seen.json`、`positions.json`、`trades.json`，执行现有仓位 schema 校验后写入 v3 状态；旧文件保留，不自动删除。若 `state.json` 已存在则只以它为准。损坏或不合法状态明确报错，不回退为空状态。

## 配置、paper 与通知

- `POLL_MS`、`GECKO_POLL_MS`、`POSITION_POLL_MS`、`LOOKBACK_BLOCKS`、`GAS_LIMIT` 在启动时验证为正整数。
- `BUY_AMOUNT_ETH`、`MAX_BUY_ETH` 必须能被 `parseEther` 解析且大于零；实盘已有二次校验继续保留。
- paper 建仓要求 `report.dex.priceUsd` 是有限正数；否则记录明确 skip 日志且不创建仓位。
- URL 脱敏匹配允许 IPv6 的 `]`，把整个 URL 交给 `URL` 解析器，输出只保留协议、`[redacted]` 和端口，不保留用户信息、主机、路径或查询参数。
- Telegram 已配置时最多尝试三次，采用短指数退避；最后一次失败继续抛出。未配置 Telegram 时控制台输出视为成功，不重试网络。
- `handleCandidate` 在需要告警时先完成告警，再 `markSeen`；安静跳过的候选直接记录 seen。这样一次通知失败不会先被标记为已通知。

## 测试与验收

所有修复遵循测试先行，每一项先运行并确认因旧行为而失败，再实现最小改动：

- `chain.test.js`：事件数超过队列容量仍全部返回；两个同 token V4 pool ID 不同。
- `queue.test.js` / `runtime.test.js` / 新的 index 测试：队列背压不丢事件；scan 不初始化 store、不标记 seen、不发 Telegram、不交易。
- `trade.test.js`：raw transaction 持久化；广播前崩溃后重播；已在 mempool 时等待；nonce 被占用时 needs_review；旧 pending 不永久等待；买卖仅按 receipt Transfer 日志结算。
- `store.test.js`：旧文件迁移；原子仓位+流水提交；写盘失败不污染内存；完全退出在同一次提交中删除仓位并追加流水。
- `safety.test.js`：IPv4、域名、带认证信息和 IPv6 URL 均完整脱敏。
- 配置子进程测试：负数/零数值启动失败，合法值通过。
- paper 测试：零/缺失价格不建仓。
- notify/runtime 测试：Telegram 前两次失败第三次成功；三次失败向上传递且不标记 seen。
- 最终运行完整 `npm test`、`git diff --check`，并执行一次无 Telegram 的 scan mock 和 pending 崩溃恢复定向测试。

## 非目标

- 不解除 `privilegesKnown=false` 或蜜罐验证未完成造成的实盘 fail-closed。
- 不新增 V3/V4 实盘交易。
- 不升级依赖、不重排目录、不格式化无关文件。
- 不删除旧状态文件，也不处理当前范围外的历史代码问题。

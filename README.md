# Robinhood Chain 扫链推送机器人

把 Robinhood Chain 的 Pons V2 生命周期、新池发现、风险分析和 Telegram 状态告警整合成一个只读机器人。

本版本只有扫描与推送功能：不读取私钥，不创建钱包，不签名、授权或广播交易，也不维护模拟仓位。Memecoin 风险极高，本工具不是投资建议。

## 能做什么

| 检查项 | 实现方式 |
| --- | --- |
| Pons V2 生命周期 | 以 Factory getter 和事件一致性确认身份，监听 Launch、Sweep、Graduated、Rescued，并核对 Hook 注册 |
| 新池发现 | 链上监听 Uniswap V2 `PairCreated`、V3 `PoolCreated`、V4 `Initialize`，并读取 GeckoTerminal `new_pools` |
| 年龄与市场数据 | 按 `MAX_AGE_MINUTES` 过滤，读取成交、买卖笔数、流动性和市值 |
| 社交与叙事 | 读取 DexScreener 社交链接并匹配名称关键词 |
| 持仓与创建者 | 读取 Blockscout holders、创建者余额和历史合约数量 |
| 蜜罐与税率线索 | 通过只读 RPC 调用检查 V2 双向报价和代币转账行为 |
| 流动性风险 | 检查 V2 LP 销毁比例；未知信息明确标为未完成 |

分析结论是启发式筛选，不等于安全证明。合约元数据、字节码或市场数据不完整时会重试，不会把候选标为已处理。Blockscout 等辅助数据失败时会显示“数据异常/未知”，且不会作为安全加分。

## 快速开始

```bash
cd robinhood-scanner-bot
npm install
copy .env.example .env
```

Telegram 可选；不配置时报告只打印到终端。

```bash
# 持续监听、终端输出，并在已配置时发送 Telegram
npm run watch

# 一次性扫描后退出；不写 data/，不发送 Telegram；部分失败时退出码非零
npm run scan

# 只读检查指定代币；90 秒后仍未完成的数据源会明确标记 unknown
npm run check -- 0x你的合约地址
```

只有 `watch`、`scan`、`check` 三个命令。`paper` 和 `live` 已移除，传入时会在连接 RPC、读取状态或发送通知前直接报错退出。

Linux 服务器可以在 `screen` 中持续运行：

```bash
screen -S robinhood
cd ~/robinhood-scanner-bot
npm run watch
# Ctrl+A，再按 D：退出 screen 但保持机器人运行
screen -r robinhood
```

单个 GeckoTerminal、DexPaprika 或 Blockscout 限流/超时时，对应辅助证据会标记为 `unknown`，不会被当作安全通过。`watch` 会按有上限的退避重试；Factory 原始日志、ABI 解码或状态不变量失败则会保留错误并停止推进该生命周期区间。

## Telegram

1. 找 [@BotFather](https://t.me/BotFather) 创建机器人并取得 token。
2. 把机器人加入频道或群，或先私聊发送 `/start`。
3. 通过 Telegram Bot API 的 `getUpdates` 方法查询 `chat.id`。
4. 把值写入本地 `.env` 的 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`。

不要提交 `.env`，也不要把 token 粘贴到日志或问题报告中。

## 主要配置

```dotenv
RPC_URL=https://rpc.mainnet.chain.robinhood.com
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

MAX_AGE_MINUTES=30
MIN_LIQUIDITY_USD=1500
MAX_MCAP_USD=1500000
MIN_SCORE=55

POLL_MS=2500
GECKO_POLL_MS=15000
ONCHAIN_SCAN=true
GECKO_SCAN=true
CONFIRMATION_BLOCKS=2
MAX_QUEUE_SIZE=500
MAX_SEEN_ENTRIES=10000
SEEN_TTL_MS=86400000
DEXPAPRIKA_SCAN=true
```

布尔值只接受 `true/false`、`1/0`、`yes/no`、`on/off`；`QUOTE_TOKENS` 接受内置 `WETH`、`ETH`、`USDG` 或明确的 20-byte 地址，symbol 只用于显示，不能决定 LONG 分类。至少启用一个扫描来源。数值越界时程序会明确报错。公共 RPC 可以用于试跑；长期监听建议使用稳定的专用 RPC。

## 扫描恢复与本地状态

`watch` 会以 schema v4 原子写入 `data/state.json`，维护：

- 已处理候选 `seen`，用于去重；
- `cursors.onchain`，表示最后一个全部候选均处理成功的区块；
- `cursors.ponsV2`、`tokens` 和 `watchlist`，保存独立的 Pons 生命周期游标与观察状态；
- `appliedEvents`、`outbox` 和 `pendingChecks`，用于事件去重、Telegram 可靠投递和辅助数据重试；
- `heat`，保存当前市场热度快照，不改变已有观察对象的准入决定；
- 旧版本留下的 `positions`、`trades` 历史字段，原样保留但不再读取、轮询或修改其业务内容。

Pons 链上阶段为 `not_graduated → swept → pool_created`，`rescued` 是不可回退终态；观察状态另行使用 `observed/watchlisted/curve_dead/decay/killed`。`pool_created` 只说明链上毕业，只有 Hook、池绑定、流动性和双向交易证据完整时 `marketReady` 才为 `true`。三类状态不会互相代替。

首次运行按区块时间二分定位年龄窗口起点。已有游标时，从“已保存游标”和“当前年龄窗口起点”中较新的位置继续。链上默认只处理落后最新高度 2 个区块的已确认范围。Factory 日志、身份 getter 和状态转换与 Pons 游标同次落盘；Telegram 或外部市场源失败不会回滚已确认的 Factory 游标，而会留在 outbox/pending check 中重试。超过 `MAX_AGE_MINUTES` 的辅助候选严格跳过。

链上与 GeckoTerminal 独立运行：一个来源故障不会阻止另一个来源。`scan` 会处理已取得的候选后汇总错误并以非零状态退出，不会把部分成功伪装成整轮成功；整轮超过 120 秒会明确报超时，公共 RPC 无法及时扫完时请换专用 RPC。`watch` 对同一 `data/` 使用单实例锁，重复启动会明确报错。

`scan` 和 `check` 不创建锁、不创建或修改 `data/`，也不发送 Telegram。配置文件通过局部解析读取，旧 `.env` 中的私钥或交易字段不会注入进程配置，也不会被程序访问。

升级前建议先备份 `data/state.json`。程序会从旧 schema v3 迁移到 v4，但不会删除旧版 `positions`、`trades` 或其他历史文件。

## 明确不做

- 不构造、签名、授权或广播链上交易；
- 不提供模拟买卖、自动买入、止盈止损或仓位管理；
- 不连接网页钱包，不索取助记词或私钥；
- 不保证准确率或收益。

## 网络参数

| 项目 | 值 |
| --- | --- |
| Chain ID | 4663 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| 浏览器 | `https://robinhoodchain.blockscout.com` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap V2 Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` |
| Uniswap V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Uniswap V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |

# Robinhood Chain 扫链推送机器人

把 Robinhood Chain 新池发现、风险分析、评分和 Telegram 告警整合成一个只读机器人。

本版本只有扫描与推送功能：不读取私钥，不创建钱包，不签名、授权或广播交易，也不维护模拟仓位。Memecoin 风险极高，本工具不是投资建议。

## 能做什么

| 检查项 | 实现方式 |
| --- | --- |
| 新池发现 | 链上监听 Uniswap V2 `PairCreated`、V3 `PoolCreated`、V4 `Initialize`，并读取 GeckoTerminal `new_pools` |
| 年龄与市场数据 | 按 `MAX_AGE_MINUTES` 过滤，读取成交、买卖笔数、流动性和市值 |
| 社交与叙事 | 读取 DexScreener 社交链接并匹配名称关键词 |
| 持仓与创建者 | 读取 Blockscout holders、创建者余额和历史合约数量 |
| 蜜罐与税率线索 | 通过只读 RPC 调用检查 V2 双向报价和代币转账行为 |
| 流动性风险 | 检查 V2 LP 销毁比例；未知信息明确标为未完成 |

分析结论是启发式筛选，不等于安全证明。缺失的市场绑定、持仓、权限或安全数据不会作为安全加分。

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

# 一次性扫描后退出；不写 data/，不发送 Telegram
npm run scan

# 只读分析指定代币
npm run check -- 0x你的合约地址
```

只有 `watch`、`scan`、`check` 三个命令。`paper` 和 `live` 已移除，传入时会在连接 RPC、读取状态或发送通知前直接报错退出。

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
MAX_QUEUE_SIZE=500
MAX_SEEN_ENTRIES=10000
SEEN_TTL_MS=86400000
```

数值配置不合法时程序会明确报错。公共 RPC 可以用于试跑；长期监听建议使用稳定的专用 RPC。

## 扫描恢复与本地状态

`watch` 会写入 `data/state.json`，仅维护：

- 已处理候选 `seen`，用于去重；
- `cursors.onchain`，表示最后一个全部候选均处理成功的区块；
- 旧版本留下的 `positions`、`trades` 历史字段，原样保留但不再读取、轮询或修改其业务内容。

首次运行按区块时间二分定位年龄窗口起点。已有游标时，从“已保存游标”和“当前年龄窗口起点”中较新的位置继续。某一区间只要有候选分析或 Telegram 推送失败，就不会推进游标；下一轮会重扫该区间，成功候选由 `seen` 去重，失败候选会重试。

`scan` 和 `check` 不创建或修改 `data/`，也不发送 Telegram。

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

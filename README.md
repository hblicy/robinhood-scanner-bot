# Robinhood Chain 扫链机器人

把 [加密狗这篇 Robinhood Chain Memecoin 教程](https://x.com/jiamigou/status/2075057589457735949) 里的人工扫链清单，做成可跑的监听 + Telegram 报警机器人。

默认 **只扫链、只报警，不自动买入**。这和原文建议一致：先熟悉工具 → 监听 + Telegram → 熟练后再考虑把规则代码化。

> 新链早期 99% 的 Memecoin 会归零。这不是投资建议。私钥只放专用小钱包。

## 原文对应关系

| 教程步骤 | 机器人怎么做 |
| --- | --- |
| DexScreener 新交易对 + NOXA / 新池 | 链上监听 Uniswap V2 `PairCreated`、V3 `PoolCreated`、V4 `Initialize`；GeckoTerminal `new_pools` 覆盖 Pons 等发射台 |
| 年龄 &lt; 30 分钟 | `MAX_AGE_MINUTES` |
| 社交 / 叙事（Robinhood、GME、猫狗…） | DexScreener 社交链接 + 名称关键词 |
| 交易量上升、买入主导、低市值 | Gecko / DexScreener 5 分钟买卖与成交 |
| 浏览器看前 10 持仓、创建者有没有狂卖 | Blockscout holders + 创建者余额 |
| GMGN 聪明钱 / 地毯 | 报告里带 GMGN 链接，需人工点开 |
| 蜜罐 / 高税 | V2 报价和转账只作诊断；没有可信完整 Router 模拟时保持“未完成”并禁止实盘 |
| 流动性可随时移除 | 只检查 V2 LP 销毁比例，不声称第三方锁仓 |
| 创建者是不是串子 | 创建者历史合约数量 |
| 控制单笔金额 | `BUY_AMOUNT_ETH` / `MAX_BUY_ETH` 是固定 ETH 额度，不代表钱包净值比例 |
| 2x 卖 30%、5x 卖 30%、10x 清仓；跌 50% 止损 | `paper` / `live` 持仓轮询 |

## 快速开始

```bash
cd robinhood-scanner-bot
npm install
copy .env.example .env
```

编辑 `.env`：至少填 Telegram（不填也能在终端看报警）。

```bash
# 查一枚已有代币（把 CA 换掉）
npm run check -- 0x你的合约

# 扫最近新池，跑一轮就退出；无论 .env MODE 如何都只读
npm run scan

# 持续监听 + Telegram（推荐先用这个）
npm run watch

# 监听 + 规则演示（不发真实交易，也不是收益回测）
npm run paper
```

### Telegram

1. 找 [@BotFather](https://t.me/BotFather) 创建机器人，拿到 token。
2. 把机器人拉进你的频道/群，或先私聊它发一句 `/start`。
3. 用 `https://api.telegram.org/bot<token>/getUpdates` 查 `chat.id`。
4. 写入 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`。

## 配置要点

```
MODE=watch                 # watch | paper | live
MAX_AGE_MINUTES=30
MIN_LIQUIDITY_USD=1500
MAX_MCAP_USD=1500000
MIN_SCORE=55
ENABLE_LIVE_TRADING=false  # 永远先保持 false
```

真实交易只允许显式执行 `node src/index.js live`，并且必须 **同时** 满足：`ENABLE_LIVE_TRADING=true`、`PRIVATE_KEY` 已填、报告为 `green`、DexScreener 数据精确绑定事件池、报价资产为 WETH、完整安全检查通过。`npm run watch` 和 `npm run scan` 不会因为 `.env` 中的 `MODE=live` 而发交易。

当前版本没有可证明可靠的通用状态化 Router「买入 → 授权 → 卖出」模拟器，因此正向蜜罐结果保持“未完成”，`tradeReady` 不会成立，真实买入会被安全门拒绝。这是有意的 fail-closed 行为；接入支持完整 fork/state override 的验证器并增加回归测试前，不应取消该限制。

公共 RPC `https://rpc.mainnet.chain.robinhood.com` 能跑，但 24/7 监听建议换成 Alchemy / QuickNode。链出块大约 100ms，日志范围不要开太大。

## 分数怎么打

满分 100，大约按教程清单加权：

- 年龄、社交、叙事词
- 5 分钟买盘 / 成交
- 低市值 + 流动性相对市值
- 前 10 持仓、创建者持仓、发币历史
- 蜜罐诊断、LP 销毁比例、是否可增发

缺失的创建者、历史、权限、持仓或市场绑定数据不会再作为“安全”加分。`green` 还要求所有安全事实完整；当前完整买卖模拟不可用时最多进入人工复核。已确认的蜜罐负面证据直接 `skip`。

候选队列有硬上限，处理完成或失败都会释放 in-flight 标记；`seen.json` 按 `SEEN_TTL_MS` 过期并最多保留 `MAX_SEEN_ENTRIES` 条。旧格式仓位会迁移为 `needs_review`，不会自动卖出。

## 明确不会做的事

- 不夹子、不抢跑、不改 mempool
- 不连钱包网页、不向你要助记词
- 不保证赚钱；规则是启发式，会被针对性绕过
- `paper` 只演示触发规则，不模拟滑点、手续费或真实成交，不能当作回测收益

## 网络参数（Robinhood Chain）

| | |
| --- | --- |
| Chain ID | 4663 |
| RPC | https://rpc.mainnet.chain.robinhood.com |
| 浏览器 | https://robinhoodchain.blockscout.com |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap V2 Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` |
| Uniswap V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Uniswap V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |

# Solana 运维

Solana 使用独立运行时，监听 Pump、PumpSwap、Raydium LaunchLab、CPMM、CLMM 和 AMM v4。WebSocket 只负责低延迟唤醒；周期性 HTTP reconciliation 是完整性来源。可信 xStocks mint 来自 Backed/xStocks 官方 v2 公共 API。

## 配置与启动

```dotenv
SOLANA_DISCOVERY_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_ANALYSIS_RPC_URL=https://你的专用节点
SOLANA_WS_RPC_URL=wss://你的可选订阅节点
SOLANA_ALERT_MODE=shadow
SOLANA_MIN_SCORE=70
SOLANA_MEANINGFUL_SELLER_COUNT=3
```

没有可靠 WebSocket 时把 `SOLANA_WS_RPC_URL` 留空，程序会使用纯 HTTP 补扫。启动：

```bash
npm run watch:solana
```

首次部署或需要更新 xStocks 清单时执行：

```bash
npm run refresh-assets -- xstocks
```

该命令分页读取 `https://api.xstocks.fi/api/v2/public/assets`，分别生成 Solana、Ethereum、BSC 清单；Solana 使用批量账户读取验证 mint owner，两个 EVM 链验证合约字节码。任一链验证失败时不会写入三条链的新清单。仓库快照在 2026-09-10 验证到 737 个 Solana xStocks；运行时直接读取快照，不会持续轮询官方 API。

首次运行只为六个程序记录当前 signature/slot，不读取或推送历史交易。随后按程序从旧到新解析；失败交易会安全越过，已确认但暂时取不到详情的交易不会推进游标。

## 安全与推送

发现使用 `confirmed`，mint、池和真实资金流证据使用 `finalized`。普通候选需要同时满足：

- 池账户由预期程序拥有；
- base/quote 金库可解码且 mint 与候选一致；
- mint/freeze/Token-2022 控制没有未知或高风险项；
- 至少达到配置数量的独立卖家真实减少目标代币，池金库收到目标代币并流出报价币/SOL；
- 分数达到 `SOLANA_MIN_SCORE`。

任一证据未知则不发普通候选。KOL/聪明钱只有在绑定池真实流出代币、标签钱包真实支付报价币或原生 SOL 时才加分。标签文件为 `data/wallets/solana.json`。

xStock 可位于 Raydium 池的 base 或 quote 任一侧；程序始终把另一侧 Meme 作为候选。Telegram 报告显示 `xStocks`、完整 reference mint 和 `backed-xstocks-api-v2` 来源。原始 `new_launch/new_pool` 事件不直接推送，只有评分达标且真实卖出证据 `confirmed` 的普通候选，或明确 `blocked` 的风险候选，才会在 `SOLANA_ALERT_MODE=live` 下推送。

Stonk Fun 当前没有可由官方 Program ID 和 IDL 固定的独立身份，因此启动摘要显示 `stonk-fun-solana:disabled-unverified/unsupported`，不会订阅或解析猜测的专属程序。其公开可见的 Raydium LaunchLab/CLMM 池仍由已验证的通用 Raydium 适配器发现。

## 故障与状态

网络错误、超时、429、5xx 会脱敏记录并重试；解析布局、程序归属等永久错误会保留上下文并停止推进对应未提交范围。状态位于 `data/solana/state.json`，每个程序拥有独立 cursor，WebSocket 重复提示与 HTTP 重放最终由候选键去重。

程序只暴露 `watch/scan/check`，RPC 包装器不暴露发送交易方法，也不读取私钥。

Solana RPC 使用量不计入四条 EVM 链合计 1800 万次的本地月预算；需要在 Solana RPC 供应商侧单独观察额度。上线前先设置 `SOLANA_ALERT_MODE=shadow` 运行 `npm run scan -- --chain solana`，确认启动摘要、程序身份和 xStocks 数量，再切换 `live`。

## 依赖审计

当前 Solana 1.x/SPL Token 依赖树的 `npm audit` 会报告 `bigint-buffer`、`stream-json` 和 `uuid` 的上游告警。不要直接运行 `npm audit fix --force`：npm 当前建议的组合会降级 SPL Token/Web3 并改变兼容性。升级前必须在独立分支验证程序解析、Token-2022、WebSocket 和全部回归测试。本程序不接收用户提交的 JSON-RPC 服务端输入、不签名交易，但仍应只连接可信 RPC，并持续跟踪上游修复。

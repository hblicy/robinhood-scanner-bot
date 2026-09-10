# 多链 EVM 运维

Ethereum、Base、BNB Chain、Robinhood Chain 必须作为四个独立进程运行。每个进程拥有独立 RPC 配置、链 ID 启动校验、状态目录、锁、游标、已处理集合和 Telegram chat。

## 启动

先让新增链保持 `shadow`：

```dotenv
ETHEREUM_ALERT_MODE=shadow
BASE_ALERT_MODE=shadow
BSC_ALERT_MODE=shadow
ROBINHOOD_ALERT_MODE=live
```

分别运行：

```bash
npm run watch:ethereum
npm run watch:base
npm run watch:bsc
npm run watch:robinhood
```

首次没有游标时只恢复年龄窗口内的状态，不发历史 Telegram。确认游标持续前进、链 ID 正确、无 429 风暴后，再逐链把 `*_ALERT_MODE` 改为 `live`。

## RPC 与失败语义

每条链的 `*_DISCOVERY_RPC_URL` 承担高频区块和日志发现，`*_ANALYSIS_RPC_URL` 承担候选深检并作为整轮发现回退。两者相同时共享一个限流器，不会对同一失败端点重复回退。网络错误、超时、429、5xx 会脱敏记录并重试；ABI、链 ID、固定协议配置等永久错误会退出，避免错误推进游标。

游标只在本轮全部候选处理成功后推进。普通候选只有 `confirmed + score >= minScore` 才推送，`blocked` 推风险，`unknown` 静默。集中流动性协议没有完成卖出证据绑定时保持 discovery-only。

四链本地月度软预算默认如下，合计 1800 万次，为供应商 2000 万硬配额保留缓冲：

| 链 | 环境变量 | 默认值 |
| --- | --- | ---: |
| Ethereum | `ETHEREUM_MONTHLY_RPC_LIMIT` | 4,500,000 |
| Base | `BASE_MONTHLY_RPC_LIMIT` | 3,000,000 |
| BSC | `BSC_MONTHLY_RPC_LIMIT` | 5,500,000 |
| Robinhood | `ROBINHOOD_MONTHLY_RPC_LIMIT` | 5,000,000 |

计数文件为 `data/<chain>/rpc-usage.json`，只统计配置为 analysis 的节点请求；公共 discovery 节点不计入。预算按 UTC 自然月轮换：达到 80% 节流，达到 95% 只深检可信股票底池候选，达到 100% 停止付费深检但继续发现和记录。每小时日志会输出主要 RPC 方法、资产目录缓存命中和按当前速率推算的月调用量。多主机部署或多个进程共用 Key 时，本地文件不能替代供应商侧的 2000 万硬上限。

## 可信资产目录与 Venue 状态

发行方清单保存在 `config/assets/<chain>.json`，成功的运行时刷新快照保存在 `data/<chain>/asset-catalog.json`。刷新间隔由 `ASSET_REFRESH_MS` 控制，默认 6 小时；只有清单明确开启已验证 HTTPS 来源时才联网刷新，任何下载、格式、来源或地址校验失败都保留最后一个有效快照。不能验证权威来源时必须保持 `disabled-unverified`，禁止按 symbol 猜测。

启动摘要会显示资产条目数、启用/禁用 Venue 和 RPC 预算阶段，不打印 RPC URL 或凭据。身份或严格卖出验证能力未完成的 Launchpad 保持 disabled/discovery-only，不能进入付费深检和 Telegram 普通候选推送。

当前 Launchpad 状态如下：

| 链 | Venue | 状态 | disabledReason / 运行规则 |
| --- | --- | --- | --- |
| Robinhood | Pons V2 | `enabled` | 独立生命周期运行；`new_launch/swept/graduated` 仅记录，`hard_kill/rescued/green/market_ready` 可立即推送 |
| Robinhood | O1 | `enabled` | Factory、Hook、PoolManager 与股票底池地址均需匹配 |
| Robinhood | Pons V1 | `disabled-unverified` | `missing-verified-abi-or-event-source` |
| Robinhood | Long | `disabled-unverified` | `missing-verified-factory` |
| BNB Chain | Four.meme | `enabled` | 创建事件仅记录；毕业事件必须绑定同交易唯一 Pancake 池 |
| BNB Chain | Flap | `enabled` | 创建事件仅记录；迁移后用 Portal `getTokenV8Safe` 校验底池、池地址及买卖税 |
| Base | Stonks Exchange | `enabled` | Launcher 状态与 Uniswap V3 Factory 必须同时绑定事件池，只接受 Base 官方 B20 底池 |
| Base | O1 | `disabled-unverified` | `stock-pair-route-not-supported` |
| Base | BaseStonk | `disabled-unverified` | `missing-public-contract-registry` |

O1、Four.meme、Flap 和 Stonks Exchange 的 `enabled` 不代表原始发币立即推送：未解析池的 Launchpad 候选统一 `record-only`；已解析池仍需至少 3 个独立真实卖家。卖出取证只回看最近 250 个区块，每个候选最多读取 500 条目标转入日志和 30 笔回执。股票底池自己的合规转账政策、暂停或倍率限制单独报告，不会改写目标 Meme 的 sellability；读取失败显示 `reference-check-unavailable`。Flap 配置税率超过 `MAX_TAX_BPS` 时直接标记 `blocked:excessive-tax`。

## 状态与回滚

状态目录是 `data/<chain>/state.json`，同目录还会保存 `rpc-usage.json` 和可选的 `asset-catalog.json`。升级前备份对应目录；不要复制一个链的状态到另一条链。停止某个进程不会影响其他链。程序只读链和外部数据，不含私钥、签名或广播交易能力。

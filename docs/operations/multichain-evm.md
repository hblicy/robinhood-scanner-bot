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

## 状态与回滚

状态目录是 `data/<chain>/state.json`。升级前备份对应目录；不要复制一个链的 state 到另一条链。停止某个进程不会影响其他链。程序只读链和外部数据，不含私钥、签名或广播交易能力。

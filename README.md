# 五链扫链推送机器人

覆盖 Ethereum、Base、BNB Chain、Robinhood Chain 和 Solana。EVM 与 Solana 使用独立运行时、RPC、状态、锁和故障边界，共享评分、严格推送门槛与 Telegram 报告；Robinhood 保留 Pons V2 生命周期能力。

本版本只有扫描与推送功能：不读取私钥，不创建钱包，不签名、授权或广播交易，也不维护模拟仓位。Memecoin 风险极高，本工具不是投资建议。

## 能做什么

| 检查项 | 实现方式 |
| --- | --- |
| Pons V2 生命周期 | 以 Factory getter 和事件一致性确认身份，监听 Launch、Sweep、Graduated、Rescued，并核对 Hook 注册 |
| 新池发现 | 链上监听 Uniswap V2 `PairCreated`、V3 `PoolCreated`、V4 `Initialize`，并读取 GeckoTerminal `new_pools` |
| 年龄与市场数据 | 按 `MAX_AGE_MINUTES` 过滤，读取成交、买卖笔数、流动性和市值 |
| 社交与叙事 | 读取 DexScreener 社交链接并匹配名称关键词 |
| KOL / 聪明钱 | 从本地标签匹配仍持有至少 1 枚代币的 V2 买家；1 个命中 +5，2 个及以上 +8 |
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
# 不带 --chain 时保持兼容，默认 Robinhood
npm run watch

# 五条链分别启动，建议各放一个 screen/systemd 进程
npm run watch:ethereum
npm run watch:base
npm run watch:bsc
npm run watch:robinhood
npm run watch:solana

# 一次性扫描后退出；不写 data/，不发送 Telegram；部分失败时退出码非零
npm run scan -- --chain base
npm run scan -- --chain solana

# 只读检查指定代币；90 秒后仍未完成的数据源会明确标记 unknown
npm run check -- --chain ethereum 0x你的合约地址
npm run check -- --chain solana 你的Mint地址
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

五个进程必须使用不同的 screen 名称。每条链只允许一个 `watch` 实例，状态分别写入 `data/ethereum`、`data/base`、`data/bsc`、`data/robinhood`、`data/solana`，不会跨链共享游标或已处理记录。

## 多链推送规则

- `recovery`：首次补扫只建立游标和状态，不发送历史 Telegram。
- `shadow`：正常发现和分析，但不发送 Telegram；Ethereum、Base、BSC、Solana 默认使用此模式。
- `live`：`blocked` 风险证据立即推送；普通候选必须同时满足 `sellability=confirmed` 和链级 `MIN_SCORE`。
- `unknown` 即使 100 分也保持静默；发现事件本身不等于可卖、安全或推荐买入。
- EVM V2 类池可进入完整可卖性检查；没有协议级卖出证据绑定的 V3/V4/集中流动性池保持 `unknown`，只发现不推普通候选。
- Solana 需要链上池程序、base/quote 金库、mint 权限和至少 3 个独立真实卖家证据一致；Pump 原始发币事件只建候选状态，不直接推送。

链级变量使用 `ETHEREUM_`、`BASE_`、`BSC_`、`ROBINHOOD_`、`SOLANA_` 前缀。完整示例见 `.env.example`；部署与故障语义见 `docs/operations/multichain-evm.md` 和 `docs/operations/multichain-solana.md`。

单个 GeckoTerminal、DexPaprika 或 Blockscout 限流/超时时，对应辅助证据会标记为 `unknown`，不会被当作安全通过。`watch` 会按有上限的退避重试；Factory 原始日志、ABI 解码或状态不变量失败则会保留错误并停止推进该生命周期区间。

## Telegram

1. 找 [@BotFather](https://t.me/BotFather) 创建机器人并取得 token。
2. 把机器人加入频道或群，或先私聊发送 `/start`。
3. 通过 Telegram Bot API 的 `getUpdates` 方法查询 `chat.id`。
4. 把值写入本地 `.env` 的 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`。

不要提交 `.env`，也不要把 token 粘贴到日志或问题报告中。

## KOL / 聪明钱标签

标签完全从本地读取，不需要 DeBot 或 OKX 密钥。先复制示例，再替换成自己核验过的钱包：

```bash
# Linux
mkdir -p data
cp examples/wallet-labels.json data/wallet-labels.json

# Windows CMD
copy examples\wallet-labels.json data\wallet-labels.json
```

标准格式是 JSON 数组：

```json
[
  {
    "address": "0x0000000000000000000000000000000000000011",
    "label": "示例 KOL",
    "type": "kol",
    "source": "manual"
  }
]
```

`type` 只接受 `kol`、`smart_money`；`source` 只接受 `manual`、`debot`、`okx`。也可以直接使用 DeBot 导出的嵌套 JSON：程序递归读取 EVM 地址键的 `mark`，统一记为 `smart_money/debot`。文件不存在时报告显示“标签未配置”；文件存在但 JSON、地址、字段或重复地址无效时，程序会明确报错退出。修改文件后需要重启 `watch`。

EVM 标签保存为 `data/wallets/evm.json`，Solana 标签保存为 `data/wallets/solana.json`。EVM 只有现有 V2 卖出检查已经采样、并且在同一固定区块仍持有至少 1 枚代币的钱包才算命中；Solana 只有绑定池真实流出目标代币且标签钱包真实付出报价币/SOL 时才算命中。Telegram 最多显示三个标签，不显示地址。1 个唯一命中加 5 分，2 个及以上加 8 分。该加分不绕过年龄、明确风险、卖出安全确认或最终 `MIN_SCORE` 门槛。

CSV 导入示例：

```bash
npm run import-wallets -- --family evm --output data/wallets/evm.json wallets-base.csv wallets-eth.csv wallets-bsc.csv wallets-robinhood.csv
npm run import-wallets -- --family solana --output data/wallets/solana.json wallets-sol.csv
```

DeBot 当前仅用于手工导出/导入；程序不调用其未公开接口。OKX 的 Smart Money/KOL Signal API 当前不支持 Robinhood Chain `4663`，因此不做实时接入；可以把人工核验后的 OKX 地址写入本地标准文件。

## 主要配置

```dotenv
DISCOVERY_RPC_URL=https://rpc.mainnet.chain.robinhood.com
DISCOVERY_RPC_CUPS=150
ANALYSIS_RPC_URL=
# 兼容旧部署：ANALYSIS_RPC_URL 留空时读取 RPC_URL
RPC_URL=
ANALYSIS_RPC_CUPS=250
DISCOVERY_RPC_COOLDOWN_MS=60000
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

布尔值只接受 `true/false`、`1/0`、`yes/no`、`on/off`；`QUOTE_TOKENS` 接受内置 `WETH`、`ETH`、`USDG` 或明确的 20-byte 地址，symbol 只用于显示，不能决定 LONG 分类。至少启用一个扫描来源。数值越界时程序会明确报错。

### 双 RPC 配置

- `DISCOVERY_RPC_URL` 默认使用 Robinhood 官方公共 RPC，负责区块、Factory 和 Pons 发现。
- `ANALYSIS_RPC_URL` 负责候选深检，并在官方节点网络错误、超时、429 或 5xx 时临时接管发现请求。
- 两个 URL 规范化后若指向同一端点，只创建一个 provider，并采用 `DISCOVERY_RPC_CUPS`、`ANALYSIS_RPC_CUPS` 中较低的预算；不会把同一个失败请求再向自己回退一次。
- 两个 URL 不同时，发现回退会在备用节点上重新读取 head，并从尚未提交的游标重新执行整段扫描；不会把主节点的 head 与备用节点的日志混在同一轮提交。
- 官方节点故障后进入 60 秒熔断；冷却结束会自动探测并切回官方。
- 底层 HTTP 请求最长等待 15 秒，429 由外层退避和熔断处理，避免节点内部重试数分钟。
- 旧 `RPC_URL` 仍可用：未填写 `ANALYSIS_RPC_URL` 时，它自动作为分析与备用节点。
- 区间扫描或候选处理失败会保留带上下文的脱敏日志，长期运行的 `watch` 不会因此退出；日志不会打印 RPC URL 中的 API key、Token 或查询参数凭据。
- 官方公共 RPC 会限流；双 RPC 能减少 Alchemy CU，但不能保证完全没有节点错误。未提交区间会重试，只有完整处理成功后才推进游标。

旧服务器可以保留：

```dotenv
RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<API_KEY>
```

显式配置写法：

```dotenv
DISCOVERY_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ANALYSIS_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<API_KEY>
```

修改后重启 `npm run watch`。如果两个变量最终指向同一个地址，启动横幅会提示没有实现 CU 分流。

## 扫描恢复与本地状态

`watch` 会以 schema v5 原子写入对应链目录下的 `state.json`，维护：

- 已处理候选 `seen`，用于去重；
- `cursors.onchain`，表示 EVM 最后一个全部候选均处理成功的区块；
- `cursors.solanaPrograms`，分别保存六个 Solana 程序的 signature/slot 锚点；
- `cursors.ponsV2`、`tokens` 和 `watchlist`，保存独立的 Pons 生命周期游标与观察状态；
- `appliedEvents`、`outbox` 和 `pendingChecks`，用于事件去重、Telegram 可靠投递和辅助数据重试；
- `heat`，保存当前市场热度快照，不改变已有观察对象的准入决定；
- 旧版本留下的 `positions`、`trades` 历史字段，原样保留但不再读取、轮询或修改其业务内容。

Pons 链上阶段为 `not_graduated → swept → pool_created`，`rescued` 是不可回退终态；观察状态另行使用 `observed/watchlisted/curve_dead/decay/killed`。`pool_created` 只说明链上毕业，只有 Hook、池绑定、流动性和双向交易证据完整时 `marketReady` 才为 `true`。三类状态不会互相代替。

首次运行按区块时间二分定位年龄窗口起点。已有游标时，从“已保存游标”和“当前年龄窗口起点”中较新的位置继续。链上默认只处理落后最新高度 2 个区块的已确认范围。Factory 日志、身份 getter 和状态转换与 Pons 游标同次落盘；Telegram 或外部市场源失败不会回滚已确认的 Factory 游标，而会留在 outbox/pending check 中重试。超过 `MAX_AGE_MINUTES` 的辅助候选严格跳过。

首次没有 Pons 游标时仅恢复链上状态、事件去重和游标，不创建历史 Telegram 或历史 pending checks。实时 Pons 原始 `new_launch`、`swept`、`graduated` 与市场热度只记录状态/终端日志；Telegram 生命周期白名单仅包含 `hard_kill`、`rescued`、`green`、`market_ready`。升级前已积压的其他类型会保留审计记录并标记为 `suppressed`。普通候选仍按 `MIN_SCORE` 输出完整评分报告，启动成功提示保持不变。

普通 Uniswap V2 候选进入过深度检查、但卖出证据仍为 `unknown` 时，会把复查任务写入 `pendingChecks`，并按首次分析后的绝对时间 `+2 分钟 / +5 分钟 / +10 分钟` 最多复查三次；重启或离线不会重置时间锚点。变为 `blocked` 时无视分数立即推送风险，变为 `confirmed` 时只有达到最终分数门槛才推送，第三次仍未知则静默完成。`prefilter-score`、V3/V4、Pons 生命周期以及超过年龄窗口的候选不进入这套普通复查。

链上与 GeckoTerminal 独立运行：一个来源故障不会阻止另一个来源。`scan` 会处理已取得的候选后汇总错误并以非零状态退出，不会把部分成功伪装成整轮成功；整轮超过 120 秒会明确报超时，公共 RPC 无法及时扫完时请换专用 RPC。`watch` 对同一 `data/` 使用单实例锁，重复启动会明确报错。

`scan` 和 `check` 不创建锁、不创建或修改 `data/`，也不发送 Telegram。配置文件通过局部解析读取，旧 `.env` 中的私钥或交易字段不会注入进程配置，也不会被程序访问。

升级前建议先备份 `data/state.json`。Robinhood 旧状态会复制迁移到 `data/robinhood`；程序可从旧 schema v3/v4 迁移到 v5，不会删除旧版 `positions`、`trades` 或其他历史文件。

## 明确不做

- 不构造、签名、授权或广播链上交易；
- 不提供模拟买卖、自动买入、止盈止损或仓位管理；
- 不连接网页钱包，不索取助记词或私钥；
- 不保证准确率或收益。

## 网络参数

| 项目 | 值 |
| --- | --- |
| Chain ID | 4663 |
| 发现 RPC（默认） | `https://rpc.mainnet.chain.robinhood.com` |
| 浏览器 | `https://robinhoodchain.blockscout.com` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap V2 Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` |
| Uniswap V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Uniswap V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |

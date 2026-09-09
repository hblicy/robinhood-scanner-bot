# 五链扫链机器人设计

日期：2026-09-09

状态：已确认，等待用户复核文档

目标版本：多链版（EVM 第一阶段，Solana 第二阶段）

## 1. 背景

当前机器人面向 Robinhood Chain，已经具备新池发现、候选分析、安全检查、评分、观察名单和 Telegram 推送能力。下一阶段要扩展为五条链：

- EVM：Robinhood、Base、BSC、Ethereum
- Solana：Solana

这不是把现有进程简单复制五份，而是保留一套公共分析和通知规则，将链、协议和运行时差异隔离到适配器中。每条链仍由独立进程运行，保证限流、游标、状态和故障互不影响。

## 2. 目标

1. 在一个仓库中支持五条链，并能按链独立启动。
2. 覆盖各链主要 DEX 和主要发射平台的新币、新池及生命周期事件。
3. 统一候选数据结构、100 分评分模型、安全结论和 Telegram 报告格式。
4. 严格执行可卖性门槛：只有确认可卖或确认受阻的币才允许推送。
5. 采用发现 RPC 与分析 RPC 分工，控制私有 RPC 的 CU 和峰值吞吐。
6. 支持 EVM 共用聪明钱地址库、Solana 独立地址库。
7. 首次补扫和故障恢复不推送历史事件，不因节点切换永久漏块。

## 3. 非目标

- 不增加自动买入、自动卖出、私钥管理或其他交易功能。
- 不保证覆盖每个小型 DEX 或未知发射平台。
- 不把第三方 API 的未知结果解释为安全。
- 不引入中央数据库、分布式任务队列或多机协调服务。
- 不要求 GoPlus、Birdeye、Helius 等付费增强 API 才能运行。
- 不承诺完全避免第三方 RPC 限流，只保证请求受控且失败不会破坏状态一致性。

## 4. 总体架构

采用“公共核心 + 链适配器 + 协议适配器”的单仓库架构。

```text
独立链进程
  -> 链配置与双 RPC
  -> EVM / Solana 运行时
  -> DEX / 发射平台适配器
  -> 统一候选事件
  -> 公共安全检查与评分
  -> 严格推送策略
  -> Telegram
```

建议模块边界：

- `core/`
  - 候选队列、去重、观察名单、评分、通知、重试和状态机。
- `chains/`
  - 五条链的 ID、原生币、确认策略、RPC、区块浏览器和评分阈值配置。
- `runtime/evm/`
  - EVM 高度、日志、交易、调用模拟和确认深度处理。
- `runtime/solana/`
  - Solana slot、signature、instruction、commitment 和订阅恢复处理。
- `venues/`
  - 每个 DEX 或发射平台的事件发现、池识别、生命周期和卖出路径适配器。
- `security/`
  - 公共安全结论接口，以及 EVM、Solana 的实现。
- `wallets/evm/`、`wallets/solana/`
  - 规范化后的 KOL 和聪明钱地址库。
- `data/<chain>/`
  - 每条链独立的游标、观察名单、通知记录和生命周期状态。

每条链是一个独立常驻进程：

```text
npm run watch -- --chain robinhood
npm run watch -- --chain base
npm run watch -- --chain bsc
npm run watch -- --chain ethereum
npm run watch -- --chain solana
```

任何一条链的限流、节点异常或协议解析失败，都不能导致其他链停止。

## 5. 协议范围

### 5.1 第一阶段：EVM

| 链 | DEX / 发射平台 |
|---|---|
| Ethereum | Uniswap V2、V3、V4 |
| Base | Uniswap V2、V3、V4；Aerodrome Classic、Slipstream；Clanker |
| BSC | PancakeSwap V2、V3、Infinity；Four.meme |
| Robinhood | 现有 Uniswap V2、V3、V4；Pons V2 |

每个协议必须通过独立适配器声明：

- 可监听的工厂或程序事件；
- token、quote token 和 pool 的提取方式；
- launch、pool-created、graduated、swept 等生命周期事件；
- 可用的路由和可卖性检测能力；
- 是否支持完整安全结论。

仅发现事件但尚无可靠可卖性检测的协议允许接入发现层，但其候选只能记录为 `sellability=unknown`，不得推送评分报告。

### 5.2 第二阶段：Solana

首批范围：

- Pump.fun bonding curve 与 PumpSwap；
- Raydium LaunchLab、CPMM、CLMM、AMM v4。

Solana 使用独立运行时和协议解析器，不复用 EVM 的 ABI、区块高度、日志索引或交易模拟假设。

### 5.3 参考实现资料

- Uniswap 官方文档：https://docs.uniswap.org/
- Aerodrome 官方合约：https://github.com/aerodrome-finance/contracts
- Clanker 官方文档与合约：https://github.com/clanker-devco/DOCS 、https://github.com/clanker-devco/v3.1-contracts
- PancakeSwap 开发文档：https://developer.pancakeswap.finance/
- Four.meme Agentic 文档：https://www.four.meme/en/agentic
- Pump 官方程序文档：https://github.com/pump-fun/pump-public-docs
- Raydium Anchor IDL：https://docs.raydium.io/sdk-api/anchor-idl

合约地址、程序地址和事件签名必须在实现阶段根据官方资料固定到链配置，并用真实夹具验证，不能依赖记忆或第三方列表。

## 6. 统一候选事件

所有协议适配器输出同一结构，至少包含：

```text
chain               链标识
chainFamily         evm | solana
venue               协议标识
sourceKind          dex | launchpad
token               目标代币地址
quoteToken          报价代币地址
pool                池地址
poolId              非地址型池标识；没有时为 null
creator             创建者；未知时为 null
blockOrSlot          EVM 区块号或 Solana slot
transactionId       EVM tx hash 或 Solana signature
eventIndex           logIndex 或 instructionIndex
createdAt            可验证的创建时间；未知时为 null
lifecyclePhase       new_launch | new_pool | graduated | swept | ...
sourceProvenance     原始来源和解析器版本
```

规则：

- 原始 `new_launch`、`new_pool` 和 `graduated` 只触发检查，不直接发送 Telegram。
- `token`、`pool`、`creator` 等字段必须保留链标识，不能跨链按裸地址合并。
- 协议解析不完整时保留原始来源和错误，不用猜测填充关键字段。

## 7. 发现流程与游标一致性

### 7.1 DiscoverySession

每轮扫描创建一个 `DiscoverySession`，整轮固定在同一个 RPC 后端执行：

1. 从选定后端读取最新高度或 slot。
2. 根据确认参数计算安全扫描终点。
3. 从已提交游标分页读取事件。
4. 解析、去重并持久化本轮结果。
5. 仅在整个安全范围处理成功后提交新游标。

若主发现 RPC 中途失败：

1. 放弃本轮尚未提交的进度；
2. 切换到备用后端；
3. 在备用后端重新读取高度；
4. 从上次已提交游标重新扫描；
5. 只能提交备用后端实际成功扫描到的安全终点。

严禁使用主节点高度配合落后的备用节点日志结果，否则会永久跳过区块。

### 7.2 确认策略

- EVM：每条链配置独立 `confirmations`，只扫描 `latest - confirmations`。
- Solana：发现阶段使用 `confirmed`；关键安全结论可用 `finalized` 复核。
- 分页读取中任何一页失败，本轮不推进最终游标。

### 7.3 初始补扫和恢复

- 首次启动只补齐游标、生命周期和观察状态，不发送历史 Telegram。
- 宕机恢复同样先补扫，再切换为实时推送模式。
- 补扫期间新发现的历史候选可以进入状态库，但不能伪装成实时事件。

### 7.4 去重键

- EVM 原始事件：`chainId + txHash + logIndex`。
- Solana 原始事件：`chain + signature + instructionIndex`。
- 池业务标识：`chain + venue + poolId/pool`。
- 代币业务标识：`chain + token`。
- Telegram 通知标识：`chain + token + alertType + stateVersion`。

## 8. 候选处理流程

候选按以下顺序处理：

1. 事件结构和地址合法性检查；
2. 原始事件去重；
3. 廉价链上初筛；
4. 相同代币任务合并和冷却检查；
5. 使用分析 RPC 执行安全深检；
6. 有并发上限地读取市场、社交、浏览器和持仓辅助数据；
7. 形成安全结论；
8. 只有安全结论允许时才评分并进入通知决策；
9. 保存结果及观察名单状态。

辅助来源超时或失败时相应字段记为 `unknown`，保留来源级错误。未知不能换算为通过，也不能让单个候选异常终止发现循环。

## 9. 安全检查

### 9.1 统一结论

```text
confirmed   已确认存在可用卖出路径
blocked     已确认无法正常卖出或存在硬性限制
unknown     证据不足、场所不支持或检查失败
```

只有 `confirmed` 和 `blocked` 可以产生 Telegram 消息。

### 9.2 EVM

检查范围：

- 池、工厂、路由和报价资产绑定关系；
- 代币 bytecode、代理关系、owner 和 mint 权限；
- 完整买入、授权、卖出路径；
- 买入所得数量与可卖数量；
- 至少两个不同数量的卖出测试；
- 最大卖出量、黑名单、高税、动态税和转账限制；
- 独立钱包的真实成功卖出及报价资产从池中流出；
- LP 锁定、销毁、控制权和异常撤池条件。

模拟成功不能单独证明安全。确认结论需要协议适配器支持正确路由，并结合模拟或真实卖出证据。只能卖出极小数量时归类为 `blocked`，不得因为 eth_call 未回滚就视为通过。

### 9.3 Solana

检查范围：

- mint authority 和 freeze authority；
- Token-2022 的 transfer hook、transfer fee、permanent delegate、default frozen 等扩展；
- pool、vault 和相关账户的 owner；
- 程序和账户是否与声明协议匹配；
- 独立签名者的真实成功卖出；
- 卖出交易是否产生报价资产流出；
- LP 和流动性控制风险。

无法可靠解析 token program 扩展、路由或资产流向时，结论必须为 `unknown`。

## 10. 统一评分模型

通过安全门槛后使用统一 100 分模型：

| 类别 | 最高分 |
|---|---:|
| 年龄与时效 | 15 |
| 流动性 | 15 |
| 市值与早期空间 | 10 |
| 买卖盘和成交活跃度 | 15 |
| 社交与叙事 | 10 |
| 持仓分布和创建者 | 15 |
| LP 与权限安全 | 12 |
| KOL / 聪明钱 | 8 |
| 合计 | 100 |

评分项目相同，但年龄、流动性、市值和成交量区间允许按链配置。默认各链 `MIN_SCORE=70`，支持例如：

```text
BASE_MIN_SCORE
BSC_MIN_SCORE
ETHEREUM_MIN_SCORE
ROBINHOOD_MIN_SCORE
SOLANA_MIN_SCORE
```

未知数据不加分，也不自动扣成硬风险；报告中必须明确显示未知项。

## 11. KOL 和聪明钱地址库

地址库只分两类：

- `wallets/evm/`：Base、BSC、Ethereum、Robinhood 共用；
- `wallets/solana/`：Solana 独立。

导入和合并规则：

1. 地址先规范化并校验格式；
2. 同一地址重复出现只保留一条；
3. 合并来源链和全部标签；
4. 任意记录包含 `kol` 标签，该地址分类为 KOL；
5. 其他标签统一归类为 smart money，包括 `smart_degen`、`launchpad_smart`、`top_followed`、`snipe_bot`、`fresh_wallet` 等；
6. 同一地址对同一代币重复交易只计一次。

加分规则：

- 一个已验证地址进入：最多加 5 分；
- 两个及以上独立地址进入：最多加 8 分；
- KOL 优先于普通聪明钱展示，但总分仍封顶 8 分。

钱包信号不能绕过可卖性硬门槛，也不能仅凭标签把未知项目判断为安全。

## 12. Telegram 推送策略

补扫模式和静默观察模式禁止发送任何 Telegram，包括历史 `blocked` 结果。以下推送条件只适用于进入实时模式后发现或重新检查出的新状态。

普通观察名单的进入条件是：候选已经满足 `sellability=confirmed`、达到该链最低分，并成功发送过首次完整候选报告。风险币单独保留风险记录，不因发送 `blocked` 报告而自动进入普通观察名单。

### 12.1 推送条件

- `sellability=confirmed` 且总分达到该链 `MIN_SCORE`：推送完整候选报告。
- `sellability=blocked`：立即推送红色风险报告，不要求达到最低分。
- `sellability=unknown`：不推送，仅记录。
- `hard_kill` 等已确认硬风险：立即推送。
- `rescued`、`green`、`market_ready`、`graduated`、`swept`：只对已进入观察名单的币推送。

### 12.2 防刷屏

- 原始 Pons、Four.meme、Pump.fun 等新币事件不直接推送。
- 同一币只有首次跨越评分门槛或关键状态改变时才再次推送。
- 重启、补扫和重复事件不能重复推送。
- 通知去重必须包含链标识，避免不同链的相同地址互相覆盖。

### 12.3 聊天配置

- 默认五条链共用 Telegram bot 和 chat ID。
- 允许链级 chat ID 覆盖。
- 消息首行必须显示链名、结论、币名和评分或风险类型。

## 13. RPC 路由和吞吐控制

### 13.1 角色

- `DISCOVERY_RPC`：官方或低成本节点，负责高度、日志和事件发现。
- `ANALYSIS_RPC`：稳定私有节点，只处理通过初筛的候选深检。
- Solana 可额外配置 WebSocket RPC；断线后必须通过 HTTP 游标恢复。

配置示例：

```text
BASE_DISCOVERY_RPC_URL
BASE_ANALYSIS_RPC_URL
BASE_CONFIRMATIONS
BASE_MIN_SCORE

SOLANA_DISCOVERY_RPC_URL
SOLANA_ANALYSIS_RPC_URL
SOLANA_WS_RPC_URL
SOLANA_MIN_SCORE
```

### 13.2 Provider 复用

- 每个规范化后的真实 RPC URL 只创建一个 Provider、调度器、限流器和熔断器。
- 若发现和分析 URL 相同，两个角色共享同一实例与请求预算。
- 相同 URL 之间禁止自我故障切换，避免立即重试同一故障节点和双倍消耗 CU。

### 13.3 重试和熔断

- 429、超时和临时网关错误采用指数退避并加入随机抖动。
- 重试有明确次数和总时长预算。
- 连续失败达到阈值后打开熔断器；冷却后有限探测恢复。
- 候选分析失败只影响该候选，不退出常驻进程。
- 发现失败不吞错：日志保留链、RPC 角色、扫描范围、方法及原始错误上下文。

### 13.4 资源上限

每条链独立配置：

- 每秒请求预算；
- 最大并发深检数；
- 日志分页区间；
- 轮询间隔；
- 候选冷却时间；
- 辅助 API 缓存时间。

先执行廉价初筛，再使用分析 RPC。相同代币在冷却期内最多存在一个深检任务。

## 14. 状态和运行隔离

每条链保存独立状态：

```text
data/robinhood/
data/base/
data/bsc/
data/ethereum/
data/solana/
```

目录中至少区分：

- 发现游标；
- 已处理事件；
- 观察名单；
- 生命周期状态；
- 已发送通知；
- RPC 熔断和恢复所需的最小状态。

可以使用 `screen`、systemd 或 PM2 启动五个进程。进程锁必须按链命名，不能让一个链的实例锁阻止其他链启动。

启动日志只显示 RPC 域名和角色，不打印 API Key、完整 URL 路径、Telegram Token 或其他凭据。

## 15. 阶段 0：现有缺陷修复

多链实现前先修复两个已确认问题：

1. 当前故障切换按方法发生，可能由主节点读取高度、由落后的备用节点读取日志，随后错误推进游标并永久漏块。
2. 当前发现与分析 RPC 即使是同一规范化 URL，也可能创建两个独立 Provider 和调度器，造成合并吞吐超过预期，并对同一地址自我重试。

修复要求：

- 使用本设计的 `DiscoverySession` 固定整轮后端；
- 切换后重新读取备用节点高度并从已提交游标重扫；
- 相同 URL 复用 Provider、限流和熔断状态；
- 增加节点高度不一致及相同 URL 的回归测试。

## 16. 测试设计

### 16.1 单元测试

- 链配置和环境变量覆盖；
- 地址、候选和通知去重；
- 100 分评分及链级阈值；
- EVM/Solana 钱包地址导入和合并；
- 推送门槛和生命周期状态机。

### 16.2 协议夹具测试

每个协议保存脱敏的真实事件与交易响应，验证：

- 新币、新池及生命周期事件解析；
- token、quote、pool、creator 提取；
- 事件唯一键；
- 不支持的安全路径正确返回 `unknown`。

### 16.3 RPC 集成测试

使用本地假 RPC 覆盖：

- 主备节点高度不同；
- 日志分页中途失败；
- 429、超时、网关错误；
- 熔断、冷却和恢复；
- 相同 URL Provider 复用；
- Solana WebSocket 断线及 HTTP 补扫。

### 16.4 安全回归测试

- 正常买入和卖出；
- 买入成功但完全不能卖；
- 只能卖出极小数量；
- 动态税、黑名单和最大交易量；
- 模拟成功但没有真实报价资产流出；
- Token-2022 权限或扩展风险；
- 未支持 venue 返回 `unknown` 且不推送。

### 16.5 状态和通知测试

- 首次补扫不推送；
- 宕机恢复不重复推送；
- 失败不推进游标；
- 评分跨线只推一次；
- 关键状态变化只对观察名单推送；
- 不同链相同地址不会互相去重。

## 17. 实施和上线顺序

### 阶段 0

修复双 RPC 的会话一致性和相同 URL 复用问题，确保现有 Robinhood 测试全部通过。

### 阶段 1

建立 EVM 公共框架，并按以下顺序迁移和接入：

1. Robinhood：迁移现有功能，验证行为不退化；
2. Base；
3. BSC；
4. Ethereum。

每增加一条链先以静默观察模式运行：执行发现、深检、评分和持久化，但关闭 Telegram。核对事件覆盖、重复率、RPC 消耗和安全结论后再启用推送。

### 阶段 2

建立 Solana runtime，先接 Pump.fun/PumpSwap，再接 Raydium。重复执行静默观察和启用流程。

## 18. 验收标准

每条链只有满足以下条件才正式启用推送：

1. 连续静默运行至少一个完整观察周期，进程不因预期 RPC 或 API 错误退出。
2. 主备节点切换不会跳跃游标或永久漏块。
3. 重启、补扫及重复事件不会重复推送。
4. 确认可卖且达到阈值的候选能推送完整报告。
5. 可卖性未知的候选不会推送评分报告。
6. 确认貔貅、限售或硬风险的候选能推送风险报告。
7. KOL/聪明钱加分按地址去重且不超过 8 分。
8. RPC 请求量和峰值吞吐在链级配置预算内。
9. 五条链的配置、状态、锁、限流和故障互相隔离。
10. 当前 Robinhood 的严格通知策略和安全回归测试保持通过。

## 19. 关键决策摘要

- 一套仓库，五个独立进程。
- EVM 与 Solana 分离运行时，共用候选、评分和通知契约。
- 第一阶段完成四条 EVM 链，第二阶段完成 Solana。
- 覆盖主要 DEX 和发射平台，但未支持卖出检测的 venue 不推送。
- 发现 RPC 承担高频扫描，分析 RPC 只承担候选深检。
- 整轮发现固定一个后端，切换后重读高度并重扫。
- 相同 RPC URL 共享限流和熔断，禁止自我故障切换。
- EVM 共用一份地址库，Solana 使用独立地址库。
- 只有确认可卖的达标候选或确认受阻的风险候选可以推送。
- 首次补扫只恢复状态，不发送历史 Telegram。

# 五链股票 Meme 与 Launchpad 集成设计

日期：2026-09-10

状态：已确认，等待文档复核

目标分支：`feat/stock-meme-launchpads`

## 1. 背景

现有机器人已经支持 Robinhood、Base、BSC、Ethereum 和 Solana 五个独立扫描进程，并具备统一候选、评分、安全结论、RPC 预算和 Telegram 推送能力。当前主要缺口不是再增加一套扫描器，而是：

- 缺少 Robinhood Stock Tokens、bStocks/4Stock、Base B20 股票和 Solana xStocks 的可信资产注册表；
- 交易对解析默认依赖固定 quote token 或 base token 方向，股票代币作底池时可能漏报或反向识别；
- 部分 Launchpad 只有发现适配器，没有接入安全能力注册表，候选会在运行时被丢弃；
- 个别平台身份仍依赖启发式判断，存在误标风险；
- Long、Stonks Exchange、BaseStonk、Stonk Fun 等平台尚未取得可验证的主网入口和 ABI/IDL，不能安全启用。

本设计在现有五链架构上增加可信资产层、Venue 能力层和平台专属安全证据，不引入交易或私钥功能。

## 2. 目标

1. 按合约地址或 mint 识别五链股票代币，禁止通过 ticker 或名称猜测资产身份。
2. 正确识别 `Meme/股票代币` 池，不受 token0/token1、base/quote 展示方向影响。
3. 接入 Pons、O1、Long、Four.meme、Flap、Stonks Exchange、BaseStonk、Stonk Fun；只有完成可信入口和安全能力核验的平台才能启用。
4. 为 EVM 和 Solana 分别提供 Venue 专属安全检查，不用通用 Uniswap 假设覆盖所有平台。
5. 保持严格通知策略：新币事件不直推，普通候选必须确认可卖且达到阈值，可靠受阻证据立即推风险。
6. 将本项目的 EVM 付费 RPC 月使用目标控制在 1800 万次以内，硬上限不超过 2000 万次。
7. 保持现有五链进程、状态、游标、锁和通知去重相互隔离。

## 3. 非目标

- 不增加自动买入、自动卖出、签名、私钥读取或交易广播。
- 不按文章、社交媒体或第三方目录中的未验证地址直接启用合约。
- 不保证未知或私有 ABI/IDL 的平台在本轮正式启用。
- 不用 GeckoTerminal、DexScreener 或 ticker 证明股票代币或 Launchpad 身份。
- 不把昂贵的 `debug_trace*` 作为正常安全检查必需条件。
- 不改变现有 100 分评分模型的类别和总分。

## 4. 信任边界

平台或资产只有满足下列来源之一才能进入启用状态：

1. 官方项目文档、官方代码仓库或官方链上注册表；
2. 区块浏览器已验证合约，并能与官方项目入口、事件和实现版本相互印证；
3. 用户提供且能在链上独立复核的 Factory/Program 地址及 ABI/IDL。

不满足上述条件时：

- 完成配置槽、能力声明和启动诊断；
- 状态固定为 `disabled-unverified`；
- 不监听、不深检、不推送；
- 日志明确列出缺少的是地址、ABI/IDL、事件签名还是安全路由；
- 不通过名称、后缀、相邻平台或普通池事件猜测身份。

## 5. 总体架构

保留现有“五链、五进程”结构，新增两个公共层：

```text
可信资产注册表
  -> DEX / Launchpad 原始事件
  -> 交易对方向分类
  -> 廉价候选门控
  -> Venue 专属安全检查
  -> 评分与观察名单
  -> Telegram
```

### 5.1 可信资产层

建议增加：

```text
src/assets/catalog.js
src/assets/cache.js
src/assets/evm.js
src/assets/solana.js
src/assets/sources/
config/assets/<chain>.json
data/<chain>/asset-catalog.json
```

资产层只负责：

- 从可信来源读取资产；
- 规范化地址、mint、symbol 和来源信息；
- 验证链、合约代码或 Solana mint 账户；
- 从 `config/assets` 读取受 Git 管理的可信清单；
- 在 `data/<chain>/asset-catalog.json` 原子更新最后一次有效运行快照；
- 为交易对分类提供常量时间查询。

### 5.2 Venue 能力层

建议增加统一 Venue 描述：

```text
venue
chain
sourceKind
identityStatus
discoveryCapability
lifecycleCapability
securityCapability
verifiedContracts
verificationSource
disabledReason
```

运行时只能调用能力表声明支持的方法。缺少安全能力的 Venue 可以进入 discovery-only 记录，但不得生成普通候选推送。

## 6. 候选数据模型

在现有统一候选上增加：

```text
targetToken             被分析和评分的 Meme
referenceAsset          股票、稳定币或原生报价资产
targetSide              token0 | token1 | base | quote
pairDirection           target/reference 的实际方向
targetAssetKind         meme | unknown
referenceAssetKind      stock | stable | native | crypto | unknown
referenceAssetIssuer    Robinhood | BTech | Coinbase | Backed | ...
assetSource             官方注册表或清单标识
assetVerifiedAt         注册表最近验证时间
venueIdentityEvidence   Factory/Program、事件及实现版本
referenceRestrictions   股票底池自身的合规或转账限制
```

兼容规则：

- 保留原有 `token` 和 `quoteToken` 字段作为过渡读取入口；
- 新代码以 `targetToken` 和 `referenceAsset` 为准；
- 序列化状态时保留 schema 版本；
- 旧状态加载时进行只读迁移，不清空观察名单或通知记录。

## 7. 可信资产注册表

### 7.1 Robinhood

- 读取 Robinhood 官方链上资产注册表；
- WETH、USDG 和 Stock Tokens 分开标记；
- 启动时读取，之后按缓存周期刷新；
- 远端或链上读取失败时使用最后一次有效快照。

官方资料：<https://docs.robinhood.com/chain/contracts/>

### 7.2 Base

- Coinbase B20 股票使用 Base 官方清单中的完整合约地址；
- 首版使用带来源和校验时间的版本化清单；
- 只有稳定的官方机器接口经过夹具验证后，才允许运行时自动刷新；
- 必须按地址验证，不能依赖 `NVDAc`、`AAPLc` 等 symbol。

官方资料：<https://www.base.org/stocks>、<https://blog.base.dev/b20-tokenized-stocks-on-base>

### 7.3 BSC

- bStocks 和 4Stock 使用独立 issuer/source 标识；
- 只导入官方发行材料或能由官方入口和浏览器验证相互印证的地址；
- 没有可信机器列表时使用经复核的版本化清单，不运行时抓取不稳定页面；
- 新增资产先验证 chainId、bytecode 和 ERC-20 基本接口，再原子发布。

### 7.4 Solana

- 从 Backed/xStocks 官方 API 获取 mint 与 metadata；
- 校验 mint 账户存在、owner 为支持的 Token Program，并记录 Token/Token-2022 类型；
- 对 API 响应建立 fixture 和 schema 校验；
- API 失败或 schema 变化时保留旧快照。

官方资料：<https://api.backed.fi/api-docs/>

### 7.5 Ethereum

- 保持现有通用 DEX 扫描；
- 官方资产源若明确发布 Ethereum 地址，则通过相同注册表机制接入；
- 不把 Solana 或其他 EVM 链的同名资产映射到 Ethereum。

### 7.6 更新和缓存

- EVM 地址统一 checksummed，查询键使用规范化小写地址；
- Solana mint 保留 base58 原文；
- 同一资产不得在互斥类别中重复；
- 更新先写临时快照、完整验证后原子替换；
- 默认刷新周期 6 小时；
- 失败不清空当前资产表；
- bytecode、mint owner 和 metadata 结果按链与地址缓存；
- 运行日志不打印 RPC key 或带凭据的完整 URL。

## 8. 交易对分类与发现

### 8.1 分类规则

| 交易对 | 处理 |
|---|---|
| Meme / 已验证股票代币 | Meme 为 `targetToken`，股票为 `referenceAsset` |
| Meme / 稳定币或原生包装币 | 保持现有候选逻辑 |
| 股票代币 / 稳定币或原生包装币 | 记录股票流动性，不作为新 Meme |
| 股票代币 / 股票代币 | 忽略 Meme 分析 |
| 两侧均为未知资产 | 保留廉价通用初筛，不猜测方向或平台 |
| 同一池被市场 API 反向返回 | 规范化为同一个 `chain + target + pool` 候选 |

`classifyPair()` 必须同时适用于：

- EVM token0/token1；
- DexScreener baseToken/quoteToken；
- GeckoTerminal base/quote；
- Solana baseMint/quoteMint 和 vault mint。

### 8.2 来源优先级

1. 已验证 Launchpad Factory/Program 原始事件；
2. 已验证 DEX Factory/Pool 原始事件；
3. GeckoTerminal/DexScreener 补漏；
4. 按 `chain + targetToken + pool` 和原始事件键去重。

市场 API 不得覆盖链上已经确定的平台身份、创建者或生命周期。

## 9. Launchpad 范围与启用条件

### 9.1 Robinhood

顺序：Pons V2 回归、Pons V1、O1、Long。

- Pons V2 保持现有行为并作为回归基线；
- Pons V1 必须取得对应事件、状态读取和安全路由后启用；
- O1 只使用官方 factory、pair catalog 和合约资料；
- Long 禁止再用“非 Pons + 股票 quote”启发式判断；
- 缺少已验证入口的平台保持 `disabled-unverified`。

O1 官方资料表明其 Robinhood factory 可注册 ETH、USDG 和股票代币底池：<https://docs.o1bot.exchange/>

### 9.2 BSC

顺序：修通 Four.meme、接入 Flap。

- Four.meme 现有发现适配器必须接入 Venue 安全能力表，避免事件在 runner 中被静默丢弃；
- Flap 使用官方 BNB Chain Portal、版本和事件 ABI；
- 标准 token、税 token 和迁移状态分别解析；
- 自定义税和 vault 进入独立风险字段。

Flap 官方地址和开发资料：<https://docs.flap.sh/flap/developers/deployed-contract-addresses>、<https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers>

### 9.3 Base

顺序：O1、Stonks Exchange、BaseStonk。

- 只有获得 Base 主网已验证 factory 和事件定义的平台才能启用；
- 不把 Robinhood 的 O1 地址或配置复用到 Base；
- B20 股票底池必须来自 Base 官方资产表；
- 未验证平台完成能力槽和诊断后保持关闭。

### 9.4 Solana

- Stonk Fun 必须取得已验证 Program ID、指令布局和账户约束；
- 验证池、vault、Meme mint 和 xStock mint 的绑定；
- Program ID 或指令布局未知时不得使用通用 Raydium/Pump 解析器猜测；
- 未验证时保持 `disabled-unverified`。

## 10. 安全证据

### 10.1 统一结论

```text
confirmed   已确认存在符合预期的卖出路径
blocked     已确认存在无法正常卖出、极小可卖量或硬限制
unknown     证据不足、Venue 不支持或外部检查失败
```

只有 `confirmed` 和 `blocked` 可以生成 Telegram。`unknown` 只记录和重试。

### 10.2 EVM

每个 Launchpad 安全适配器需要：

- 验证 Factory/Portal/Hook/Pool 与事件来源；
- 读取 launch 阶段、迁移状态、税率、最大交易量和转账限制；
- 使用正确路由执行至少两个数量级的卖出模拟；
- 比较输入数量、实际可卖数量和报价输出，识别“只能卖极小数量”；
- 结合真实 receipt、Transfer 日志和池余额变化确认 token 流入池、报价资产流出；
- 区分 Meme 限制和股票底池自身的合规限制；
- 无法绑定正确 Venue 路由时返回 `unknown:unsupported-venue`。

正常路径不要求 `debug_trace*`。只有明确配置的诊断模式才能使用 trace，并计入单独预算。

### 10.3 Solana

- 验证 Program、池、vault 和 mint 账户 owner；
- 解析 Token/Token-2022 mint/freeze authority 及扩展；
- 从真实成功交易的 pre/post token balance 验证 Meme 流入池和 reference asset 流出；
- 验证标签钱包实际支付 reference asset 后才计入聪明钱；
- 任一关键账户或指令布局无法验证时返回 `unknown`。

## 11. Telegram 和生命周期

- `new_launch`、`new_pool` 只触发检查，不直接推送；
- `confirmed + score >= chain MIN_SCORE` 推送完整候选报告；
- `blocked` 有可靠证据时立即推送风险报告，不要求最低分；
- `unknown` 静默；
- `graduated`、`swept`、`rescued`、`green`、`market_ready` 只对观察名单推送；
- 首次补扫、宕机恢复和历史事件不推送；
- 消息增加链、Launchpad、股票底池、资产来源、reference restriction 和安全证据摘要；
- 通知键继续包含链、token、alert type 和状态版本。

## 12. RPC 预算

### 12.1 月度目标

Dwellir 套餐总量为 2500 万次/月，另一个项目预留 500 万。本机器人设置：

| 链 | 月度目标 |
|---|---:|
| BSC | 550 万 |
| Ethereum | 450 万 |
| Robinhood | 500 万 |
| Base | 300 万 |
| 合计 | 1800 万 |

保留 200 万缓冲，硬上限不得超过 2000 万。Solana 独立统计，不占 EVM 配额。

### 12.2 计数和降级

- 按规范化真实 RPC URL 统计请求；
- 同一 URL 的 discovery、analysis 和 fallback 共享预算池；
- 按链、方法和角色记录 `eth_getLogs`、`eth_call`、receipt、block 等；
- 官方 RPC 优先承担高频发现，付费 RPC 承担候选深检和故障回退；
- 相同 token/pool 的链上事件与市场 API 任务合并；
- 资产、bytecode、metadata、pool config 和安全静态项缓存；
- 每小时输出脱敏用量摘要和月度投影。

预算阶段：

- 低于 80%：正常运行；
- 80%：降低市场补漏和非关键复检频率；
- 95%：只深检高初筛分、观察名单和风险状态候选；
- 100%：停止调用该受限付费端点，继续通过官方发现节点保存待处理候选，不无限重试。

预算降级不能推进未完成的发现游标，也不能把检查失败解释为安全。

## 13. 错误处理和可观测性

预期业务错误使用稳定原因码：

```text
asset-registry-unavailable
asset-unverified
venue-disabled-unverified
venue-security-unsupported
reference-asset-restricted
rpc-budget-throttled
rpc-budget-exhausted
```

非预期解析、ABI、schema 或状态错误必须保留链、Venue、事件键和调用上下文，让当前候选或发现轮次明确失败；不得用宽泛 catch 静默吞掉。

启动摘要至少显示：

- 每链资产数量和快照时间；
- 每个 Venue 的 enabled/discovery-only/disabled-unverified 状态；
- discovery/analysis RPC 脱敏域名；
- 当前月预算、已用量和降级阶段；
- Telegram live/shadow 状态。

## 14. 测试

### 14.1 资产与分类

- 官方清单 schema、地址规范化和重复处理；
- 更新成功、更新失败、旧快照回退和原子替换；
- ticker 冒充股票资产；
- Meme/股票池正反方向；
- 股票/稳定币不进入 Meme 分析；
- DexScreener/Gecko 反向数据去重。

### 14.2 Venue 夹具

每个启用平台使用脱敏真实事件和交易 fixture 验证：

- token、reference、pool、creator 和生命周期；
- Factory/Program 身份；
- 事件唯一键；
- 未验证或不支持平台正确返回禁用/unknown。

### 14.3 安全回归

- 正常卖出；
- 完全不能卖；
- 只能卖出极小数量；
- 动态税、黑名单、最大交易量；
- reference asset 自身合规限制；
- 模拟成功但没有真实报价资产流出；
- Solana Token-2022 扩展和错误 vault owner。

### 14.4 通知、状态和预算

- 补扫和重启不推送；
- 普通报告、风险报告和观察名单生命周期规则；
- 五链相同地址不互相去重；
- 同 URL 请求只计一次；
- 80%、95%、100% 降级；
- 预算耗尽不出现重试风暴或游标跳跃；
- 现有 Robinhood 全量回归。

## 15. 实施与 PR 顺序

使用四个串行 PR，全部完成但保持可独立审查：

1. 可信资产注册表、方向无关交易对分类、Venue 能力表和 RPC 预算基础；
2. Robinhood 与 BSC：Pons V1/V2、O1、Long、Four.meme、Flap；
3. Base：O1、Stonks Exchange、BaseStonk 和 B20 股票底池；
4. Solana：xStocks、Stonk Fun 和资金流安全验证。

每个阶段遵循测试先行，完成后运行全量测试。新增链或 Venue 先以 `shadow` 运行；只有可信入口、安全路径、事件夹具和 RPC 预算均通过验收后才切换 `live`。

## 16. 验收标准

1. 五链股票资产按可信地址识别，ticker 冒充不会进入股票底池逻辑。
2. Meme/股票池两个方向均能产生同一规范候选。
3. 已验证 Launchpad 事件不会被 runner 静默丢弃或误标为其他平台。
4. 未验证 Venue 明确显示 `disabled-unverified` 且不推送。
5. 普通候选只有 `confirmed + score >= MIN_SCORE` 才推送。
6. 极小可卖量等可靠风险能形成 `blocked` 报告。
7. 股票底池自身限制与 Meme 限售分开报告。
8. 补扫、重启和重复 API 数据不重复推送。
9. 付费 EVM RPC 月度目标不超过 1800 万，硬上限不超过 2000 万。
10. 预算降级、429、超时和单候选错误不会退出常驻进程或错误推进游标。
11. 全量现有测试和新增回归测试通过。
12. 扫描器仍然只读链、只推送，不包含任何交易功能。

## 17. 关键决策摘要

- 保留一套仓库、五个独立进程。
- 资产按官方或已验证地址识别，不按 ticker 猜测。
- 股票代币成为受信任 reference asset，不再被误当成 Meme。
- 交易对分类与 token 顺序无关。
- Venue 必须显式声明发现、生命周期和安全能力。
- 已验证即可启用；无法验证则完整诊断并默认关闭。
- 市场 API 只补漏，不提供身份真实性。
- 安全证据绑定实际 Venue，不用通用路由乐观放行。
- EVM RPC 目标 1800 万/月，硬上限 2000 万/月。
- 分四个串行 PR 完成全部范围。

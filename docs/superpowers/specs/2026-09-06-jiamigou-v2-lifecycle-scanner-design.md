# Jiamigou 第二篇：Pons V2 生命周期扫链设计

来源：

- 第一篇（2026-07-09）：https://x.com/jiamigou/status/2075057589457735949
- 第二篇（2026-09-04）：https://x.com/jiamigou/status/2095812180314902711
- Medium 图文对照：https://medium.com/@jiamigou/robinhood-chain-第2篇memecoin保姆级教程-学会扫链-抓住百倍币-ae1ad9113af5

当前代码基线：纯扫描推送机器人（`watch` / `scan` / `check`）。不读私钥、不签名、不广播、不维护仓位。本设计保持该约束。

## 目标

把机器人从「Uniswap 新池打分器」改成 **Pons V2 生命周期监控 + 淘汰器**。默认动作是丢掉，不是买入。

第二篇相对第一篇的核心变化：

> 找新币不是刷新 GMGN。三条线并行，全部围绕淘汰垃圾：出生证明 → 冲线/毕业是否走完 → 毕业后 24h 还活不活。

成功标准（对应原文「什么叫监控成功」）：

- 能给出平台温度三个数字和「打 / 不打」
- 当天最多 3 个 CA 的出生证明（工厂 + `pairToken`）
- 其中毕业的，能判定有没有 `PoolRegistered` / `PoolCreated` + hook 对上
- 衰减表至少 2 个时间点
- 一笔都没下也算成功；追了没核工厂算失败

本工具只做核验、淘汰、备忘录和告警。不自动交易。

## 现状差距

当前实现按第一篇：监听 Uniswap V2 `PairCreated`、V3 `PoolCreated`、V4 `Initialize`，并用 GeckoTerminal `new_pools` 做发现；再用 DexScreener / Blockscout 打 100 分加权。

第二篇已经写死：NOXA 停发；日常扫盘 Pons 看量、LONG 看股票梗。Pons V2 毕业前没有 Uniswap 池，只有 Bonding Curve。因此：

| 当前行为 | 第二篇要求 | 后果 |
| --- | --- | --- |
| 把 Uniswap 新池当出生 | 出生事件是 Pons V2 `TokenLaunched` | 曲线盘看不见，自发池/毕业瞬间池会刷屏 |
| Gecko `new_pools` 当发现源 | 新池 ≠ Pons 新币 | 毕业建池和垃圾自发池混在一起 |
| 一套分数留下 | 一条命中就划掉 | 垃圾盘仍可能「能看」 |
| 无发射台身份 | 先核工厂、curve、`pairToken`、phase | 分不清 V1/V2/LONG/自发池 |
| 无毕业状态机 | 进度条 90% ≠ 能买 | 会把 NotGraduated 当机会 |
| 创建者「终身发币数」 | 创作者 **24h** 发 >20 就丢 | 串子过滤过松 |
| 报价只认 WETH/ETH/USDG | 可报价 NVDA/TSLA/GME/USDG/ETH | 股票梗盘被丢掉或标错 |
| 每只新盘长清单报警 | 最多 3 个 CA，状态机报警 | 噪声淹没核验 |
| 无平台温度 | 温度 → 发现 → 事件 → 池子 → 浏览器 | 日发射 2 万时仍按牛市窗口扫 |

保留：只读 RPC、Telegram、蜜罐/税率启发式、持仓集中度、`watch/scan/check` CLI、seen 去重、游标失败不推进、URL 脱敏。

## 发射台与合约

Robinhood Chain `4663`。地址以官方/Blockscout 核验为准，写入 `src/config.js` 常量，不从用户输入读取。

### Pons V2（主发现源）

| 角色 | 地址 |
| --- | --- |
| Launch factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Launch router | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |
| Meme hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| Launch locker | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` |
| Graduation executor | `0xC7819B64A1dAECD7eC19856d026cb14EfBd89046` |

Factory 事件（Bitquery topic0 仅作对照，运行时用 ethers `Interface` 计算）：

| 事件 | 用途 |
| --- | --- |
| `TokenLaunched(address,address,address,address,uint256,uint256)` | 出生：token、curve、deployer、pairToken |
| `LaunchSwept(address,uint256,uint256)` | 曲线结束，资产被扫走 |
| `PoolGraduated(address,uint256,uint256,uint256)` | 正式毕业，V4 池已建，有 positionId |
| `GraduationTokensPermanentlyLocked(address,uint256)` | LP/供给永久锁定线索 |

每只币有自己的 Bonding Curve 合约。曲线成交看该 curve 上的 `CurveBuy` / `CurveSell`（以及可选的 `SnipeTaxCharged`）。毕业后的正式池必须带 Pons meme hook；hook 地址对不上则不当 Pons V2 毕业盘。

只读核验：Factory `getLaunchedToken(token)`。调用成功本身不能证明是 V2，因为 Solidity mapping 对未知 token 也会返回全零结构，其中 `phase=0`。只有同时满足以下条件才标记为 `pons-v2`：

- 返回记录 `exists == true`
- 返回的 `token` 与查询 CA 完全一致
- `curve != address(0)`、`deployer != address(0)`
- 从 `TokenLaunched` 发现时，事件里的 curve / deployer / pairToken 与读取结果一致

读取失败、`exists=false`、返回空结构或字段不一致，都不得标为 V2（可能是 V1、假盘或 RPC 故障；RPC 故障保留为 `unknown`，不能误判为 V1）。`pairToken == address(0)` 视为 ETH 交易对；否则只按合约地址去 Blockscout 和本地地址白名单核验，ticker/symbol 仅用于显示，不能用于身份判断。

`watch` 启动时还要做一次部署不变量检查：上述固定地址必须有 bytecode，且 Factory 的 `memeHook()`、`locker()`、`graduationExecutor()` 返回值必须与常量一致。检查失败立即停止 Pons V2 线路并给出明确错误，不能继续产生 V2 判断。

### Pons V1（默认淘汰）

V1 一出生就进 Uniswap V3 池，是机器人狙击场。默认 **L1 彩票**：不满 24h（可配置，默认再加 7d 才值得研究）不进备忘录。已知 V1 factory：`0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`（及更早 legacy，若仍能扫到则同样打 `pons-v1`）。

创建交易 `to` 直接建 V3 池 + 锁 LP、且 Factory `getLaunchedToken` 读不到 → 标 `pons-v1` 或 `uniswap-native`，走 V1 规则，不跑线 B。

### LONG / 股票报价

LONG 不是瀑布刷盘，是盯名单。发现路径：报价资产白名单（ETH、USDG、以及核验过的股票代币，文中 NVDA 例：`0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec`）出现新交易对时记录 CA。必须链上确认 quote 就是该合约，不能信 ticker。Pons 工厂冒充「股票盘」按假盘丢掉。

### 其它垫

Uniswap Labs `pools.trade`、Bankr、Flap、Virtuals：能识别则打标签，默认不进 3 个 CA 名额。Noxa 不再监听、不再出现在文档和使用说明里。

## 候选身份与状态机

每个 CA 持久化一份记录。链上协议阶段与机器人观察结论必须分开，不能共用一个 `phase`：

```text
pad: pons-v2 | pons-v1 | long | uniswap-native | unknown
protocolPhase: not_graduated | swept | pool_created | rescued | not_applicable
monitorState: observed | watchlisted | curve_dead | decay | killed
marketReady: true | false | unknown  # 市场数据是否足以观察；不改变链上阶段
pairToken, curve, deployer, factory, hook
birthBlock, birthAt
poolId, positionId, poolRegisteredAt
watchlist: bool          # 是否占用 3 个名额之一
killReason: string|null
riskDataStatus: known | unknown
```

`protocolPhase` 直接映射 Factory 的 `GraduationPhase`，只允许 `not_graduated → swept → pool_created`，或者 `swept → rescued`；`rescued` 是没有正式池的终态，必须移出 watchlist 并明确报警。`monitorState` 只描述机器人决策，可进入 `killed`，但不得反向改写链上阶段。第三方行情是否收录只更新 `marketReady`，不得把真实的 `pool_created` 降级。

`check` 可对任意 CA 跑一遍核验，不自动写入 watchlist。每次启动及每次处理生命周期事件后，都以 Factory 当前记录为权威状态进行 reconcile；这样即使机器人晚启动、重启或漏掉较早的 `LaunchSwept`，也能恢复到真实阶段。

## 三条监控线

### 线 A：刚出生（0–20 分钟）

发现主源改为 Pons V2 `TokenLaunched` 日志，不再用 Uniswap PairCreated 当出生。Uniswap V2/V3/V4 与 Gecko `new_pools` 降为**毕业后/未知垫**的辅助源：抄到 CA 后必须先走工厂核验，不能直接当新狗。

年龄：忽略前 10 秒（反狙击税）；主窗口 1–20 分钟（`MAX_AGE_MINUTES` 对 V2 出生默认改为 20，或新增 `LINE_A_MAX_AGE_MINUTES=20`）。0–10 秒只记出生，不报警「可看」。

**一条命中就划掉（硬淘汰，不靠总分硬扛）：**

- 名字含 `official` / `airdrop` / `Teneo` / `Robinhood` / `HOOD` 空投（大小写不敏感）
- 创作者滚动 24h 发币 > 20（改掉当前终身 `MAX_DEPLOYER_TOKENS` 作为唯一门槛；终身次数可保留为次要信号）
- 捆绑或内部 > 30%（仅在数据源可复现且状态为 `known` 时硬过滤；没有可靠数据则标 `riskDataStatus=unknown`，允许以「待核验」进入 watchlist，但不能变绿）
- 只能买不能卖
- 年龄至少 5 分钟、最近窗口至少 5 笔成交且至少 3 个独立交易者时，仍然全买零卖
- 同一标准化交易者占最近窗口成交笔数 > 80%，且买卖方向形成明显对倒
- 持有人卡住 ≤3 个地址
- 自动规则说不出发行理由（梗 / 股票挂钩 / 模仿活盘）→ `no-narrative`，只保留为 `observed`，不占 3 名额；人工可依据 `check` 报告自行研究，但本版不提供人工写回或强制晋级入口
- DexScreener / Gecko 还没收录 → 只记 CA，禁止「可小仓」类文案

**留下必须同时满足才允许进入备忘录：**

- 工厂对得上（Pons V2 或已核验的 LONG）
- 持有人在增加，不是只有 3 个地址
- 有双向成交
- 自动侧能给出一句发行理由（叙事关键词或已核验股票/RWA 报价挂钩）

不足 5 笔成交或不足 3 个独立交易者时，成交方向结论为 `unknown`，不能据此硬淘汰，也不能变绿。标准化交易者优先使用 `tx.from`；若它是已知 Router / Forwarder，再结合事件的 buyer/seller 与 recipient 推断，并把推断依据写入报告。不得因为所有事件都由同一个 Router 发出就判定为同地址对倒。

Watchlist 硬顶 **3 个 CA**。新的合格候选在满员时：只回收已经 `killed` 的名额；`curve_dead` 先降为低频毕业核验，确认死亡满 4 小时后才移出，避免漏掉后来完成的 graduation。否则只记 seen 并静默或发「名额已满」短告警，不挤掉活盘。

### 线 B：冲线与毕业（只对 `pons-v2`）

对 watchlist 内、`protocolPhase` 尚未进入 `pool_created` / `rescued` 的 CA 轮询。非 V2 不跑线 B。`curve_dead` 仍保留低频 phase 核验，直到确认死亡满 4 小时或链上进入终态。

1. **曲线是否还活**  
   最近 N 笔（默认 30）`CurveBuy`/`CurveSell`：  
   - 时间间隔拉长到数分钟无成交 → 可能已死或 Sweep，转查毕业  
   - 标准化交易者高度重复 → 可能建老鼠仓；只有达到线 A 的样本门槛并排除已知 Router 后才淘汰，否则标高风险  
   - 只剩 `CurveSell` → 曲线在出货，不当打新  

2. **protocolPhase**  
   按前述 `exists/token/curve` 规则读取 `getLaunchedToken(CA)`。仍是 `NotGraduated` 时，即使 Pons 进度条 90%、群里喊马上毕业，也**不发可买信号**。若为 `Rescued`，标记 `monitorState=killed`、原因 `graduation-rescued-no-pool`。

3. **链上毕业完成**  
   Factory 当前记录 `exists=true && phase=PoolCreated` 是权威条件。实时消费时同时保存 `LaunchSwept`、`PoolGraduated(positionId)`、V4 `Initialize` 和 Hook `PoolRegistered` 证据；晚启动或重启时允许根据 Factory 记录、固定 hook 和完整 PoolKey 计算 poolId，再读取 Hook 注册记录进行恢复，不要求本地必须见过较早的 `LaunchSwept`。poolId 的 currencies 必须按地址排序，fee/tickSpacing 取 launch 快照，hook 必须等于启动时核验过的 Pons meme hook。

   满足链上条件后设置 `protocolPhase=pool_created`，与 Gecko/DexPaprika 是否已经收录无关。若链上仅为 `Swept`，文案写「已 Sweep，正式池未完成」；若证据冲突则保持失败关闭并报警，不能猜测状态。

4. **市场可观察**  
   Gecko/DexPaprika 或链上 V4 Swap 数据确认池子已有可信双向成交、净买入不是单笔尖刺后，才设置 `marketReady=true`。只有 `protocolPhase=pool_created && marketReady=true` 才允许出现「可小仓观察」；第三方接口超时或未收录只令 `marketReady=false/unknown`，不得篡改链上阶段。

5. **可卖性与蜜罐语义**  
   Pons V2 曲线不能复用 Uniswap V2 报价模拟。曲线期优先以工厂身份、标准曲线 bytecode/接口和至少一笔成功 `CurveSell` 为证据；没有历史卖出时，只有在 RPC 支持可靠 state override，或找到余额与 allowance 均满足的真实调用上下文时，才可把 `eth_call sell` 成功视为通过。因调用者没余额、没 allowance 或曲线已 ready-to-graduate 导致的 revert 一律是 `unknown`，不能标蜜罐。毕业后改用计算出的 V4 PoolKey/hook 和 V4 Swap/Quoter 路径核验。

### 线 C：毕业后 24 小时衰减

仅 `protocolPhase=pool_created` 之后填表，以 `poolRegisteredAt` 为 `t=0`，不以出生时间为零点。建议字段：窗口起止、流动性、成交量、买/卖、独立交易者、持有人数、调整后前 10%、创建者余额、净买入和数据源。至少记录 `[0h,2h]` 基准窗口及其后每个完整 2h 窗口（可用 `LINE_C_INTERVAL_MS`）。若机器人晚启动导致基准窗口无法从链上或历史 API 重建，标 `baseline=unknown`，禁用依赖基准的硬淘汰规则。

前 10% 集中度必须排除已识别的 curve、V4 pool/PoolManager、locker、burn/zero 等协议或销毁地址，并同时保留原始值与调整值，避免把协议托管余额误判成庄家持仓。

写死判定：

| 条件 | 动作 |
| --- | --- |
| 当前完整 2h 窗口成交量 ≤ 前一完整窗口的 50%，且持有人净增 ≤0、净买入 <0 | `killed`，移出 watchlist；窗口不完整或任一数据未知时只标风险 |
| `[22h,24h]` 成交量 < `[0h,2h]` 的 20% | 当死盘，移出；不是拿 24h 累计量比较 |
| 持有人增加但前 10 更集中 | 标庄，不是社区；不得变绿 |
| 创建者余额下降且能由 Swap/转入交易场所证明为卖出 | 告警实际下降比例并标高风险；单纯余额变化只记待核验，不输出仓位建议 |
| 价格/成交只跟 `$PONS` 动、自身无独立买卖 | 影子币，移出 |

活的留到毕业后 24h；曲线疑似死亡的候选继续低频核验至 4h，仍无成交且未 Sweep/毕业才可撤，名额还给新 CA。

## 温度（开盘用，不当 K 线刷）

不爬 Dune、不解析 ponsinomics 网页。用已有公开接口做弱信号：

- 今日（或滚动 24h）Pons V2 `TokenLaunched` 数量：超过明确配置阈值时只把新的 watchlist admission 名额从 3 降到 1，并标高温风险；本版不自动改写持有人/捆绑阈值，避免隐藏且无法复现的策略漂移
- DexPaprika Robinhood 前 10：全是 WETH/USDG、股票、PONS → 判定「钱不在新狗」，线 A 名额改为 1
- Gecko 与 DexPaprika 对同一 CA 流动性差一倍以上 → 不信较大的那个，以链上/Blockscout 为准，并在报告里标明数据冲突

温度导致名额从 3 收紧到 1 时，只限制新的 admission，不自动踢出现有活盘；已有候选继续按 B/C 线走到终态。外部温度接口失败时沿用最近一次未过期结果并标 `stale`，超过一个计算周期仍失败则采用最保守的新入选上限 1，但不能改变已保存的 token 状态。

温度三个数字（建议）：24h 发射数、前 10 是否新 ticker、Pons 池在热门中的占比。写入每次 `watch` 启动 banner 和可选的整点短告警；盘中最多再算一次，不每轮刷 Telegram。

「打 / 不打」只表示是否开放新的重点观察名额，不是买入建议：前 10 全为基础设施/股票/PONS 或任一必需温度数据过期且无法刷新时为「不打」，新候选 admission 上限 1 且不得变绿；否则为「打」。24h 发射数超过 `HIGH_HEAT_LAUNCHES_24H` 时即使为「打」也只开放 1 个新候选名额。Pons 热门池占比只作为展示数字，本版不单独触发状态转换。

## 发现源优先级

1. Pons V2 Factory 日志（出生、sweep、毕业）—— 主源  
2. 各 token 的 curve 日志 —— 只对 watchlist / `check`  
3. DexPaprika 热门池 + Gecko 毕业后行情 —— 线 C 与温度  
4. Uniswap V2/V3/V4 事件 —— 仅用于识别「非 V2 出生」和毕业后正式池，不再当 memecoin 出生源  
5. Bitquery GraphQL —— **可选**。无 API key 时完全不请求；有 key 时只作索引加速，不得替代链上 Factory 事件。订阅会烧免费额度，默认关闭。

GMGN 没有稳定公开 API：核验流水线用 Blockscout + 链上事件 + Gecko/DexPaprika。报告可附 GMGN 链接，不抓 GMGN 页面。

## 命令与告警

命令保持三个：`watch`、`scan`、`check`。`paper`/`live` 继续立即拒绝。

- `watch`：跑线 A/B/C，写 state（seen、游标、watchlist、衰减快照），配置了 Telegram 才推送。  
- `scan`：一次性只读，不写 `data/`，不发 Telegram；输出当前窗口内的出生证明和淘汰原因。  
- `check <token>`：第二篇场景 1 的 90 秒核验报告：工厂 → phase → 曲线最后几笔 → hook/池子 → 买卖方向 → 杀因或留下理由。不自动写入 watchlist。

Telegram 改为状态机短消息，禁止每只新盘发完整 100 分清单。只报：

- 出生证明（工厂 + pairToken + curve + 留下/划掉）
- 被哪条规则划掉（一条理由）
- 曲线死亡 / 只剩卖
- **链上毕业完成**（`protocolPhase=pool_created`；只有同时 `marketReady=true` 才能使用「可小仓观察」文案）
- 衰减风险升级 / 移出 watchlist
- 名额已满

文案必须继续声明「只扫描报警，不自动交易」。未完成毕业时禁止出现「可买」「绿灯」类措辞。`green` 仅允许在 `pons-v2` + `protocolPhase=pool_created` + `marketReady=true` + 线 A 全过 + `riskDataStatus=known` + 对应交易路径的可卖性核验通过时出现。

现有加权评分可保留为次要参考，**不得覆盖硬淘汰**。对应交易路径的可卖性核验未完成不得变绿（已有原则继续保持，但 Pons Curve/V4 需要新增独立测试）。

## 配置

新增（均有默认值，布尔仍只接受现有 true/false 词表）：

```dotenv
PONS_V2_SCAN=true
LINE_A_MAX_AGE_MINUTES=20
LINE_A_SKIP_FIRST_SECONDS=10
MAX_WATCHLIST=3
MAX_DEPLOYER_TOKENS_24H=20
MAX_BUNDLE_PCT=30
MIN_FLOW_SAMPLE_TRADES=5
MIN_FLOW_UNIQUE_TRADERS=3
MAX_SINGLE_TRADER_PCT=80
HIGH_HEAT_LAUNCHES_24H=20000
LINE_C_INTERVAL_MS=7200000
BITQUERY_API_KEY=
BITQUERY_SCAN=false
DEXPAPRIKA_SCAN=true
```

`QUOTE_TOKENS` 保留内置标识 `WETH,ETH,USDG`；任何新增股票/RWA 报价资产必须填写 20-byte 合约地址。代码内维护 `address → displayLabel` 的已核验常量（例如 NVDA），symbol 只显示、不参与白名单匹配，也不允许把任意 symbol 自动解析成地址。未在地址白名单的 `pairToken` 标 `unknown-quote`，不进 watchlist。

`ONCHAIN_SCAN` 在开启时必须包含 Pons V2 Factory；关闭 Uniswap 三工厂监听可以另设开关，默认 Uniswap 监听保留但只用于分类，不产生线 A 出生。

## 状态与游标

`state.json` 升级为 **schemaVersion 4**，提供确定性的 v3 → v4 一次迁移。迁移必须原样保留旧 `seen`、`cursors.onchain`、`positions`、`trades`；旧 `positions`/`trades` 继续作为 opaque 历史只读保留。不能继续复用版本 3，否则旧二进制可能读入新文件并在下一次写盘时静默删除新增字段。

新增：

- `watchlist`: 最多 3 条 CA 记录  
- `tokens`: CA → 身份/protocolPhase/monitorState/marketReady/killReason/衰减快照  
- `cursors.ponsV2`：Factory 日志最后一个完整消费区块（与现有 `cursors.onchain` 分开，避免 Uniswap 区间失败卡住 Pons 出生）  
- `heat`: 最近一次温度数字、计算时间与 stale 状态
- `appliedEvents`: 已原子应用的链上事件 ID，按保留期裁剪
- `outbox`: 待发送/已发送的状态机短消息
- `pendingChecks`: 待执行/重试的持有人、行情、可卖性与 reconcile 任务

每个链上事件的唯一键为 `chainId:txHash:logIndex`，处理前按 `(blockNumber, transactionIndex, logIndex)` 排序。同一个事件重放只能得到相同状态，不能重复添加 watchlist 或重复创建通知。

基础事件事实、状态转换、`appliedEvents`、必要的 `pendingChecks` 和待发送 outbox 必须在同一次原子 `state.json` 写入中提交；提交成功后即可推进对应链上游标。Telegram 由独立 outbox worker 重试，发送成功后标 `deliveredAt`。这样 Telegram 故障不会卡住链上消费，也不会因「状态已写但告警未发」永久漏报。

只有日志无法解码、Factory 身份不变量无法完成必要核验，或原子状态写入失败时，当前 Pons 区间不得推进游标。Blockscout、Gecko、DexPaprika、holders 或可卖性分析失败时，把字段写为 `unknown` 并创建持久化 `pendingChecks` 重试任务，不得让单只坏币或第三方接口故障永久卡住整条 Factory 游标。重试任务采用有上限的指数退避，成功或过期后进入明确终态，非预期错误保留上下文日志。

消息投递按 `notificationId = eventId + transitionType` 幂等；Telegram 不提供端到端幂等键，超时且结果未知时不能保证 exactly-once，因此重试消息必须携带相同短 notificationId，并采用有上限的指数退避，让人工可以识别重复。`appliedEvents` 至少保留 7 天且覆盖所有允许的回扫/重组窗口。`scan` 使用隔离的内存状态，不读取/写入 outbox、`state.json` 或 Telegram。

## 实施顺序

**P0**（不落地则第二篇等于没做）

- 监听 Pons V2 `TokenLaunched` / `LaunchSwept` / `PoolGraduated`
- `getLaunchedToken` 按 `exists/token/curve` 不变量读取 protocolPhase、pairToken、deployer
- schema v3 → v4 无损迁移、事件幂等与持久化 outbox
- 发射台分类：V2 优先，V1 默认丢
- 线 A 硬淘汰 + watchlist 最多 3 个 CA
- Telegram 改为出生/划掉短消息

**P1**（生命线）

- 按 curve 拉买卖，判老鼠仓 / 只卖 / 停工
- `protocolPhase=pool_created && marketReady=true` 才允许「可小仓观察」
- `check` 改成 90 秒核验报告

**P2**（衰减 + 温度）

- 线 C 表 + 2h/24h
- DexPaprika 前 10 + 日发射数量调节过滤强度
- LONG / 股票报价白名单

**P3**（可选）

- Bitquery 作备用索引（默认关）
- 捆绑%/内部% 仅在有可复现数据源时硬过滤，否则保持 unknown

## 测试与验收

- 给定 `TokenLaunched` 日志能解析出 token、curve、deployer、pairToken；`pairToken=0x0` 视为 ETH。
- `getLaunchedToken` 返回 `exists=false`、token 不匹配、curve 为零或空结构 → 不得标 `pons-v2`；RPC/限流失败 → 保持 `unknown`，不得误标 V1。
- 固定地址无 bytecode，或 Factory getter 与配置的 hook/locker/executor 不一致 → Pons V2 线路启动失败。
- Pons V1 / 直接 V3 建池候选不得进入 watchlist（除非超过存活门槛，且仍不得跑线 B）。
- 线 A 任一杀因命中 → `monitorState=killed`，不进 watchlist，但不得伪造或回退 `protocolPhase`。
- 捆绑/内部数据 `unknown` 可标记为待核验并进入 watchlist，但不得变绿；已知值 >30% 必须淘汰。
- 成交不足 5 笔或独立交易者不足 3 个时不得以「全买零卖」硬淘汰；已知 Router 重复不得当成对倒。
- watchlist 第 4 个合格候选不得挤掉 3 个活盘。
- 温度将 admission 上限降到 1 时不得自动删除已有活盘。
- 进度条/仅 `TokenLaunched` 不得发出毕业完成或可小仓文案。
- `phase=PoolCreated` 但行情 API 未收录 → 保持 `protocolPhase=pool_created`、`marketReady=false`，不得出现可小仓文案。
- `PoolGraduated` / 计算出的 PoolKey 与固定 hook 不匹配 → 不得 `marketReady`，并产生关键配置/证据冲突告警。
- `phase=Rescued` → `monitorState=killed`，不得声称存在正式池。
- Pons Curve 因调用者无余额/allowance 或 `readyToGraduate` 导致 sell `eth_call` revert → 结果为 unknown，不得误报蜜罐。
- 线 C 用 `poolRegisteredAt` 为零点；夹具分别覆盖 `[0h,2h]`、`[22h,24h]`、不完整窗口和缺失 baseline。
- v3 → v4 迁移完整保留 `seen/cursors/positions/trades`；新状态重新载入后不得丢失 tokens/watchlist/heat/outbox/pendingChecks。
- 同一生命周期日志重复、乱序或区间重扫时，状态转换和 outbox 各只能产生一次。
- Telegram 失败时游标在状态/outbox 原子提交后仍可推进；恢复后待发消息能继续投递。
- Gecko/DexPaprika/Blockscout 故障时写入 unknown 和 pendingChecks，不能卡住 Factory 游标；恢复后能补齐分析。
- `paper`/`live` 仍立即拒绝；源码仍不得出现 Wallet / PRIVATE_KEY / 签名广播。
- `scan` 仍不写 `data/`、不写 outbox、不发 Telegram。

## 非目标

- 不恢复 `paper`/`live`、不自动买入、不做夹子/抢跑。
- 不在曲线 90%、NotGraduated、无 hook、GMGN 未收录时发出可买信号。
- 不接 GMGN 非公开接口，不打开/推荐钓鱼站，不把群链接当数据源。
- 不把 Gecko 新池第一当 Pons 新币。
- 不爬 Dune / ponsinomics 作为运行时依赖。
- 不 24 小时无差别长文报警。
- 不删除用户现有 `.env`、`data/` 或历史 positions/trades。
- 本设计不实现第三篇「全自动策略调参」；只为那篇提供半自动分步语义。

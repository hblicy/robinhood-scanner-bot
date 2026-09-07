# 严格卖出安全门槛设计

## 目标

普通候选只有在机器人取得可复现、非粉尘的真实卖出证据后，才允许进入现有 Telegram 评分推送。安全证据不足时静默；发现隐藏余额、额度限卖或明确无法卖出时，强制发送红色风险报告。

本设计保持机器人纯只读：不增加私钥、钱包、授权、签名、交易构造或广播能力。

## 事故样本与根因

回归样本：

- Token：`0x3FBf37267A7a0f54B9062a465A997e4698925910`
- Pool：`0xEb0995022Dce9e26629D70F6D39a8fe553Ab38B8`
- Wallet：`0xa8D8f52c31Ffb15d10EdD33b5ebeef546b9a5621`
- Buy transaction：`0x5f2927b6bf3607aee64c3d5a7a78ed289b962af221e5ffb94c984416f75711c7`
- Sell transaction：`0x2ac90c35280e4a47665c31d92626896b76a682b22f3953681631fdc710545d6d`

买入 Transfer 向该钱包记入 `328585691549515` 个最小单位；卖出前没有对应的大额转出 Transfer。卖出交易 calldata 的数量参数及实际 Transfer 均只有 `50` 个最小单位，卖出后 `balanceOf` 仍只返回 `50`。这说明代币的 Transfer 账本余额与合约报告余额发生巨大偏差，属于隐藏余额变更或按地址返回伪造余额一类的高风险行为。

当前机器人漏拦的根因有两层：

1. V2 `getAmountsOut` 只计算池报价，不执行代币的真实转账规则；直接 `transfer` 模拟也不能证明 Router 的完整买入、授权和卖出路径。
2. `honeypot=unknown` 只是不获得安全加分，候选仍可能靠年龄、社交、成交、流动性和市值达到 `MIN_SCORE`，以“人工复核”形式推送。

## 状态模型

新增卖出安全结论：

```text
confirmed  已观察到满足门槛的真实卖出，且未发现账本或额度异常
unknown    数据缺失、样本不足或对应交易路径尚不支持
blocked    发现隐藏余额、额度限卖、明确 revert/false 或卖出报价为零
```

结论必须附带稳定原因码和证据摘要。至少支持：

- `hidden-balance-mutation`
- `sell-size-limited`
- `sell-transfer-blocked`
- `sell-quote-zero`
- `insufficient-meaningful-sells`
- `unsupported-venue`
- `evidence-unavailable`

未知不能转成通过；一个钱包成功或一次粉尘卖出不能转成通过。

## Transfer 账本一致性

对普通候选从池创建区块扫描到分析时的安全区块，读取目标 token 的 Transfer 日志。区块起点优先使用发现事件自带的 `blockNumber`；Gecko 候选使用 DexScreener 的 `pairCreatedAt` 通过现有区块时间二分逻辑定位。起点无法确定时结论为 `unknown`。

从 `pool → wallet` 的买入 Transfer 中选择最多 5 个近期不同钱包，排除 pool、Router、零地址、销毁地址和合约地址。对每个样本在同一区间计算：

```text
ledgerBalance = Σ incoming Transfer - Σ outgoing Transfer
missing = ledgerBalance - balanceOf(wallet)
missingRatio = missing / ledgerBalance
```

仅在 `ledgerBalance >= 1 whole token` 时执行差异判定。若 `missing > 0` 且 `missingRatio > 1%`，立即得到 `blocked / hidden-balance-mutation`。反射、重基或其他无 Transfer 的余额变化也会被保守过滤，这是已确认的产品取舍。

账本计算使用整数，不把大整数转换为 JavaScript `Number`。查询错误或样本不足得到 `unknown`，不得吞错后宣称通过。

## 多档额度检查

对最多 3 个当前余额至少为 1 whole token 的样本钱包，以钱包为 `from`、pool 为 `to`，执行 1%、10%、50%、100% 当前余额的只读 ERC-20 `transfer` `eth_call`。

- 调用 revert 或标准布尔返回值为 `false`：`blocked`。
- 小额档通过而较大档失败：`blocked / sell-size-limited`。
- 返回值必须按 ERC-20 ABI 解码；RPC 返回成功但布尔值为 `false` 不能算通过。
- 全部通过只表示没有发现直接转账额度限制，不能单独得到 `confirmed`，因为 Router `transferFrom` 仍可能有不同规则。

不使用 state override 伪造未知存储槽，不向链上发送交易。

## 真实卖出证据

从目标 token 的 `wallet → pool` Transfer 中提取候选卖出，按交易哈希读取成功 receipt。一次卖出只有同时满足以下条件才算“有效卖出”：

- 卖方不是 pool、Router、零地址、销毁地址或合约地址。
- token 输入不少于分析时 pool token 余额的 `0.01%`，且不少于 1 whole token。
- 同一 receipt 中存在从 pool 流出的非零报价币 Transfer；原生币路径允许使用 WETH 从 pool 流向 Router 后销毁/解包的证据。
- receipt 状态成功。

至少 3 个不同钱包各有一笔有效卖出，且账本一致性和多档检查均未发现阻断，才得到 `confirmed`。receipt 查询限制在为证明 3 个不同卖方所需的最少数量，并设置硬上限；达到上限仍不足时为 `unknown / insufficient-meaningful-sells`。

该规则降低白名单钱包伪造卖出证据的风险，但不能保证识别所有选择性黑名单、延时开关或未来状态变化。

## 分析与推送集成

卖出安全证据接入现有 `honeypotCheck` 结果：

- `blocked` → `honeypot=true`、`complete=true`，加入“蜜罐 / 无法卖出”红旗，最终 verdict 必须为 `skip`。
- `confirmed` → `honeypot=false`、`complete=true`，之后才能获得现有安全加分并参与 `green/review` 判定。
- `unknown` → `honeypot=null`、`complete=false`，不宣称安全。

`handleCandidate` 的 Telegram 门槛改为：

```text
blocked:
  推送红色风险报告

confirmed 且满足现有 MIN_SCORE / verdict 条件:
  推送现有完整评分报告

unknown:
  静默，不因总分、review 或其他加分推送
```

该门槛作用于所有普通候选。当前卖出证据收集只支持可确定地址的 Uniswap V2 池；V3、V4、无地址 poolId 或其他 venue 返回 `unknown / unsupported-venue`，因此普通候选静默。Pons 生命周期 outbox、`hard_kill`、`rescued`、`market_ready` 和启动提示不经过该门槛，行为保持不变。

Telegram 报告增加明确一行：卖出安全状态、原因及样本数。不得在 `unknown` 时使用“通过”“可小仓”文案。

## 错误处理与资源边界

- RPC 日志、receipt、code 或 balance 查询发生预期外失败时，保留错误上下文并返回 `unknown / evidence-unavailable`。
- 数据不足是明确的 `unknown`，不伪装成系统错误，也不生成红色误报。
- 每枚候选最多检查 5 个买家、3 个额度样本，并限制 receipt 查询数量。
- 日志使用现有分块与退避读取；不得用一个无限区块范围查询。
- 本次不新增普通候选的持久化重试队列。证据不足或数据异常的候选可能被静默并错过，安全优先于覆盖率。
- 关键日志输出 token、pool、状态、原因码和样本计数，不输出 RPC 凭据。

## 测试与验收

自动化测试必须证明：

1. SNOWBALL 固定样本中，Transfer 账本余额远大于 `balanceOf`，得到 `blocked / hidden-balance-mutation`。
2. 差异恰好 1% 不阻断，超过 1% 阻断；所有计算保持 bigint 精度。
3. 反射或重基造成显著差异时同样保守阻断。
4. 多档检查正确解码 ERC-20 `true/false`；小额通过而大额失败得到 `sell-size-limited`。
5. 单钱包、粉尘卖出、receipt 失败或没有报价币流出不能形成有效卖出。
6. 三个不同钱包的有效卖出、账本一致且额度检查无异常时得到 `confirmed`。
7. RPC 或证据读取失败得到 `unknown`，且保留可识别原因。
8. `unknown` 即使 100 分也不调用 Telegram；`blocked` 发送红色风险报告；`confirmed` 仍按 `MIN_SCORE` 推送完整报告。
9. V3、V4 与无法定位地址的池返回 `unsupported-venue` 并静默。
10. Pons 关键生命周期通知和启动提示不受影响。
11. `npm test`、`git diff --check` 和无交易能力静态扫描通过。

## 非目标

- 不承诺 100% 识别按钱包、按区块或延时启用的恶意逻辑。
- 不执行真实买入、授权、卖出或牺牲钱包测试。
- 不为 V3/V4 新增 Router 模拟。
- 不改变现有评分项目、`MIN_SCORE`、生命周期 schema 或 Pons 状态机。
- 不新增后台数据库、外部付费风控 API 或普通候选持久化重试系统。

# Alchemy 日志范围与 Gecko V2 venue 修复设计

## 背景

机器人使用 Alchemy Robinhood Mainnet Free RPC 时，Pons 和普通链上监听持续出现 `400 Bad Request` 与 `could not coalesce error`。Alchemy Free 对 Robinhood Mainnet 的单次 `eth_getLogs` 查询限制为 10 个区块，而当前公共日志读取器默认按 2000 个区块查询，范围错误后的递归拆分下限仍为 40 个区块。

同时，GeckoTerminal 把 Robinhood 上的 Uniswap V2 标识为 `uniswap-v2-robinhood`，分析器只接受规范值 `uniswap-v2`，导致这些候选被安全门标为 `unknown:unsupported-venue`。

## 方案比较

### 方案 A：固定 10 区块切片并归一化白名单 venue（采用）

- 公共 `getLogsChunked` 默认每批最多查询 10 个区块，递归拆分下限同步降到单区块。
- Gecko 数据入口只将明确白名单中的 `uniswap-v2-robinhood` 规范化为 `uniswap-v2`。
- 后续仍由现有 Factory、Pair、token0/token1 校验决定是否形成卖出证据。

优点是行为确定、兼容 Alchemy Free，不依赖供应商错误文案；缺点是首次补扫会产生更多 RPC 请求。

### 方案 B：先发大范围请求，失败后识别 Alchemy 错误并自适应拆分

正常情况下请求更少，但 Alchemy 的 HTTP 400 经过 ethers 后可能只剩通用错误，错误文本不稳定，仍可能无法识别并拆分。

### 方案 C：维持 2000 区块，要求使用付费 RPC

代码改动最少，但与当前用户使用的 Alchemy Free 套餐不兼容，不能满足本次修复目标。

## 设计

### RPC 日志读取

`getLogsChunked` 的默认 `chunk` 改为 10。每次传给 `provider.getLogs` 的闭区间长度不得超过 10。保留已有重试、结果预算与顺序合并语义；若供应商对更小范围仍报告范围过大，则允许继续二分直至单区块。授权、限流、网络错误等非范围错误继续向调用方传播，由现有 watch 循环记录并重试，不推进游标。

### Gecko venue 归一化

在 `market.js` 的 Gecko 解析边界增加最小白名单映射：

- `uniswap-v2-robinhood` → `uniswap-v2`
- 其他 venue 保持原值。

映射只决定进入现有 V2 检查路径，不替代链上可信校验。伪造或错误池地址仍会在 Factory/Pair/token 顺序校验中失败并保持静默。

### 测试

- `getLogsChunked` 默认覆盖超过 10 个区块时，断言每个 RPC 请求最多包含 10 个区块且整体无遗漏、无重叠。
- 范围限制错误可以继续拆到单区块；非范围错误不做无意义拆分。
- Gecko 的 `uniswap-v2-robinhood` 产出规范 `uniswap-v2`；未知 venue 不被误映射。
- 运行完整 `npm test` 与 `git diff --check`。

## 非目标

- 不改变评分、Telegram 推送阈值、Pons 生命周期规则或只读边界。
- 不新增 RPC 服务商自动识别、付费套餐探测或交易功能。

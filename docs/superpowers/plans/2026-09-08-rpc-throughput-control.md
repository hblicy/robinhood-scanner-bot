# RPC Throughput Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Robinhood 扫描器的 RPC 峰值稳定控制在 Alchemy Free 限额以内，并消除每个 V2 候选的全历史 Transfer 扫描。

**Architecture:** 用独立的加权调度器包装默认 JsonRpcProvider 的读取方法，使所有生产 RPC 共用 350 CU/s 的平滑预算。候选分析先计算不含卖出安全加分的预评分，仅对仍可能达到最终门槛的候选执行深检；深检从最新区块向前读取最多 500 个区块并在原始买卖候选充足时提前停止。

**Tech Stack:** Node.js 18+、ES modules、ethers v6、`node:test`、`node:assert/strict`

---

## 文件结构

- Create: `src/rpc-budget.js` — 纯粹的 CU 成本表、平滑调度器和 Provider 包装器。
- Create: `test/rpc-budget.test.js` — 并发调度、Provider 方法成本和透明错误传播测试。
- Modify: `src/chain.js` — 默认 Provider 接入调度器；识别限流错误并选择退避时间。
- Modify: `test/chain.test.js` — 429 与普通错误退避回归测试。
- Modify: `src/sellability.js` — 最近优先的有限 Transfer 窗口和候选内收据缓存。
- Modify: `test/sellability.test.js` — 500 区块上限、倒序分片和提前停止测试。
- Modify: `src/analyze.js` — 在深度卖出检查前完成预评分。
- Modify: `test/analyze.test.js` — 低分跳过和临界分继续深检测试。
- Modify: `src/scanner.js`、`test/index.test.js` — 生产默认分析并发降为 1。
- Modify: `.env.example` — 说明内建 350 CU/s 预算和有限卖出证据窗口，不增加新配置项。

### Task 1: 全局 CU 调度器

**Files:**
- Create: `src/rpc-budget.js`
- Create: `test/rpc-budget.test.js`
- Modify: `src/chain.js`

- [ ] **Step 1: 编写并发任务间隔失败测试**

在 `test/rpc-budget.test.js` 中用可控时钟调用期望 API：

```js
const waits = [];
let now = 0;
const schedule = createRpcScheduler({
  cuPerSecond: 100,
  now: () => now,
  sleep: async (ms) => { waits.push(ms); now += ms; },
});
await Promise.all([
  schedule(20, async () => "a"),
  schedule(20, async () => "b"),
  schedule(20, async () => "c"),
]);
assert.deepEqual(waits, [200, 200]);
```

再断言 `createBudgetedProvider` 把 `getLogs` 计为 60 CU、`call` 计为 26 CU，并原样返回结果、原样抛出底层错误。

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `node --test test/rpc-budget.test.js`

Expected: FAIL，提示找不到 `../src/rpc-budget.js`。

- [ ] **Step 3: 实现最小调度器和 Provider 包装器**

在 `src/rpc-budget.js` 导出：

```js
export const RPC_CU = Object.freeze({
  getBlockNumber: 10,
  getBlock: 20,
  getCode: 20,
  getLogs: 60,
  getTransaction: 17,
  getTransactionReceipt: 20,
  call: 26,
});
export const DEFAULT_RPC_CUPS = 350;
export function createRpcScheduler({
  cuPerSecond = DEFAULT_RPC_CUPS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isFinite(cuPerSecond) || cuPerSecond <= 0) throw new Error("cuPerSecond must be positive");
  let nextStartAt = 0;
  return async (cost, operation) => {
    if (!Number.isFinite(cost) || cost <= 0) throw new Error("RPC cost must be positive");
    if (typeof operation !== "function") throw new Error("RPC operation must be a function");
    const current = now();
    const reservedAt = Math.max(current, nextStartAt);
    nextStartAt = reservedAt + Math.ceil((cost * 1000) / cuPerSecond);
    const delay = Math.max(0, reservedAt - current);
    if (delay > 0) await sleep(delay);
    return operation();
  };
}

export function createBudgetedProvider(provider, schedule) {
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const cost = RPC_CU[property];
      if (!cost) return value.bind(target);
      return (...args) => schedule(cost, () => value.apply(target, args));
    },
  });
}
```

`schedule(cost, operation)` 必须先同步预留 `max(now(), nextStartAt)`，再等待，不允许并发调用取得同一个起始时间。

在 `src/chain.js` 中让 `getProvider()` 只创建一次原始 `JsonRpcProvider`，并返回只创建一次的 budgeted proxy。现有所有调用方继续使用同一接口，不新增供应商识别。

- [ ] **Step 4: 运行专项测试**

Run: `node --test test/rpc-budget.test.js test/chain.test.js`

Expected: PASS，0 failures。

- [ ] **Step 5: 提交**

```bash
git add src/rpc-budget.js src/chain.js test/rpc-budget.test.js
git commit -m "限制 RPC 读取峰值吞吐"
```

### Task 2: 限流错误指数退避

**Files:**
- Modify: `src/chain.js`
- Modify: `test/chain.test.js`

- [ ] **Step 1: 编写失败测试**

新增两个测试：嵌套 `{ error: { status: 429 } }` 连续失败时收集到 `[1000, 2000]`；普通错误仍收集到 `[400, 800]`。同时覆盖消息中的 `rate limit`、`too many requests`、`compute units` 和 `throughput`。

- [ ] **Step 2: 运行测试并确认失败原因**

Run: `node --test test/chain.test.js`

Expected: FAIL，429 实际仍得到 `[400, 800]` 或缺少 `isRateLimitError` 导出。

- [ ] **Step 3: 实现错误识别和退避**

在 `src/chain.js` 复用 `errorDetails`，导出 `isRateLimitError(error)`。`withRetry` 在第 `i` 次失败后使用：

```js
const delay = isRateLimitError(err) ? 1000 * (2 ** i) : 400 * (i + 1);
```

最终一次失败不等待，仍抛出原始错误对象。

- [ ] **Step 4: 运行专项测试并提交**

Run: `node --test test/chain.test.js test/rpc-budget.test.js`

Expected: PASS，0 failures。

```bash
git add src/chain.js test/chain.test.js
git commit -m "延长 RPC 限流错误退避"
```

### Task 3: 限定 Transfer 证据窗口

**Files:**
- Modify: `src/sellability.js`
- Modify: `test/sellability.test.js`

- [ ] **Step 1: 编写窗口范围失败测试**

为导出的 `recentTransferRanges` 编写断言：`start=0, head=1000` 只能生成 `[991,1000]` 到 `[501,510]` 的 50 个倒序闭区间；`start=997` 时只能生成 `[997,1000]`。断言相邻区间无遗漏、无重叠。

再通过 `inspectSellability` 注入 `getLogs`，确认任何请求都满足 `fromBlock >= head - 499`；当最新分片包含 5 个池转出买家和 3 个转入池卖家时，只请求一个分片。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/sellability.test.js`

Expected: FAIL，缺少 `recentTransferRanges`，现有实现仍从池创建区块完整读取。

- [ ] **Step 3: 实现最近优先读取**

在 `src/sellability.js` 增加常量 `MAX_TRANSFER_LOOKBACK_BLOCKS = 500` 与 `TRANSFER_CHUNK_BLOCKS = 10`，并导出纯函数：

```js
export function recentTransferRanges(start, head, maxBlocks = 500, chunk = 10) {
  const floor = Math.max(start, head - maxBlocks + 1);
  const ranges = [];
  for (let end = head; end >= floor;) {
    const fromBlock = Math.max(floor, end - chunk + 1);
    ranges.push({ fromBlock, toBlock: end });
    end = fromBlock - 1;
  }
  return ranges;
}
```

`inspectSellability` 逐段调用已有 `getLogs`，累计结果并维护统一 `MAX_TRANSFER_LOGS` 预算。累计日志至少包含 5 个不同的池转出地址及 3 个不同的转入池地址时停止扩展；随后仍执行现有 EOA、账本、梯度转账和真实卖家收据校验。opening balance 改用实际窗口 floor 的前一块。

候选内增加 `Map<hash, Promise<receipt>>`，所有收据读取经过同一 `retry`，同一哈希只创建一个 Promise。

- [ ] **Step 4: 运行专项测试并提交**

Run: `node --test test/sellability.test.js test/honeypot.test.js`

Expected: PASS，0 failures。

```bash
git add src/sellability.js test/sellability.test.js
git commit -m "限制卖出证据日志窗口"
```

### Task 4: 评分预筛后执行深检

**Files:**
- Modify: `src/analyze.js`
- Modify: `test/analyze.test.js`

- [ ] **Step 1: 编写预筛失败测试**

在测试依赖 helper 中设置 `minScore: 0` 以保持既有用例显式进入深检。新增低分用例设置 `minScore: 70`，断言 `honeypotCheck` 调用次数为 0、结果为 `unknown:prefilter-score`；新增预评分恰为 60 的用例，断言在最终门槛 70 下仍调用一次深检。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/analyze.test.js`

Expected: FAIL，低分候选仍调用 `honeypotCheck`。

- [ ] **Step 3: 实现基础 facts 与条件深检**

把 `DEFAULT_ANALYZE_DEPENDENCIES.minScore` 设为 `SETTINGS.minScore`。先构造 honeypot/sellability 均未知、`securityComplete=false` 的基础 facts，调用 `scoreFromFacts`；若：

```js
preliminary.score < Math.max(0, dependencies.minScore - 10)
```

则使用 `sellabilityResult(SELLABILITY.UNKNOWN, "prefilter-score")`，不调用 `honeypotCheck`。否则运行现有深检。最终始终用真实或未知安全结果重建 facts 并重新评分，确保预评分不直接成为最终报告。

- [ ] **Step 4: 运行专项测试并提交**

Run: `node --test test/analyze.test.js test/runtime.test.js test/format.test.js`

Expected: PASS，0 failures。

```bash
git add src/analyze.js test/analyze.test.js
git commit -m "仅对可能达标候选执行卖出深检"
```

### Task 5: 默认串行分析与运维说明

**Files:**
- Modify: `src/scanner.js`
- Modify: `test/index.test.js`
- Modify: `.env.example`

- [ ] **Step 1: 编写默认并发失败测试**

新增不传 `analysisConcurrency` 的 `runReadOnlyCandidates` 用例，使用阻塞计数器断言 `maxActive === 1`；保留显式传 2 的既有用例，证明测试和一次性扫描仍可覆盖注入行为。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/index.test.js`

Expected: FAIL，默认最大并发仍为 2。

- [ ] **Step 3: 修改默认值和说明**

将 `src/scanner.js` 的 `DEFAULT_ANALYSIS_CONCURRENCY` 改为 1。在 `.env.example` 相邻 RPC 注释中说明程序内建 350 CU/s 平滑预算，并说明普通候选仅对可能达标者读取最近 500 区块的卖出证据；不新增环境变量。

- [ ] **Step 4: 运行专项测试并提交**

Run: `node --test test/index.test.js test/config.test.js test/push-only.test.js`

Expected: PASS，0 failures。

```bash
git add src/scanner.js test/index.test.js .env.example
git commit -m "降低候选分析默认并发"
```

### Task 6: 完整验证与差异审查

**Files:**
- Verify all modified files

- [ ] **Step 1: 运行完整测试**

Run: `npm test`

Expected: 所有测试 PASS，0 failures，进程退出码 0。

- [ ] **Step 2: 检查补丁质量**

Run: `git diff --check`

Expected: 无输出，退出码 0。

Run: `git status --short --branch`

Expected: 只包含本计划直接产生的提交；工作区无未提交文件。

- [ ] **Step 3: 对照规格逐项验收**

确认：350 CU/s 调度覆盖默认 Provider；429 退避为 1/2 秒；日志窗口不超过 500；低分不深检；临界分不漏检；默认并发 1；Telegram、Pons 生命周期和 push-only 测试未改变。

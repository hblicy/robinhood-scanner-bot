# Alchemy 日志范围与 Gecko V2 Venue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Alchemy Robinhood Mainnet Free RPC 的链上日志扫描稳定运行，并让 Gecko 的 Robinhood Uniswap V2 候选进入现有严格卖出校验路径。

**Architecture:** 公共日志读取器使用供应商无关的保守 10 区块默认切片，同时允许已识别的范围限制错误继续二分到单区块。Gecko 数据只在入口处规范化一个明确白名单别名，后续安全判断继续依赖现有链上 Factory/Pair/token 顺序校验。

**Tech Stack:** Node.js ESM、ethers v6、`node:test`

---

### Task 1: 将日志读取限制为 Alchemy Free 可接受的范围

**Files:**
- Modify: `test/chain.test.js`
- Modify: `src/chain.js:166-213`

- [ ] **Step 1: 写默认 10 区块切片的失败测试**

把原有 “uses a 2000-block default chunk” 测试改为：

```js
it("uses Alchemy Free-compatible ten-block default chunks", async () => {
  const ranges = [];
  await getLogsChunked({
    address: ADDR.V2_FACTORY,
    topics: [],
    fromBlock: 1,
    toBlock: 23,
    provider: {
      getLogs: async ({ fromBlock, toBlock }) => {
        ranges.push([fromBlock, toBlock]);
        return [];
      },
    },
  });
  assert.deepEqual(ranges, [[1, 10], [11, 20], [21, 23]]);
});
```

- [ ] **Step 2: 写范围错误可拆到单区块的失败测试**

```js
it("splits provider range errors below forty blocks", async () => {
  const ranges = [];
  const logs = await getLogsChunked({
    address: ADDR.V2_FACTORY,
    topics: [],
    fromBlock: 1,
    toBlock: 12,
    chunk: 12,
    provider: {
      getLogs: async ({ fromBlock, toBlock }) => {
        ranges.push([fromBlock, toBlock]);
        if (toBlock > fromBlock) throw new Error("range too large");
        return [{ blockNumber: fromBlock }];
      },
    },
    retry: async (fn) => fn(),
  });
  assert.equal(logs.length, 12);
  assert.equal(new Set(logs.map(({ blockNumber }) => blockNumber)).size, 12);
  assert.ok(ranges.some(([fromBlock, toBlock]) => fromBlock === toBlock));
});
```

同时给现有共享预算拆分测试显式传入 `chunk: 80`，使它继续覆盖递归分支。

- [ ] **Step 3: 运行测试确认 RED**

Run: `node --test test/chain.test.js`

Expected: 默认切片仍得到大区间，且 12 区块范围错误未被拆分。

- [ ] **Step 4: 最小修改日志切片实现**

在 `getLogsChunked` 中修改默认值与拆分下限：

```js
chunk = 10,
```

```js
if (end - start + 1 > 1 && isLogRangeLimitError(err)) {
  const mid = Math.floor((start + end) / 2);
  const nextChunk = Math.max(1, Math.floor((end - start + 1) / 2));
```

其余重试、预算和游标语义不变。

- [ ] **Step 5: 运行测试确认 GREEN**

Run: `node --test test/chain.test.js`

Expected: `test/chain.test.js` 全部通过。

- [ ] **Step 6: 提交 Task 1**

```bash
git add src/chain.js test/chain.test.js
git commit -m "兼容 Alchemy 免费日志查询范围"
```

### Task 2: 规范化 Gecko Robinhood Uniswap V2 venue

**Files:**
- Modify: `test/market.test.js`
- Modify: `src/market.js:8-75`

- [ ] **Step 1: 写 venue 白名单映射失败测试**

```js
it("normalizes only the Robinhood Uniswap V2 Gecko venue alias", async () => {
  const known = geckoRow(new Date(NOW).toISOString());
  known.relationships.dex.data.id = "uniswap-v2-robinhood";
  const unknown = geckoRow(new Date(NOW).toISOString());
  unknown.attributes.address = WRONG_POOL;
  unknown.relationships.dex.data.id = "mystery-dex";

  const events = await geckoNewPools(1, {
    fetchImpl: async () => jsonResponse({ data: [known, unknown] }),
    now: () => NOW,
    maxAgeMinutes: 30,
  });

  assert.equal(events[0].venue, "uniswap-v2");
  assert.equal(events[1].venue, "mystery-dex");
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/market.test.js`

Expected: 第一项仍为 `uniswap-v2-robinhood`，断言失败。

- [ ] **Step 3: 增加最小白名单规范化**

在 `src/market.js` 增加并使用：

```js
const GECKO_VENUE_ALIASES = new Map([
  ["uniswap-v2-robinhood", "uniswap-v2"],
]);

function normalizeGeckoVenue(value) {
  const venue = String(value || "unknown").toLowerCase();
  return GECKO_VENUE_ALIASES.get(venue) || venue;
}
```

解析池时以规范化结果设置 `event.venue`；V4 bytes32 判断继续使用该规范化结果。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/market.test.js`

Expected: `test/market.test.js` 全部通过。

- [ ] **Step 5: 提交 Task 2**

```bash
git add src/market.js test/market.test.js
git commit -m "规范化 Gecko 的 Robinhood V2 venue"
```

### Task 3: 完整验证并更新现有 PR

**Files:**
- Verify: `src/chain.js`
- Verify: `src/market.js`
- Verify: `test/chain.test.js`
- Verify: `test/market.test.js`

- [ ] **Step 1: 运行完整测试**

Run: `npm test`

Expected: 全部测试通过，0 fail、0 cancelled。

- [ ] **Step 2: 检查补丁与工作树**

Run: `git diff --check origin/main...HEAD`

Expected: 退出码 0，无空白错误。

Run: `git status --short --branch`

Expected: 工作树干净，分支仅领先远端尚未推送的提交。

- [ ] **Step 3: 推送并更新 PR**

Run: `git push origin feat/pons-v2-lifecycle-scanner`

Expected: 推送成功，现有未合并 PR 自动包含本次提交；若原 PR 已合并，则创建只包含未合并提交的后续 PR。

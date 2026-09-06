# Robinhood Scanner Residual Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复复审确认的扫描丢失、交易恢复、状态一致性、只读扫描及四项低优先级缺陷，同时保持实盘 fail-closed。

**Architecture:** 扫描侧移除结果截断，通过显式队列背压控制内存，并为一次性扫描注入完全内存化依赖。交易侧把签名交易作为 durable pending 落入单一 v3 状态快照，从指定 receipt 的 ERC-20 Transfer 日志结算，再用一个原子 store 操作同时提交仓位与流水。

**Tech Stack:** Node.js 18+ ESM、`node:test`、ethers v6、JSON 原子 rename 持久化。

---

## 文件结构与职责

- Modify: `src/chain.js` — 完整日志获取、V4 `poolId` 解析。
- Modify: `src/queue.js` — 暴露队列容量状态，不改变去重语义。
- Modify: `src/index.js` — 背压消费、可注入 drain、真正只读的 `scanOnce`。
- Modify: `src/runtime.js` — 告警成功后再标记 seen。
- Modify: `src/store.js` — v3 单文件状态、旧格式迁移、原子仓位+流水提交。
- Modify: `src/trade.js` — durable pending、receipt Transfer 结算、原子 store 调用、paper 价格校验。
- Modify: `src/config.js` — 正整数和正 ETH 数量启动校验。
- Modify: `src/safety.js` — IPv6 URL 完整脱敏、正 ETH 辅助校验。
- Modify: `src/notify.js` — Telegram 三次有界重试并向上传递最终失败。
- Modify: `README.md`, `.env.example` — 状态格式、只读 scan、配置约束与 pending 恢复说明。
- Modify/Create tests under `test/` — 每项缺陷的回归覆盖。

### Task 1: 链上日志完整性与 V4 唯一身份

**Files:**
- Modify: `test/chain.test.js`
- Modify: `test/runtime.test.js`
- Modify: `src/chain.js`
- Modify: `src/runtime.js`

- [ ] **Step 1: 写入失败测试**

在 `test/chain.test.js` 增加：

```js
import { Interface } from "ethers";
import { V4_PM_ABI } from "../src/abis.js";
import { getLogsChunked, parseV4PoolLog } from "../src/chain.js";

it("does not truncate logs at queue capacity", async () => {
  const provider = {
    getLogs: async ({ fromBlock }) => [
      { blockNumber: fromBlock, transactionHash: `0x${String(fromBlock).padStart(64, "0")}` },
    ],
  };
  const logs = await getLogsChunked({
    address: "0x1111111111111111111111111111111111111111",
    topics: [],
    fromBlock: 1,
    toBlock: 4,
    chunk: 1,
    provider,
  });
  assert.equal(logs.length, 4);
});

it("keeps the V4 pool id separate from address-valued pool", () => {
  const iface = new Interface(V4_PM_ABI);
  const event = iface.getEvent("Initialize");
  const encoded = iface.encodeEventLog(event, [
    `0x${"ab".repeat(32)}`,
    "0x0000000000000000000000000000000000000000",
    "0x1111111111111111111111111111111111111111",
    3000,
    60,
    "0x0000000000000000000000000000000000000000",
    1n,
    0,
  ]);
  const parsed = parseV4PoolLog({ ...encoded, blockNumber: 10, transactionHash: "0x01" });
  assert.equal(parsed.pool, null);
  assert.equal(parsed.poolId, `0x${"ab".repeat(32)}`);
});
```

在 `test/runtime.test.js` 增加同 token、不同 `poolId` 的 key 不相等断言。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/chain.test.js test/runtime.test.js`

Expected: FAIL，因为 `getLogsChunked` 忽略注入 provider 并按 limit 截断，`parseV4PoolLog`/`poolId` 尚不存在。

- [ ] **Step 3: 实现最小修复**

在 `src/chain.js`：

```js
export async function getLogsChunked({ address, topics, fromBlock, toBlock, chunk = 400, provider = getProvider() }) {
  const out = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      out.push(...await withRetry(() => provider.getLogs({ address, topics, fromBlock: start, toBlock: end })));
    } catch (error) {
      if (chunk <= 40 || start === end) throw error;
      const mid = Math.floor((start + end) / 2);
      out.push(
        ...await getLogsChunked({ address, topics, fromBlock: start, toBlock: mid, chunk: Math.floor(chunk / 2), provider }),
        ...await getLogsChunked({ address, topics, fromBlock: mid + 1, toBlock: end, chunk: Math.floor(chunk / 2), provider })
      );
    }
    start = end + 1;
  }
  return out;
}
```

让 `baseEvent` 原样携带可选 `poolId`，新增 `parseV4PoolLog(log)`，其中 `pool:null`、`poolId:String(parsed.args.id)`；`scanOnchain` 使用该函数并把最终返回改为 `attachBlockTimes(events)`。`candidateKey` 的第二段改为 `event.poolId || event.pool || "no-pool"`。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/chain.test.js test/runtime.test.js`

Expected: 所有测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/chain.js src/runtime.js test/chain.test.js test/runtime.test.js
git commit -m "修复：避免链上事件截断并保留V4池标识"
```

### Task 2: 队列背压与真正只读 scan

**Files:**
- Modify: `test/queue.test.js`
- Create: `test/index.test.js`
- Modify: `src/queue.js`
- Modify: `src/index.js`

- [ ] **Step 1: 写入失败测试**

在 `test/queue.test.js` 断言 `q.isFull` 在达到容量时为 true、take 后为 false。

在 `test/index.test.js` 使用以下生产接口测试所有事件都被处理：

```js
import { processEvents, scanOnce } from "../src/index.js";
import { CandidateQueue } from "../src/queue.js";

it("drains a full queue and retries the current event", async () => {
  const queue = new CandidateQueue({ maxSize: 1, hasSeen: () => false });
  const handled = [];
  await processEvents([{ token: "a" }, { token: "b" }, { token: "c" }], queue, async () => {
    while (queue.size) {
      const event = queue.take();
      handled.push(event.token);
      queue.finish(event);
    }
  });
  assert.deepEqual(handled, ["a", "b", "c"]);
});

it("runs one-shot scan without store, Telegram or trading side effects", async () => {
  const calls = { seen: 0, telegram: 0, trade: 0, analyzed: 0 };
  await scanOnce({
    settings: { lookbackBlocks: 1, maxQueueSize: 1, onchainScan: true, geckoScan: false, minScore: 55, maxAgeMinutes: 30 },
    getBlockNumber: async () => 10,
    scanOnchain: async () => [{ token: "0x1", venue: "uniswap-v2", pool: "0xa", source: "test" }],
    geckoNewPools: async () => [],
    analyze: async (event) => ({ ...event, score: 90, verdict: "green", meta: { symbol: "SAFE" }, red: [], honeypot: {} }),
    markSeen: () => { calls.seen += 1; },
    alertReport: async () => { calls.telegram += 1; },
    maybeTrade: async () => { calls.trade += 1; },
    consoleAlert: async () => { calls.analyzed += 1; },
    log: () => {},
  });
  assert.deepEqual(calls, { seen: 0, telegram: 0, trade: 0, analyzed: 1 });
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/queue.test.js test/index.test.js`

Expected: FAIL，因为 `isFull`、`processEvents` 和可注入的 `scanOnce` 尚不存在。

- [ ] **Step 3: 实现最小修复**

给 `CandidateQueue` 增加：

```js
get isFull() {
  return this.items.length >= this.maxSize;
}
```

在 `src/index.js` 把全局 drain 内核改成接收 queue/dependencies 的 `drainQueue`，并新增：

```js
export async function processEvents(events, queue, runDrain) {
  let accepted = 0;
  for (const event of events) {
    if (queue.isFull) await runDrain();
    if (queue.enqueue(event)) accepted += 1;
  }
  await runDrain();
  return accepted;
}
```

watch 对 onchain 和 Gecko 结果调用 `processEvents`，只有 await 完成后更新 `lastBlock`。`scanOnce(supplied = null)` 构造局部 queue（`hasSeen:()=>false`）和控制台-only `alertReport`；显式忽略传入的持久 `markSeen/alertReport/maybeTrade`，调用 `handleCandidate` 时固定 `{allowTrading:false,persistSeen:false}`。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/queue.test.js test/index.test.js`

Expected: 所有测试通过，三条候选顺序完整处理，scan 副作用计数保持为零。

- [ ] **Step 5: 提交**

```bash
git add src/queue.js src/index.js test/queue.test.js test/index.test.js
git commit -m "修复：为候选队列增加背压并隔离只读扫描"
```

### Task 3: v3 原子状态快照

**Files:**
- Modify: `test/store.test.js`
- Modify: `src/store.js`

- [ ] **Step 1: 写入失败测试**

增加四组测试：

```js
it("migrates legacy files into one v3 state without deleting them", () => {
  const dir = tempDir();
  write(dir, "seen.json", JSON.stringify({ a: { updatedAt: 1 } }));
  write(dir, "positions.json", JSON.stringify({}));
  write(dir, "trades.json", JSON.stringify([{ side: "buy" }]));
  createStore({ dataDir: dir, now: () => 2, maxSeenEntries: 10, seenTtlMs: 10 });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.trades.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "trades.json")), true);
});

it("commits an updated position and trade in one snapshot", () => {
  const store = createStore({ dataDir: tempDir(), now: () => 3 });
  store.commitPositionTrade({ token: TOKEN, state: "open" }, { side: "buy", token: TOKEN });
  assert.equal(store.listPositions().length, 1);
  assert.equal(store.listTrades().length, 1);
});

it("removes a closed position and appends its sell in one snapshot", () => {
  const store = createStore({ dataDir: tempDir(), now: () => 3 });
  store.upsertPosition({ token: TOKEN, state: "open" });
  store.commitPositionTrade(null, { side: "sell", token: TOKEN }, { removeToken: TOKEN });
  assert.equal(store.listPositions().length, 0);
  assert.equal(store.listTrades().length, 1);
});
```

第四组通过注入 `writeState` 抛错，断言提交失败后 `listPositions/listTrades` 仍返回提交前状态。同步修改已有 legacy position 用例：旧 `positions.json` 保留原内容，迁移结果改从 `state.json.positions` 断言。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/store.test.js`

Expected: FAIL，因为没有 `state.json`、`listTrades`、`commitPositionTrade` 和 staged write。

- [ ] **Step 3: 实现最小修复**

在 `src/store.js` 定义：

```js
const STATE_VERSION = 3;

function atomicWriteState(dataDir, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "state.json");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
```

`createStore` 优先读取并验证 v3 state；不存在时读取三个 legacy 文件，迁移 position，写入 v3 但保留旧文件。所有 mutation 走：

```js
function commit(mutator) {
  const draft = structuredClone(state);
  const result = mutator(draft);
  writeState(dataDir, draft);
  state = draft;
  return result;
}
```

`commitPositionTrade(position, trade, { removeToken } = {})` 在一个 draft 中更新/删除 position，并追加 `{...trade, at:now()}`。导出默认 store 的 `listTrades` 和 `commitPositionTrade` wrapper。损坏或版本错误明确抛错。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/store.test.js`

Expected: 所有 store 测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/store.js test/store.test.js
git commit -m "修复：统一原子提交仓位和交易流水"
```

### Task 4: receipt 成交解析与 durable pending 买入

**Files:**
- Modify: `test/trade.test.js`
- Modify: `src/trade.js`

- [ ] **Step 1: 写入失败测试**

新增纯函数测试，使用 ethers `Interface` 编码 Transfer 日志：

```js
import { Interface } from "ethers";
import { netTransferAmount, reconcilePendingBuy } from "../src/trade.js";

const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
function transferLog(from, to, value, address = TOKEN) {
  const encoded = transfer.encodeEventLog(transfer.getEvent("Transfer"), [from, to, value]);
  return { address, topics: encoded.topics, data: encoded.data };
}

it("derives only this receipt's token inflow", () => {
  const receipt = { logs: [
    transferLog("0x0000000000000000000000000000000000000000", WALLET, 100n),
    transferLog(WALLET, TOKEN, 5n),
    transferLog("0x0000000000000000000000000000000000000000", WALLET, 999n, POOL),
  ] };
  assert.equal(netTransferAmount(receipt, TOKEN, WALLET), 95n);
});
```

再增加四种 pending buy 测试：receipt 已确认时按日志结算并调用一次 `commitPositionTrade`；节点无 receipt 但能查到 transaction 时保持 pending；节点无 transaction、nonce 未消费时调用 `broadcastTransaction(rawTx)` 重播；缺少 rawTx/nonce 的旧 pending 进入 `needs_review`。现有成功交易 fixture 的 receipt 补上目标 token 的 Transfer 日志，prepare fixture 补上 `rawTx` 和 `nonce`，确保测试走真实的新结算条件。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/trade.test.js`

Expected: FAIL，因为 rawTx/nonce 没有持久化，恢复只查 receipt，成交仍用 balance delta。

- [ ] **Step 3: 实现最小修复**

在 `prepareSignedCall` 返回 `rawTx:signed` 和 `nonce:Number(populated.nonce)`。pending 写入 `rawTx/nonce/preparedAt`。新增：

```js
const transferIface = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);

export function netTransferAmount(receipt, token, wallet) {
  let net = 0n;
  for (const log of receipt?.logs || []) {
    if (!sameAddress(log.address, token)) continue;
    try {
      const parsed = transferIface.parseLog(log);
      if (sameAddress(parsed.args.to, wallet)) net += BigInt(parsed.args.value);
      if (sameAddress(parsed.args.from, wallet)) net -= BigInt(parsed.args.value);
    } catch {
      // 仅忽略目标 token 中不匹配 Transfer ABI 的日志。
    }
  }
  return net;
}
```

新增 `lookupOrRebroadcast(position,deps)`：依次 `getTransactionReceipt`、`getTransaction`、`getTransactionCount(position.wallet,"latest")`；nonce 已消费或字段不全时返回 needs_review transition，nonce 未消费时 `broadcastTransaction(rawTx)` 并保持 pending。确认买入后要求 `netTransferAmount > 0n`，调用 `commitPositionTrade(updated,buyTrade)` 一次完成结算。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/trade.test.js`

Expected: 新增 pending buy 和 receipt 日志测试全部通过，旧安全门测试保持通过。

- [ ] **Step 5: 提交**

```bash
git add src/trade.js test/trade.test.js
git commit -m "修复：持久化签名交易并按回执恢复买入"
```

### Task 5: durable pending 卖出与原子交易提交

**Files:**
- Modify: `test/trade.test.js`
- Modify: `src/trade.js`

- [ ] **Step 1: 写入失败测试**

增加测试覆盖：卖出 pending 持久化 rawTx/nonce；confirmed receipt 的 token 净流出作为 soldAmount；恢复部分卖出调用一次 `commitPositionTrade(updated, trade)`；恢复完全卖出调用一次 `commitPositionTrade(null, trade, {removeToken})`；nonce 被其他交易消费时转 `needs_review`；恢复卖出必须追加 `recovered:true` 的流水。

关键断言改用 `node:assert` 支持的逐字段比较：

```js
assert.equal(commits.length, 1);
assert.equal(commits[0].position, null);
assert.equal(commits[0].trade.side, "sell");
assert.equal(commits[0].trade.amount, "70");
assert.equal(commits[0].trade.recovered, true);
assert.deepEqual(commits[0].options, { removeToken: TOKEN });
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/trade.test.js`

Expected: FAIL，因为恢复卖出不写流水、使用余额差，正常买卖仍分两次写 store。

- [ ] **Step 3: 实现最小修复**

默认依赖改为导入 `commitPositionTrade`。正常买入、正常卖出、恢复买入、恢复卖出、paper 买入和 paper 卖出确认路径统一调用该 API；删除原来的相邻 `upsertPosition/addTrade` 与 `addTrade/removePosition` 组合。卖出使用 `netTransferAmount(receipt, token, wallet)` 的负值，要求 `-net > 0`，再限制到剩余仓位。测试同时断言 paper 开仓与退出也各只触发一次原子提交。

所有 pending 错误转换继续只调用 `upsertPosition(needsReview)`；未确认交易不追加流水。通知仍在原子提交成功之后发送。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/trade.test.js test/store.test.js`

Expected: 所有交易与存储测试通过，恢复卖出流水存在且不会产生两阶段状态窗口。

- [ ] **Step 5: 提交**

```bash
git add src/trade.js test/trade.test.js
git commit -m "修复：原子结算买卖与恢复交易流水"
```

### Task 6: 配置范围与 paper 价格校验

**Files:**
- Create: `test/config.test.js`
- Modify: `test/trade.test.js`
- Modify: `src/safety.js`
- Modify: `src/config.js`
- Modify: `src/trade.js`

- [ ] **Step 1: 写入失败测试**

`test/config.test.js` 通过 `spawnSync(process.execPath,["--input-type=module","-e","import('./src/config.js')"],{env})` 分别设置 `POLL_MS=0`、`POSITION_POLL_MS=-1`、`BUY_AMOUNT_ETH=-1`、`MAX_BUY_ETH=0`，断言退出码非零且 stderr 包含对应变量名；合法配置退出码为零。

在 `trade.test.js` 抽出并测试 `createPaperPosition(report, amountIn, now)`：`priceUsd` 为 0、null、NaN 时抛出 `paper entry price must be positive`，正数时返回 `entryPriceUsd`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/config.test.js test/trade.test.js`

Expected: FAIL，因为这些配置尚未验证，paper position 仍允许零价格。

- [ ] **Step 3: 实现最小修复**

在 `safety.js` 增加 `import { parseEther } from "ethers";` 和：

```js
export function validatePositiveEth(name, value) {
  let parsed;
  try { parsed = parseEther(String(value)); }
  catch (cause) { throw new Error(`${name} must be a positive ETH amount`, { cause }); }
  if (parsed <= 0n) throw new Error(`${name} must be a positive ETH amount`);
  return String(value);
}
```

在 `config.js` 对五个 interval/block/gas 配置使用 `validatePositiveInteger`，对两个买入配置使用 `validatePositiveEth`。`createPaperPosition` 校验 `Number.isFinite(price) && price > 0`；`maybeTrade` 捕获此预期业务条件，打印 `skip paper trade: missing positive entry price` 并返回 null，不写 position/trade。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/config.test.js test/trade.test.js`

Expected: 配置子进程和 paper 价格测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/safety.js src/config.js src/trade.js test/config.test.js test/trade.test.js
git commit -m "修复：校验运行参数和模拟仓位入场价格"
```

### Task 7: URL 脱敏与 Telegram 有界重试

**Files:**
- Modify: `test/safety.test.js`
- Create: `test/notify.test.js`
- Modify: `test/runtime.test.js`
- Modify: `src/safety.js`
- Modify: `src/notify.js`
- Modify: `src/runtime.js`

- [ ] **Step 1: 写入失败测试**

在 `safety.test.js` 加入已复现字符串，断言输出不含 `SECRET`、`TOKEN`、IPv6 主机或路径：

```js
const message = safeErrorMessage(new Error(
  "SERVER_ERROR requestUrl=https://user:pass@[2001:db8::1]:8545/v2/SECRET?q=TOKEN"
));
assert.equal(message, "SERVER_ERROR requestUrl=https://[redacted]:8545");
```

`notify.test.js` 针对导出的 `sendTelegramWith(text,{settings,fetchImpl,sleep})`：前两次返回 503、第三次 200 时调用三次并成功；连续三次 503 时 reject，错误包含最后状态且不包含 bot token。

`runtime.test.js` 增加：alertReport reject 时 `markSeen` 未调用；alert 成功后调用一次 markSeen；quiet skip 仍直接标记。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test test/safety.test.js test/notify.test.js test/runtime.test.js`

Expected: IPv6 用例泄漏尾部，通知没有注入/重试接口，runtime 在告警前写 seen。

- [ ] **Step 3: 实现最小修复**

把 URL 匹配改为允许 IPv6 右括号：

```js
return String(message).replace(/https?:\/\/[^\s"'<>)}]+/gi, (url) => sanitizeRpcUrl(url));
```

`sendTelegramWith` 使用最多三次循环；503/网络错误保留最后错误，等待 `200ms`、`400ms` 后重试，第三次抛出经脱敏且不含请求 URL/token 的错误。`sendTelegram` 调用默认 settings/fetch/sleep。`alertReport` 不再吞掉最终异常。

`handleCandidate` 先计算 shouldAlert；需要告警时 await 成功后再 markSeen，不告警则直接 markSeen。交易仍在 seen 提交之后执行，现有活动仓位检查继续防止重复交易。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `node --test test/safety.test.js test/notify.test.js test/runtime.test.js`

Expected: 脱敏、三次重试及 seen 顺序测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/safety.js src/notify.js src/runtime.js test/safety.test.js test/notify.test.js test/runtime.test.js
git commit -m "修复：完整脱敏RPC地址并重试告警"
```

### Task 8: 文档、全量验证与目标目录同步

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Verify: all changed files

- [ ] **Step 1: 更新文档**

README 明确：`scan` 不读写本地状态且不发 Telegram；运行状态统一存储在 `data/state.json`；旧三个 JSON 首次非只读运行自动迁移且保留；pending 会重播完全相同的签名交易，nonce 冲突转人工复核；实盘安全门仍关闭。`.env.example` 注明 poll/block/gas 必须为正整数，买入额必须为正 ETH 十进制数。

- [ ] **Step 2: 运行完整测试**

Run: `npm test`

Expected: 全部 suite/test 通过，exit code 0，无未处理 rejection。

- [ ] **Step 3: 运行静态差异检查**

Run: `git diff --check 75775a9..HEAD`

Expected: 无输出，exit code 0。

- [ ] **Step 4: 运行定向验收**

Run: `node --test test/chain.test.js test/index.test.js test/store.test.js test/trade.test.js test/config.test.js test/safety.test.js test/notify.test.js test/runtime.test.js`

Expected: 所有新增回归测试通过。

Run: `npm run scan`（仅在 RPC 可用时）

Expected: 打印候选报告；运行前后均不存在新建的 `data/`，且不调用 Telegram。若网络不可用，记录为环境限制，不把它表述为功能通过。

- [ ] **Step 5: 复查范围**

Run: `git status --short` and `git diff --stat 75775a9..HEAD`

Expected: 只有本计划列出的源码、测试和文档；无依赖升级、无无关格式化。

- [ ] **Step 6: 提交文档**

```bash
git add README.md .env.example
git commit -m "文档：说明原子状态和只读扫描行为"
```

- [ ] **Step 7: 同步到用户目标目录并复验**

从隔离分支列出 `75775a9..HEAD` 的变更文件，只把这些文件同步到 `D:\code-web3\07-web3-bot\DEX\robinhood-scanner-bot`；同步前逐个比较目标文件，若发现目标在本轮期间有新的用户修改则停止并报告冲突。同步后在目标目录重新运行 `npm test` 和四组定向验收，不复制 `.git`、`node_modules` 或测试产生的 `data/`。

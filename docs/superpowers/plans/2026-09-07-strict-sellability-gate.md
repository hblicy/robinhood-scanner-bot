# Strict Sellability Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通候选只有在取得三名不同钱包的非粉尘真实卖出证据、账本余额一致且多档转账未发现限制时才可推送，并把隐藏余额或额度限卖强制归为红色风险。

**Architecture:** 新建独立的 `sellability` 模块，把纯判定与有边界的链上证据采集集中在一处；`honeypotCheck` 继续负责现有 V2 报价和字节码检查，再将卖出安全结论映射到现有 `honeypot/complete` 字段。运行时以 `sellability.status` 作为普通候选 Telegram 的第一道门，生命周期通知仍走原有独立路径。

**Tech Stack:** Node.js 18+、ES modules、ethers v6、Node 内置 `node:test`、BigInt、现有 Robinhood Chain JSON-RPC。

---

## File map

- Create `src/sellability.js`: Transfer 日志解析、账本一致性、多档只读转账、真实卖出收据判定与最终状态聚合。
- Create `test/sellability.test.js`: SNOWBALL 固定样本、1% 边界、额度阶梯、有效卖出、RPC 失败和不支持 venue 的单元测试。
- Modify `src/abis.js`: 为现有 ERC-20 ABI 增加 `Transfer` 事件，供日志及 receipt 统一解码。
- Modify `src/analyze.js`: 调用卖出安全检查、传递创建区块/时间/decimals，并保持现有报告字段兼容。
- Modify `test/honeypot.test.js`: 验证 `blocked/confirmed/unknown` 到 `honeypot/complete` 的映射。
- Modify `test/analyze.test.js`: 验证分析上下文和报告中的卖出安全字段。
- Modify `src/runtime.js`: 普通候选只允许 `blocked` 风险报告或 `confirmed` 达标报告发送 Telegram。
- Modify `test/runtime.test.js`: 覆盖 unknown 100 分静默、blocked 推送、confirmed 阈值行为。
- Modify `src/notify.js`: 报告明确显示卖出安全状态、原因和样本数。
- Modify `test/format.test.js`: 防止 unknown 文案误称“通过”，验证 blocked/confirmed 文案。
- Modify `test/push-only.test.js`: 确认新增检查仍不包含钱包、签名、授权、交换和广播能力。

### Task 1: Build the pure sellability decision core

**Files:**
- Create: `src/sellability.js`
- Create: `test/sellability.test.js`

- [ ] **Step 1: Write failing tests for ledger mismatch and BigInt boundaries**

Create `test/sellability.test.js` with the fixed incident values and exact threshold tests:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLedgerBalance,
  evaluateTransferLadder,
  finalizeSellability,
} from "../src/sellability.js";

describe("sellability pure decisions", () => {
  it("blocks the SNOWBALL hidden balance mutation sample", () => {
    assert.deepEqual(
      evaluateLedgerBalance({
        ledgerBalance: 328585691549515n,
        reportedBalance: 50n,
        oneToken: 1_000_000_000n,
      }),
      { blocked: true, reason: "hidden-balance-mutation" }
    );
  });

  it("does not block at exactly 1 percent but blocks above it without Number conversion", () => {
    const ledgerBalance = 10n ** 30n;
    assert.equal(evaluateLedgerBalance({
      ledgerBalance,
      reportedBalance: ledgerBalance * 99n / 100n,
      oneToken: 1n,
    }).blocked, false);
    assert.equal(evaluateLedgerBalance({
      ledgerBalance,
      reportedBalance: ledgerBalance * 9899n / 10000n,
      oneToken: 1n,
    }).blocked, true);
  });

  it("ignores sub-token ledger dust", () => {
    assert.deepEqual(
      evaluateLedgerBalance({ ledgerBalance: 999n, reportedBalance: 0n, oneToken: 1000n }),
      { blocked: false, reason: null }
    );
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test test/sellability.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/sellability.js`.

- [ ] **Step 3: Implement the ledger evaluator and stable result shape**

Create `src/sellability.js` with these exports and integer-only comparison:

```js
export const SELLABILITY = Object.freeze({
  CONFIRMED: "confirmed",
  UNKNOWN: "unknown",
  BLOCKED: "blocked",
});

export function sellabilityResult(status, reason, evidence = {}) {
  return {
    status,
    reason,
    buyerSamples: evidence.buyerSamples || 0,
    ladderSamples: evidence.ladderSamples || 0,
    meaningfulSellers: evidence.meaningfulSellers || 0,
    details: evidence.details || [],
  };
}

export function evaluateLedgerBalance({ ledgerBalance, reportedBalance, oneToken }) {
  if (ledgerBalance < oneToken || reportedBalance >= ledgerBalance) {
    return { blocked: false, reason: null };
  }
  const missing = ledgerBalance - reportedBalance;
  return missing * 100n > ledgerBalance
    ? { blocked: true, reason: "hidden-balance-mutation" }
    : { blocked: false, reason: null };
}
```

- [ ] **Step 4: Add failing ladder and aggregation tests**

Append to the same `describe` block:

```js
it("blocks false/revert transfer results and identifies size limits", () => {
  assert.deepEqual(
    evaluateTransferLadder([
      { percent: 1, ok: true },
      { percent: 10, ok: true },
      { percent: 50, ok: false },
      { percent: 100, ok: false },
    ]),
    { blocked: true, reason: "sell-size-limited" }
  );
  assert.deepEqual(
    evaluateTransferLadder([{ percent: 1, ok: false }]),
    { blocked: true, reason: "sell-transfer-blocked" }
  );
  assert.deepEqual(
    evaluateTransferLadder([{ percent: 1, ok: null }]),
    { blocked: false, reason: "evidence-unavailable" }
  );
});

it("requires three distinct meaningful sellers for confirmation", () => {
  assert.equal(finalizeSellability({ buyerSamples: 3, ladderSamples: 3, sellers: new Set(["a", "b"]) }).status, "unknown");
  assert.equal(finalizeSellability({ buyerSamples: 3, ladderSamples: 0, sellers: new Set(["a", "b", "c"]) }).status, "unknown");
  assert.deepEqual(
    finalizeSellability({ buyerSamples: 3, ladderSamples: 3, sellers: new Set(["a", "b", "c"]) }),
    {
      status: "confirmed",
      reason: null,
      buyerSamples: 3,
      ladderSamples: 3,
      meaningfulSellers: 3,
      details: [],
    }
  );
});
```

- [ ] **Step 5: Run the focused test and verify the new exports fail**

Run: `node --test test/sellability.test.js`

Expected: FAIL because `evaluateTransferLadder` and `finalizeSellability` are not exported.

- [ ] **Step 6: Implement the ladder and confirmation rules**

Append to `src/sellability.js`:

```js
export function evaluateTransferLadder(results) {
  const failed = results.find((item) => item.ok === false);
  if (failed) {
    const smallerPassed = results.some((item) => item.percent < failed.percent && item.ok === true);
    return {
      blocked: true,
      reason: smallerPassed ? "sell-size-limited" : "sell-transfer-blocked",
    };
  }
  if (results.some((item) => item.ok === null)) {
    return { blocked: false, reason: "evidence-unavailable" };
  }
  return { blocked: false, reason: null };
}

export function finalizeSellability({ buyerSamples, ladderSamples, sellers, details = [] }) {
  const meaningfulSellers = sellers.size;
  if (buyerSamples === 0 || ladderSamples === 0) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "evidence-unavailable", {
      buyerSamples,
      ladderSamples,
      meaningfulSellers,
      details,
    });
  }
  if (meaningfulSellers < 3) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "insufficient-meaningful-sells", {
      buyerSamples,
      ladderSamples,
      meaningfulSellers,
      details,
    });
  }
  return sellabilityResult(SELLABILITY.CONFIRMED, null, {
    buyerSamples,
    ladderSamples,
    meaningfulSellers,
    details,
  });
}
```

- [ ] **Step 7: Run the focused test and commit the pure core**

Run: `node --test test/sellability.test.js`

Expected: PASS.

```bash
git add src/sellability.js test/sellability.test.js
git commit -m "实现卖出安全纯判定"
```

### Task 2: Collect bounded on-chain evidence

**Files:**
- Modify: `src/abis.js`
- Modify: `src/sellability.js`
- Modify: `test/sellability.test.js`

- [ ] **Step 1: Write failing tests for venue support, creation block lookup and ERC-20 bool decoding**

Extend imports and tests:

```js
import {
  decodeTransferCall,
  resolveStartBlock,
  inspectSellability,
} from "../src/sellability.js";

it("treats V3, V4 and missing V2 pool addresses as unsupported", async () => {
  for (const input of [
    { venue: "uniswap-v3", pool: "0x3333333333333333333333333333333333333333" },
    { venue: "uniswap-v4", pool: null },
    { venue: "uniswap-v2", pool: null },
  ]) {
    const result = await inspectSellability({
      ...input,
      token: "0x1111111111111111111111111111111111111111",
      quote: "0x2222222222222222222222222222222222222222",
      decimals: 18,
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "unsupported-venue");
  }
});

it("prefers an event block and otherwise resolves DexScreener creation time", async () => {
  assert.equal(await resolveStartBlock({ blockNumber: 123, pairCreatedAt: 1 }, 999, async () => 456), 123);
  assert.equal(await resolveStartBlock({ blockNumber: null, pairCreatedAt: 1_000 }, 999, async (time, head) => {
    assert.equal(time, 1_000);
    assert.equal(head, 999);
    return 456;
  }), 456);
  assert.equal(await resolveStartBlock({ blockNumber: null, pairCreatedAt: null }, 999, async () => 456), null);
});

it("decodes standard true/false and leaves empty return data unknown", () => {
  assert.equal(decodeTransferCall(`0x${"0".repeat(63)}1`), true);
  assert.equal(decodeTransferCall(`0x${"0".repeat(64)}`), false);
  assert.equal(decodeTransferCall("0x"), null);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/sellability.test.js`

Expected: FAIL for the three missing exports.

- [ ] **Step 3: Add the Transfer event and evidence collector scaffolding**

Add to `ERC20_ABI` in `src/abis.js`:

```js
"event Transfer(address indexed from,address indexed to,uint256 value)",
```

At the top of `src/sellability.js`, add imports and constants:

```js
import { Interface, getAddress, ZeroAddress } from "ethers";
import { ERC20_ABI } from "./abis.js";
import { ADDR } from "./config.js";
import { findFirstBlockAtOrAfter, getLogsChunked, getProvider, isContractCallRevert, withRetry } from "./chain.js";
import { safeErrorMessage } from "./safety.js";

const erc20Iface = new Interface(ERC20_ABI);
const transferTopic = erc20Iface.getEvent("Transfer").topicHash;
const LADDER = [1, 10, 50, 100];
const MAX_BUYERS = 5;
const MAX_LADDER_WALLETS = 3;
const MAX_RECEIPTS = 30;

export function decodeTransferCall(data) {
  if (!data || data === "0x") return null;
  return erc20Iface.decodeFunctionResult("transfer", data)[0] === true;
}

export async function resolveStartBlock(context, head, findBlock = findFirstBlockAtOrAfter) {
  if (Number.isInteger(context.blockNumber)) return context.blockNumber;
  if (!Number.isFinite(context.pairCreatedAt)) return null;
  return findBlock(context.pairCreatedAt, head);
}
```

Implement the early support and error boundary in `inspectSellability`:

```js
export async function inspectSellability(context, dependencies = {}) {
  if (context.venue !== "uniswap-v2" || !context.pool) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "unsupported-venue");
  }
  const provider = dependencies.provider || getProvider();
  const getLogs = dependencies.getLogs || getLogsChunked;
  const findBlock = dependencies.findBlock || findFirstBlockAtOrAfter;
  const retry = dependencies.retry || ((fn) => withRetry(fn));
  try {
    return await collectV2Evidence(context, { provider, getLogs, findBlock, retry });
  } catch (error) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "evidence-unavailable", {
      details: [safeErrorMessage(error)],
    });
  }
}
```

- [ ] **Step 4: Run focused tests and verify the support/decoder tests pass**

Run: `node --test test/sellability.test.js`

Expected: PASS for unsupported venues, start-block resolution and bool decoding; existing pure tests remain PASS.

- [ ] **Step 5: Write failing synthetic-log tests for hidden balance and meaningful sells**

Use ethers `Interface.encodeEventLog` to build logs and mocked receipts. Add these imports, constants and deterministic helpers before the cases:

```js
import { Interface } from "ethers";
import { ERC20_ABI } from "../src/abis.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const QUOTE = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const BUYER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BUYER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BUYER_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const ROUTER = "0x4444444444444444444444444444444444444444";
const testIface = new Interface(ERC20_ABI);
let nextLogIndex = 0;

function v2Context(overrides = {}) {
  return {
    venue: "uniswap-v2",
    token: TOKEN,
    quote: QUOTE,
    pool: POOL,
    decimals: 9,
    blockNumber: 100,
    pairCreatedAt: 1_000,
    ...overrides,
  };
}

function transfer(from, to, value, transactionHash, address = TOKEN) {
  const encoded = testIface.encodeEventLog(testIface.getEvent("Transfer"), [from, to, value]);
  return {
    address,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 101 + nextLogIndex,
    index: nextLogIndex++,
    transactionHash,
  };
}

function ledgerBalance(address, transfers) {
  const target = address.toLowerCase();
  return transfers.reduce((sum, log) => {
    if (log.address.toLowerCase() !== TOKEN.toLowerCase()) return sum;
    const parsed = testIface.parseLog(log);
    if (parsed.args.to.toLowerCase() === target) sum += parsed.args.value;
    if (parsed.args.from.toLowerCase() === target) sum -= parsed.args.value;
    return sum;
  }, 0n);
}

function fakeChain({
  transfers,
  balances = new Map(),
  quoteOut = new Set(),
  receiptStatus = {},
  transferResult = true,
  fail = null,
}) {
  const explicitBalances = new Map(
    [...balances].map(([address, value]) => [address.toLowerCase(), value])
  );
  const provider = {
    getBlockNumber: async () => 200,
    getCode: async (address) => {
      if (fail === "code") throw new Error("rpc unavailable");
      return [BUYER_A, BUYER_B, BUYER_C].includes(address.toLowerCase()) ? "0x" : "0x6000";
    },
    call: async (tx) => {
      const parsed = testIface.parseTransaction({ data: tx.data });
      if (parsed.name === "balanceOf") {
        if (fail === "balance") throw new Error("rpc unavailable");
        const address = parsed.args[0];
        const balanceKey = address.toLowerCase();
        const value = explicitBalances.has(balanceKey)
          ? explicitBalances.get(balanceKey)
          : address.toLowerCase() === POOL.toLowerCase()
            ? 1_000_000_000_000n
            : ledgerBalance(address, transfers);
        return testIface.encodeFunctionResult("balanceOf", [value < 0n ? 0n : value]);
      }
      return transferResult === null
        ? "0x"
        : testIface.encodeFunctionResult("transfer", [transferResult]);
    },
    getTransactionReceipt: async (hash) => {
      if (fail === "receipt") throw new Error("rpc unavailable");
      return {
        status: receiptStatus[hash] ?? 1,
        logs: quoteOut.has(hash) ? [transfer(POOL, ROUTER, 1n, hash, QUOTE)] : [],
      };
    },
  };
  return {
    provider,
    getLogs: async () => {
      if (fail === "logs") throw new Error("rpc unavailable");
      return transfers;
    },
    findBlock: async () => 100,
    retry: async (fn) => fn(),
  };
}
```

Then add these cases:

```js
it("blocks when a sampled buyer ledger is more than 1 percent above balanceOf", async () => {
  const result = await inspectSellability(v2Context(), fakeChain({
    transfers: [transfer(POOL, BUYER_A, 328585691549515n, "0xbuy")],
    balances: new Map([[BUYER_A, 50n], [POOL, 1_000_000_000_000n]]),
  }));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "hidden-balance-mutation");
  assert.equal(result.buyerSamples, 1);
});

it("rejects dust, failed receipts, missing quote out and duplicate sellers", async () => {
  const result = await inspectSellability(v2Context(), fakeChain({
    transfers: [
      transfer(BUYER_A, POOL, 1n, "0xdust"),
      transfer(BUYER_A, POOL, 2_000_000_000n, "0xfailed"),
      transfer(BUYER_A, POOL, 2_000_000_000n, "0xnoquote"),
      transfer(BUYER_A, POOL, 2_000_000_000n, "0xvalid1"),
      transfer(BUYER_A, POOL, 2_000_000_000n, "0xvalid2"),
    ],
    receiptStatus: { "0xfailed": 0 },
    quoteOut: new Set(["0xvalid1", "0xvalid2"]),
  }));
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "insufficient-meaningful-sells");
  assert.equal(result.meaningfulSellers, 1);
});

it("confirms only three distinct non-dust successful sellers with quote out", async () => {
  const result = await inspectSellability(v2Context(), fakeChain({
    transfers: [BUYER_A, BUYER_B, BUYER_C].flatMap((buyer, index) => [
      transfer(POOL, buyer, 10_000_000_000n, `0xbuy${index}`),
      transfer(buyer, POOL, 2_000_000_000n, `0xsell${index}`),
    ]),
    quoteOut: new Set(["0xsell0", "0xsell1", "0xsell2"]),
  }));
  assert.equal(result.status, "confirmed");
  assert.equal(result.meaningfulSellers, 3);
});
```

- [ ] **Step 6: Run the synthetic-log tests and verify RED**

Run: `node --test test/sellability.test.js`

Expected: FAIL because `collectV2Evidence` is not implemented.

- [ ] **Step 7: Implement bounded log parsing, buyer selection, ledger checks and ladder calls**

Implement these internal helpers in `src/sellability.js`:

```js
function normalizeTransfer(log) {
  const parsed = erc20Iface.parseLog(log);
  return {
    from: getAddress(parsed.args.from),
    to: getAddress(parsed.args.to),
    value: parsed.args.value,
    transactionHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
    index: Number(log.index ?? log.logIndex ?? 0),
  };
}

function protocolAddresses(pool) {
  return new Set([
    pool, ADDR.V2_ROUTER, ADDR.V3_ROUTER, ADDR.V4_POOL_MANAGER,
    ADDR.DEAD, ADDR.ZERO, ZeroAddress,
  ].filter(Boolean).map((address) => address.toLowerCase()));
}

function ledgerFor(address, transfers) {
  const target = address.toLowerCase();
  return transfers.reduce((balance, item) => {
    if (item.to.toLowerCase() === target) balance += item.value;
    if (item.from.toLowerCase() === target) balance -= item.value;
    return balance;
  }, 0n);
}

async function isEoa(provider, address, retry) {
  return (await retry(() => provider.getCode(address))) === "0x";
}

async function callBalance(provider, token, address, blockTag, retry) {
  const data = erc20Iface.encodeFunctionData("balanceOf", [address]);
  const raw = await retry(() => provider.call({ to: token, data, blockTag }));
  return erc20Iface.decodeFunctionResult("balanceOf", raw)[0];
}

async function runLadder(provider, token, pool, wallet, balance, blockTag, retry) {
  const results = [];
  for (const percent of LADDER) {
    const amount = balance * BigInt(percent) / 100n || 1n;
    const data = erc20Iface.encodeFunctionData("transfer", [pool, amount]);
    try {
      const raw = await retry(() => provider.call({ from: wallet, to: token, data, blockTag }));
      results.push({ percent, ok: decodeTransferCall(raw) });
    } catch (error) {
      if (!isContractCallRevert(error)) throw error;
      results.push({ percent, ok: false });
    }
  }
  return results;
}
```

Add buyer sampling and the first half of `collectV2Evidence`:

```js
async function selectRecentBuyers(transfers, pool, excluded, provider, retry) {
  const buyers = [];
  const seen = new Set();
  for (const item of [...transfers].reverse()) {
    if (buyers.length >= MAX_BUYERS) break;
    const address = item.to.toLowerCase();
    if (item.from.toLowerCase() !== pool.toLowerCase()) continue;
    if (excluded.has(address) || seen.has(address)) continue;
    seen.add(address);
    if (await isEoa(provider, item.to, retry)) buyers.push(item.to);
  }
  return buyers;
}

async function collectV2Evidence(context, { provider, getLogs, findBlock, retry }) {
  const head = await retry(() => provider.getBlockNumber());
  const fromBlock = await resolveStartBlock(context, head, findBlock);
  if (fromBlock === null) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "evidence-unavailable", {
      details: ["pool creation block unavailable"],
    });
  }

  const logs = await getLogs({
    address: context.token,
    topics: [transferTopic],
    fromBlock,
    toBlock: head,
    provider,
    retry,
  });
  const transfers = logs.map(normalizeTransfer).sort(
    (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
  );
  const excluded = protocolAddresses(context.pool);
  const buyers = await selectRecentBuyers(transfers, context.pool, excluded, provider, retry);
  const oneToken = 10n ** BigInt(context.decimals);
  const balances = new Map();

  for (const buyer of buyers) {
    const ledgerBalance = ledgerFor(buyer, transfers);
    const reportedBalance = await callBalance(provider, context.token, buyer, head, retry);
    balances.set(buyer.toLowerCase(), reportedBalance);
    const ledgerCheck = evaluateLedgerBalance({ ledgerBalance, reportedBalance, oneToken });
    if (ledgerCheck.blocked) {
      return sellabilityResult(SELLABILITY.BLOCKED, ledgerCheck.reason, {
        buyerSamples: buyers.length,
        details: [
          `wallet=${buyer}`,
          `ledger=${ledgerBalance}`,
          `reported=${reportedBalance}`,
        ],
      });
    }
  }

  let ladderSamples = 0;
  for (const buyer of buyers) {
    if (ladderSamples >= MAX_LADDER_WALLETS) break;
    const balance = balances.get(buyer.toLowerCase()) || 0n;
    if (balance < oneToken) continue;
    ladderSamples += 1;
    const ladder = evaluateTransferLadder(
      await runLadder(provider, context.token, context.pool, buyer, balance, head, retry)
    );
    if (ladder.blocked) {
      return sellabilityResult(SELLABILITY.BLOCKED, ladder.reason, {
        buyerSamples: buyers.length,
        ladderSamples,
        details: [`wallet=${buyer}`],
      });
    }
    if (ladder.reason === "evidence-unavailable") {
      return sellabilityResult(SELLABILITY.UNKNOWN, ladder.reason, {
        buyerSamples: buyers.length,
        ladderSamples,
        details: [`wallet=${buyer}`, "transfer returned no standard bool"],
      });
    }
  }
```

- [ ] **Step 8: Implement bounded meaningful-sell receipt validation**

Add the receipt parser:

```js
function receiptHasQuoteOut(receipt, quote, pool) {
  const quoteLower = quote.toLowerCase();
  const poolLower = pool.toLowerCase();
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== quoteLower || log.topics?.[0] !== transferTopic) continue;
    try {
      const parsed = erc20Iface.parseLog(log);
      if (parsed.args.from.toLowerCase() === poolLower && parsed.args.value > 0n) return true;
    } catch {
      // A malformed unrelated receipt log is not sell evidence.
    }
  }
  return false;
}
```

Continue `collectV2Evidence` with the exact threshold and receipt rules, then close the function:

```js
const poolBalance = await callBalance(provider, context.token, context.pool, head, retry);
const minimumSell = poolBalance / 10_000n > oneToken ? poolBalance / 10_000n : oneToken;
const rawQuote = String(context.quote || "").toLowerCase();
const nativeQuotes = new Set([ADDR.NATIVE, ADDR.ZERO, ZeroAddress].filter(Boolean).map((value) => value.toLowerCase()));
const quoteAddress = nativeQuotes.has(rawQuote) ? ADDR.WETH : getAddress(context.quote);
const sellers = new Set();
const seenHashes = new Set();
let receiptCount = 0;

for (const item of [...transfers].reverse()) {
  if (sellers.size >= 3 || receiptCount >= MAX_RECEIPTS) break;
  if (item.to.toLowerCase() !== context.pool.toLowerCase() || item.value < minimumSell) continue;
  if (excluded.has(item.from.toLowerCase()) || !(await isEoa(provider, item.from, retry))) continue;
  if (seenHashes.has(item.transactionHash)) continue;
  seenHashes.add(item.transactionHash);
  receiptCount += 1;
  const receipt = await retry(() => provider.getTransactionReceipt(item.transactionHash));
  if (!receipt || Number(receipt.status) !== 1) continue;
  if (!receiptHasQuoteOut(receipt, quoteAddress, context.pool)) continue;
  sellers.add(item.from.toLowerCase());
}
return finalizeSellability({
  buyerSamples: buyers.length,
  ladderSamples,
  sellers,
  details: [`receipts=${receiptCount}`],
});
}
```

The WETH `pool → router` leg immediately before unwrap is accepted because it is a nonzero quote-token transfer from the pool. A successful receipt without this transfer remains insufficient.

- [ ] **Step 9: Add and pass explicit error-boundary tests**

Add an exact error case for each RPC stage:

```js
for (const failure of ["logs", "code", "balance", "receipt"]) {
  it(`returns evidence-unavailable when ${failure} RPC fails`, async () => {
    const transfers = [
      transfer(POOL, BUYER_A, 10_000_000_000n, "0xbuy-a"),
      transfer(BUYER_A, POOL, 2_000_000_000n, "0xsell-a"),
    ];
    const result = await inspectSellability(v2Context(), fakeChain({
      transfers,
      quoteOut: new Set(["0xsell-a"]),
      fail: failure,
    }));
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "evidence-unavailable");
    assert.match(result.details.join(" "), /rpc unavailable/);
  });
}
```

Run: `node --test test/sellability.test.js`

Expected: all sellability tests PASS.

- [ ] **Step 10: Commit the evidence collector**

```bash
git add src/abis.js src/sellability.js test/sellability.test.js
git commit -m "采集严格卖出安全证据"
```

### Task 3: Integrate sellability into analysis and honeypot mapping

**Files:**
- Modify: `src/analyze.js`
- Modify: `test/honeypot.test.js`
- Modify: `test/analyze.test.js`

- [ ] **Step 1: Write failing honeypot mapping tests**

In `test/honeypot.test.js`, inject `inspectSellability` and cover all three states:

```js
for (const [sellability, expected] of [
  [{ status: "blocked", reason: "hidden-balance-mutation" }, { honeypot: true, complete: true }],
  [{ status: "confirmed", reason: null }, { honeypot: false, complete: true }],
  [{ status: "unknown", reason: "insufficient-meaningful-sells" }, { honeypot: null, complete: false }],
]) {
  const result = await honeypotCheck({
    ...input,
    blockNumber: 123,
    pairCreatedAt: 1_000,
    decimals: 18,
  }, {
    bytecodeFlags: async () => ({ hasCode: true }),
    quoteRoundTrip: async () => ({ buyOk: true, sellOk: true }),
    inspectSellability: async () => sellability,
  });
  assert.equal(result.honeypot, expected.honeypot);
  assert.equal(result.complete, expected.complete);
  assert.equal(result.sellability.status, sellability.status);
  assert.equal(result.sellability.reason, sellability.reason);
}
```

Add the unsupported-venue mapping test:

```js
for (const venue of ["uniswap-v3", "uniswap-v4"]) {
  const result = await honeypotCheck({ ...input, venue }, {
    bytecodeFlags: async () => ({ hasCode: true }),
    quoteRoundTrip: async () => ({ buyOk: true, sellOk: true }),
    inspectSellability: async () => ({ status: "unknown", reason: "unsupported-venue" }),
  });
  assert.equal(result.honeypot, null);
  assert.equal(result.complete, false);
  assert.equal(result.sellability.reason, "unsupported-venue");
}
```

- [ ] **Step 2: Run honeypot tests and verify RED**

Run: `node --test test/honeypot.test.js`

Expected: FAIL because `honeypotCheck` does not call or expose `inspectSellability`.

- [ ] **Step 3: Replace the old holder-transfer pass signal with sellability mapping**

In `src/analyze.js`, import `inspectSellability`, `sellabilityResult`, and `SELLABILITY`, then include the inspector in `honeypotCheck` dependencies. Initialize every result with an explicit unknown state:

```js
sellability: sellabilityResult(SELLABILITY.UNKNOWN, "evidence-unavailable"),
```

For each existing early hard failure, set both legacy fields and the gate state before returning:

```js
function blockResult(result, reason, sellabilityReason) {
  result.honeypot = true;
  result.complete = true;
  result.sellOk = false;
  result.reason = reason;
  result.sellability = sellabilityResult(SELLABILITY.BLOCKED, sellabilityReason, {
    details: [reason],
  });
  return result;
}
```

Use `no-contract-code` for missing bytecode, `buy-quote-unavailable` for a failed buy quote, and `sell-quote-zero` for a zero/reverted sell quote. These two additional reason codes preserve existing red-risk behavior while the approved minimum reason-code set remains present. Remove the old “pick one Blockscout holder and direct-transfer 1%” branch as a safety signal. After bytecode and V2 quote hard failures, call:

```js
const sellability = await inspectSafety({
  token,
  quote: quoteAddr,
  venue,
  pool,
  blockNumber,
  pairCreatedAt,
  decimals,
});
result.sellability = sellability;
result.complete = sellability.status !== "unknown";
result.honeypot = sellability.status === "blocked"
  ? true
  : sellability.status === "confirmed"
    ? false
    : null;
result.sellOk = sellability.status === "confirmed"
  ? true
  : sellability.status === "blocked"
    ? false
    : null;
result.reason = sellability.reason || result.reason;
return result;
```

Keep `sell-quote-zero` as a blocked result when `getAmountsOut` returns zero or reverts on the sell path. Do not treat a successful quote as confirmation.

- [ ] **Step 4: Run honeypot tests and verify GREEN**

Run: `node --test test/honeypot.test.js`

Expected: all honeypot tests PASS after updating obsolete expectations that previously considered one direct holder transfer sufficient.

- [ ] **Step 5: Write failing analyze-context tests**

In `test/analyze.test.js`, make the mock `honeypotCheck` capture its input and assert:

```js
assert.deepEqual(captured, {
  token: TOKEN,
  quote: QUOTE,
  venue: "uniswap-v2",
  pool: POOL,
  holders: [],
  blockNumber: 123,
  pairCreatedAt: event.createdAt,
  decimals: 18,
});
assert.equal(report.sellability.status, "confirmed");
assert.equal(report.facts.sellabilityStatus, "confirmed");
```

Use an event fixture with `blockNumber: 123`, and return a honeypot result containing:

```js
sellability: {
  status: "confirmed",
  reason: null,
  buyerSamples: 5,
  ladderSamples: 3,
  meaningfulSellers: 3,
  details: [],
}
```

- [ ] **Step 6: Run analyze tests and verify RED**

Run: `node --test test/analyze.test.js`

Expected: FAIL because the new context and report fields are absent.

- [ ] **Step 7: Pass complete context and expose the status in reports**

Change the `honeypotCheck` call in `analyze` to pass `event.blockNumber`, `dex?.pairCreatedAt`, and `meta.decimals`. Add:

```js
const sellability = hp.sellability || {
  status: "unknown",
  reason: hp.reason || "evidence-unavailable",
  buyerSamples: 0,
  ladderSamples: 0,
  meaningfulSellers: 0,
  details: [],
};
```

Expose `sellability` on the top-level report and add these fact fields:

```js
sellabilityStatus: sellability.status,
sellabilityReason: sellability.reason,
sellabilityBuyerSamples: sellability.buyerSamples,
sellabilityLadderSamples: sellability.ladderSamples,
sellabilityMeaningfulSellers: sellability.meaningfulSellers,
```

Keep `securityComplete` dependent on `hp.complete === true && hp.honeypot === false`, so only `confirmed` can reach green.

- [ ] **Step 8: Run focused analysis tests and commit**

Run: `node --test test/honeypot.test.js test/analyze.test.js test/score.test.js`

Expected: PASS.

```bash
git add src/analyze.js test/honeypot.test.js test/analyze.test.js
git commit -m "接入卖出安全分析结论"
```

### Task 4: Enforce the Telegram gate for ordinary candidates

**Files:**
- Modify: `src/runtime.js`
- Modify: `test/runtime.test.js`

- [ ] **Step 1: Write failing runtime policy tests**

Add this report factory and runner to `test/runtime.test.js`:

```js
function report(overrides = {}) {
  return {
    verdict: "skip",
    score: 0,
    venue: "uniswap-v2",
    pool: "0xA",
    token: "0x1",
    meta: { symbol: "SAFE" },
    honeypot: { honeypot: null },
    sellability: { status: "unknown", reason: "insufficient-meaningful-sells" },
    ...overrides,
  };
}

async function runCandidate(result, alertReport) {
  return handleCandidate(
    { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
    { persistSeen: false },
    {
      now: () => 1,
      maxAgeMinutes: 30,
      minScore: 55,
      analyze: async () => result,
      markSeen: () => {},
      alertReport: async () => alertReport(),
      log: () => {},
    }
  );
}
```

Then add these assertions:

```js
it("keeps an unknown ordinary candidate silent even at 100 points", async () => {
  let alerts = 0;
  await runCandidate(report({ score: 100, verdict: "green", sellability: { status: "unknown" } }), () => { alerts += 1; });
  assert.equal(alerts, 0);
});

it("immediately alerts a blocked ordinary candidate as a risk", async () => {
  let alerts = 0;
  await runCandidate(report({ score: 0, verdict: "skip", sellability: { status: "blocked" } }), () => { alerts += 1; });
  assert.equal(alerts, 1);
});

it("alerts a confirmed candidate only when existing score/verdict rules allow it", async () => {
  let alerts = 0;
  await runCandidate(report({ score: 54, verdict: "skip", sellability: { status: "confirmed" } }), () => { alerts += 1; });
  await runCandidate(report({ score: 55, verdict: "review", sellability: { status: "confirmed" } }), () => { alerts += 1; });
  assert.equal(alerts, 1);
});
```

Update pre-existing alert-success/failure fixtures to use `sellability: { status: "confirmed" }`; otherwise they correctly become silent under the new rule.

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `node --test test/runtime.test.js`

Expected: FAIL because score/verdict currently bypass unknown safety.

- [ ] **Step 3: Implement the explicit gate and traceable quiet log**

Replace `shouldAlert` in `src/runtime.js` with:

```js
const sellabilityStatus = report.sellability?.status || "unknown";
const blocked = sellabilityStatus === "blocked";
const scoreEligible =
  report.verdict === "green" ||
  report.verdict === "review" ||
  report.score >= dependencies.minScore;
const shouldAlert = blocked || (sellabilityStatus === "confirmed" && scoreEligible);
```

Include `sellability=${status}:${reason || "none"}` in the existing quiet-skip log. Do not change lifecycle outbox dispatch, startup Telegram, or Pons transition allowlist.

- [ ] **Step 4: Run runtime and lifecycle regression tests**

Run: `node --test test/runtime.test.js test/lifecycle.test.js test/outbox.test.js test/scanner-pons.test.js`

Expected: PASS, including unchanged `hard_kill`, `rescued`, `green`, `market_ready`, and startup behavior.

- [ ] **Step 5: Commit the runtime gate**

```bash
git add src/runtime.js test/runtime.test.js
git commit -m "限制普通候选推送安全门槛"
```

### Task 5: Make Telegram safety wording unambiguous

**Files:**
- Modify: `src/notify.js`
- Modify: `test/format.test.js`

- [ ] **Step 1: Write failing formatting tests**

Extend report fixtures with `sellability` and assert:

```js
assert.match(confirmedText, /卖出安全<\/b> 已确认.*真实卖家 3/);
assert.match(blockedText, /卖出安全<\/b> 已阻断.*hidden-balance-mutation/);
assert.match(unknownText, /卖出安全<\/b> 未确认.*insufficient-meaningful-sells/);
assert.doesNotMatch(unknownText, /可小仓试|卖出安全<\/b> 通过/);
```

The unknown test report must use `verdict: "review"` to prove the formatter itself does not add a passing safety claim.

- [ ] **Step 2: Run format tests and verify RED**

Run: `node --test test/format.test.js`

Expected: FAIL because no sellability line exists.

- [ ] **Step 3: Add status labels and evidence counts**

In `src/notify.js`, derive:

```js
const sellability = report.sellability || {};
const sellabilityLabel = {
  confirmed: "已确认",
  blocked: "已阻断",
  unknown: "未确认",
}[sellability.status] || "未确认";
lines.push(
  `<b>卖出安全</b> ${sellabilityLabel}` +
  `  原因 ${esc(sellability.reason || "无")}` +
  `  买家样本 ${sellability.buyerSamples || 0}` +
  `  额度样本 ${sellability.ladderSamples || 0}` +
  `  真实卖家 ${sellability.meaningfulSellers || 0}`
);
```

Keep the existing tax/LP line, but change its honeypot word to `风险 已阻断/未发现阻断/未确认`; do not print “通过” when the status is unknown.

- [ ] **Step 4: Run format tests and commit**

Run: `node --test test/format.test.js test/notify.test.js`

Expected: PASS.

```bash
git add src/notify.js test/format.test.js
git commit -m "明确展示卖出安全证据"
```

### Task 6: Verify read-only safety and full regression suite

**Files:**
- Modify: `test/push-only.test.js`

- [ ] **Step 1: Add a failing static assertion for transaction submission**

Extend the forbidden patterns in `test/push-only.test.js` with provider-side submission methods while keeping `provider.call` allowed:

```js
/sendTransaction\s*\(/,
/eth_sendRawTransaction/,
/eth_sendTransaction/,
```

Also assert `src/sellability.js` contains `provider.call` and does not contain `Wallet`, `approve`, router swap selectors, signing, or broadcast APIs.

- [ ] **Step 2: Run the push-only test**

Run: `node --test test/push-only.test.js`

Expected: PASS. If it fails, remove the transaction-capable production call; do not weaken the assertion.

- [ ] **Step 3: Run every directly affected test**

Run:

```bash
node --test test/sellability.test.js test/honeypot.test.js test/analyze.test.js test/runtime.test.js test/format.test.js test/notify.test.js test/lifecycle.test.js test/outbox.test.js test/scanner-pons.test.js test/push-only.test.js
```

Expected: all tests PASS with zero failures.

- [ ] **Step 4: Run the complete suite and source checks**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected: the full suite reports zero failures; `git diff --check` exits 0; status contains only the intended files until the final commit.

- [ ] **Step 5: Review the diff against the approved design**

Run:

```bash
git diff HEAD~4 -- src test docs/superpowers/specs/2026-09-07-strict-sellability-gate-design.md
```

Verify explicitly:

- SNOWBALL’s ledger mismatch is a deterministic blocked fixture.
- exactly 1% is allowed and above 1% is blocked using BigInt.
- three distinct meaningful sellers are mandatory.
- unknown 100-point ordinary candidates remain silent.
- blocked candidates still send the red risk report.
- V3/V4 ordinary candidates are unsupported and silent.
- lifecycle notifications do not depend on sellability.
- no private key, wallet, approval, swap, signing, or broadcast code was introduced.

- [ ] **Step 6: Commit the verification guard**

```bash
git add test/push-only.test.js
git commit -m "加强只推送模式回归检查"
```

- [ ] **Step 7: Run final verification after the last commit**

Run:

```bash
npm test
git diff --check HEAD~5..HEAD
git status --short --branch
```

Expected: zero test failures, no whitespace errors, and a clean working tree. Do not push or update PR #3 until the user explicitly requests it.

# Pure Push-Only Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every paper/live transaction path and close the remaining alert retry, restart recovery, and URL-redaction defects while preserving historical state data.

**Architecture:** Keep discovery, analysis, terminal output, Telegram alerting, and bounded seen persistence. Replace the fixed startup lookback with a timestamp-derived block boundary, persist only the last fully processed on-chain block, and prevent cursor advancement whenever any candidate fails. Preserve legacy position/trade data as opaque history but expose no runtime API that can execute or mutate it.

**Tech Stack:** Node.js 18+, ES modules, ethers v6 read-only provider/contracts, node:test, JSON state with atomic rename.

---

### Task 1: Remove all transaction-capable command and code surfaces

**Files:**
- Create: `test/push-only.test.js`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `src/index.js`
- Modify: `src/config.js`
- Modify: `src/runtime.js`
- Modify: `src/notify.js`
- Modify: `src/abis.js`
- Modify: `test/index.test.js`
- Modify: `test/runtime.test.js`
- Delete: `src/trade.js`
- Delete: `test/trade.test.js`

- [ ] **Step 1: Write failing source-surface and command tests**

Create a test that reads `package.json`, `.env.example`, and every file under `src/`. Assert that only `start/watch/scan/check/test` scripts exist and that source/config contain none of these transaction capabilities:

```js
const forbidden = [
  /\bWallet\b/, /PRIVATE_KEY/, /ENABLE_LIVE_TRADING/,
  /signTransaction/, /broadcastTransaction/,
  /swapExactETHForTokens/, /swapExactTokensForETH/, /exactInputSingle/, /\.approve\(/,
];
for (const pattern of forbidden) assert.doesNotMatch(source, pattern);
assert.deepEqual(Object.keys(pkg.scripts).sort(), ["check", "scan", "start", "test", "watch"]);
```

Use `spawnSync(process.execPath, ["src/index.js", "paper"])` and the same for `live`; assert non-zero exit and `commands: watch | scan | check <token>` in stderr before any scanner banner.

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test test/push-only.test.js`

Expected: FAIL because `paper`, `live`, `Wallet`, private-key config, swap ABI methods, and `src/trade.js` still exist.

- [ ] **Step 3: Remove the transaction paths minimally**

In `src/index.js`, remove trade/store-position imports, `reportReviewPositions`, position timers, `allowTrading`, and `paper/live` branches. The accepted command dispatch becomes:

```js
if (command === "watch") await watch();
else if (command === "scan") await scanOnce();
else if (command === "check") await checkOne(argument);
else throw new Error("commands: watch | scan | check <token>");
```

In `src/runtime.js`, remove `allowTrading`, `tradeMode`, `shouldTrade`, and `maybeTrade`. In `src/notify.js`, remove `liveTradingAllowed` and always append the push-only warning. Remove the paper script and all trading configuration. Shrink ERC20/V2 router ABIs to read-only functions plus the `transfer` function needed only to encode `eth_call`; remove approvals, swaps, and the unused V3 Router/Quoter ABIs. Delete `src/trade.js` and its test.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/push-only.test.js test/index.test.js test/runtime.test.js test/format.test.js test/honeypot.test.js`

Expected: PASS with no network calls and no `data/` creation.

- [ ] **Step 5: Commit**

```bash
git add package.json .env.example src test
git commit -m "重构：移除全部模拟与实盘交易路径"
```

### Task 2: Preserve historical state while adding a scanner cursor

**Files:**
- Modify: `src/store.js`
- Modify: `test/store.test.js`

- [ ] **Step 1: Write failing preservation and cursor tests**

Load a v3 state containing arbitrary historical `positions` and `trades`, call `markSeen`, then call the wished-for `setOnchainCursor(123)`. Assert the persisted file retains those two fields byte-for-value at the parsed-data level and contains `cursors.onchain === 123`. Reopen the store and assert `getOnchainCursor() === 123`. Also assert decreasing or non-integer cursors are rejected.

```js
store.markSeen("pool", { score: 80 });
store.setOnchainCursor(123);
assert.deepEqual(saved.positions, original.positions);
assert.deepEqual(saved.trades, original.trades);
assert.equal(saved.cursors.onchain, 123);
assert.equal(createStore(options).getOnchainCursor(), 123);
```

- [ ] **Step 2: Run store tests and verify RED**

Run: `node --test test/store.test.js`

Expected: FAIL because cursor APIs and `cursors` state do not exist.

- [ ] **Step 3: Implement opaque history preservation and cursor APIs**

Initialize/load state as:

```js
state = {
  schemaVersion: 3,
  seen: loaded.seen,
  positions: structuredClone(loaded.positions || {}),
  trades: structuredClone(loaded.trades || []),
  cursors: structuredClone(loaded.cursors || {}),
};
```

Expose only scanner methods: `hasSeen`, `markSeen`, `getSeen`, `getOnchainCursor`, and `setOnchainCursor`. `setOnchainCursor` must require a non-negative integer and refuse regression below an existing cursor. Keep legacy JSON import but copy positions/trades without conversion; retain all old files.

- [ ] **Step 4: Run store tests and verify GREEN**

Run: `node --test test/store.test.js`

Expected: PASS, including atomic-write failure preserving in-memory state.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "修复：保留历史状态并持久化扫描游标"
```

### Task 3: Prevent cursor advancement after candidate failures

**Files:**
- Modify: `src/index.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write failing batch-result tests**

Change the expected `processEvents` contract to `{ accepted, failed }`. Add a test whose drain reports one failure and assert `failed === 1`. Add a test for a new `processOnchainRange` helper: when processing fails, `setOnchainCursor` is not called; when every candidate succeeds, it is called once with `head`.

```js
const failed = await processOnchainRange({ from: 11, head: 12 }, {
  scanOnchain: async () => [event],
  processEvents: async () => ({ accepted: 1, failed: 1 }),
  setOnchainCursor: (block) => committed.push(block),
});
assert.equal(failed.complete, false);
assert.deepEqual(committed, []);
```

- [ ] **Step 2: Run index tests and verify RED**

Run: `node --test test/index.test.js`

Expected: FAIL because drain swallows failures and watch commits the cursor unconditionally.

- [ ] **Step 3: Propagate failure counts and commit cursor only on complete batches**

Make `drain` return `{ handled, failed }`, incrementing `failed` in its existing catch. Make `processEvents` accumulate drain results across queue-pressure drains. Extract `processOnchainRange` so tests can inject discovery, processing, and cursor persistence. In watch, update the in-memory cursor only from a complete result; otherwise keep the prior cursor and log that the exact range will retry.

- [ ] **Step 4: Run index/runtime tests and verify GREEN**

Run: `node --test test/index.test.js test/runtime.test.js test/queue.test.js test/notify.test.js`

Expected: PASS; failed alerts remain unseen and prevent cursor persistence.

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "修复：候选失败时保留区块游标以便重试"
```

### Task 4: Derive startup scan range from token age

**Files:**
- Modify: `src/chain.js`
- Modify: `src/index.js`
- Modify: `test/chain.test.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write a failing block-time search test**

Add a test for `findFirstBlockAtOrAfter(timestampMs, head, provider)`. Use deterministic blocks with timestamps `[100, 200, 300, 400]` and assert target 250 seconds returns block 2; target before genesis returns 0; unavailable midpoint throws with context instead of silently guessing.

```js
const provider = { getBlock: async (n) => ({ number: n, timestamp: [100, 200, 300, 400][n] }) };
assert.equal(await findFirstBlockAtOrAfter(250_000, 3, provider), 2);
```

- [ ] **Step 2: Run chain tests and verify RED**

Run: `node --test test/chain.test.js`

Expected: FAIL because the timestamp search helper does not exist.

- [ ] **Step 3: Implement binary search and startup selection**

Binary-search `[0, head]` using block timestamps and return the earliest block whose timestamp is at least the cutoff. Export an `initialOnchainCursor` helper in `src/index.js` that returns:

```js
const firstRelevant = await findFirstBlockAtOrAfter(now() - maxAgeMinutes * 60_000, head);
return Math.min(head, Math.max(savedCursor ?? -1, firstRelevant - 1));
```

Remove `LOOKBACK_BLOCKS` from config and `.env.example`. Validate `MAX_AGE_MINUTES` as a finite positive number. Use the helper in both watch startup and the read-only one-shot scan; scan must not persist the derived cursor.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/chain.test.js test/index.test.js test/config.test.js`

Expected: PASS and no tests depend on a fixed block lookback.

- [ ] **Step 5: Commit**

```bash
git add src/chain.js src/index.js test/chain.test.js test/index.test.js test/config.test.js .env.example
git commit -m "修复：按候选年龄窗口恢复链上扫描"
```

### Task 5: Redact complete URL fragments and update documentation

**Files:**
- Modify: `src/safety.js`
- Modify: `test/safety.test.js`
- Modify: `README.md`

- [ ] **Step 1: Add the failing right-parenthesis secret test**

```js
const message = safeErrorMessage(
  new Error("requestUrl=https://user:pass@rpc.example/v2/foo)?key=SECRET next")
);
assert.doesNotMatch(message, /user:pass|SECRET|\?key=/);
assert.match(message, /\[redacted URL\]/);
```

- [ ] **Step 2: Run safety tests and verify RED**

Run: `node --test test/safety.test.js`

Expected: FAIL because `?key=SECRET` remains after the current regex stops at `)`.

- [ ] **Step 3: Replace arbitrary-text URL parsing with whole-fragment redaction**

Keep `sanitizeRpcUrl` for the banner. Implement error redaction as:

```js
return String(message).replace(/https?:\/\/\S+/gi, "[redacted URL]");
```

Update README to document only watch/scan/check, state cursor retry behavior, historical data preservation, and the permanent removal of all transaction functionality.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
node --test test/safety.test.js
npm test
git diff --check 77e5ffe..HEAD
rg -n "Wallet|PRIVATE_KEY|ENABLE_LIVE_TRADING|signTransaction|broadcastTransaction|swapExact|exactInputSingle|approve\\(" src package.json .env.example README.md
```

Expected: all tests PASS; diff check has no output; forbidden-capability search has no matches except a README sentence explicitly stating they were removed, if retained.

- [ ] **Step 5: Commit**

```bash
git add src/safety.js test/safety.test.js README.md
git commit -m "修复：完整脱敏错误地址并更新纯推送文档"
```

### Task 6: Final review and target-directory synchronization

**Files:**
- Synchronize only paths changed since `0506d45` into `D:\code-web3\07-web3-bot\DEX\robinhood-scanner-bot`

- [ ] **Step 1: Verify the isolated branch**

Run `npm test`, `git diff --check 77e5ffe..HEAD`, `git status --short`, and the forbidden-capability search. Expected: all tests pass, no whitespace errors, only intended changes, no transaction-capable source.

- [ ] **Step 2: Request an independent read-only code review**

Review the diff from `77e5ffe` to HEAD for command rejection, chain-write reachability, cursor loss, historical data loss, read-only scan violations, secret leakage, and missing regression tests. Fix any P0/P1 findings with a new RED/GREEN cycle before continuing.

- [ ] **Step 3: Protect target changes and synchronize**

For each changed existing target file, compare `git hash-object` against the `0506d45` baseline; require new paths to be absent. Stop on any mismatch. Copy only the verified changed paths; never copy `.env`, `data/`, `node_modules`, or repository metadata.

- [ ] **Step 4: Verify the formal target directory**

Run `npm test` in `D:\code-web3\07-web3-bot\DEX\robinhood-scanner-bot`, compare SHA-256 for every synchronized file, confirm `.env` was untouched, and confirm no command or source contains transaction-capable behavior.

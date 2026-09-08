# Candidate Retry and Smart Wallet Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistently recheck high-potential ordinary V2 candidates with unknown sellability and add a bounded score bonus for locally labeled KOL/smart-money buyers without increasing RPC reads.

**Architecture:** A focused wallet-label module loads either normalized JSON or DeBot exports and produces a validated in-memory catalog. Existing V2 Transfer evidence produces normalized wallet signals which feed scoring and Telegram formatting. Ordinary candidate rechecks use the existing schema-v4 `pendingChecks` store with a new check type and absolute `+2m/+5m/+10m` policy, while initial analysis and rechecks share the watch-level serial executor.

**Tech Stack:** Node.js ESM, ethers v6, synchronous local JSON loading, existing atomic JSON store, `node:test`.

---

## File map

- Create `src/wallet-labels.js`: parse normalized/DeBot data, load the optional local file, normalize wallet-signal evidence.
- Create `src/candidate-retry.js`: pure eligibility, schedule construction and next-step decisions for ordinary candidate rechecks.
- Create `test/wallet-labels.test.js`: parser, loader and normalization regression tests.
- Create `test/candidate-retry.test.js`: absolute timing, age and terminal-state tests.
- Create `examples/wallet-labels.json`: safe example with placeholder addresses.
- Modify `src/sellability.js`: prioritize tagged buyers and attach bounded wallet signals using existing reads.
- Modify `src/analyze.js`: load the catalog, pass it into sellability inspection and add the bounded score bonus.
- Modify `src/notify.js`: render configured, unconfigured and matched wallet-signal states.
- Modify `src/store.js`: atomically and idempotently schedule a generic pending check.
- Modify `src/scanner.js`: support expected business rescheduling and wire initial/recheck flows through one serial executor.
- Modify `src/runtime.js`: run a post-analysis persistence callback before marking a candidate seen.
- Modify `test/sellability.test.js`, `test/score.test.js`, `test/analyze.test.js`, `test/format.test.js`, `test/store.test.js`, `test/scanner-pons.test.js`, `test/index.test.js`, and `test/runtime.test.js`: cover each affected contract.
- Modify `README.md` and `.env.example`: document the file, bonus, retry timing and unchanged safety gate.

### Task 1: Local wallet-label catalog

**Files:**
- Create: `src/wallet-labels.js`
- Create: `test/wallet-labels.test.js`
- Create: `examples/wallet-labels.json`

- [ ] **Step 1: Write failing parser and loader tests**

Create tests that use `fs.mkdtempSync`, write isolated fixtures, and assert these exact contracts:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadWalletLabels,
  normalizeWalletLabels,
  normalizeWalletSignals,
} from "../src/wallet-labels.js";

const A = "0x0000000000000000000000000000000000000011";
const B = "0x0000000000000000000000000000000000000022";

describe("wallet labels", () => {
  it("normalizes the standard array and defaults source to manual", () => {
    const catalog = normalizeWalletLabels([
      { address: A, label: "Alpha", type: "kol" },
      { address: B, label: "Beta", type: "smart_money", source: "okx" },
    ]);
    assert.equal(catalog.status, "known");
    assert.equal(catalog.labels.get(A.toLowerCase()).source, "manual");
    assert.equal(catalog.labels.get(B.toLowerCase()).type, "smart_money");
  });

  it("imports EVM entries from a DeBot nested export", () => {
    const catalog = normalizeWalletLabels({
      sol: { notAnEvmAddress: { mark: "ignored" } },
      eth: { [A]: { mark: "DeBot Alpha" } },
    });
    assert.deepEqual(catalog.labels.get(A.toLowerCase()), {
      label: "DeBot Alpha", type: "smart_money", source: "debot",
    });
    assert.equal(catalog.labels.size, 1);
  });

  it("returns unconfigured for a missing file", () => {
    assert.deepEqual(loadWalletLabels(path.join(os.tmpdir(), "missing-wallet-labels.json")), {
      status: "unconfigured", labels: new Map(),
    });
  });

  it("rejects invalid addresses, labels, types, sources and duplicates", () => {
    assert.throws(() => normalizeWalletLabels([{ address: "bad", label: "x", type: "kol" }]), /address/i);
    assert.throws(() => normalizeWalletLabels([{ address: A, label: " ", type: "kol" }]), /label/i);
    assert.throws(() => normalizeWalletLabels([{ address: A, label: "x", type: "whale" }]), /type/i);
    assert.throws(() => normalizeWalletLabels([{ address: A, label: "x", type: "kol", source: "web" }]), /source/i);
    assert.throws(() => normalizeWalletLabels([
      { address: A, label: "x", type: "kol" },
      { address: A, label: "y", type: "kol" },
    ]), /duplicate/i);
  });

  it("normalizes wallet signals without trusting malformed counts", () => {
    assert.deepEqual(normalizeWalletSignals({
      status: "known",
      count: 2,
      matches: [{ label: "A", type: "kol", source: "manual" }],
    }), {
      status: "known",
      count: 2,
      matches: [{ label: "A", type: "kol", source: "manual" }],
    });
    assert.equal(normalizeWalletSignals({ status: "known", count: -1 }).count, 0);
    assert.equal(normalizeWalletSignals().status, "unconfigured");
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test test/wallet-labels.test.js`

Expected: FAIL because `src/wallet-labels.js` does not exist.

- [ ] **Step 3: Implement the catalog module**

Implement these exports in `src/wallet-labels.js`:

```js
import fs from "node:fs";
import { getAddress } from "ethers";

const TYPES = new Set(["kol", "smart_money"]);
const SOURCES = new Set(["manual", "debot", "okx"]);

function cleanLabel(value) {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label || [...label].length > 80) throw new Error("wallet label must contain 1-80 characters");
  return label;
}

function addEntry(output, entry) {
  let address;
  try { address = getAddress(entry.address).toLowerCase(); }
  catch { throw new Error(`wallet label address is invalid: ${String(entry.address || "")}`); }
  if (output.has(address)) throw new Error(`duplicate wallet label address: ${address}`);
  const type = String(entry.type || "");
  const source = String(entry.source || "manual");
  if (!TYPES.has(type)) throw new Error(`wallet label type is invalid: ${type}`);
  if (!SOURCES.has(source)) throw new Error(`wallet label source is invalid: ${source}`);
  output.set(address, { label: cleanLabel(entry.label), type, source });
}

function collectDebot(node, output) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (/^0x[0-9a-fA-F]{40}$/.test(key)) {
      if (value?.mark == null || String(value.mark).trim() === "") continue;
      addEntry(output, { address: key, label: value.mark, type: "smart_money", source: "debot" });
    } else {
      collectDebot(value, output);
    }
  }
}

export function normalizeWalletLabels(value) {
  const labels = new Map();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("wallet label entry must be an object");
      addEntry(labels, entry);
    }
  } else if (value && typeof value === "object") {
    collectDebot(value, labels);
  } else {
    throw new Error("wallet labels must contain an array or DeBot object");
  }
  return { status: "known", labels };
}

export function loadWalletLabels(filePath) {
  if (!fs.existsSync(filePath)) return { status: "unconfigured", labels: new Map() };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (cause) { throw new Error(`cannot parse wallet labels file ${filePath}`, { cause }); }
  return normalizeWalletLabels(parsed);
}

export function normalizeWalletSignals(value) {
  const status = ["known", "unconfigured"].includes(value?.status) ? value.status : "unconfigured";
  const matches = Array.isArray(value?.matches)
    ? value.matches.slice(0, 3).filter((item) => item && TYPES.has(item.type) && SOURCES.has(item.source) && typeof item.label === "string")
      .map((item) => ({ label: item.label.trim().slice(0, 80), type: item.type, source: item.source }))
      .filter((item) => item.label)
    : [];
  const count = status === "known" && Number.isInteger(value?.count) && value.count >= matches.length
    ? value.count
    : 0;
  return { status, count, matches: count ? matches : [] };
}
```

- [ ] **Step 4: Add a safe example file**

Create `examples/wallet-labels.json` with two clearly non-production placeholder entries using the standard schema. Do not add a real `data/wallet-labels.json` because `data/` is intentionally ignored.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `node --test test/wallet-labels.test.js`

Expected: all wallet-label tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/wallet-labels.js test/wallet-labels.test.js examples/wallet-labels.json
git commit -m "增加本地聪明钱标签解析"
```

### Task 2: Attach wallet signals to existing V2 evidence

**Files:**
- Modify: `src/sellability.js`
- Modify: `test/sellability.test.js`

- [ ] **Step 1: Write failing evidence tests**

Add focused cases to `test/sellability.test.js` using the existing fake provider:

```js
it("reports labeled buyers that still hold at least one token without extra read classes", async () => {
  const catalog = {
    status: "known",
    labels: new Map([
      [BUYERS[0].toLowerCase(), { label: "Alpha", type: "kol", source: "manual" }],
      [BUYERS[1].toLowerCase(), { label: "Beta", type: "smart_money", source: "debot" }],
    ]),
  };
  const logs = BUYERS.slice(0, 2).map((buyer, index) =>
    transferLog({ from: POOL, to: buyer, value: 100n, blockNumber: 10 + index })
  );
  const provider = fakeProvider({ logs, balances: new Map([
    [BUYERS[0].toLowerCase(), 100n],
    [BUYERS[1].toLowerCase(), 100n],
  ]) });
  const result = await inspectSellability(context(), { provider, walletCatalog: catalog });
  assert.equal(result.walletSignals.status, "known");
  assert.equal(result.walletSignals.count, 2);
  assert.deepEqual(result.walletSignals.matches.map((item) => item.label), ["Beta", "Alpha"]);
});

it("does not count a labeled buyer that has sold out", async () => {
  const catalog = { status: "known", labels: new Map([
    [BUYERS[0].toLowerCase(), { label: "Exited", type: "kol", source: "manual" }],
  ]) };
  const provider = fakeProvider({
    logs: [transferLog({ from: POOL, to: BUYERS[0], value: 100n })],
    balances: new Map([[BUYERS[0].toLowerCase(), 0n]]),
  });
  const result = await inspectSellability(context(), { provider, walletCatalog: catalog });
  assert.equal(result.walletSignals.count, 0);
});
```

Also add a case with six buyers proving a labeled buyer is selected before unlabelled candidates when the five-buyer cap applies.

- [ ] **Step 2: Run the sellability test and verify RED**

Run: `node --test test/sellability.test.js`

Expected: FAIL because results do not expose `walletSignals` and buyer selection does not prioritize labels.

- [ ] **Step 3: Extend normalized sellability results**

Import `normalizeWalletSignals` into `src/sellability.js`. Extend `sellabilityResult` and `normalizeSellabilityEvidence` so every result carries a validated value:

```js
walletSignals: normalizeWalletSignals(evidence.walletSignals),
```

Never use `walletSignals` to promote an unknown or malformed sellability status.

- [ ] **Step 4: Prioritize labeled buyers within existing caps**

In `inspectSellability`, read `dependencies.walletCatalog` with an unconfigured empty fallback. Build the newest-first unique candidate list, order tagged addresses before untagged addresses, and then run the existing EOA check until `MAX_BUYERS` is reached. Do not raise `MAX_BUYERS`, `MAX_CODE_LOOKUPS`, log range, balance calls or ladder calls.

After existing fixed-block balances are known, construct:

```js
const matches = buyers
  .filter((wallet) => (balances.get(wallet.toLowerCase()) ?? 0n) >= oneToken)
  .map((wallet) => walletCatalog.labels.get(wallet.toLowerCase()))
  .filter(Boolean);
const walletSignals = normalizeWalletSignals({
  status: walletCatalog.status,
  count: matches.length,
  matches: matches.slice(0, 3),
});
```

Attach this value to blocked, unavailable and final results after buyer balances are available; earlier exits use the catalog status with zero matches.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `node --test test/sellability.test.js`

Expected: all sellability tests PASS and existing RPC/read-cap assertions remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/sellability.js test/sellability.test.js
git commit -m "从卖出证据识别聪明钱买家"
```

### Task 3: Score and render smart-wallet evidence

**Files:**
- Modify: `src/analyze.js`
- Modify: `src/notify.js`
- Modify: `test/score.test.js`
- Modify: `test/analyze.test.js`
- Modify: `test/honeypot.test.js`
- Modify: `test/format.test.js`

- [ ] **Step 1: Write failing scoring tests**

Extend the score fixture with `walletSignalsStatus: "known"` and `walletSignalCount: 0`, then add:

```js
it("adds five points for one labeled buyer and caps two or more at eight", () => {
  const none = scoreFromFacts(base());
  const one = scoreFromFacts(base({ walletSignalCount: 1 }));
  const two = scoreFromFacts(base({ walletSignalCount: 2 }));
  const many = scoreFromFacts(base({ walletSignalCount: 10 }));
  assert.equal(one.score - none.score, 5);
  assert.equal(two.score - none.score, 8);
  assert.equal(many.score, two.score);
});

it("does not reward unconfigured wallet signals", () => {
  const none = scoreFromFacts(base());
  const unconfigured = scoreFromFacts(base({ walletSignalsStatus: "unconfigured", walletSignalCount: 2 }));
  assert.equal(unconfigured.score, none.score);
});
```

Use a low enough base score in these assertions to avoid the existing 100-point cap masking the delta.

- [ ] **Step 2: Write failing analysis and formatting tests**

Assert that `analyze` passes an injected catalog into `honeypotCheck`, maps normalized signals into `facts`, and leaves the prefilter decision unchanged when labels are configured. In `test/format.test.js`, assert the exact distinctions:

```js
assert.match(formatAlert(reportWith({ walletSignals: { status: "unconfigured", count: 0, matches: [] } })), /聪明钱.*标签未配置/);
assert.match(formatAlert(reportWith({ walletSignals: { status: "known", count: 0, matches: [] } })), /聪明钱.*未命中/);
assert.match(formatAlert(reportWith({ walletSignals: {
  status: "known", count: 2,
  matches: [
    { label: "Alpha", type: "kol", source: "manual" },
    { label: "Beta", type: "smart_money", source: "debot" },
  ],
} })), /聪明钱.*2.*Alpha.*Beta/);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `node --test test/score.test.js test/analyze.test.js test/honeypot.test.js test/format.test.js`

Expected: FAIL because wallet signals are not passed, scored or rendered.

- [ ] **Step 4: Wire the catalog through analysis**

In `src/analyze.js`, import `DATA_DIR`, `path`, `loadWalletLabels`, and `normalizeWalletSignals`. Load `path.join(DATA_DIR, "wallet-labels.json")` once into `DEFAULT_ANALYZE_DEPENDENCIES.walletCatalog`. Pass the catalog in the `honeypotCheck` input, pass it onward to `inspectSellability`, normalize the returned signals, expose them as top-level `report.walletSignals`, and add these facts:

```js
walletSignalsStatus: walletSignals.status,
walletSignalCount: walletSignals.count,
```

The prefilter facts must explicitly use `{ status: "unconfigured", count: 0, matches: [] }`; it must not use a potential +8 bonus to enter deep inspection.

- [ ] **Step 5: Add the bounded score item**

In `scoreFromFacts`, before the final clamp:

```js
const walletCount = f.walletSignalsStatus === "known" && Number.isInteger(f.walletSignalCount)
  ? Math.max(0, f.walletSignalCount)
  : 0;
const walletPoints = walletCount >= 2 ? 8 : walletCount === 1 ? 5 : 0;
score += walletPoints;
checks.push({
  key: "smart_money",
  ok: walletPoints > 0,
  pts: walletPoints,
  detail: f.walletSignalsStatus !== "known"
    ? "标签未配置"
    : walletCount > 0 ? `命中 ${walletCount} 个已标记买家` : "未命中",
});
```

- [ ] **Step 6: Render the report**

In `formatAlert`, normalize `report.walletSignals || report.sellability?.walletSignals`. Render one escaped line after sellability. Show `标签未配置`, `未命中`, or `命中 N：label(type)、...`; never render wallet addresses.

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run: `node --test test/score.test.js test/analyze.test.js test/honeypot.test.js test/format.test.js`

Expected: all focused tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/analyze.js src/notify.js test/score.test.js test/analyze.test.js test/honeypot.test.js test/format.test.js
git commit -m "将聪明钱信号纳入评分报告"
```

### Task 4: Persistent generic pending-check primitives

**Files:**
- Modify: `src/store.js`
- Modify: `src/scanner.js`
- Modify: `test/store.test.js`
- Modify: `test/scanner-pons.test.js`

- [ ] **Step 1: Write failing store tests**

Add a store test which schedules the same check twice and proves the original attempt state is not reset:

```js
const check = {
  id: "candidate-recheck:key",
  type: "candidate_recheck",
  event: { token: TOKEN, venue: "uniswap-v2", pool: POOL },
  firstAnalyzedAt: 1_000,
  dueAt: 121_000,
  retryOffsetsMs: [120_000, 300_000, 600_000],
  maxAttempts: 3,
};
store.scheduleCheck(check);
store.rescheduleCheck(check.id, { status: "pending", attempts: 1, nextAttemptAt: 301_000, lastError: "pending" });
store.scheduleCheck(check);
assert.equal(store.snapshot().pendingChecks[check.id].attempts, 1);
assert.equal(store.snapshot().pendingChecks[check.id].nextAttemptAt, 301_000);
```

- [ ] **Step 2: Write failing expected-reschedule tests**

In `test/scanner-pons.test.js`, call `runPendingChecks` with a handler returning `{ retryAt: 5000, lastError: "sellability pending" }`. Assert status remains pending, attempts increments once, no failure is counted and no exception is needed. Add a thrown-error case with `retryOffsetsMs` proving the next attempt is anchored to `firstAnalyzedAt`, and existing Pons fallback backoff remains unchanged when those fields are absent.

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `node --test test/store.test.js test/scanner-pons.test.js`

Expected: FAIL because `scheduleCheck` and expected business rescheduling do not exist.

- [ ] **Step 4: Add atomic idempotent scheduling**

Add this store method without changing schema version:

```js
scheduleCheck(check) {
  if (!check?.id || !check?.type || !Number.isFinite(check.dueAt)) {
    throw new Error("pending check requires id, type and dueAt");
  }
  return commit((draft) => {
    if (draft.pendingChecks[check.id]) return draft.pendingChecks[check.id];
    draft.pendingChecks[check.id] = {
      ...structuredClone(check),
      eventId: check.eventId ?? null,
      status: "pending",
      attempts: 0,
      nextAttemptAt: check.dueAt,
      createdAt: now(),
      completedAt: null,
      lastError: null,
    };
    return draft.pendingChecks[check.id];
  });
},
```

- [ ] **Step 5: Support explicit business rescheduling**

In `runPendingChecks`, validate and handle `update.retryAt` before completion:

```js
if (update?.retryAt != null) {
  if (!Number.isFinite(update.retryAt)) throw new Error(`pending check ${check.id} returned invalid retryAt`);
  store.rescheduleCheck(check.id, {
    status: "pending",
    attempts: Number(check.attempts || 0) + 1,
    nextAttemptAt: update.retryAt,
    lastError: safeErrorMessage(update.lastError || "evidence pending"),
  });
  result.retried += 1;
  continue;
}
```

For thrown errors, calculate `maxAttempts` from `check.maxAttempts` when it is a positive integer, otherwise use the function default. If `retryOffsetsMs` and `firstAnalyzedAt` are valid, use the next absolute offset; otherwise retain `nextRetryAt`.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run: `node --test test/store.test.js test/scanner-pons.test.js`

Expected: all focused tests PASS, including existing Pons pending-check tests.

- [ ] **Step 7: Commit**

```bash
git add src/store.js src/scanner.js test/store.test.js test/scanner-pons.test.js
git commit -m "支持普通候选持久化复查任务"
```

### Task 5: Pure candidate-retry policy

**Files:**
- Create: `src/candidate-retry.js`
- Create: `test/candidate-retry.test.js`

- [ ] **Step 1: Write failing policy tests**

Create fixtures for a non-Pons V2 event and reports with normalized sellability. Assert:

```js
assert.equal(shouldScheduleCandidateRecheck(v2Event, unknownReport("insufficient-meaningful-sells")), true);
assert.equal(shouldScheduleCandidateRecheck(v2Event, unknownReport("prefilter-score")), false);
assert.equal(shouldScheduleCandidateRecheck({ ...v2Event, venue: "uniswap-v4" }, unknownReport("unsupported-venue")), false);
assert.equal(shouldScheduleCandidateRecheck(v2Event, confirmedReport), false);
assert.equal(shouldScheduleCandidateRecheck(v2Event, blockedReport), false);

const check = createCandidateRecheck(v2Event, 1_000);
assert.equal(check.nextAttemptAt, 121_000);
assert.equal(decideCandidateRecheck({ ...check, attempts: 0 }, unknownReport("insufficient-meaningful-sells"), 121_000, 30).retryAt, 301_000);
assert.equal(decideCandidateRecheck({ ...check, attempts: 1 }, unknownReport("insufficient-meaningful-sells"), 301_000, 30).retryAt, 601_000);
assert.equal(decideCandidateRecheck({ ...check, attempts: 2 }, unknownReport("insufficient-meaningful-sells"), 601_000, 30).complete, true);
```

Also prove `createdAt` older than the configured window completes without another retry, while a missing `createdAt` uses `firstAnalyzedAt` as the age origin.

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test test/candidate-retry.test.js`

Expected: FAIL because `src/candidate-retry.js` does not exist.

- [ ] **Step 3: Implement the pure policy**

Implement:

```js
import { candidateKey } from "./runtime.js";
import { normalizeSellabilityEvidence } from "./sellability.js";

export const CANDIDATE_RETRY_OFFSETS_MS = Object.freeze([120_000, 300_000, 600_000]);

export function shouldScheduleCandidateRecheck(event, report) {
  const sellability = normalizeSellabilityEvidence(report?.sellability, report?.honeypot?.honeypot);
  return event?.venue === "uniswap-v2" &&
    sellability.status === "unknown" &&
    !["prefilter-score", "unsupported-venue"].includes(sellability.reason);
}

export function createCandidateRecheck(event, firstAnalyzedAt) {
  if (!Number.isFinite(firstAnalyzedAt)) throw new Error("candidate recheck requires firstAnalyzedAt");
  return {
    id: `candidate-recheck:${candidateKey(event)}`,
    type: "candidate_recheck",
    event: structuredClone(event),
    firstAnalyzedAt,
    dueAt: firstAnalyzedAt + CANDIDATE_RETRY_OFFSETS_MS[0],
    retryOffsetsMs: [...CANDIDATE_RETRY_OFFSETS_MS],
    maxAttempts: CANDIDATE_RETRY_OFFSETS_MS.length,
  };
}

export function decideCandidateRecheck(check, report, at, maxAgeMinutes) {
  if (!shouldScheduleCandidateRecheck(check?.event, report)) return { complete: true };
  const origin = Number.isFinite(check.event.createdAt) ? check.event.createdAt : check.firstAnalyzedAt;
  if (!Number.isFinite(at) || at - origin > maxAgeMinutes * 60_000) return { complete: true };
  const completedAttempt = Number(check.attempts || 0) + 1;
  const nextOffset = CANDIDATE_RETRY_OFFSETS_MS[completedAttempt];
  if (nextOffset == null) return { complete: true };
  return {
    complete: false,
    retryAt: check.firstAnalyzedAt + nextOffset,
    lastError: report.sellability?.reason || "evidence-unavailable",
  };
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/candidate-retry.test.js`

Expected: all candidate-retry tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/candidate-retry.js test/candidate-retry.test.js
git commit -m "定义普通候选有限复查策略"
```

### Task 6: Runtime and watch integration

**Files:**
- Modify: `src/runtime.js`
- Modify: `src/scanner.js`
- Modify: `test/runtime.test.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write a failing persistence-order test**

In `test/runtime.test.js`, inject `onAnalyzed` and record call order. Assert it receives the normalized report and event before `markSeen`. Add a rejecting callback case proving `markSeen` is not called if durable scheduling fails.

```js
assert.deepEqual(order, ["analyze", "schedule", "seen"]);
await assert.rejects(() => handleCandidate(event, { persistSeen: true }, {
  ...dependencies,
  onAnalyzed: async () => { throw new Error("state write failed"); },
}), /state write failed/);
assert.equal(seen, 0);
```

- [ ] **Step 2: Write failing scanner helper tests**

Export focused factories from `src/scanner.js` and test them without starting infinite loops:

- `createCandidateRetryScheduler({ store, now })` schedules only eligible initial reports and is idempotent through the store.
- `createCandidateRecheckHandler(...)` updates `observedAt`, runs through an injected serial executor, returns `{ retryAt, lastError }` for unknown evidence, completes for blocked/confirmed/expired results, and preserves `handleCandidate` push rules.
- Two concurrent calls through the same executor never have more than one active analysis.

- [ ] **Step 3: Run runtime and scanner tests and verify RED**

Run: `node --test test/runtime.test.js test/index.test.js`

Expected: FAIL because the callback and scanner retry factories do not exist.

- [ ] **Step 4: Add the pre-seen callback**

In `handleCandidate`, after successful alert/quiet logging and before `markSeen`, add:

```js
if (typeof dependencies.onAnalyzed === "function") {
  await dependencies.onAnalyzed(normalizedReport, event);
}
```

Do not invoke it for candidates rejected by the age check before analysis.

- [ ] **Step 5: Implement scanner retry factories**

Add imports from `candidate-retry.js`. `createCandidateRetryScheduler` calls `store.scheduleCheck(createCandidateRecheck(event, now()))` only when eligible. `createCandidateRecheckHandler` must:

1. Validate `check.event`.
2. Clone it with `observedAt: now()`.
3. Execute `handleCandidate` through the injected shared executor with no initial scheduling callback.
4. Return nothing for an age-expired null report or a terminal report.
5. Return `{ retryAt, lastError }` from `decideCandidateRecheck` when evidence remains unknown and another slot exists.

- [ ] **Step 6: Wire watch with one shared executor**

Create `executeCandidate` before building pending handlers. Merge the Pons handlers with `candidate_recheck`. Pass the initial scheduler as `onAnalyzed` in ordinary source handling. The pending-check loop and both ordinary discovery sources must reference the same `executeCandidate` closure.

Do not route raw Pons V2 candidates into this retry policy; existing `classifyAuxiliaryCandidate` continues to return before generic analysis.

- [ ] **Step 7: Run directly affected tests and verify GREEN**

Run: `node --test test/runtime.test.js test/index.test.js test/scanner-pons.test.js test/store.test.js test/candidate-retry.test.js`

Expected: all directly affected tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runtime.js src/scanner.js test/runtime.test.js test/index.test.js
git commit -m "接入普通候选持久化复查"
```

### Task 7: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-09-08-candidate-retry-smart-wallet-scoring-design.md`

- [ ] **Step 1: Document operator behavior**

Add instructions to copy `examples/wallet-labels.json` to `data/wallet-labels.json`, explain the standard and DeBot formats, state that file changes require restarting `watch`, and repeat these safety facts:

- +5 for one currently holding labeled buyer, +8 for two or more.
- Labels do not bypass confirmed sellability or the final score floor.
- Only candidates already above the `MIN_SCORE - 10` prefilter use label matching.
- Unknown ordinary V2 evidence is retried at `+2m/+5m/+10m`; Pons and V3/V4 behavior is unchanged.
- DeBot is manual import only; OKX `4663` signals are not supported and no OKX secrets are required.

Add comments to `.env.example` near `MIN_SCORE`; do not add a new secret or runtime setting.

- [ ] **Step 2: Reconcile the design document with implemented names**

Update the spec only if an implementation identifier differs from the approved name. Do not change product behavior during this step.

- [ ] **Step 3: Run all tests**

Run: `npm test`

Expected: exit code 0, all tests PASS, no failures.

- [ ] **Step 4: Run repository checks**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` emits no errors; status lists only the intended documentation changes before commit.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md .env.example docs/superpowers/specs/2026-09-08-candidate-retry-smart-wallet-scoring-design.md
git commit -m "说明聪明钱标签与候选复查"
```

- [ ] **Step 6: Fresh final verification**

Run:

```bash
npm test
git diff --check origin/feat/pons-v2-lifecycle-scanner..HEAD
git status --short --branch
```

Expected: all tests PASS, diff check emits no errors, and the working tree is clean with the feature branch ahead of its remote.

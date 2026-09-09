# Multi-chain Phase 0 RPC Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate permanent block skips during discovery failover and make identical discovery/analysis RPC URLs share one provider and one CU budget.

**Architecture:** Replace method-level discovery failover in watch paths with a session runner that pins head and log reads to one provider. Construct role providers as one bundle so normalized identical URLs reuse a single budgeted ethers provider and have no self-fallback path.

**Tech Stack:** Node.js 18+, ECMAScript modules, ethers v6, built-in `node:test`.

---

## File map

- Create `src/rpc-endpoints.js`: URL normalization and role-provider construction.
- Create `src/discovery-session.js`: whole-session circuit breaker and fallback.
- Modify `src/chain.js`: build and expose the provider bundle.
- Modify `src/scanner.js`: run EVM and Pons discovery inside pinned sessions.
- Modify `src/rpc-failover.js`: retain only compatibility behavior still used by tests; watch no longer depends on method-level routing.
- Create `test/rpc-endpoints.test.js`: identical/different endpoint construction tests.
- Create `test/discovery-session.test.js`: whole-session retry and circuit tests.
- Modify `test/chain.test.js`: provider identity and explicit-provider checks.
- Modify `test/index.test.js`: onchain cursor and lagging fallback regression tests.
- Modify `test/scanner-pons.test.js`: Pons cursor and lagging fallback regression tests.
- Modify `README.md` and `.env.example`: operator-facing same-URL and failover behavior.

### Task 1: Construct role providers without duplicate schedulers

**Files:**
- Create: `src/rpc-endpoints.js`
- Create: `test/rpc-endpoints.test.js`

- [ ] **Step 1: Write the failing endpoint tests**

Create `test/rpc-endpoints.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRpcEndpoint,
  createRoleProviders,
} from "../src/rpc-endpoints.js";

describe("RPC role endpoints", () => {
  it("normalizes harmless URL spelling differences", () => {
    assert.equal(
      normalizeRpcEndpoint("HTTPS://RPC.Example:443/v2/key/"),
      normalizeRpcEndpoint("https://rpc.example/v2/key")
    );
  });

  it("preserves path and query values that may contain credentials", () => {
    assert.notEqual(
      normalizeRpcEndpoint("https://rpc.example/v2/Key"),
      normalizeRpcEndpoint("https://rpc.example/v2/key")
    );
    assert.notEqual(
      normalizeRpcEndpoint("https://rpc.example?v=One"),
      normalizeRpcEndpoint("https://rpc.example?v=one")
    );
  });

  it("reuses one provider and the lower budget for identical endpoints", () => {
    const calls = [];
    const bundle = createRoleProviders({
      discoveryUrl: "https://rpc.example/v2/key/",
      analysisUrl: "https://RPC.example:443/v2/key",
      discoveryCups: 150,
      analysisCups: 250,
      createProvider: (url, cups) => {
        const provider = { url, cups };
        calls.push(provider);
        return provider;
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cups, 150);
    assert.equal(bundle.discoveryPrimary, bundle.analysis);
    assert.equal(bundle.discoveryFallback, null);
    assert.equal(bundle.sameEndpoint, true);
  });

  it("creates two providers and exposes analysis as fallback for different endpoints", () => {
    const calls = [];
    const bundle = createRoleProviders({
      discoveryUrl: "https://official.example",
      analysisUrl: "https://analysis.example/v2/key",
      discoveryCups: 150,
      analysisCups: 250,
      createProvider: (url, cups) => {
        const provider = { url, cups };
        calls.push(provider);
        return provider;
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(bundle.discoveryPrimary, calls[0]);
    assert.equal(bundle.analysis, calls[1]);
    assert.equal(bundle.discoveryFallback, calls[1]);
    assert.equal(bundle.sameEndpoint, false);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/rpc-endpoints.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/rpc-endpoints.js`.

- [ ] **Step 3: Implement endpoint normalization and bundle construction**

Create `src/rpc-endpoints.js`:

```js
export function normalizeRpcEndpoint(value) {
  const parsed = new URL(value);
  parsed.hash = "";
  if ((parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")) {
    parsed.port = "";
  }
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.href;
}

export function createRoleProviders({
  discoveryUrl,
  analysisUrl,
  discoveryCups,
  analysisCups,
  createProvider,
}) {
  if (typeof createProvider !== "function") throw new Error("createProvider must be a function");
  const discoveryKey = normalizeRpcEndpoint(discoveryUrl);
  const analysisKey = normalizeRpcEndpoint(analysisUrl);
  if (discoveryKey === analysisKey) {
    const shared = createProvider(analysisUrl, Math.min(discoveryCups, analysisCups));
    return {
      analysis: shared,
      discoveryPrimary: shared,
      discoveryFallback: null,
      sameEndpoint: true,
    };
  }
  const discoveryPrimary = createProvider(discoveryUrl, discoveryCups);
  const analysis = createProvider(analysisUrl, analysisCups);
  return {
    analysis,
    discoveryPrimary,
    discoveryFallback: analysis,
    sameEndpoint: false,
  };
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node --test test/rpc-endpoints.test.js`

Expected: all endpoint tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rpc-endpoints.js test/rpc-endpoints.test.js
git commit -m "复用相同地址的 RPC 请求预算"
```

### Task 2: Add whole-discovery-session failover

**Files:**
- Create: `src/discovery-session.js`
- Create: `test/discovery-session.test.js`

- [ ] **Step 1: Write failing whole-session tests**

Create `test/discovery-session.test.js` with providers carrying observable names. Cover these cases:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDiscoverySessionRunner } from "../src/discovery-session.js";

describe("discovery session runner", () => {
  it("pins every read in one successful session to primary", async () => {
    const primary = { name: "official" };
    const fallback = { name: "analysis" };
    const seen = [];
    const sessions = createDiscoverySessionRunner({
      primary, fallback, shouldFallback: () => true,
      cooldownMs: 60_000, now: () => 0, log: () => {},
    });
    const value = await sessions.run(async (provider) => {
      seen.push(provider.name, provider.name);
      return 102;
    });
    assert.equal(value, 102);
    assert.deepEqual(seen, ["official", "official"]);
  });

  it("restarts the complete callback on fallback", async () => {
    const primary = { name: "official" };
    const fallback = { name: "analysis" };
    const attempts = [];
    const sessions = createDiscoverySessionRunner({
      primary, fallback, shouldFallback: () => true,
      cooldownMs: 60_000, now: () => 0, log: () => {},
    });
    const value = await sessions.run(async (provider) => {
      attempts.push(provider.name);
      if (provider === primary) throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
      return 98;
    });
    assert.equal(value, 98);
    assert.deepEqual(attempts, ["official", "analysis"]);
  });

  it("does not self-fallback when fallback is absent", async () => {
    const primary = { name: "shared" };
    let calls = 0;
    const sessions = createDiscoverySessionRunner({
      primary, fallback: null, shouldFallback: () => true,
      cooldownMs: 60_000, now: () => 0, log: () => {},
    });
    await assert.rejects(() => sessions.run(async () => {
      calls += 1;
      throw Object.assign(new Error("rate limited"), { status: 429 });
    }), /rate limited/);
    assert.equal(calls, 1);
  });

  it("uses fallback during cooldown and probes primary once after cooldown", async () => {
    let now = 0;
    let fail = true;
    const calls = [];
    const primary = { name: "official" };
    const fallback = { name: "analysis" };
    const sessions = createDiscoverySessionRunner({
      primary, fallback, shouldFallback: () => true,
      cooldownMs: 60_000, now: () => now, log: () => {},
    });
    const work = async (provider) => {
      calls.push(provider.name);
      if (provider === primary && fail) throw new Error("temporary");
      return provider.name;
    };
    assert.equal(await sessions.run(work), "analysis");
    now = 30_000;
    assert.equal(await sessions.run(work), "analysis");
    now = 60_000;
    fail = false;
    assert.equal(await sessions.run(work), "official");
    assert.deepEqual(calls, ["official", "analysis", "analysis", "official"]);
  });
});
```

Also carry forward the existing expectations from `test/rpc-failover.test.js`: permanent errors do not fall back, both errors are preserved in `AggregateError`, only state changes are logged, and endpoint secrets are redacted.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/discovery-session.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the session runner**

Create `src/discovery-session.js`:

```js
import { safeErrorMessage } from "./safety.js";

export function createDiscoverySessionRunner({
  primary,
  fallback = null,
  shouldFallback,
  cooldownMs,
  now = Date.now,
  log = console.warn,
}) {
  if (!primary) throw new Error("primary discovery provider is required");
  if (typeof shouldFallback !== "function") throw new Error("shouldFallback must be a function");
  if (!Number.isInteger(cooldownMs) || cooldownMs <= 0) {
    throw new Error("cooldownMs must be a positive integer");
  }
  let openUntil = 0;
  let probeInFlight = false;
  let openingError = null;

  async function onFallback(work, primaryError = openingError) {
    if (!fallback) throw primaryError;
    try {
      return await work(fallback);
    } catch (fallbackError) {
      throw new AggregateError(
        [primaryError, fallbackError].filter(Boolean),
        "discovery session failed on primary and fallback"
      );
    }
  }

  async function run(work) {
    if (typeof work !== "function") throw new Error("discovery work must be a function");
    const current = now();
    if (fallback && current < openUntil) return onFallback(work);
    if (fallback && probeInFlight) return onFallback(work);

    const probing = fallback && openUntil > 0;
    if (probing) probeInFlight = true;
    try {
      const result = await work(primary);
      if (probing) {
        openUntil = 0;
        openingError = null;
        log("发现 RPC 已恢复，后续扫描切回主节点");
      }
      return result;
    } catch (error) {
      if (!fallback || !shouldFallback(error)) throw error;
      const firstOpen = openUntil === 0;
      openingError = error;
      openUntil = now() + cooldownMs;
      if (firstOpen) log(`发现 RPC 进入熔断：${safeErrorMessage(error)}`);
      return onFallback(work, error);
    } finally {
      if (probing) probeInFlight = false;
    }
  }

  return { run };
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/discovery-session.test.js test/rpc-failover.test.js`

Expected: all tests PASS. Existing method-level tests remain as compatibility coverage until Task 6 removes unused wiring.

- [ ] **Step 5: Commit**

```bash
git add src/discovery-session.js test/discovery-session.test.js
git commit -m "按扫描会话切换发现 RPC"
```

### Task 3: Wire the provider bundle into chain access

**Files:**
- Modify: `src/chain.js`
- Modify: `test/chain.test.js`

- [ ] **Step 1: Add failing identity tests**

Add injectable construction coverage around a new export:

```js
import { createChainRpcContext } from "../src/chain.js";

it("shares one provider and disables fallback for the same normalized URL", () => {
  const made = [];
  const context = createChainRpcContext({
    chain: { id: 4663, discoveryRpc: "https://rpc.example/x/", analysisRpc: "https://RPC.example:443/x" },
    settings: { discoveryRpcCups: 150, analysisRpcCups: 250, discoveryRpcCooldownMs: 60_000 },
    createProvider: (url, cups) => {
      const provider = { url, cups };
      made.push(provider);
      return provider;
    },
    shouldFallback: () => true,
    log: () => {},
  });
  assert.equal(made.length, 1);
  assert.equal(context.analysisProvider, context.discoveryPrimary);
  assert.equal(context.discoveryFallback, null);
});
```

Add a different-URL case proving `discoverySessions.run()` receives the primary, then the already-created analysis provider after a transient primary failure.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/chain.test.js`

Expected: FAIL because `createChainRpcContext` does not exist.

- [ ] **Step 3: Build the context once**

In `src/chain.js`, export an injectable constructor and use it for the singleton:

```js
import { createRoleProviders } from "./rpc-endpoints.js";
import { createDiscoverySessionRunner } from "./discovery-session.js";

export function createChainRpcContext({
  chain,
  settings,
  createProvider = createBudgetedJsonRpcProvider,
  shouldFallback = isDiscoveryFallbackError,
  log = console.warn,
}) {
  const providers = createRoleProviders({
    discoveryUrl: chain.discoveryRpc,
    analysisUrl: chain.analysisRpc,
    discoveryCups: settings.discoveryRpcCups,
    analysisCups: settings.analysisRpcCups,
    createProvider,
  });
  return {
    analysisProvider: providers.analysis,
    discoveryPrimary: providers.discoveryPrimary,
    discoveryFallback: providers.discoveryFallback,
    discoverySessions: createDiscoverySessionRunner({
      primary: providers.discoveryPrimary,
      fallback: providers.discoveryFallback,
      shouldFallback,
      cooldownMs: settings.discoveryRpcCooldownMs,
      log,
    }),
  };
}
```

Replace the two separate singleton variables with one lazy `rpcContext`. Keep `getProvider()` as the analysis alias. Export `getDiscoverySessions()` for watch. Do not make `getDiscoveryProvider()` return a method-level proxy; either return `discoveryPrimary` for backward-compatible non-watch callers or remove callers in Task 6 before deleting the export.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/chain.test.js test/rpc-endpoints.test.js test/discovery-session.test.js test/rpc-budget.test.js`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chain.js test/chain.test.js
git commit -m "集中构建链级 RPC 上下文"
```

### Task 4: Make onchain cursor advancement session-safe

**Files:**
- Modify: `src/scanner.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: Add a lagging-fallback regression test**

Create a fake session runner that first invokes the callback with an official provider at head 102, fails during logs, then invokes the complete callback with an analysis provider at head 98. Assert every scan uses the provider that supplied its head and the committed cursor is 98, never 102:

```js
const official = { name: "official", head: 102 };
const analysis = { name: "analysis", head: 98 };
const scans = [];
let cursor = 90;
const runDiscoverySession = async (work) => {
  await assert.rejects(() => work(official), /official logs failed/);
  return work(analysis);
};
await runWatchIteration({ lastBlock: 90, lastGecko: 0 }, {
  settings: { onchainScan: true, geckoScan: false, confirmationBlocks: 0, maxAgeMinutes: 30 },
  runDiscoverySession,
  now: () => 1_000,
  getBlockNumber: async (provider) => provider.head,
  getOnchainCursor: () => cursor,
  findFirstBlockAtOrAfter: async () => 0,
  scanOnchain: async (from, to, provider) => {
    scans.push([provider.name, from, to]);
    if (provider === official) throw new Error("official logs failed");
    return [];
  },
  handleEvents: async () => ({ accepted: 0, handled: 0, failed: 0 }),
  setOnchainCursor: (value) => { cursor = value; },
  log: () => {},
});
assert.deepEqual(scans, [["official", 91, 102], ["analysis", 91, 98]]);
assert.equal(cursor, 98);
```

Also add a failed candidate-handling case proving neither persistent cursor nor in-memory `lastBlock` advances.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/index.test.js`

Expected: FAIL because `runWatchIteration` reads the head outside a pinned session and `processOnchainRange` commits internally.

- [ ] **Step 3: Return progress before committing it**

Remove `setOnchainCursor` from `processOnchainRange`; make it return `{ events, accepted, handled, failed, complete }`. In `runWatchIteration`, execute height, boundary and logs through one provider:

```js
const result = await dependencies.runDiscoverySession(async (provider) => {
  const latestHead = await dependencies.getBlockNumber(provider);
  const safeHead = latestHead - (settings.confirmationBlocks ?? 0);
  let lastBlock = state.lastBlock;
  if (safeHead >= 0 && lastBlock == null) {
    lastBlock = await initialOnchainCursor({
      head: safeHead,
      savedCursor: dependencies.getOnchainCursor(),
      maxAgeMinutes: settings.maxAgeMinutes,
      now: dependencies.now,
      findFirstBlockAtOrAfter: (target, head) =>
        dependencies.findFirstBlockAtOrAfter(target, head, provider),
    });
  }
  if (safeHead < 0 || safeHead <= lastBlock) return { safeHead, lastBlock, scanned: null };
  const from = lastBlock + 1;
  const scanned = await processOnchainRange(
    { from, head: safeHead },
    {
      scanOnchain: (start, end) => dependencies.scanOnchain(start, end, provider),
      handleEvents: (events) => dependencies.handleEvents(
        events.map((event) => ({ ...event, observedAt: event.observedAt ?? observedAt })),
        "onchain"
      ),
    }
  );
  return { safeHead, lastBlock, from, scanned };
});
if (result.scanned?.complete) {
  dependencies.setOnchainCursor(result.safeHead);
  state.lastBlock = result.safeHead;
} else if (result.scanned) {
  dependencies.log(`onchain ${result.from}-${result.safeHead}: ${result.scanned.failed} failed; cursor not advanced`);
} else if (state.lastBlock == null) {
  state.lastBlock = result.lastBlock;
}
```

The initial boundary calculation must not persist a cursor by itself. A completed empty range may advance to its safe head.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/index.test.js test/chain.test.js`

Expected: all focused tests PASS; the new test commits 98, not 102.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.js test/index.test.js
git commit -m "按同一 RPC 会话提交发现游标"
```

### Task 5: Make Pons cursor advancement session-safe

**Files:**
- Modify: `src/scanner.js`
- Modify: `test/scanner-pons.test.js`

- [ ] **Step 1: Add Pons lagging-fallback tests**

Inject the same official-102/analysis-98 session pattern into `runPonsWatchIteration`. Assert `scanRange` receives the provider and safe range belonging to the same backend, `store.commitPonsRange` never receives 102 after the official failure, and recovery mode still sets `scheduleChecks: false`.

Use a store spy with:

```js
const committed = [];
const store = {
  getPonsCursor: () => 90,
  commitPonsRange: ({ toBlock }) => committed.push(toBlock),
};
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/scanner-pons.test.js`

Expected: FAIL because Pons obtains its safe head through method-level fallback rather than a whole session.

- [ ] **Step 3: Wrap the full Pons iteration**

Change `runPonsWatchIteration` to call `dependencies.runDiscoverySession(async (provider) => ...)`. Inside that callback:

- read the head from `provider`;
- find the initial boundary from `provider`;
- pass `provider` into `watchPonsRange`, `scanRange`, and `readLaunch`;
- return the completed safe head.

Assign `state.lastBlock` only after the session returns successfully. Preserve `scheduleChecks: !recovering`, and let the existing atomic store commit remain the persistent cursor authority.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/scanner-pons.test.js test/store.test.js test/pons.test.js`

Expected: all tests PASS and fallback commits only the fallback safe head.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.js test/scanner-pons.test.js
git commit -m "固定 Pons 扫描会话的 RPC 节点"
```

### Task 6: Replace watch wiring and remove self-failover

**Files:**
- Modify: `src/scanner.js`
- Modify: `src/chain.js`
- Modify: `src/rpc-failover.js`
- Modify: `test/index.test.js`
- Modify: `test/rpc-failover.test.js`

- [ ] **Step 1: Add watch wiring tests**

Test an injected watch dependency factory rather than starting an infinite loop. Assert both onchain and Pons loops receive the same `discoverySessions.run` function, while `analyze` receives `analysisProvider`. Add a same-URL case proving one failing request is attempted once and returned to the loop as a recoverable error without a second request to the same URL.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/index.test.js test/rpc-failover.test.js`

Expected: FAIL because `watch()` still consumes the method-level failover proxy.

- [ ] **Step 3: Use the session context in watch**

In `watch()`, replace `getDiscoveryProvider()` with the chain RPC context:

```js
const analysisProvider = getAnalysisProvider();
const discoverySessions = getDiscoverySessions();
const runDiscoverySession = (work) => discoverySessions.run(work);
const getDiscoveryBlockNumber = (provider) => getBlockNumber(provider);
const findDiscoveryStart = (target, head, provider) =>
  findFirstBlockAtOrAfter(target, head, provider);
const scanDiscovery = (from, to, provider) =>
  scanOnchain(from, to, { provider });
```

Pass `runDiscoverySession` and explicit-provider callbacks to onchain, Pons, and startup checks. Candidate identity classification may use the analysis provider because it is candidate work, not high-frequency range discovery.

Remove the production import and construction of `createFailoverProvider`. Delete `src/rpc-failover.js` only if `rg "createFailoverProvider" src test` confirms no remaining production or test caller; otherwise retain it as a separately tested compatibility primitive without using it in watch.

- [ ] **Step 4: Run directly affected tests**

Run: `node --test test/index.test.js test/scanner-pons.test.js test/chain.test.js test/discovery-session.test.js test/rpc-endpoints.test.js test/rpc-budget.test.js`

Expected: all directly affected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scanner.js src/chain.js src/rpc-failover.js test/index.test.js test/rpc-failover.test.js
git commit -m "在监控流程启用整轮 RPC 回退"
```

### Task 7: Document and verify Phase 0

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Update operator documentation**

Document these exact behaviors:

- discovery and analysis URLs that normalize to the same endpoint share the lower of the two configured CUPS budgets;
- same-endpoint mode has no fallback retry to itself;
- different-endpoint failover restarts the entire uncommitted discovery range and re-reads the fallback head;
- range and candidate errors are logged but the long-running watch process remains alive;
- secrets remain redacted from logs.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: exit code 0 and every test PASS.

- [ ] **Step 3: Run static repository checks**

Run:

```bash
git diff --check
node --check src/rpc-endpoints.js
node --check src/discovery-session.js
node --check src/chain.js
node --check src/scanner.js
```

Expected: all commands exit 0 with no syntax or whitespace errors.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md .env.example
git commit -m "说明 RPC 会话回退与共享限流"
```

- [ ] **Step 5: Fresh final verification**

Run:

```bash
npm test
git diff --check HEAD~7..HEAD
git status --short --branch
```

Expected: all tests PASS, diff check is clean, and the working tree contains no uncommitted files.

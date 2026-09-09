# Dual RPC Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route high-frequency Robinhood Chain discovery through the official public RPC while reserving Alchemy for candidate analysis and bounded discovery failover.

**Architecture:** Add explicit discovery and analysis RPC configuration, then build two independently budgeted ethers providers. Wrap the discovery provider in a method-level circuit breaker whose fallback is the already-budgeted analysis provider, and wire scanner discovery/lifecycle operations to the discovery role while keeping all security analysis on the analysis role.

**Tech Stack:** Node.js 18+, ECMAScript modules, ethers v6, built-in `node:test`, dotenv.

---

### Task 1: Add dual-RPC configuration with legacy compatibility

**Files:**
- Modify: `src/config.js:14-84`
- Modify: `src/config.js:155-203`
- Modify: `test/config.test.js:9-70`

- [ ] **Step 1: Add failing configuration tests**

Extend `test/config.test.js` with a helper that prints the resolved RPC settings from a clean child process:

```js
function readRpcConfig(overrides = {}) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import('./src/config.js').then(({ CHAIN, SETTINGS }) => {
        console.log(JSON.stringify({
          discoveryRpc: CHAIN.discoveryRpc,
          analysisRpc: CHAIN.analysisRpc,
          legacyRpc: CHAIN.rpc,
          discoveryRpcCups: SETTINGS.discoveryRpcCups,
          analysisRpcCups: SETTINGS.analysisRpcCups,
          discoveryRpcCooldownMs: SETTINGS.discoveryRpcCooldownMs,
        }));
      })`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        RPC_URL: "",
        DISCOVERY_RPC_URL: "",
        ANALYSIS_RPC_URL: "",
        DISCOVERY_RPC_CUPS: "",
        ANALYSIS_RPC_CUPS: "",
        DISCOVERY_RPC_COOLDOWN_MS: "",
        POLL_MS: "2500",
        GECKO_POLL_MS: "15000",
        MAX_AGE_MINUTES: "30",
        ONCHAIN_SCAN: "true",
        GECKO_SCAN: "true",
        QUOTE_TOKENS: "WETH,ETH,USDG",
        ...overrides,
      },
      encoding: "utf8",
    }
  );
}
```

Add these tests:

```js
it("uses the official endpoint for discovery and the legacy RPC for analysis", () => {
  const result = readRpcConfig({ RPC_URL: "https://legacy.example/v2/key" });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.discoveryRpc, "https://rpc.mainnet.chain.robinhood.com");
  assert.equal(config.analysisRpc, "https://legacy.example/v2/key");
  assert.equal(config.legacyRpc, config.analysisRpc);
});

it("prefers explicit discovery and analysis endpoints", () => {
  const result = readRpcConfig({
    RPC_URL: "https://legacy.example/v2/key",
    DISCOVERY_RPC_URL: "https://discovery.example",
    ANALYSIS_RPC_URL: "https://analysis.example/v2/key",
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.discoveryRpc, "https://discovery.example");
  assert.equal(config.analysisRpc, "https://analysis.example/v2/key");
});

it("uses positive dual-RPC budget defaults", () => {
  const result = readRpcConfig();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(
    [config.discoveryRpcCups, config.analysisRpcCups, config.discoveryRpcCooldownMs],
    [150, 250, 60_000]
  );
});

for (const [name, value] of [
  ["DISCOVERY_RPC_CUPS", "0"],
  ["ANALYSIS_RPC_CUPS", "1.5"],
  ["DISCOVERY_RPC_COOLDOWN_MS", "-1"],
]) {
  it(`rejects invalid ${name}`, () => {
    const result = readRpcConfig({ [name]: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(name));
  });
}

for (const [name, value] of [
  ["DISCOVERY_RPC_URL", "ftp://discovery.example"],
  ["ANALYSIS_RPC_URL", "not-a-url"],
]) {
  it(`rejects invalid ${name}`, () => {
    const result = readRpcConfig({ [name]: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(name));
  });
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/config.test.js
```

Expected: FAIL because `DISCOVERY_RPC_URL`, `ANALYSIS_RPC_URL`, and the three numeric variables are not allowed or exported.

- [ ] **Step 3: Implement the minimal configuration**

Add the five new names to `ALLOWED_ENV` in `src/config.js`:

```js
"DISCOVERY_RPC_URL",
"ANALYSIS_RPC_URL",
"DISCOVERY_RPC_CUPS",
"ANALYSIS_RPC_CUPS",
"DISCOVERY_RPC_COOLDOWN_MS",
```

Validate and resolve endpoints once before exporting `CHAIN`:

```js
const OFFICIAL_RPC = "https://rpc.mainnet.chain.robinhood.com";

function validateRpcUrl(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  return value;
}

const explicitAnalysisRpc = env("ANALYSIS_RPC_URL", "");
const analysisInput = explicitAnalysisRpc || env("RPC_URL", OFFICIAL_RPC);
const discoveryInput = env("DISCOVERY_RPC_URL", OFFICIAL_RPC);
const analysisRpc = validateRpcUrl(
  explicitAnalysisRpc ? "ANALYSIS_RPC_URL" : "RPC_URL",
  analysisInput
);
const discoveryRpc = validateRpcUrl("DISCOVERY_RPC_URL", discoveryInput);

export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  rpc: analysisRpc,
  discoveryRpc,
  analysisRpc,
  explorer: "https://robinhoodchain.blockscout.com",
  dexScreener: "https://dexscreener.com/robinhood",
  geckoNetwork: "robinhood",
  nativeSymbol: "ETH",
};
```

Add validated settings:

```js
discoveryRpcCups: validatePositiveInteger(
  "DISCOVERY_RPC_CUPS",
  envNum("DISCOVERY_RPC_CUPS", 150)
),
analysisRpcCups: validatePositiveInteger(
  "ANALYSIS_RPC_CUPS",
  envNum("ANALYSIS_RPC_CUPS", 250)
),
discoveryRpcCooldownMs: validatePositiveInteger(
  "DISCOVERY_RPC_COOLDOWN_MS",
  envNum("DISCOVERY_RPC_COOLDOWN_MS", 60_000)
),
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/config.test.js
```

Expected: all configuration tests PASS.

- [ ] **Step 5: Commit the configuration slice**

```bash
git add src/config.js test/config.test.js
git commit -m "配置双 RPC 节点与独立限速"
```

---

### Task 2: Implement the discovery circuit breaker

**Files:**
- Create: `src/rpc-failover.js`
- Create: `test/rpc-failover.test.js`

- [ ] **Step 1: Write failing routing tests**

Create `test/rpc-failover.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFailoverProvider } from "../src/rpc-failover.js";

function provider(name, calls, implementation = async () => name) {
  return {
    async getBlockNumber(...args) {
      calls.push([name, "getBlockNumber", args]);
      return implementation(...args);
    },
  };
}

describe("discovery RPC failover", () => {
  it("uses only the primary while the circuit is closed", async () => {
    const calls = [];
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => 10),
      fallback: provider("analysis", calls, async () => 11),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 10);
    assert.deepEqual(calls.map(([name]) => name), ["official"]);
  });

  it("falls back once and bypasses the primary during cooldown", async () => {
    const calls = [];
    let now = 0;
    const failure = Object.assign(new Error("rate limited"), { status: 429 });
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => { throw failure; }),
      fallback: provider("analysis", calls, async () => 20),
      shouldFallback: (error) => error === failure,
      cooldownMs: 60_000,
      now: () => now,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 20);
    now = 30_000;
    assert.equal(await routed.getBlockNumber(), 20);
    assert.deepEqual(calls.map(([name]) => name), ["official", "analysis", "analysis"]);
  });

  it("probes once after cooldown and restores the primary", async () => {
    const calls = [];
    let now = 0;
    let officialCalls = 0;
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => {
        officialCalls += 1;
        if (officialCalls === 1) throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
        return 30;
      }),
      fallback: provider("analysis", calls, async () => 20),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 20);
    now = 60_000;
    assert.equal(await routed.getBlockNumber(), 30);
    assert.equal(await routed.getBlockNumber(), 30);
    assert.deepEqual(calls.map(([name]) => name), ["official", "analysis", "official", "official"]);
  });

  it("renews cooldown when the half-open probe still fails", async () => {
    const calls = [];
    let now = 0;
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => {
        throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
      }),
      fallback: provider("analysis", calls, async () => 20),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 20);
    now = 60_000;
    assert.equal(await routed.getBlockNumber(), 20);
    now = 90_000;
    assert.equal(await routed.getBlockNumber(), 20);
    assert.deepEqual(calls.map(([name]) => name), [
      "official", "analysis", "official", "analysis", "analysis",
    ]);
  });

  it("allows only one half-open probe", async () => {
    const calls = [];
    let now = 0;
    let resolveProbe;
    let officialCalls = 0;
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => {
        officialCalls += 1;
        if (officialCalls === 1) throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
        return new Promise((resolve) => { resolveProbe = resolve; });
      }),
      fallback: provider("analysis", calls, async () => 20),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 20);
    now = 60_000;
    const probe = routed.getBlockNumber();
    const concurrent = routed.getBlockNumber();
    assert.equal(await concurrent, 20);
    resolveProbe(30);
    assert.equal(await probe, 30);
    assert.deepEqual(calls.map(([name]) => name), ["official", "analysis", "official", "analysis"]);
  });

  it("does not fall back for permanent errors", async () => {
    const calls = [];
    const permanent = Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => { throw permanent; }),
      fallback: provider("analysis", calls),
      shouldFallback: () => false,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    await assert.rejects(() => routed.getBlockNumber(), (error) => error === permanent);
    assert.deepEqual(calls.map(([name]) => name), ["official"]);
  });

  it("preserves both errors when primary and fallback fail", async () => {
    const primaryError = new Error("official unavailable");
    const fallbackError = new Error("analysis unavailable");
    const routed = createFailoverProvider({
      primary: provider("official", [], async () => { throw primaryError; }),
      fallback: provider("analysis", [], async () => { throw fallbackError; }),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    await assert.rejects(
      () => routed.getBlockNumber(),
      (error) => error instanceof AggregateError
        && error.errors[0] === primaryError
        && error.errors[1] === fallbackError
    );
  });

  it("logs only state changes and redacts URLs", async () => {
    const logs = [];
    let now = 0;
    let fail = true;
    const routed = createFailoverProvider({
      primary: provider("official", [], async () => {
        if (fail) throw new Error("timeout at https://rpc.example/private-key");
        return 30;
      }),
      fallback: provider("analysis", [], async () => 20),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: (message) => logs.push(message),
    });
    await routed.getBlockNumber();
    await routed.getBlockNumber();
    now = 60_000;
    fail = false;
    await routed.getBlockNumber();
    assert.equal(logs.length, 2);
    assert.match(logs[0], /熔断|fallback/i);
    assert.match(logs[1], /恢复|recover/i);
    assert.doesNotMatch(logs.join("\n"), /rpc\.example|private-key/);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/rpc-failover.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/rpc-failover.js`.

- [ ] **Step 3: Implement the minimal failover provider**

Create `src/rpc-failover.js`:

```js
import { safeErrorMessage } from "./safety.js";

export function createFailoverProvider({
  primary,
  fallback,
  shouldFallback,
  cooldownMs,
  now = Date.now,
  log = console.warn,
}) {
  if (!primary || !fallback) throw new Error("primary and fallback providers are required");
  if (typeof shouldFallback !== "function") throw new Error("shouldFallback must be a function");
  if (!Number.isInteger(cooldownMs) || cooldownMs <= 0) {
    throw new Error("cooldownMs must be a positive integer");
  }

  let circuitOpen = false;
  let openUntil = 0;
  let probeInFlight = false;

  const runFallback = async (method, args, primaryError = null) => {
    try {
      return await fallback[method](...args);
    } catch (fallbackError) {
      if (!primaryError) throw fallbackError;
      throw new AggregateError(
        [primaryError, fallbackError],
        `discovery RPC ${String(method)} failed on primary and fallback`
      );
    }
  };

  const open = (error) => {
    const changed = !circuitOpen;
    circuitOpen = true;
    openUntil = now() + cooldownMs;
    if (changed) {
      log(`发现 RPC 进入熔断，临时使用分析备用节点：${safeErrorMessage(error)}`);
    }
  };

  const invoke = async (method, args) => {
    const current = now();
    if (circuitOpen && current < openUntil) return runFallback(method, args);
    if (circuitOpen && probeInFlight) return runFallback(method, args);

    const probing = circuitOpen;
    if (probing) probeInFlight = true;
    try {
      const result = await primary[method](...args);
      if (probing) {
        circuitOpen = false;
        openUntil = 0;
        log("发现 RPC 已恢复，切回官方节点");
      }
      return result;
    } catch (error) {
      if (!shouldFallback(error)) throw error;
      open(error);
      return runFallback(method, args, error);
    } finally {
      if (probing) probeInFlight = false;
    }
  };

  return new Proxy(primary, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => invoke(property, args);
    },
  });
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/rpc-failover.test.js
```

Expected: all failover tests PASS.

- [ ] **Step 5: Commit the failover primitive**

```bash
git add src/rpc-failover.js test/rpc-failover.test.js
git commit -m "实现发现 RPC 熔断回退"
```

---

### Task 3: Build separately budgeted providers and classify transient failures

**Files:**
- Modify: `src/chain.js:1-31`
- Modify: `src/chain.js:41-99`
- Modify: `src/chain.js:102-104`
- Modify: `src/chain.js:247-318`
- Modify: `test/chain.test.js`
- Modify: `test/rpc-budget.test.js`

- [ ] **Step 1: Add failing chain/provider tests**

In `test/chain.test.js`, import the new exports and add transient classification cases:

```js
import {
  getAnalysisProvider,
  getDiscoveryProvider,
  getProvider,
  isDiscoveryFallbackError,
  scanOnchain,
} from "../src/chain.js";

it("keeps getProvider as the analysis provider alias", () => {
  assert.equal(getProvider(), getAnalysisProvider());
  assert.notEqual(getDiscoveryProvider(), getAnalysisProvider());
});

for (const error of [
  { status: 408, message: "request timeout" },
  { status: 503, message: "service unavailable" },
  { code: "NETWORK_ERROR", message: "socket closed" },
  { code: "TIMEOUT", message: "request timed out" },
  { error: { code: 429, message: "throughput exceeded" } },
]) {
  it(`falls back for transient discovery failure ${error.status || error.code || "nested"}`, () => {
    assert.equal(isDiscoveryFallbackError(error), true);
  });
}

for (const error of [
  { code: "CALL_EXCEPTION", message: "execution reverted" },
  { code: "INVALID_ARGUMENT", message: "invalid address" },
  { code: -32601, message: "method not found" },
  new Error("token metadata missing"),
]) {
  it(`does not fall back for permanent discovery failure ${error.code || error.message}`, () => {
    assert.equal(isDiscoveryFallbackError(error), false);
  });
}

it("passes one explicit provider through every onchain discovery read", async () => {
  const discoveryProvider = { role: "discovery" };
  const seen = [];
  await scanOnchain(10, 11, {
    provider: discoveryProvider,
    getLogs: async (request) => {
      seen.push(request.provider);
      return [];
    },
    attachTimes: async (events, provider) => {
      seen.push(provider);
      return events;
    },
  });
  assert.deepEqual(seen, [discoveryProvider, discoveryProvider, discoveryProvider, discoveryProvider]);
});
```

In `test/rpc-budget.test.js`, import `createFailoverProvider` and prove the router reuses the already-budgeted analysis object rather than creating a new budget:

```js
it("lets discovery fallback reuse an already budgeted analysis provider", async () => {
  const charged = [];
  const analysis = createBudgetedProvider({
    async getBlockNumber() { return 22; },
  }, async (cost, operation) => {
    charged.push(cost);
    return operation();
  });
  const discovery = createFailoverProvider({
    primary: {
      async getBlockNumber() {
        throw Object.assign(new Error("official timeout"), { code: "TIMEOUT" });
      },
    },
    fallback: analysis,
    shouldFallback: () => true,
    cooldownMs: 60_000,
    now: () => 0,
    log: () => {},
  });
  assert.equal(await discovery.getBlockNumber(), 22);
  assert.deepEqual(charged, [RPC_CU.getBlockNumber]);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/chain.test.js test/rpc-budget.test.js
```

Expected: FAIL because the role-specific provider exports, transient classifier, and `scanOnchain` provider injection do not exist.

- [ ] **Step 3: Implement provider factories and error classification**

Update imports and singleton state in `src/chain.js`:

```js
import { ADDR, CHAIN, SETTINGS, isQuote } from "./config.js";
import { createFailoverProvider } from "./rpc-failover.js";

let analysisProvider;
let discoveryProvider;

function createBudgetedJsonRpcProvider(url, cuPerSecond) {
  const provider = new JsonRpcProvider(url, CHAIN.id, { staticNetwork: true });
  return createBudgetedProvider(provider, createRpcScheduler({ cuPerSecond }));
}

export function getAnalysisProvider() {
  if (!analysisProvider) {
    analysisProvider = createBudgetedJsonRpcProvider(CHAIN.analysisRpc, SETTINGS.analysisRpcCups);
  }
  return analysisProvider;
}

export function getDiscoveryProvider() {
  if (!discoveryProvider) {
    const official = createBudgetedJsonRpcProvider(CHAIN.discoveryRpc, SETTINGS.discoveryRpcCups);
    discoveryProvider = createFailoverProvider({
      primary: official,
      fallback: getAnalysisProvider(),
      shouldFallback: isDiscoveryFallbackError,
      cooldownMs: SETTINGS.discoveryRpcCooldownMs,
      log: console.warn,
    });
  }
  return discoveryProvider;
}

export function getProvider() {
  return getAnalysisProvider();
}
```

Extend the existing nested error traversal rather than matching only the outer ethers error:

```js
export function isDiscoveryFallbackError(error) {
  if (isRateLimitError(error)) return true;
  return errorDetails(error).some((value) => {
    const status = Number(typeof value === "object" ? value.status || value.statusCode : NaN);
    const code = typeof value === "object" ? String(value.code || "").toUpperCase() : "";
    const message = typeof value === "string"
      ? value
      : `${value.shortMessage || ""} ${value.message || ""}`;
    return [408, 500, 502, 503, 504].includes(status)
      || ["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT"].includes(code)
      || /\b(?:timed?\s*out|connection|socket|econnreset|econnrefused|enotfound|eai_again|service unavailable|bad gateway|gateway timeout)\b/i.test(message);
  });
}
```

Make `getBlockNumber` injectable without changing its default analysis behavior:

```js
export async function getBlockNumber(provider = getAnalysisProvider()) {
  return withRetry(() => provider.getBlockNumber());
}
```

Extend `scanOnchain` options and pass the same provider into all reads:

```js
export async function scanOnchain(
  fromBlock,
  toBlock,
  {
    provider = getAnalysisProvider(),
    getLogs = getLogsChunked,
    attachTimes = attachBlockTimes,
  } = {}
) {
  const common = { fromBlock, toBlock, provider };
  const [v2logs, v3logs, v4logs] = await Promise.all([
    getLogs({ ...common, address: ADDR.V2_FACTORY, topics: [TOPICS.pairCreated] }),
    getLogs({ ...common, address: ADDR.V3_FACTORY, topics: [TOPICS.poolCreated] }),
    getLogs({ ...common, address: ADDR.V4_POOL_MANAGER, topics: [TOPICS.initialize] }),
  ]);
  // The existing V2, V3 and V4 parsing loops remain immediately below these reads.
  return attachTimes(events, provider);
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test test/chain.test.js test/rpc-budget.test.js test/rpc-failover.test.js
```

Expected: all focused tests PASS with no network calls.

- [ ] **Step 5: Commit provider construction**

```bash
git add src/chain.js test/chain.test.js test/rpc-budget.test.js
git commit -m "拆分发现与分析 RPC Provider"
```

---

### Task 4: Route scanner and lifecycle calls by role

**Files:**
- Modify: `src/scanner.js:1-4`
- Modify: `src/scanner.js:658-822`
- Modify: `src/scanner.js:829-940`
- Modify: `src/scanner.js:964-973`
- Modify: `test/index.test.js`
- Modify: `test/scanner-pons.test.js`
- Modify: `test/push-only.test.js`

- [ ] **Step 1: Add failing scanner-routing tests**

Add a `scanOnce` routing test to `test/index.test.js`. Use distinct marker objects and dependency functions that assert which provider they receive:

```js
it("routes one-shot discovery to discovery RPC and analysis to analysis RPC", async () => {
  const discoveryProvider = { role: "discovery" };
  const analysisProvider = { role: "analysis" };
  const token = "0x1000000000000000000000000000000000000001";
  const event = {
    source: "onchain",
    venue: "uniswap-v2",
    token,
    pool: "0x2000000000000000000000000000000000000002",
    createdAt: Date.now(),
  };
  let analyzedWith;

  await scanOnce({
    timeoutMs: 2_000,
    now: () => Date.now(),
    settings: {
      onchainScan: true,
      geckoScan: false,
      confirmationBlocks: 0,
      ponsConfirmations: 0,
      maxAgeMinutes: 30,
      maxQueueSize: 10,
      minScore: 70,
    },
    discoveryProvider,
    analysisProvider,
    verifyPonsDeployment: async (provider) => assert.equal(provider, discoveryProvider),
    previewPonsRange: async ({ provider }) => {
      assert.equal(provider, discoveryProvider);
      return { transitions: [] };
    },
    getBlockNumber: async (provider) => {
      assert.equal(provider, discoveryProvider);
      return 100;
    },
    findFirstBlockAtOrAfter: async (_target, _head, provider) => {
      assert.equal(provider, discoveryProvider);
      return 90;
    },
    scanOnchain: async (_from, _to, { provider }) => {
      assert.equal(provider, discoveryProvider);
      return [event];
    },
    geckoNewPools: async () => [],
    classifyCandidate: async (candidate, { provider }) => {
      assert.equal(provider, discoveryProvider);
      return { ...candidate, identity: "not_pons", pad: "ordinary" };
    },
    analyze: async (_candidate, { provider }) => {
      analyzedWith = provider;
      return {
        token,
        pool: event.pool,
        poolId: null,
        venue: event.venue,
        meta: { symbol: "TEST" },
        score: 60,
        verdict: "skip",
        honeypot: { honeypot: null },
        sellability: { status: "unknown", reason: "unsupported-venue" },
        errorSources: [],
      };
    },
    consoleAlert: async () => {},
    consolePons: async () => {},
    log: () => {},
  });

  assert.equal(analyzedWith, analysisProvider);
});
```

Add a banner test to `test/push-only.test.js` that captures console output and asserts no URL is printed:

```js
it("prints RPC roles without exposing endpoint URLs", () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    scanner.banner();
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /Discovery RPC|发现 RPC/);
  assert.match(output, /Analysis RPC|分析 RPC/);
  assert.doesNotMatch(output, /https?:\/\//);
});
```

Update relevant Pons scanner fixtures in `test/scanner-pons.test.js` to name their provider `discoveryProvider`, and add an assertion that Pons range scanning receives that exact object.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/index.test.js test/scanner-pons.test.js test/push-only.test.js
```

Expected: FAIL because `scanOnce` still uses one `provider`, does not pass Provider options to analysis/discovery dependencies, and the banner still prints one RPC URL.

- [ ] **Step 3: Wire role-specific providers in watch mode**

Update imports in `src/scanner.js`:

```js
import {
  findFirstBlockAtOrAfter,
  getAnalysisProvider,
  getBlockNumber,
  getDiscoveryProvider,
  scanOnchain,
  sleep,
} from "./chain.js";
```

At watch startup create both roles once:

```js
const discoveryProvider = getDiscoveryProvider();
const analysisProvider = getAnalysisProvider();
const getDiscoveryBlockNumber = () => getBlockNumber(discoveryProvider);
const findDiscoveryStart = (target, head) =>
  findFirstBlockAtOrAfter(target, head, discoveryProvider);
const scanDiscovery = (from, to) =>
  scanOnchain(from, to, { provider: discoveryProvider });
const analyzeCandidate = (event) => analyze(event, { provider: analysisProvider });
```

Use `discoveryProvider` for:

```js
await verifyPonsDeployment(discoveryProvider);
await reconcilePonsWatchlist({ provider: discoveryProvider, store });
classifyAuxiliaryCandidate(event, { provider: discoveryProvider });
loops.push(runPonsWatchLoop(ponsState, {
  provider: discoveryProvider,
  store,
  settings: SETTINGS,
  getBlockNumber: getDiscoveryBlockNumber,
  findFirstBlockAtOrAfter: findDiscoveryStart,
  scanRange: scanPonsRange,
  readLaunch: readPonsLaunch,
  now: Date.now,
  sleep,
  log: console.log,
  logError: console.error,
}));
refreshMarketHeat({ provider: discoveryProvider, store });
```

Use `analysisProvider` for inspection handlers and candidate analysis:

```js
const pendingHandlers = {
  ...createInspectionCheckHandlers({ provider: analysisProvider, store }),
  candidate_recheck: createCandidateRecheckHandler({
    executeCandidate,
    now: Date.now,
    maxAgeMinutes: SETTINGS.maxAgeMinutes,
    minScore: SETTINGS.minScore,
    analyze: analyzeCandidate,
    alertReport,
    log: console.log,
  }),
};
```

Pass the discovery wrappers into both onchain watch iterations. Gecko candidates still use `analyzeCandidate`, but Gecko HTTP discovery itself does not use either RPC.

- [ ] **Step 4: Wire role-specific providers in one-shot scan**

Resolve compatibility fields at the start of `scanOnceCore`:

```js
const dependencies = supplied || {
  settings: SETTINGS,
  discoveryProvider: getDiscoveryProvider(),
  analysisProvider: getAnalysisProvider(),
  getBlockNumber,
  findFirstBlockAtOrAfter,
  scanOnchain,
  geckoNewPools,
  previewPonsRange,
  verifyPonsDeployment,
  analyze,
  classifyCandidate: classifyAuxiliaryCandidate,
  // Keep existing console/log functions.
};
const discoveryProvider = dependencies.discoveryProvider || dependencies.provider;
const analysisProvider = dependencies.analysisProvider || dependencies.provider || getAnalysisProvider();
```

Call dependencies with explicit roles:

```js
await dependencies.verifyPonsDeployment(discoveryProvider);
const latestHead = await dependencies.getBlockNumber(discoveryProvider);
const from = await dependencies.findFirstBlockAtOrAfter(target, head, discoveryProvider);
await dependencies.previewPonsRange({ provider: discoveryProvider, fromBlock: from, toBlock: head, now });
await dependencies.scanOnchain(from, head, { provider: discoveryProvider });
```

Wrap analysis and classification before passing them to `runReadOnlyCandidates`:

```js
analyze: (event) => dependencies.analyze(event, { provider: analysisProvider }),
classifyCandidate: (event) => dependencies.classifyCandidate(event, { provider: discoveryProvider }),
```

The `dependencies.provider` fallback preserves existing injected tests and callers while new runtime defaults always use explicit roles.

- [ ] **Step 5: Replace endpoint output with role-safe banner text**

Replace the single sanitized URL line:

```js
const sharedRpc = CHAIN.discoveryRpc === CHAIN.analysisRpc;
console.log(` Discovery RPC ${sharedRpc ? "shared endpoint" : "official primary + analysis fallback"}`);
console.log(` Analysis RPC configured${sharedRpc ? " (same endpoint; no CU separation)" : ""}`);
```

Do not print either URL. Keep `sanitizeRpcUrl` unchanged because other diagnostics/tests may still use it.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test test/index.test.js test/scanner-pons.test.js test/push-only.test.js test/analyze.test.js test/check.test.js
```

Expected: all focused tests PASS; no test performs a live RPC call.

- [ ] **Step 7: Commit scanner routing**

```bash
git add src/scanner.js test/index.test.js test/scanner-pons.test.js test/push-only.test.js
git commit -m "按角色路由扫描与深检 RPC"
```

---

### Task 5: Document deployment and verify the complete branch

**Files:**
- Modify: `.env.example:1-5`
- Modify: `README.md:95-125`

- [ ] **Step 1: Update the environment example**

Replace the current single-RPC block in `.env.example` with:

```dotenv
# High-frequency discovery uses the Robinhood public RPC first.
DISCOVERY_RPC_URL=https://rpc.mainnet.chain.robinhood.com
DISCOVERY_RPC_CUPS=150

# Candidate analysis and discovery failover use this provider.
# Existing deployments may keep RPC_URL instead of ANALYSIS_RPC_URL.
ANALYSIS_RPC_URL=
RPC_URL=
ANALYSIS_RPC_CUPS=250
DISCOVERY_RPC_COOLDOWN_MS=60000
```

Keep all real API keys out of the repository.

- [ ] **Step 2: Update README deployment guidance**

Document these exact behaviors in `README.md`:

````markdown
### 双 RPC 配置

- `DISCOVERY_RPC_URL` 默认使用 Robinhood 官方公共 RPC，负责区块、Factory 和 Pons 发现。
- `ANALYSIS_RPC_URL` 负责候选深检，并在官方节点网络错误、超时、429 或 5xx 时临时接管发现请求。
- 官方节点故障后进入 60 秒熔断；冷却结束会自动探测并切回官方。
- 旧 `RPC_URL` 仍可用：未填写 `ANALYSIS_RPC_URL` 时，它自动作为分析与备用节点。
- 官方公共 RPC 会限流；双 RPC 能减少 Alchemy CU，但不能保证完全没有节点错误或漏扫。

旧服务器可以保留：

```dotenv
RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<API_KEY>
```

显式配置写法：

```dotenv
DISCOVERY_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ANALYSIS_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<API_KEY>
```

修改后重启 `npm run watch`。
````

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
npm test
```

Expected: all tests PASS with zero failures, cancellations, or skipped tests.

Run:

```bash
git diff --check
```

Expected: no output and exit status 0.

Run:

```bash
git status --short --branch
```

Expected: only the intended documentation changes remain before the documentation commit; `data/wallet-labels.json` remains ignored and absent from Git status.

- [ ] **Step 4: Commit documentation**

```bash
git add .env.example README.md
git commit -m "说明双 RPC 部署配置"
```

- [ ] **Step 5: Re-run final verification after the last commit**

Run:

```bash
npm test
git diff --check HEAD^..HEAD
git status --short --branch
```

Expected: all tests PASS, diff check has no output, and the branch is clean except for being ahead of its remote.

- [ ] **Step 6: Update the existing pull request after explicit user approval**

Push the current feature branch and update PR #7 rather than creating another PR:

```bash
git push origin feat/pons-v2-lifecycle-scanner
```

Use a UTF-8 body file or GitHub API to add the dual-RPC routing, circuit-breaker behavior, compatibility rule, and final test count to PR #7. Do not include `data/wallet-labels.json`, RPC URLs containing keys, or any credential value.

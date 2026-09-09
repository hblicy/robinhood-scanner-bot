# Multi-chain EVM Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run isolated Robinhood, Base, BSC, and Ethereum scanners from one repository with shared candidate, safety, scoring, wallet-signal, state, and Telegram contracts.

**Architecture:** Introduce immutable chain profiles and protocol adapters around the existing scanner instead of copying the application. Each process selects one chain at startup, owns a chain-scoped store and RPC context, normalizes protocol events into one candidate contract, and passes them through common analysis and notification policy.

**Tech Stack:** Node.js 18+, ECMAScript modules, ethers v6, built-in `node:test`, dotenv, JSON/CSV fixtures.

---

## Preconditions

- Execute `docs/superpowers/plans/2026-09-09-multichain-phase0-rpc-consistency.md` first.
- Start this implementation in an isolated worktree using `superpowers:using-git-worktrees`.
- Do not enable Telegram for a new chain until its shadow-run acceptance task passes.
- Protocol deployment addresses must be obtained from the official sources named in the design, verified with `eth_getCode`, and committed with source URL and verification block metadata.

## File map

- Create `src/cli.js`: parse command, token argument, and `--chain`.
- Create `src/chains/evm-profiles.js`: non-secret immutable EVM chain metadata.
- Create `src/chains/load-chain.js`: chain-prefixed environment resolution and validation.
- Create `src/core/candidate.js`: normalized event validation and chain-aware keys.
- Create `src/core/alert-policy.js`: strict common candidate/lifecycle policy.
- Create `src/core/score.js`: explicit 100-point category scoring.
- Create `src/evm/rpc.js`: per-profile provider and discovery-session construction.
- Create `src/evm/discovery.js`: adapter orchestration for a block range.
- Create `src/venues/evm/uniswap.js`: V2/V3/V4 factory parsing.
- Create `src/venues/evm/aerodrome.js`: Classic and Slipstream parsing.
- Create `src/venues/evm/clanker.js`: Clanker deployment parsing.
- Create `src/venues/evm/pancakeswap.js`: V2/V3/Infinity parsing.
- Create `src/venues/evm/four-meme.js`: Four.meme launch/lifecycle parsing.
- Create `src/venues/evm/pons.js`: Robinhood Pons bridge to the existing lifecycle module.
- Create `src/security/evm/index.js`: venue security registry.
- Create `src/security/evm/observed-sells.js`: venue-neutral receipt/token-flow evidence.
- Create `src/wallets/catalog.js`: EVM/Solana catalog normalization.
- Create `scripts/import-wallet-csv.js`: repeatable CSV import.
- Create `src/app.js`: assemble one chain process.
- Modify `src/config.js`, `src/chain.js`, `src/scanner.js`, `src/runtime.js`, `src/analyze.js`, `src/notify.js`, `src/store.js`, `src/instance-lock.js`, `src/index.js`, `src/abis.js`.
- Create focused tests and fixtures under `test/fixtures/evm/`.

### Task 1: Parse chain-aware CLI arguments

**Files:**
- Create: `src/cli.js`
- Modify: `src/index.js`
- Create: `test/cli.test.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: Write failing CLI tests**

Create `test/cli.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../src/cli.js";

describe("chain CLI", () => {
  it("keeps Robinhood as the compatibility default", () => {
    assert.deepEqual(parseCli(["watch"]), {
      command: "watch", chain: "robinhood", argument: null,
    });
  });

  it("accepts --chain before or after the command", () => {
    assert.equal(parseCli(["watch", "--chain", "base"]).chain, "base");
    assert.equal(parseCli(["--chain=bsc", "scan"]).chain, "bsc");
  });

  it("preserves the token argument for check", () => {
    assert.deepEqual(parseCli(["check", "0x1111111111111111111111111111111111111111", "--chain", "ethereum"]), {
      command: "check",
      chain: "ethereum",
      argument: "0x1111111111111111111111111111111111111111",
    });
  });

  for (const argv of [
    ["watch", "--chain", "unknown"],
    ["check", "--chain", "base"],
    ["watch", "extra"],
  ]) {
    it(`rejects invalid arguments: ${argv.join(" ")}`, () => {
      assert.throws(() => parseCli(argv));
    });
  }
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/cli.test.js test/index.test.js`

Expected: FAIL because `src/cli.js` does not exist.

- [ ] **Step 3: Implement exact parsing**

Create `src/cli.js`:

```js
const COMMANDS = new Set(["watch", "scan", "check"]);
const CHAINS = new Set(["robinhood", "base", "bsc", "ethereum", "solana"]);

export function parseCli(argv) {
  const args = [...argv];
  let chain = "robinhood";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--chain") {
      if (!args[i + 1]) throw new Error("--chain requires a value");
      chain = args.splice(i, 2)[1].toLowerCase();
      i -= 1;
    } else if (args[i].startsWith("--chain=")) {
      chain = args.splice(i, 1)[0].slice(8).toLowerCase();
      i -= 1;
    }
  }
  if (!CHAINS.has(chain)) throw new Error(`unsupported chain ${chain}`);
  const command = args.shift() || "watch";
  if (!COMMANDS.has(command)) throw new Error("commands: watch | scan | check <token>");
  const argument = args.shift() || null;
  if (args.length || (command === "check" && !argument) || (command !== "check" && argument)) {
    throw new Error(`invalid arguments for ${command}`);
  }
  return { command, chain, argument };
}
```

Make `src/index.js` call `parseCli(process.argv.slice(2))` and pass the returned object to a dynamically imported app entry. Preserve the existing top-level rejection handler and secret-safe error formatting.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/cli.test.js test/index.test.js`

Expected: all CLI and index tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js src/index.js test/cli.test.js test/index.test.js
git commit -m "支持按链启动扫描命令"
```

### Task 2: Define immutable EVM chain profiles

**Files:**
- Create: `src/chains/evm-profiles.js`
- Create: `src/chains/load-chain.js`
- Create: `test/chain-profiles.test.js`
- Modify: `src/config.js`
- Modify: `test/config.test.js`

- [ ] **Step 1: Verify deployment inputs from primary sources**

For each profile, collect chain ID, explorer, DexScreener slug, Gecko network slug, wrapped-native token, supported quote tokens, official discovery RPC, confirmation default, protocol deployment address, deployment block, and official source URL. Use only:

- Uniswap official deployment documentation;
- Aerodrome official contracts/registry;
- Clanker official contracts or SDK constants;
- PancakeSwap official deployment documentation;
- Four.meme official contracts or on-chain event documentation;
- existing verified Robinhood/Pons configuration.

For each address, call `eth_getCode` through that chain's configured RPC. Reject an empty `0x` response. Record the verification block in the profile metadata so later reviews can reproduce the check.

- [ ] **Step 2: Write failing profile tests**

Create `test/chain-profiles.test.js`:

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EVM_PROFILES } from "../src/chains/evm-profiles.js";
import { loadChainConfig } from "../src/chains/load-chain.js";

const expectedIds = {
  ethereum: 1,
  base: 8453,
  bsc: 56,
  robinhood: 4663,
};

describe("EVM chain profiles", () => {
  for (const [key, id] of Object.entries(expectedIds)) {
    it(`defines a complete ${key} profile`, () => {
      const profile = EVM_PROFILES[key];
      assert.equal(profile.key, key);
      assert.equal(profile.family, "evm");
      assert.equal(profile.id, id);
      assert.match(profile.explorer, /^https:\/\//);
      assert.ok(profile.quotes.length > 0);
      assert.ok(profile.venues.length > 0);
      for (const venue of profile.venues) {
        assert.match(venue.sourceUrl, /^https:\/\//);
        assert.ok(Number.isInteger(venue.verifiedAtBlock));
        for (const address of Object.values(venue.contracts)) {
          assert.match(address, /^0x[0-9a-fA-F]{40}$/);
        }
      }
    });
  }

  it("loads chain-prefixed values without cross-chain leakage", () => {
    const config = loadChainConfig("base", {
      BASE_DISCOVERY_RPC_URL: "https://base-public.example",
      BASE_ANALYSIS_RPC_URL: "https://base-private.example/key",
      BASE_MIN_SCORE: "72",
      BSC_MIN_SCORE: "61",
      TELEGRAM_CHAT_ID: "common",
      BASE_TELEGRAM_CHAT_ID: "base-chat",
    });
    assert.equal(config.rpc.discoveryUrl, "https://base-public.example");
    assert.equal(config.rpc.analysisUrl, "https://base-private.example/key");
    assert.equal(config.settings.minScore, 72);
    assert.equal(config.telegram.chatId, "base-chat");
  });
});
```

- [ ] **Step 3: Run and verify RED**

Run: `node --test test/chain-profiles.test.js test/config.test.js`

Expected: FAIL because profiles and the chain-prefixed loader do not exist.

- [ ] **Step 4: Implement profiles and loader**

Each entry in `src/chains/evm-profiles.js` must be deeply immutable and pass this validator before export:

```js
function defineEvmProfile(value) {
  if (value.family !== "evm") throw new Error(`${value.key} must use the EVM family`);
  if (!Number.isInteger(value.id) || value.id <= 0) throw new Error(`${value.key} chain ID is invalid`);
  if (!value.quotes?.length || !value.venues?.length) throw new Error(`${value.key} profile is incomplete`);
  for (const venue of value.venues) {
    if (!Number.isInteger(venue.deploymentBlock) || venue.deploymentBlock < 0) {
      throw new Error(`${venue.id} deployment block is invalid`);
    }
    if (!Number.isInteger(venue.verifiedAtBlock) || venue.verifiedAtBlock < venue.deploymentBlock) {
      throw new Error(`${venue.id} verification block is invalid`);
    }
    if (!/^https:\/\//.test(venue.sourceUrl)) throw new Error(`${venue.id} source URL is invalid`);
  }
  return deepFreeze(value);
}
```

Instantiate all four profiles with the concrete values verified in Step 1. The committed source must contain no example, dummy, or zero-value deployment metadata.

`loadChainConfig(chainKey, envSource)` must:

- select the immutable profile;
- resolve the selected chain prefix for discovery RPC, analysis RPC, RPC CUPS, minimum score, confirmations, Telegram chat ID, and alert mode;
- fall back to the profile public RPC for discovery, then legacy `RPC_URL` only for Robinhood analysis compatibility;
- use the common Telegram chat if no chain override exists;
- return a chain-scoped `dataDir` under `data/{chain}`;
- validate score 0–100, confirmations as non-negative integer, and HTTP(S) RPC URLs.

Keep `src/config.js` as a compatibility export for Robinhood until Task 7 migrates all production imports.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/chain-profiles.test.js test/config.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/chains/evm-profiles.js src/chains/load-chain.js src/config.js test/chain-profiles.test.js test/config.test.js
git commit -m "定义四条 EVM 链配置"
```

### Task 3: Normalize chain-aware candidates and keys

**Files:**
- Create: `src/core/candidate.js`
- Create: `test/candidate.test.js`
- Modify: `src/runtime.js`
- Modify: `test/runtime.test.js`

- [ ] **Step 1: Write failing candidate contract tests**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCandidate,
  rawEventKey,
  candidateKey,
  notificationKey,
} from "../src/core/candidate.js";

const input = {
  chain: "base", chainFamily: "evm", venue: "uniswap-v3-base",
  sourceKind: "dex", token: "0x1111111111111111111111111111111111111111",
  quoteToken: "0x2222222222222222222222222222222222222222",
  pool: "0x3333333333333333333333333333333333333333",
  creator: null, blockOrSlot: 100, transactionId: `0x${"4".repeat(64)}`,
  eventIndex: 2, createdAt: 1_000, lifecyclePhase: "new_pool",
  sourceProvenance: "uniswap-v3@1",
};

describe("normalized candidate", () => {
  it("normalizes EVM addresses and creates chain-aware keys", () => {
    const value = normalizeCandidate(input);
    assert.equal(value.chain, "base");
    assert.match(rawEventKey(value), /^base\|0x[0-9a-f]{64}\|2$/);
    assert.match(candidateKey(value), /^base\|uniswap-v3-base\|/);
    assert.match(notificationKey(value, "candidate", 1), /^base\|/);
  });

  it("does not collide across chains", () => {
    const base = normalizeCandidate(input);
    const ethereum = normalizeCandidate({ ...input, chain: "ethereum" });
    assert.notEqual(candidateKey(base), candidateKey(ethereum));
  });

  it("rejects missing provenance and invalid event identity", () => {
    assert.throws(() => normalizeCandidate({ ...input, sourceProvenance: "" }));
    assert.throws(() => normalizeCandidate({ ...input, eventIndex: -1 }));
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/candidate.test.js test/runtime.test.js`

Expected: FAIL because the common contract does not exist and the old key omits chain.

- [ ] **Step 3: Implement normalization**

Create `src/core/candidate.js`. Use `getAddress` for EVM addresses and return a frozen object. Export:

```js
export function rawEventKey(event) {
  const transactionId = event.chainFamily === "evm"
    ? event.transactionId.toLowerCase()
    : event.transactionId;
  return `${event.chain}|${transactionId}|${event.eventIndex}`;
}

export function candidateKey(event) {
  const values = [event.chain, event.venue, event.poolId || event.pool || event.token];
  return (event.chainFamily === "evm"
    ? values.map((value) => String(value).toLowerCase())
    : values.map(String)
  ).join("|");
}

export function notificationKey(event, alertType, stateVersion) {
  const values = [event.chain, event.token, alertType, stateVersion];
  return (event.chainFamily === "evm"
    ? values.map((value) => String(value).toLowerCase())
    : values.map(String)
  ).join("|");
}
```

`normalizeCandidate` must validate the fields defined in design section 6, allow `poolId`, `creator`, and `createdAt` to be null, and reject chain-family/address mismatches. Re-export `candidateKey` from `src/runtime.js` during migration so existing imports do not break.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/candidate.test.js test/runtime.test.js test/queue.test.js`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/candidate.js src/runtime.js test/candidate.test.js test/runtime.test.js
git commit -m "统一多链候选事件与去重键"
```

### Task 4: Build the generic EVM adapter contract

**Files:**
- Create: `src/evm/discovery.js`
- Create: `src/venues/evm/uniswap.js`
- Create: `test/evm-discovery.test.js`
- Create: `test/fixtures/evm/uniswap-v2-pair-created.json`
- Create: `test/fixtures/evm/uniswap-v3-pool-created.json`
- Create: `test/fixtures/evm/uniswap-v4-initialize.json`
- Modify: `src/abis.js`

- [ ] **Step 1: Write failing adapter orchestration tests**

Define the adapter contract as `{ id, addresses, topics, parse(log, context) }`. Test that `scanEvmRange` groups addresses/topics, passes one explicit provider to every request, sorts logs by block/transaction/log index, validates candidates, and wraps parse failures with chain, venue, block, and transaction context.

Use this assertion:

```js
const events = await scanEvmRange({
  chain,
  provider,
  fromBlock: 100,
  toBlock: 110,
  adapters: [adapterA, adapterB],
  getLogs: async ({ provider: seenProvider }) => {
    assert.equal(seenProvider, provider);
    return fixtureLogs;
  },
  getBlockTimes: async () => new Map([[101, 1_000]]),
});
assert.ok(events.every((event) => event.chain === "base"));
assert.ok(events.every((event) => event.sourceProvenance));
```

Load the three committed Uniswap fixtures and assert exact token, quote, pool/poolId, fee, transaction ID, event index, and lifecycle phase.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/evm-discovery.test.js`

Expected: FAIL because discovery and adapter modules do not exist.

- [ ] **Step 3: Implement orchestration and Uniswap adapters**

`scanEvmRange` must invoke only adapters listed in the selected chain profile. Each parsed event is completed with:

```js
normalizeCandidate({
  chain: chain.key,
  chainFamily: "evm",
  venue: adapter.id,
  sourceKind: adapter.sourceKind,
  token: parsed.token,
  quoteToken: parsed.quoteToken,
  pool: parsed.pool,
  creator: parsed.creator ?? null,
  blockOrSlot: Number(log.blockNumber),
  transactionId: log.transactionHash,
  eventIndex: Number(log.index ?? log.logIndex),
  createdAt: blockTimes.get(Number(log.blockNumber)) ?? null,
  lifecyclePhase: parsed.lifecyclePhase,
  sourceProvenance: `${adapter.id}@${adapter.version}`,
});
```

Move the existing V2/V3/V4 interfaces and parsing behavior from `src/chain.js` into factory functions in `src/venues/evm/uniswap.js`. Quote recognition comes from the selected profile rather than global `ADDR`. V4 pool IDs remain in adapter metadata if the chain has no addressable pool; normalized `pool` uses the configured PoolManager address and metadata retains `poolId`.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/evm-discovery.test.js test/chain.test.js`

Expected: all Uniswap fixture and legacy parsing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/evm/discovery.js src/venues/evm/uniswap.js src/abis.js test/evm-discovery.test.js test/fixtures/evm
git commit -m "抽取通用 EVM 发现适配器"
```

### Task 5: Add chain-scoped state, locks, and silent recovery

**Files:**
- Modify: `src/store.js`
- Modify: `src/instance-lock.js`
- Modify: `src/scanner.js`
- Create: `test/multichain-state.test.js`
- Modify: `test/store.test.js`
- Modify: `test/instance-lock.test.js`

- [ ] **Step 1: Write failing isolation tests**

Create two stores under sibling temporary directories and prove cursors, seen keys, watchlists, outbox entries, and locks do not cross. Add startup-mode tests:

```js
assert.equal(notificationsEnabledForMode("recovery"), false);
assert.equal(notificationsEnabledForMode("shadow"), false);
assert.equal(notificationsEnabledForMode("live"), true);
```

Add a recovery scan case proving candidates and lifecycle states are persisted while no outbox item is created.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/multichain-state.test.js test/store.test.js test/instance-lock.test.js`

Expected: FAIL because mode-aware notification decisions and explicit chain store construction are missing.

- [ ] **Step 3: Make scope explicit**

Require `dataDir` when constructing production stores and locks. Change the default store cache into a map keyed by absolute data directory:

```js
const stores = new Map();
export function getStoreFor(dataDir, settings) {
  const key = path.resolve(dataDir);
  if (!stores.has(key)) {
    stores.set(key, createStore({
      dataDir: key,
      maxSeenEntries: settings.maxSeenEntries,
      seenTtlMs: settings.seenTtlMs,
    }));
  }
  return stores.get(key);
}
```

The scanner receives `mode: "recovery" | "shadow" | "live"`. Export `notificationsEnabledForMode` as a pure validator returning true only for `live` and throwing on other values. Recovery ends only after the saved cursor reaches the session safe head. Both recovery and shadow modes call analysis/state updates but pass `notificationsEnabled: false`, suppressing candidate, blocked, lifecycle, heat, and startup Telegram writes.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/multichain-state.test.js test/store.test.js test/instance-lock.test.js test/scanner-pons.test.js test/outbox.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/instance-lock.js src/scanner.js test/multichain-state.test.js test/store.test.js test/instance-lock.test.js
git commit -m "隔离各链状态并静默恢复"
```

### Task 6: Implement common scoring and alert admission

**Files:**
- Create: `src/core/score.js`
- Create: `src/core/alert-policy.js`
- Create: `test/core-score.test.js`
- Create: `test/alert-policy.test.js`
- Modify: `src/analyze.js`
- Modify: `src/runtime.js`
- Modify: `src/notification-policy.js`
- Modify: `test/score.test.js`
- Modify: `test/format.test.js`

- [ ] **Step 1: Write failing 100-point model tests**

Assert category maxima exactly match the design:

```js
assert.deepEqual(SCORE_MAXIMA, {
  age: 15,
  liquidity: 15,
  marketCap: 10,
  flow: 15,
  social: 10,
  ownership: 15,
  lpAndPermissions: 12,
  smartWallets: 8,
});
assert.equal(Object.values(SCORE_MAXIMA).reduce((a, b) => a + b, 0), 100);
```

Test unknown facts receive zero for that item, one unique labeled holder adds 5, two or more add 8, and repeated transactions by one address still add 5.

- [ ] **Step 2: Write failing alert-policy tests**

Cover the complete truth table:

```js
assert.equal(decideCandidateAlert({ mode: "live", sellability: "confirmed", score: 70, minScore: 70 }).type, "candidate");
assert.equal(decideCandidateAlert({ mode: "live", sellability: "confirmed", score: 69, minScore: 70 }), null);
assert.equal(decideCandidateAlert({ mode: "live", sellability: "blocked", score: 0, minScore: 70 }).type, "risk");
assert.equal(decideCandidateAlert({ mode: "live", sellability: "unknown", score: 100, minScore: 70 }), null);
assert.equal(decideCandidateAlert({ mode: "recovery", sellability: "blocked", score: 0, minScore: 70 }), null);
assert.equal(decideCandidateAlert({ mode: "shadow", sellability: "confirmed", score: 100, minScore: 70 }), null);
```

For lifecycle alerts, assert `hard_kill` is allowed only in live mode with confirmed evidence; `rescued`, `green`, `market_ready`, `graduated`, and `swept` require `watchlisted: true`; raw `new_launch` and `new_pool` are always suppressed.

- [ ] **Step 3: Run and verify RED**

Run: `node --test test/core-score.test.js test/alert-policy.test.js test/score.test.js test/format.test.js`

Expected: FAIL because scoring categories and the unified policy are not isolated.

- [ ] **Step 4: Implement pure scoring and policy**

`scoreCandidate(facts, thresholds)` returns:

```js
{
  score: 0,
  categories: {
    age: { points: 0, max: 15, checks: [] },
    liquidity: { points: 0, max: 15, checks: [] },
    marketCap: { points: 0, max: 10, checks: [] },
    flow: { points: 0, max: 15, checks: [] },
    social: { points: 0, max: 10, checks: [] },
    ownership: { points: 0, max: 15, checks: [] },
    lpAndPermissions: { points: 0, max: 12, checks: [] },
    smartWallets: { points: 0, max: 8, checks: [] },
  },
  redFlags: [],
}
```

Port current scoring facts into these fixed buckets without changing the sum beyond 100. Thresholds are supplied by the selected chain config. `src/analyze.js` maps collected facts to this function and preserves legacy `checks`, `red`, and `verdict` fields until formatting tests are migrated.

`decideCandidateAlert` and `decideLifecycleAlert` must be pure functions implementing the truth tables above. `runtime.handleCandidate` calls only these functions; a successful candidate alert sets `watchlistAdmission: true`, while a risk alert records risk state without normal admission.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/core-score.test.js test/alert-policy.test.js test/score.test.js test/analyze.test.js test/runtime.test.js test/format.test.js`

Expected: all focused tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/score.js src/core/alert-policy.js src/analyze.js src/runtime.js src/notification-policy.js test/core-score.test.js test/alert-policy.test.js test/score.test.js test/format.test.js
git commit -m "统一多链评分与严格推送门槛"
```

### Task 7: Import and merge EVM wallet CSV catalogs

**Files:**
- Create: `scripts/import-wallet-csv.js`
- Create: `src/wallets/catalog.js`
- Create: `test/wallet-csv.test.js`
- Create: `test/fixtures/wallets/evm-a.csv`
- Create: `test/fixtures/wallets/evm-b.csv`
- Modify: `src/wallet-labels.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing import tests**

Fixtures must contain duplicate mixed-case EVM addresses, `kol`, `smart_degen`, `launchpad_smart`, and malformed addresses. Test:

```js
const catalog = importWalletCsvFiles([evmA, evmB], { family: "evm" });
assert.equal(catalog.family, "evm");
assert.equal(catalog.wallets.length, 2);
assert.deepEqual(catalog.wallets[0].sourceChains.sort(), ["base", "bsc", "ethereum", "robinhood"]);
assert.equal(catalog.wallets.find((w) => w.tags.includes("kol")).type, "kol");
assert.equal(catalog.wallets.find((w) => !w.tags.includes("kol")).type, "smart_money");
assert.equal(catalog.rejected.length, 1);
```

Assert deterministic sorting and byte-identical output regardless of input file order.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/wallet-csv.test.js test/wallet-labels.test.js`

Expected: FAIL because CSV import and merged catalogs do not exist.

- [ ] **Step 3: Implement a dependency-free CSV parser for the known export**

The importer must require this header set:

```js
const REQUIRED_COLUMNS = new Set([
  "address", "source", "tags", "chain", "has_detail", "has_holdings",
]);
```

Implement RFC-4180 quoting for commas, quotes, CRLF, and LF. Normalize EVM addresses with `getAddress`, union tags/source chains, classify any address containing `kol` as KOL, classify all remaining accepted tags as smart money, and emit deterministic JSON:

```js
{
  schemaVersion: 1,
  family: "evm",
  wallets: [{
    address: "0x1111111111111111111111111111111111111111",
    type: "kol",
    tags: ["kol", "smart_degen"],
    sources: ["gmgn"],
    sourceChains: ["base", "bsc", "ethereum", "robinhood"],
  }],
  rejected: [{ file: "evm-a.csv", row: 4, reason: "invalid-address" }],
}
```

The CLI accepts `--family evm --output data/wallets/evm.json` followed by one or more CSV paths, writes through a temporary file followed by rename, and prints only counts—never all wallet addresses. Add the `import-wallets` npm script.

Adapt `src/wallet-labels.js` to load schema version 1 while preserving the existing manual JSON format.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/wallet-csv.test.js test/wallet-labels.test.js test/sellability.test.js test/score.test.js`

Expected: all tests PASS and existing +5/+8 caps remain unchanged.

- [ ] **Step 5: Commit**

```bash
git add scripts/import-wallet-csv.js src/wallets/catalog.js src/wallet-labels.js package.json test/wallet-csv.test.js test/wallet-labels.test.js test/fixtures/wallets
git commit -m "导入并合并 EVM 聪明钱地址"
```

### Task 8: Migrate Robinhood without behavior regression

**Files:**
- Create: `src/venues/evm/pons.js`
- Create: `src/app.js`
- Modify: `src/chain.js`
- Modify: `src/scanner.js`
- Modify: `src/config.js`
- Modify: `src/pons.js`
- Modify: `src/market.js`
- Modify: `src/notify.js`
- Modify: `test/pons.test.js`
- Modify: `test/scanner-pons.test.js`
- Modify: `test/push-only.test.js`
- Create: `test/robinhood-app.test.js`

- [ ] **Step 1: Write failing application assembly tests**

Call `createApp({ chainKey: "robinhood", env, dependencies })` and assert:

- its RPC context uses chain ID 4663;
- store and lock paths end in `data/robinhood`;
- Uniswap and Pons adapters are registered;
- Pons recovery schedules no historical notification;
- Telegram title contains `Robinhood`;
- `check`, `scan`, and `watch` remain push-only and expose no transaction method.
- DexScreener, GeckoTerminal, and explorer failures become source-specific unknown data, never a safety pass.
- auxiliary requests respect the configured concurrency and cache limits.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/robinhood-app.test.js test/pons.test.js test/scanner-pons.test.js test/push-only.test.js`

Expected: FAIL because `createApp` and the Pons adapter do not exist.

- [ ] **Step 3: Assemble dependencies per chain**

`createApp` returns a small command surface:

```js
{
  config,
  async watch() {},
  async scan() {},
  async check(token) {},
}
```

Construct configuration, store, lock, RPC context, venue registry, security registry, analysis dependencies, notifier, and scanner inside the factory. Do not retain mutable module-global `CHAIN`, `ADDR`, `SETTINGS`, or default store dependencies in the running path.

Wrap the existing Pons functions behind `src/venues/evm/pons.js`; preserve Pons lifecycle IDs and state migration. Prefix new notification and candidate identities with `robinhood`, while reading legacy Robinhood state into `data/robinhood` through a one-time, tested copy migration that never deletes the old state.

Refactor `src/market.js` to receive the active chain profile and an injected bounded scheduler. Cache successful auxiliary responses by `chain + token + source`; cache expected not-found results briefly; do not cache transient failures as successful data. Return source-tagged errors so analysis records `unknown` without stopping the discovery loop. Keep DexScreener, GeckoTerminal, and explorer APIs optional and do not add a paid API dependency.

- [ ] **Step 4: Run focused regression tests**

Run: `node --test test/robinhood-app.test.js test/pons.test.js test/scanner-pons.test.js test/push-only.test.js test/runtime.test.js test/notify.test.js test/market.test.js`

Expected: all tests PASS with the same strict sellability behavior as before migration.

- [ ] **Step 5: Commit**

```bash
git add src/venues/evm/pons.js src/app.js src/chain.js src/scanner.js src/config.js src/pons.js src/market.js src/notify.js test/robinhood-app.test.js test/pons.test.js test/scanner-pons.test.js test/push-only.test.js test/market.test.js
git commit -m "迁移 Robinhood 到多链运行时"
```

### Task 9: Add Base protocol adapters

**Files:**
- Create: `src/venues/evm/aerodrome.js`
- Create: `src/venues/evm/clanker.js`
- Create: `test/base-adapters.test.js`
- Create: `test/fixtures/evm/aerodrome-classic-pool-created.json`
- Create: `test/fixtures/evm/aerodrome-slipstream-pool-created.json`
- Create: `test/fixtures/evm/clanker-token-created.json`
- Modify: `src/abis.js`
- Modify: `src/chains/evm-profiles.js`

- [ ] **Step 1: Capture verified real fixtures**

From Base mainnet, capture one official transaction receipt for each event type. Redact RPC URLs, keep transaction hash, block, log address, topics, and data. Verify the log address belongs to the official deployment/registry recorded in the profile.

- [ ] **Step 2: Write failing fixture tests**

For Aerodrome Classic and Slipstream, assert the adapter extracts both currencies, selects only pools containing a configured quote token, emits `new_pool`, and retains stable/concentrated fee metadata. For Clanker, assert token, creator, paired token/pool metadata, deployment transaction, and `new_launch` phase.

Also assert a Clanker raw launch is not directly eligible for Telegram and a pool with neither side in the quote set returns no candidate.

- [ ] **Step 3: Run and verify RED**

Run: `node --test test/base-adapters.test.js`

Expected: FAIL because Base-specific adapters do not exist.

- [ ] **Step 4: Implement adapters with explicit provenance**

Each factory returns the common adapter shape from Task 4. Use ethers `Interface` with the exact event declarations copied from the verified official ABI. The Clanker adapter treats the factory event as discovery only; it resolves the actual pool through event fields or a fixed-block factory read, and returns `unknown` identity if that resolution fails rather than guessing a Uniswap pool.

Register all verified Aerodrome factories returned by its official FactoryRegistry, rather than hardcoding only one Slipstream generation. Include deployment block bounds so scans do not query before a factory existed.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/base-adapters.test.js test/evm-discovery.test.js test/candidate.test.js`

Expected: all Base adapter tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/venues/evm/aerodrome.js src/venues/evm/clanker.js src/abis.js src/chains/evm-profiles.js test/base-adapters.test.js test/fixtures/evm
git commit -m "接入 Base 主要协议发现"
```

### Task 10: Add BSC protocol adapters

**Files:**
- Create: `src/venues/evm/pancakeswap.js`
- Create: `src/venues/evm/four-meme.js`
- Create: `test/bsc-adapters.test.js`
- Create: `test/fixtures/evm/pancake-v2-pair-created.json`
- Create: `test/fixtures/evm/pancake-v3-pool-created.json`
- Create: `test/fixtures/evm/pancake-infinity-initialize.json`
- Create: `test/fixtures/evm/four-meme-launch.json`
- Create: `test/fixtures/evm/four-meme-graduated.json`
- Modify: `src/abis.js`
- Modify: `src/chains/evm-profiles.js`

- [ ] **Step 1: Capture and verify BSC fixtures**

Capture one BSC receipt per event from the official PancakeSwap and Four.meme deployments. Record deployment source and verification block in the BSC profile. Reject any address whose `eth_getCode` is empty or whose emitted topic does not match the official ABI.

- [ ] **Step 2: Write failing adapter tests**

Assert PancakeSwap V2/V3/Infinity normalize to distinct venue IDs and retain pool-key metadata needed for later security binding. Assert Four.meme emits `new_launch` and `graduated` lifecycle phases, but `new_launch` creates no direct Telegram decision.

Add a malformed factory-read case that returns an explicit adapter error with chain, venue, transaction, and log index.

- [ ] **Step 3: Run and verify RED**

Run: `node --test test/bsc-adapters.test.js`

Expected: FAIL because BSC adapters do not exist.

- [ ] **Step 4: Implement BSC adapters**

Implement the common adapter contract using exact official ABI events. V2 and V3 may reuse pure parser helpers from Uniswap only when their event signatures and field semantics are byte-for-byte equivalent; Infinity and Four.meme require their own parser and provenance version.

Four.meme graduation links the launch token to its migrated DEX pool through a stored lifecycle identity. If the destination pool is absent or cannot be verified, persist the phase but do not create a sellability-capable candidate.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/bsc-adapters.test.js test/evm-discovery.test.js test/lifecycle.test.js`

Expected: all BSC and lifecycle tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/venues/evm/pancakeswap.js src/venues/evm/four-meme.js src/abis.js src/chains/evm-profiles.js test/bsc-adapters.test.js test/fixtures/evm
git commit -m "接入 BSC 主要协议发现"
```

### Task 11: Generalize EVM sellability and venue binding

**Files:**
- Create: `src/security/evm/index.js`
- Create: `src/security/evm/observed-sells.js`
- Create: `test/evm-security.test.js`
- Modify: `src/sellability.js`
- Modify: `src/analyze.js`
- Modify: `test/sellability.test.js`
- Modify: `test/honeypot.test.js`

- [ ] **Step 1: Write failing venue-security tests**

Define a registry lookup by exact `chain + venue`. Cover:

- V2-like pools use the existing pool binding, balance mutation ladder, and observed sells.
- V3/V4/Slipstream/Infinity candidates require verified pool binding plus at least three meaningful independent real sellers and quote outflow.
- Pons and Four.meme use their launchpad-specific binding.
- a known discovery adapter without a security adapter returns `unknown:unsupported-venue`.
- a factory/pool mismatch returns `blocked:pool-binding-mismatch`.
- one wallet selling dust does not confirm sellability.

Use receipt fixtures that prove quote-token transfer from the pool/vault to the seller or router recipient in the same successful transaction.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/evm-security.test.js test/sellability.test.js test/honeypot.test.js`

Expected: FAIL because security selection is globally V2-shaped.

- [ ] **Step 3: Implement the registry and observed-sell primitive**

Expose:

```js
export function createEvmSecurityRegistry(entries) {
  const byVenue = new Map(entries.map((entry) => [`${entry.chain}|${entry.venue}`, entry]));
  return {
    inspect(candidate, dependencies) {
      const adapter = byVenue.get(`${candidate.chain}|${candidate.venue}`);
      if (!adapter) return sellabilityResult("unknown", "unsupported-venue");
      return adapter.inspect(candidate, dependencies);
    },
  };
}
```

`observed-sells.js` must decode token transfers from successful receipts, bind the token and quote flow to the verified pool/vault, count unique external sellers, exclude routers/pool/factory/system addresses, and require a configurable meaningful threshold. It returns evidence only; it cannot promote an unbound candidate.

Adapt the current V2 inspection behind one registry entry without weakening its two-size ladder or meaningful-seller rules. Register only venues with complete, fixture-backed bindings. All others remain unknown and therefore silent.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/evm-security.test.js test/sellability.test.js test/honeypot.test.js test/analyze.test.js test/runtime.test.js`

Expected: all security tests PASS; unknown venues never trigger a candidate report.

- [ ] **Step 5: Commit**

```bash
git add src/security/evm/index.js src/security/evm/observed-sells.js src/sellability.js src/analyze.js test/evm-security.test.js test/sellability.test.js test/honeypot.test.js
git commit -m "按协议绑定 EVM 可卖性证据"
```

### Task 12: Assemble Base, BSC, and Ethereum apps

**Files:**
- Modify: `src/app.js`
- Modify: `src/index.js`
- Modify: `src/notify.js`
- Create: `test/evm-apps.test.js`
- Modify: `test/notify.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing four-app tests**

For each EVM chain, build an app with fake RPCs and a temporary directory. Assert profile ID, adapter IDs, independent state path, independent lock, min-score override, common Telegram fallback, per-chain chat override, and chain-prefixed notification ID.

Assert `ethereum` registers only the verified Uniswap generations; Base and BSC register their chain-specific adapters; Robinhood retains Pons. Assert all apps expose only `watch`, `scan`, and `check`.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/evm-apps.test.js test/notify.test.js`

Expected: FAIL until non-Robinhood assembly and chain-aware formatting are complete.

- [ ] **Step 3: Complete assembly and formatting**

`src/index.js` dispatches:

```js
const cli = parseCli(process.argv.slice(2));
const app = await createApp({ chainKey: cli.chain });
if (cli.command === "watch") await app.watch();
else if (cli.command === "scan") await app.scan();
else await app.check(cli.argument);
```

Every Telegram report starts with a chain line and uses links from the active profile:

```text
🟡 [Base] 人工复核 TOKEN 72/100
```

Add convenience scripts without changing the generic command:

```json
{
  "watch:robinhood": "node src/index.js watch --chain robinhood",
  "watch:base": "node src/index.js watch --chain base",
  "watch:bsc": "node src/index.js watch --chain bsc",
  "watch:ethereum": "node src/index.js watch --chain ethereum"
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/evm-apps.test.js test/notify.test.js test/push-only.test.js test/index.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/index.js src/notify.js package.json test/evm-apps.test.js test/notify.test.js
git commit -m "组装四条 EVM 链独立进程"
```

### Task 13: Document, shadow-run, and accept EVM rollout

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Create: `docs/operations/multichain-evm.md`

- [ ] **Step 1: Update configuration documentation**

Document all four commands, chain-prefixed RPC/score/confirmation/chat variables, state paths, wallet import command, recovery mode, shadow mode, and push-only guarantee. State that unsupported venue security stays unknown and silent.

Update `AGENTS.md` with the confirmed product direction: one repository, independent EVM/Solana runtimes, one process per chain, no transaction functionality, and strict confirmed/blocked notification gate.

- [ ] **Step 2: Run full automated verification**

Run:

```bash
npm test
node --check src/index.js
node --check src/app.js
node --check src/evm/discovery.js
node --check src/security/evm/index.js
git diff --check
```

Expected: all commands exit 0 and every test PASS.

- [ ] **Step 3: Run one-shot fixture-backed smoke commands**

Run `scan` for each chain against a local fake RPC fixture server. Expected: each process reports its own chain ID, writes only under `data/{chain}`, emits no Telegram in shadow mode, and exits 0 after the scan.

- [ ] **Step 4: Run live-RPC shadow observation**

On the deployment host, set `ALERT_MODE=shadow` and run each EVM process independently for the agreed observation window. Record:

- discovered event count by venue;
- duplicate rejection count;
- analysis count and confirmed/blocked/unknown counts;
- RPC request/CU estimate and 429 count;
- cursor before/after restart;
- process exit/restart count.

Acceptance requires no unexplained cursor gaps, no cross-chain state writes, no Telegram messages, no secret-bearing logs, and request rates within the configured budget.

- [ ] **Step 5: Enable chains one at a time**

Set `ALERT_MODE=live` first for Robinhood, then Base, BSC, and Ethereum. After each change, verify one startup line, current cursor progress, and that only confirmed high-score or confirmed blocked reports reach the configured chat.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md .env.example AGENTS.md docs/operations/multichain-evm.md
git commit -m "说明 EVM 多链部署与验收"
```

- [ ] **Step 7: Fresh final verification**

Run:

```bash
npm test
git diff --check
git status --short --branch
```

Expected: all tests PASS, diff check is clean, and the worktree has no uncommitted changes.

# Multi-chain Solana Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated Solana scanner for Pump.fun/PumpSwap and Raydium while preserving the common strict alert, scoring, wallet-signal, state, and Telegram contracts.

**Architecture:** Build a Solana-specific runtime that combines WebSocket hints with deterministic HTTP reconciliation, normalizes program instructions into the common candidate contract, and evaluates SPL/Token-2022 authorities plus observed token/quote flows. Solana owns its provider, cursor, state directory, address catalog, concurrency, and failure boundary; only pure scoring and notification policy are shared with EVM.

**Tech Stack:** Node.js 18+, ECMAScript modules, `@solana/web3.js`, `@solana/spl-token`, built-in `node:test`, dotenv, JSON transaction fixtures.

---

## Preconditions

- Complete Phase 0 and the EVM core tasks through common candidate, score, alert-policy, state, wallet catalog, and application factory.
- Execute in an isolated worktree.
- Obtain program IDs and IDLs only from Pump.fun and Raydium official repositories/docs, then verify each executable program account over the configured Solana RPC.
- Keep `ALERT_MODE=shadow` until the final acceptance task passes.

## File map

- Create `src/chains/solana-profile.js`: immutable Solana metadata and verified program manifests.
- Modify `src/chains/load-chain.js`: Solana HTTP/WS configuration.
- Modify `src/core/candidate.js`: Base58/program event normalization.
- Create `src/solana/rpc.js`: HTTP connection and WebSocket subscription construction.
- Create `src/solana/cursor.js`: per-program signature/slot reconciliation state.
- Create `src/solana/discovery.js`: subscription hints, HTTP backfill, ordering, and dedupe.
- Create `src/venues/solana/pump.js`: Pump bonding curve and PumpSwap parsing.
- Create `src/venues/solana/raydium.js`: LaunchLab, CPMM, CLMM, AMM v4 parsing.
- Create `src/security/solana/mint.js`: SPL/Token-2022 authority and extension checks.
- Create `src/security/solana/flows.js`: real seller and quote-outflow evidence.
- Create `src/security/solana/index.js`: venue binding and strict sellability result.
- Modify `src/store.js`, `src/app.js`, `src/notify.js`, `src/wallets/catalog.js`, `scripts/import-wallet-csv.js`, `package.json`, `package-lock.json`.
- Create focused tests and sanitized fixtures under `test/fixtures/solana/`.

### Task 1: Add Solana dependencies and profile configuration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/chains/solana-profile.js`
- Modify: `src/chains/load-chain.js`
- Create: `test/solana-config.test.js`

- [ ] **Step 1: Verify current official program manifests**

From the official Pump public docs and Raydium program-address/IDL pages, record:

- Pump bonding-curve program;
- PumpSwap program;
- Raydium LaunchLab, CPMM, CLMM, and AMM v4 programs;
- wrapped SOL and supported stable quote mints;
- official explorer and market-data slugs;
- official source URL for every ID.

For each program ID, call `getAccountInfo` and require `executable: true`. Record the verification slot. Keep the exact IDL revision or repository commit used to create fixtures.

- [ ] **Step 2: Write failing config tests**

```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SOLANA_PROFILE } from "../src/chains/solana-profile.js";
import { loadChainConfig } from "../src/chains/load-chain.js";

describe("Solana profile", () => {
  it("defines verified programs and quotes", () => {
    assert.equal(SOLANA_PROFILE.key, "solana");
    assert.equal(SOLANA_PROFILE.family, "solana");
    assert.ok(SOLANA_PROFILE.programs.length >= 6);
    for (const program of SOLANA_PROFILE.programs) {
      assert.match(program.programId, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      assert.ok(Number.isInteger(program.verifiedAtSlot));
      assert.match(program.sourceUrl, /^https:\/\//);
      assert.ok(program.idlRevision);
    }
  });

  it("loads independent HTTP, analysis, WebSocket, score, and chat values", () => {
    const config = loadChainConfig("solana", {
      SOLANA_DISCOVERY_RPC_URL: "https://solana-public.example",
      SOLANA_ANALYSIS_RPC_URL: "https://solana-private.example/key",
      SOLANA_WS_RPC_URL: "wss://solana-private.example/key",
      SOLANA_MIN_SCORE: "74",
      TELEGRAM_CHAT_ID: "common",
      SOLANA_TELEGRAM_CHAT_ID: "sol-chat",
    });
    assert.equal(config.family, "solana");
    assert.equal(config.rpc.discoveryUrl, "https://solana-public.example");
    assert.equal(config.rpc.analysisUrl, "https://solana-private.example/key");
    assert.equal(config.rpc.wsUrl, "wss://solana-private.example/key");
    assert.equal(config.settings.minScore, 74);
    assert.equal(config.telegram.chatId, "sol-chat");
    assert.match(config.dataDir, /solana$/);
  });
});
```

- [ ] **Step 3: Run and verify RED**

Run: `node --test test/solana-config.test.js`

Expected: FAIL because the profile and Solana settings do not exist.

- [ ] **Step 4: Install pinned compatible dependencies**

Run:

```bash
npm install @solana/web3.js@^1 @solana/spl-token@^0.4
```

Expected: `package.json` and `package-lock.json` change, installation exits 0, and the selected versions support Node 18.

- [ ] **Step 5: Implement the profile and loader**

Normalize every verified program record through this constructor:

```js
function defineProgram(value) {
  const programId = new PublicKey(value.programId).toBase58();
  if (!Number.isInteger(value.deploymentSlot) || value.deploymentSlot < 0) {
    throw new Error(`${value.id} deployment slot is invalid`);
  }
  if (!Number.isInteger(value.verifiedAtSlot) || value.verifiedAtSlot < value.deploymentSlot) {
    throw new Error(`${value.id} verification slot is invalid`);
  }
  if (!value.idlRevision || !/^https:\/\//.test(value.sourceUrl)) {
    throw new Error(`${value.id} provenance is incomplete`);
  }
  return Object.freeze({ ...value, programId });
}
```

Instantiate the records with the concrete program IDs, slots, revisions, and URLs verified in Step 1. No example or dummy deployment data may remain in source. The loader validates HTTP(S) discovery/analysis URLs, WS(S) subscription URLs, positive request/concurrency limits, and score 0–100. If `SOLANA_WS_RPC_URL` is absent, derive `ws:`/`wss:` only when the HTTP provider documents matching WebSocket support; otherwise run reconciliation-only mode.

- [ ] **Step 6: Run and verify GREEN**

Run: `node --test test/solana-config.test.js test/chain-profiles.test.js`

Expected: all configuration tests PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/chains/solana-profile.js src/chains/load-chain.js test/solana-config.test.js
git commit -m "配置 Solana 运行时与官方程序"
```

### Task 2: Extend the candidate contract for Solana

**Files:**
- Modify: `src/core/candidate.js`
- Modify: `test/candidate.test.js`

- [ ] **Step 1: Add failing Solana normalization tests**

```js
const solanaInput = {
  chain: "solana",
  chainFamily: "solana",
  venue: "pump-bonding-curve",
  sourceKind: "launchpad",
  token: "So11111111111111111111111111111111111111112",
  quoteToken: "11111111111111111111111111111111",
  pool: "Vote111111111111111111111111111111111111111",
  creator: null,
  blockOrSlot: 123,
  transactionId: "5".repeat(64),
  eventIndex: 1,
  createdAt: 1_000,
  lifecyclePhase: "new_launch",
  sourceProvenance: "pump-bonding-curve@fixture",
};
const event = normalizeCandidate(solanaInput);
assert.equal(event.token, solanaInput.token);
assert.equal(rawEventKey(event), `solana|${solanaInput.transactionId}|1`);
assert.throws(() => normalizeCandidate({ ...solanaInput, token: "0x1234" }));
```

Add a cross-family case proving an EVM address is rejected for Solana and Base58 is rejected for EVM.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/candidate.test.js`

Expected: FAIL because candidate normalization accepts only EVM addresses and hashes.

- [ ] **Step 3: Add family-specific validation**

Use `new PublicKey(value).toBase58()` to validate Solana account keys. Validate signatures as non-empty Base58 strings up to 88 characters. Preserve `blockOrSlot` and `eventIndex` as non-negative integers. Do not lowercase Base58 fields in keys:

```js
const identity = event.chainFamily === "solana"
  ? [event.chain, event.venue, event.pool || event.token]
  : [event.chain, event.venue, event.pool || event.token].map((value) => value.toLowerCase());
return identity.join("|");
```

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/candidate.test.js test/runtime.test.js test/queue.test.js`

Expected: all candidate and queue tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/candidate.js test/candidate.test.js
git commit -m "支持 Solana 候选事件标识"
```

### Task 3: Build deterministic per-program cursors

**Files:**
- Create: `src/solana/cursor.js`
- Create: `test/solana-cursor.test.js`
- Modify: `src/store.js`
- Modify: `test/store.test.js`

- [ ] **Step 1: Write failing cursor tests**

Test pure cursor validation and page planning:

```js
const state = createSolanaCursorState();
assert.deepEqual(state, { programs: {} });
const next = advanceProgramCursor(state, "pump", {
  signature: "abc", slot: 101, finalized: false,
});
assert.deepEqual(next.programs.pump, {
  signature: "abc", slot: 101, finalized: false,
});
assert.throws(() => advanceProgramCursor(next, "pump", { signature: "def", slot: 100 }));
```

Add store migration coverage from the current schema to a new version containing `cursors.solanaPrograms`, while preserving every EVM cursor and outbox item.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/solana-cursor.test.js test/store.test.js`

Expected: FAIL because per-program cursor state is absent.

- [ ] **Step 3: Implement monotonic cursor state**

Each program cursor stores:

```js
{
  signature: "base58",
  slot: 123,
  finalized: false,
  updatedAt: 1_000,
}
```

Permit a different signature at the same slot only after all signatures for that slot have been persisted in `appliedEvents`; otherwise retain the earlier anchor and rescan the slot. Store cursor updates atomically with applied event IDs. Reject decreasing slots. Extend migration by one schema version and keep all current version inputs accepted.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/solana-cursor.test.js test/store.test.js`

Expected: all cursor and migration tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/solana/cursor.js src/store.js test/solana-cursor.test.js test/store.test.js
git commit -m "持久化 Solana 程序扫描游标"
```

### Task 4: Implement HTTP reconciliation and WebSocket hints

**Files:**
- Create: `src/solana/rpc.js`
- Create: `src/solana/discovery.js`
- Create: `test/solana-discovery.test.js`
- Create: `test/fixtures/solana/signature-pages.json`

- [ ] **Step 1: Write failing reconciliation tests**

Cover:

- `getSignaturesForAddress` pages are read newest-first but processed oldest-first;
- pagination stops at the persisted signature/slot anchor;
- all transactions use the same HTTP connection selected for that reconciliation session;
- a primary failure restarts the entire uncommitted session against fallback and re-reads its current slot;
- cursor advances only after all transaction callbacks succeed;
- WS duplicate hints and later HTTP reconciliation produce one raw event;
- a WS disconnect does not stop the process and schedules immediate HTTP reconciliation.

Use an injected connection interface:

```js
{
  getSlot(commitment),
  getSignaturesForAddress(programId, options, commitment),
  getTransaction(signature, options),
  onLogs(programId, callback, commitment),
  removeOnLogsListener(id),
}
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/solana-discovery.test.js`

Expected: FAIL because Solana discovery modules do not exist.

- [ ] **Step 3: Construct rate-limited connections**

`createSolanaRpcContext(config)` creates discovery and analysis `Connection` objects. Identical normalized HTTP URLs reuse one limiter and connection, mirroring Phase 0. The discovery-session runner receives the connection as a whole. `send` calls are not exposed because this repository is push-only.

- [ ] **Step 4: Implement reconciliation and subscriptions**

`reconcileProgram` must return, without committing:

```js
{
  programId,
  safeSlot,
  newestProcessed: { signature, slot },
  events,
}
```

The caller atomically commits events and cursor only after all parsers/handlers succeed. `subscribePrograms` treats WebSocket notifications as low-latency hints, fetches the full transaction over HTTP, deduplicates by `signature + instructionIndex`, and always retains periodic HTTP reconciliation as the source of completeness.

Use `confirmed` for discovery. Security code may request `finalized` separately.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/solana-discovery.test.js test/solana-cursor.test.js test/discovery-session.test.js`

Expected: all discovery tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/solana/rpc.js src/solana/discovery.js test/solana-discovery.test.js test/fixtures/solana/signature-pages.json
git commit -m "实现 Solana 订阅与确定性补扫"
```

### Task 5: Parse Pump lifecycle events

**Files:**
- Create: `src/venues/solana/pump.js`
- Create: `test/pump-adapter.test.js`
- Create: `test/fixtures/solana/pump-create.json`
- Create: `test/fixtures/solana/pump-trade.json`
- Create: `test/fixtures/solana/pump-migrate.json`
- Create: `test/fixtures/solana/pumpswap-create-pool.json`

- [ ] **Step 1: Capture official-IDL-backed fixtures**

Capture sanitized `getTransaction` JSON for one Pump create, buy, sell, migration, and PumpSwap pool creation. Record signature, slot, block time, account keys, inner instructions, log messages, pre/post token balances, and IDL revision. Confirm the executing program matches the verified profile.

- [ ] **Step 2: Write failing parser tests**

Assert exact normalized values for mint, quote mint, bonding curve/pool, creator, signature, instruction index, slot, created time, and lifecycle:

- create → `new_launch`;
- migration → `graduated`;
- PumpSwap create pool → `new_pool`.

Assert raw create/graduation events never directly produce a Telegram decision, malformed account layouts return contextual parser errors, and buy/sell instructions feed lifecycle/flow evidence without becoming new candidates.

- [ ] **Step 3: Run and verify RED**

Run: `node --test test/pump-adapter.test.js`

Expected: FAIL because the Pump adapter does not exist.

- [ ] **Step 4: Implement against the pinned IDL revision**

Export one adapter per Pump program with:

```js
{
  id,
  version,
  programId,
  sourceKind: "launchpad",
  parseTransaction(transactionContext),
}
```

Decode instruction discriminators and account positions from the pinned official IDL. If the deployed transaction uses an unknown discriminator or account layout, return an `unsupported-idl-revision` error with program, signature, and instruction index; do not guess fields from log text alone.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/pump-adapter.test.js test/candidate.test.js test/alert-policy.test.js`

Expected: all Pump parser and policy tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/venues/solana/pump.js test/pump-adapter.test.js test/fixtures/solana/pump-create.json test/fixtures/solana/pump-trade.json test/fixtures/solana/pump-migrate.json test/fixtures/solana/pumpswap-create-pool.json
git commit -m "接入 Pump 与 PumpSwap 生命周期"
```

### Task 6: Parse Raydium pools and launches

**Files:**
- Create: `src/venues/solana/raydium.js`
- Create: `test/raydium-adapter.test.js`
- Create: `test/fixtures/solana/raydium-launchlab.json`
- Create: `test/fixtures/solana/raydium-cpmm.json`
- Create: `test/fixtures/solana/raydium-clmm.json`
- Create: `test/fixtures/solana/raydium-amm-v4.json`

- [ ] **Step 1: Capture verified Raydium fixtures**

Using official Raydium IDLs/SDK layouts, capture one sanitized transaction per program. Confirm executable program ID, IDL/layout revision, pool account, base/quote mints, vaults, authority, and creation slot.

- [ ] **Step 2: Write failing parser tests**

Assert LaunchLab emits launch/lifecycle data and CPMM/CLMM/AMM v4 emit `new_pool`. Each parser must choose the target token only when the other mint is in the configured Solana quote set, preserve pool/vault/authority metadata for security, and reject account-owner mismatches.

- [ ] **Step 3: Run and verify RED**

Run: `node --test test/raydium-adapter.test.js`

Expected: FAIL because the Raydium adapter does not exist.

- [ ] **Step 4: Implement pinned parsers**

Use Anchor IDL discriminators for LaunchLab, CPMM, and CLMM. Use the official Raydium SDK account layout for AMM v4. Normalize every event through `normalizeCandidate`; add adapter metadata containing pool authority and vaults but never serialize connection objects or raw secrets.

Unknown account versions produce `unsupported-layout-revision`, not a partially trusted candidate.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/raydium-adapter.test.js test/solana-discovery.test.js test/candidate.test.js`

Expected: all Raydium tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/venues/solana/raydium.js test/raydium-adapter.test.js test/fixtures/solana/raydium-launchlab.json test/fixtures/solana/raydium-cpmm.json test/fixtures/solana/raydium-clmm.json test/fixtures/solana/raydium-amm-v4.json
git commit -m "接入 Raydium 主要池与发射平台"
```

### Task 7: Inspect mint controls and real sell flows

**Files:**
- Create: `src/security/solana/mint.js`
- Create: `src/security/solana/flows.js`
- Create: `src/security/solana/index.js`
- Create: `test/solana-security.test.js`
- Create: `test/fixtures/solana/token-2022-mints.json`
- Create: `test/fixtures/solana/real-sells.json`

- [ ] **Step 1: Write failing mint-risk tests**

Cover legacy SPL Token and Token-2022 mints with:

- no mint/freeze authority;
- active mint authority;
- active freeze authority;
- transfer fee;
- transfer hook;
- permanent delegate;
- default-frozen accounts;
- unknown extension.

Assert these controls become explicit facts/red flags. Authority or extension presence alone does not claim `blocked`; unsupported behavior keeps sellability `unknown` unless a transaction proves blocking.

- [ ] **Step 2: Write failing real-flow tests**

Using `preTokenBalances`, `postTokenBalances`, `preBalances`, `postBalances`, and account keys, prove:

- three independent sellers reduce target-token balances and receive quote-token/SOL value tied to the verified pool vault;
- repeated sells by one signer count once;
- dust-only outflow does not count as meaningful;
- failed transactions do not count;
- a transfer unrelated to the bound pool does not count;
- explicit sell failures caused by a program restriction can produce `blocked` only when the venue adapter identifies the restriction deterministically.

- [ ] **Step 3: Run and verify RED**

Run: `node --test test/solana-security.test.js`

Expected: FAIL because Solana security modules do not exist.

- [ ] **Step 4: Implement mint inspection**

Use `getMint`/Token-2022 extension decoding at `finalized` commitment. Return:

```js
{
  status: "complete" | "unknown",
  tokenProgram,
  mintAuthority,
  freezeAuthority,
  extensions: {
    transferFee: null,
    transferHook: null,
    permanentDelegate: null,
    defaultFrozen: null,
  },
  redFlags: [],
}
```

An undecodable mint or unknown extension sets status to unknown and cannot contribute safety points.

- [ ] **Step 5: Implement sell-flow evidence and registry**

Bind the candidate program, pool, authority, base/quote vaults, and mints before counting evidence. Return the common `sellabilityResult` shape. `confirmed` requires the configured meaningful independent-seller threshold and verified quote outflow; `blocked` requires deterministic restriction evidence; every other outcome is `unknown` with a machine-readable reason.

- [ ] **Step 6: Run and verify GREEN**

Run: `node --test test/solana-security.test.js test/alert-policy.test.js test/core-score.test.js`

Expected: all security and common policy tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/security/solana/mint.js src/security/solana/flows.js src/security/solana/index.js test/solana-security.test.js test/fixtures/solana/token-2022-mints.json test/fixtures/solana/real-sells.json
git commit -m "验证 Solana 权限与真实卖出证据"
```

### Task 8: Import the Solana wallet catalog

**Files:**
- Modify: `src/wallets/catalog.js`
- Modify: `scripts/import-wallet-csv.js`
- Modify: `test/wallet-csv.test.js`
- Create: `test/fixtures/wallets/solana.csv`

- [ ] **Step 1: Add failing Base58 catalog tests**

Assert valid Base58 addresses are accepted, EVM addresses are rejected for family `solana`, duplicates merge tags/sources, any `kol` tag wins classification, all other tags become smart money, and output is deterministic.

Assert the command:

```bash
npm run import-wallets -- --family solana --output data/wallets/solana.json test/fixtures/wallets/solana.csv
```

reports accepted/rejected counts without printing the catalog addresses.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/wallet-csv.test.js`

Expected: FAIL until the importer validates Solana `PublicKey` values.

- [ ] **Step 3: Implement family-specific address normalization**

For Solana, use `new PublicKey(address).toBase58()` and preserve case. Reject rows whose chain column is not `sol` or `solana`. Emit the same schema version 1 shape with `family: "solana"`. Keep the +5/+8 scoring cap and address-once rule in the common scorer.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/wallet-csv.test.js test/core-score.test.js`

Expected: all wallet and score tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wallets/catalog.js scripts/import-wallet-csv.js test/wallet-csv.test.js test/fixtures/wallets/solana.csv
git commit -m "导入 Solana KOL 与聪明钱地址"
```

### Task 9: Assemble the Solana process and Telegram report

**Files:**
- Modify: `src/app.js`
- Modify: `src/notify.js`
- Modify: `src/index.js`
- Modify: `package.json`
- Create: `test/solana-app.test.js`
- Modify: `test/notify.test.js`
- Modify: `test/push-only.test.js`

- [ ] **Step 1: Write failing application tests**

Build a Solana app with fake connections and temporary state. Assert:

- state and lock use `data/solana`;
- Pump and Raydium adapters are registered;
- recovery and shadow mode emit no Telegram, including blocked historical results;
- live `confirmed + score >= minScore` emits a candidate report;
- live `blocked` emits a risk report;
- live `unknown + score 100` stays silent;
- notification IDs preserve Base58 and include `solana`;
- report links use Solana explorer/DexScreener profiles;
- no transaction/send method exists.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/solana-app.test.js test/notify.test.js test/push-only.test.js`

Expected: FAIL until the app factory can assemble the Solana runtime.

- [ ] **Step 3: Assemble runtime dependencies**

Branch only at the runtime boundary:

```js
export async function createApp({ chainKey, env = process.env, dependencies = {} }) {
  const config = loadChainConfig(chainKey, env);
  return config.family === "solana"
    ? createSolanaApp(config, dependencies)
    : createEvmApp(config, dependencies);
}
```

Both implementations return the same `watch/scan/check` command surface and feed the same candidate handler, score, alert policy, store, outbox, and notifier. The Solana app runs one reconciliation loop, optional WS subscriptions, pending checks, and outbox loop under one process-level failure boundary.

Add:

```json
{
  "watch:solana": "node src/index.js watch --chain solana"
}
```

Format the first line as:

```text
🟡 [Solana] 人工复核 TOKEN 74/100
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/solana-app.test.js test/notify.test.js test/push-only.test.js test/index.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/notify.js src/index.js package.json test/solana-app.test.js test/notify.test.js test/push-only.test.js
git commit -m "组装 Solana 独立扫描进程"
```

### Task 10: Document, shadow-run, and accept Solana

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `AGENTS.md`
- Create: `docs/operations/multichain-solana.md`

- [ ] **Step 1: Document operation and failure semantics**

Document HTTP/analysis/WS RPC roles, reconciliation-only mode, per-program cursors, `confirmed` discovery vs `finalized` security checks, Solana wallet import, shadow mode, state directory, and strict confirmed/blocked notification gate. Repeat that no private key or transaction function is present.

Update `AGENTS.md` only if the EVM plan did not already add the confirmed EVM/Solana split and push-only rules.

- [ ] **Step 2: Run full automated verification**

Run:

```bash
npm test
node --check src/solana/rpc.js
node --check src/solana/discovery.js
node --check src/venues/solana/pump.js
node --check src/venues/solana/raydium.js
node --check src/security/solana/index.js
git diff --check
```

Expected: all commands exit 0 and every test PASS.

- [ ] **Step 3: Run fixture-backed process smoke tests**

Run `scan --chain solana` against the local fake HTTP/WS fixtures. Expected: events are processed oldest-first, recovery writes only `data/solana`, no Telegram is sent in shadow mode, WS duplicates are deduplicated, and the process exits 0 for one-shot scan.

- [ ] **Step 4: Run live-RPC shadow observation**

Run `npm run watch:solana` with `ALERT_MODE=shadow`. Record discovery counts by program, reconciliation lag, duplicate count, confirmed/blocked/unknown security results, HTTP request rate, WS reconnects, 429 count, cursor continuity across restart, and process exits.

Acceptance requires no unexplained signature/slot gaps, no cross-chain state writes, no Telegram messages, no secret-bearing logs, and request rates within configured budgets.

- [ ] **Step 5: Enable Solana live alerts**

Set `ALERT_MODE=live`, restart only the Solana process, and verify startup chain identity, advancing per-program cursors, and the alert truth table. Do not enable any adapter that lacks fixture-backed pool binding and sellability evidence; it remains discovery-only and silent.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md .env.example AGENTS.md docs/operations/multichain-solana.md
git commit -m "说明 Solana 部署与安全验收"
```

- [ ] **Step 7: Fresh final verification**

Run:

```bash
npm test
git diff --check
git status --short --branch
```

Expected: all tests PASS, diff check is clean, and the worktree has no uncommitted files.

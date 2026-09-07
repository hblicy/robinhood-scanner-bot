import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZeroAddress, getAddress } from "ethers";
import { createStore } from "../src/store.js";
import {
  classifyAuxiliaryCandidate,
  createInspectionCheckHandlers,
  previewPonsRange,
  reconcilePonsWatchlist,
  runPendingChecks,
  runPonsWatchIteration,
  refreshMarketHeat,
  watchPonsRange,
} from "../src/scanner.js";
import { ADDR } from "../src/config.js";
import { drainOutbox } from "../src/outbox.js";
import { createPonsTokenState } from "../src/lifecycle.js";

const dirs = [];
const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const CURVE = getAddress("0x2222222222222222222222222222222222222222");
const DEPLOYER = getAddress("0x3333333333333333333333333333333333333333");
const EVENT_ID = `4663:${"0x" + "ab".repeat(32)}:1`;

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pons-scanner-"));
  dirs.push(dir);
  return createStore({ dataDir: dir, now: () => 10_000, maxSeenEntries: 10, seenTtlMs: 1000 });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function launchRecord(phase = 0) {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: DEPLOYER,
    creatorFeeRecipient: DEPLOYER,
    pairToken: ZeroAddress,
    graduationThreshold: "1000",
    poolFee: 0,
    tickSpacing: 200,
    creatorTaxBps: 100,
    buybackEnabled: true,
    phase,
    sweptQuote: "0",
    sweptTokens: "0",
    sweptAt: 0,
    exists: true,
  };
}

function launchEvent() {
  return {
    kind: "token_launched",
    eventId: EVENT_ID,
    blockNumber: 120,
    transactionIndex: 0,
    logIndex: 1,
    transactionHash: `0x${"ab".repeat(32)}`,
    token: TOKEN,
    createdAt: 9_000,
    args: { curve: CURVE, deployer: DEPLOYER, pairToken: ZeroAddress },
  };
}

function dependencies(store, overrides = {}) {
  return {
    provider: {},
    store,
    fromBlock: 120,
    toBlock: 120,
    now: () => 10_000,
    scanRange: async () => [launchEvent()],
    readLaunch: async () => launchRecord(),
    ...overrides,
  };
}

test("atomically commits realtime Pons state and checks without raw lifecycle notification", async () => {
  const store = tempStore();
  const result = await watchPonsRange(dependencies(store));
  const state = store.snapshot();
  assert.equal(result.transitions.length, 1);
  assert.equal(state.cursors.ponsV2, 120);
  assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "not_graduated");
  assert.ok(state.appliedEvents[EVENT_ID]);
  assert.equal(Object.keys(state.outbox).length, 0);
  assert.ok(state.pendingChecks[`${EVENT_ID}:curve_flow`]);
});

test("replaying the same Pons range does not duplicate state or notifications", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  await watchPonsRange(dependencies(store));
  const state = store.snapshot();
  assert.equal(Object.keys(state.appliedEvents).length, 1);
  assert.equal(Object.keys(state.outbox).length, 0);
  assert.equal(Object.keys(state.pendingChecks).length, 4);
  assert.equal(state.watchlist.length, 0);
});

test("Telegram failure leaves a critical notification retryable without rolling back its cursor", async () => {
  const store = tempStore();
  store.commitPonsRange({
    toBlock: 120,
    transitions: [{
      eventId: EVENT_ID,
      blockNumber: 120,
      token: TOKEN,
      nextToken: createPonsTokenState(launchEvent(), launchRecord(), 10_000),
      notifications: [{
        id: `${EVENT_ID}:hard_kill`,
        eventId: EVENT_ID,
        transitionType: "hard_kill",
        token: TOKEN,
        text: "hard kill",
      }],
      checks: [],
    }],
  });
  const result = await drainOutbox({
    store,
    send: async () => { throw new Error("telegram unavailable"); },
    now: () => 10_000,
  });
  const state = store.snapshot();
  assert.equal(result.retried, 1);
  assert.equal(state.cursors.ponsV2, 120);
  assert.equal(state.outbox[`${EVENT_ID}:hard_kill`].attempts, 1);
});

test("third-party check failures do not roll back the Pons cursor", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  const result = await runPendingChecks({
    store,
    handlers: {
      curve_flow: async () => { throw new Error("Gecko unavailable"); },
      holders: async () => null,
      deployer_24h: async () => null,
      line_a: async () => null,
    },
    now: () => 10_000,
  });
  const state = store.snapshot();
  assert.equal(result.retried, 1);
  assert.equal(state.cursors.ponsV2, 120);
  assert.match(state.pendingChecks[`${EVENT_ID}:curve_flow`].lastError, /Gecko unavailable/);
});

test("inspection pending checks atomically update risk state and enqueue a transition", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  const handlers = createInspectionCheckHandlers({
    provider: {},
    store,
    now: () => 20_000,
    inspect: async () => ({
      token: TOKEN,
      identity: "pons-v2",
      protocolPhase: "not_graduated",
      monitorState: "killed",
      marketReady: false,
      riskDataStatus: "known",
      reasons: ["cannot-sell"],
      curve: { status: "sufficient", tradeCount: 5, uniqueTraders: 3, bidirectional: false },
      timedOut: false,
      errors: [],
    }),
  });
  const result = await runPendingChecks({ store, handlers, now: () => 20_000, limit: 1 });
  const state = store.snapshot();
  assert.equal(result.completed, 1);
  assert.equal(state.tokens[TOKEN.toLowerCase()].monitorState, "killed");
  assert.equal(state.tokens[TOKEN.toLowerCase()].killReason, "cannot-sell");
  assert.equal(state.pendingChecks[`${EVENT_ID}:curve_flow`].status, "completed");
  assert.ok(state.outbox[`${EVENT_ID}:curve_flow:hard_kill`]);
});

test("timed-out inspections remain retryable without changing token state", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  const before = store.snapshot().tokens[TOKEN.toLowerCase()];
  const handlers = createInspectionCheckHandlers({
    provider: {},
    store,
    now: () => 20_000,
    inspect: async () => ({ timedOut: true, unfinishedSources: ["holders"] }),
  });
  const result = await runPendingChecks({ store, handlers, now: () => 20_000, limit: 1 });
  const state = store.snapshot();
  assert.equal(result.retried, 1);
  assert.deepEqual(state.tokens[TOKEN.toLowerCase()], before);
  assert.match(state.pendingChecks[`${EVENT_ID}:curve_flow`].lastError, /holders/);
});

test("required factory identity read failure prevents range commit", async () => {
  const store = tempStore();
  await assert.rejects(() => watchPonsRange(dependencies(store, {
    readLaunch: async () => { throw new Error("factory rate limited"); },
  })), /factory rate limited/);
  assert.equal(store.snapshot().cursors.ponsV2, null);
  assert.deepEqual(store.snapshot().tokens, {});
});

test("preview is isolated from persistent state and delivery", async () => {
  let storeCalls = 0;
  let sendCalls = 0;
  const result = await previewPonsRange({
    provider: {},
    fromBlock: 120,
    toBlock: 120,
    now: () => 10_000,
    scanRange: async () => [launchEvent()],
    readLaunch: async () => launchRecord(),
    store: { commitPonsRange: () => { storeCalls += 1; } },
    send: async () => { sendCalls += 1; },
  });
  assert.equal(result.transitions.length, 1);
  assert.equal(storeCalls, 0);
  assert.equal(sendCalls, 0);
});

test("startup reconcile applies an authoritative rescued phase without reviving the token", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  store.commitTokenUpdate({
    token: TOKEN,
    nextToken: { ...store.snapshot().tokens[TOKEN.toLowerCase()], watchlist: true, monitorState: "watchlisted" },
  });
  const result = await reconcilePonsWatchlist({
    provider: {},
    store,
    readLaunch: async () => launchRecord(3),
    now: () => 20_000,
  });
  const state = store.snapshot();
  assert.equal(result.updated, 1);
  assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "rescued");
  assert.equal(state.tokens[TOKEN.toLowerCase()].monitorState, "killed");
  assert.equal(state.tokens[TOKEN.toLowerCase()].watchlist, false);
  assert.ok(state.outbox[`reconcile:${TOKEN.toLowerCase()}:rescued:rescued`]);
});

test("startup reconcile updates graduation state without Telegram", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  store.commitTokenUpdate({
    token: TOKEN,
    nextToken: {
      ...store.snapshot().tokens[TOKEN.toLowerCase()],
      watchlist: true,
      monitorState: "watchlisted",
    },
  });

  await reconcilePonsWatchlist({
    provider: {},
    store,
    readLaunch: async () => launchRecord(2),
    now: () => 20_000,
  });

  const state = store.snapshot();
  assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "pool_created");
  assert.equal(Object.keys(state.outbox).length, 0);
});

test("a Pons watch iteration scans only finalized blocks and advances its own cursor", async () => {
  const store = tempStore();
  const ranges = [];
  const runtime = { lastBlock: null };
  const result = await runPonsWatchIteration(runtime, {
    provider: {},
    store,
    settings: { ponsConfirmations: 2, lineAMaxAgeMinutes: 20 },
    getBlockNumber: async () => 125,
    findFirstBlockAtOrAfter: async () => 120,
    scanRange: async (_provider, fromBlock, toBlock) => {
      ranges.push([fromBlock, toBlock]);
      return [launchEvent()];
    },
    readLaunch: async () => launchRecord(),
    now: () => 10_000,
  });
  assert.deepEqual(ranges, [[120, 123]]);
  assert.equal(result.complete, true);
  assert.equal(runtime.lastBlock, 123);
  const state = store.snapshot();
  assert.equal(state.cursors.ponsV2, 123);
  assert.equal(Object.keys(state.outbox).length, 0);
  assert.equal(Object.keys(state.pendingChecks).length, 0);
});

test("a saved Pons cursor schedules realtime checks without raw launch notifications", async () => {
  const store = tempStore();
  store.commitPonsRange({ toBlock: 119, transitions: [] });
  const runtime = { lastBlock: null };

  await runPonsWatchIteration(runtime, {
    provider: {},
    store,
    settings: { ponsConfirmations: 2, lineAMaxAgeMinutes: 20 },
    getBlockNumber: async () => 125,
    findFirstBlockAtOrAfter: async () => 120,
    scanRange: async () => [launchEvent()],
    readLaunch: async () => launchRecord(),
    now: () => 10_000,
  });

  const state = store.snapshot();
  assert.equal(Object.keys(state.outbox).length, 0);
  assert.ok(state.pendingChecks[`${EVENT_ID}:line_a`]);
});

test("auxiliary discovery classifies LONG only after an explicit non-Pons factory result", async () => {
  const event = {
    token: TOKEN,
    quote: ADDR.WETH,
    venue: "uniswap-v4",
    poolId: `0x${"aa".repeat(32)}`,
  };
  const long = await classifyAuxiliaryCandidate(event, {
    provider: {},
    readLaunch: async () => ({ ...launchRecord(), exists: false }),
  });
  assert.equal(long.pad, "long");

  const pons = await classifyAuxiliaryCandidate(event, {
    provider: {},
    readLaunch: async () => launchRecord(),
  });
  assert.equal(pons.pad, "pons-v2");

  const unknown = await classifyAuxiliaryCandidate(event, {
    provider: {},
    readLaunch: async () => { throw new Error("RPC timeout"); },
  });
  assert.equal(unknown.pad, "unknown");
  assert.match(unknown.error, /RPC timeout/);
});

test("LONG classification uses quote addresses and ignores display symbols", async () => {
  const result = await classifyAuxiliaryCandidate({
    token: TOKEN,
    quote: "0x6666666666666666666666666666666666666666",
    quoteSymbol: "NVDA",
    venue: "uniswap-v4",
  }, {
    provider: {},
    readLaunch: async () => ({ ...launchRecord(), exists: false }),
  });
  assert.equal(result.pad, "uniswap-native");
});

test("market heat is persisted without Telegram notifications", async () => {
  const store = tempStore();
  const base = {
    provider: {},
    store,
    now: () => 3_600_000,
    getBlockNumber: async () => 100,
    findFirstBlockAtOrAfter: async () => 50,
    scanRange: async () => [
      { kind: "token_launched" },
      { kind: "token_launched" },
    ],
    getTopPools: async () => [{ category: "memecoin" }],
    settings: { highHeatLaunches24h: 20_000, watchlistCapNormal: 3, watchlistCapHighHeat: 1 },
  };
  const first = await refreshMarketHeat(base);
  const second = await refreshMarketHeat(base);
  const state = store.snapshot();
  assert.equal(first.decision, "打");
  assert.equal(second.decision, "打");
  assert.equal(state.heat.admissionCap, 3);
  assert.equal(Object.keys(state.outbox).length, 0);
});

test("market heat becomes conservatively no-trade when a required source fails", async () => {
  const store = tempStore();
  const heat = await refreshMarketHeat({
    provider: {},
    store,
    now: () => 3_600_000,
    getBlockNumber: async () => 100,
    findFirstBlockAtOrAfter: async () => 50,
    scanRange: async () => { throw new Error("Factory rate limited"); },
    getTopPools: async () => [{ category: "memecoin" }],
    settings: { highHeatLaunches24h: 20_000, watchlistCapNormal: 3, watchlistCapHighHeat: 1 },
  });
  assert.equal(heat.decision, "不打");
  assert.equal(heat.stale, true);
  assert.match(heat.errors[0].message, /Factory rate limited/);
});

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
  const inspectionId = `${EVENT_ID}:pons_inspection`;
  assert.ok(state.pendingChecks[inspectionId]);
  assert.equal(state.pendingChecks[inspectionId].type, "pons_inspection");
  assert.equal(Object.keys(state.pendingChecks).length, 1);
});

test("replaying the same Pons range does not duplicate state or notifications", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  await watchPonsRange(dependencies(store));
  const state = store.snapshot();
  assert.equal(Object.keys(state.appliedEvents).length, 1);
  assert.equal(Object.keys(state.outbox).length, 0);
  assert.equal(Object.keys(state.pendingChecks).length, 1);
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
        evidenceConfirmed: true,
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
      pons_inspection: async () => { throw new Error("Gecko unavailable"); },
    },
    now: () => 10_000,
  });
  const state = store.snapshot();
  assert.equal(result.retried, 1);
  assert.equal(state.cursors.ponsV2, 120);
  assert.match(state.pendingChecks[`${EVENT_ID}:pons_inspection`].lastError, /Gecko unavailable/);
  assert.equal(state.pendingChecks[`${EVENT_ID}:pons_inspection`].nextAttemptAt, 15_000);
});

test("a superseded Pons inspection cannot overwrite newer lifecycle state", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  let releaseInspection;
  let inspectionStarted;
  const started = new Promise((resolve) => { inspectionStarted = resolve; });
  const gate = new Promise((resolve) => { releaseInspection = resolve; });
  const running = runPendingChecks({
    store,
    handlers: {
      pons_inspection: async (check) => {
        const staleToken = store.snapshot().tokens[check.token.toLowerCase()];
        inspectionStarted();
        await gate;
        return {
          token: check.token,
          nextToken: { ...staleToken, monitorState: "killed", updatedAt: 20_000 },
        };
      },
    },
    now: () => 20_000,
    limit: 1,
  });
  await started;

  const newerEventId = `4663:${"0x" + "cd".repeat(32)}:2`;
  store.commitPonsRange({
    toBlock: 121,
    transitions: [{
      eventId: newerEventId,
      blockNumber: 121,
      token: TOKEN,
      nextToken: {
        ...store.snapshot().tokens[TOKEN.toLowerCase()],
        protocolPhase: "pool_created",
        monitorState: "watchlisted",
        updatedAt: 21_000,
      },
      notifications: [],
      checks: [{
        id: `${newerEventId}:pons_inspection`,
        eventId: newerEventId,
        type: "pons_inspection",
        token: TOKEN,
        dueAt: 21_000,
      }],
    }],
  });
  releaseInspection();
  const result = await running;

  const state = store.snapshot();
  assert.equal(result.completed, 0);
  assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "pool_created");
  assert.equal(state.tokens[TOKEN.toLowerCase()].monitorState, "watchlisted");
  assert.equal(state.pendingChecks[`${EVENT_ID}:pons_inspection`].status, "expired");
});

test("a failed superseded Pons inspection cannot become pending again", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  let releaseInspection;
  let inspectionStarted;
  const started = new Promise((resolve) => { inspectionStarted = resolve; });
  const gate = new Promise((resolve) => { releaseInspection = resolve; });
  const running = runPendingChecks({
    store,
    handlers: {
      pons_inspection: async () => {
        inspectionStarted();
        await gate;
        throw new Error("late timeout");
      },
    },
    now: () => 20_000,
    limit: 1,
  });
  await started;

  const newerEventId = `4663:${"0x" + "ef".repeat(32)}:3`;
  store.commitPonsRange({
    toBlock: 121,
    transitions: [{
      eventId: newerEventId,
      blockNumber: 121,
      token: TOKEN,
      nextToken: {
        ...store.snapshot().tokens[TOKEN.toLowerCase()],
        protocolPhase: "pool_created",
        updatedAt: 21_000,
      },
      notifications: [],
      checks: [{
        id: `${newerEventId}:pons_inspection`,
        eventId: newerEventId,
        type: "pons_inspection",
        token: TOKEN,
        dueAt: 21_000,
      }],
    }],
  });
  releaseInspection();
  const result = await running;

  assert.equal(result.retried, 0);
  assert.equal(store.snapshot().pendingChecks[`${EVENT_ID}:pons_inspection`].status, "expired");
});

test("a Pons inspection retries from current state after a lifecycle event without a replacement check", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  let releaseInspection;
  let inspectionStarted;
  const started = new Promise((resolve) => { inspectionStarted = resolve; });
  const gate = new Promise((resolve) => { releaseInspection = resolve; });
  let inspections = 0;
  let currentTime = 20_000;
  const handlers = createInspectionCheckHandlers({
    provider: {},
    store,
    now: () => currentTime,
    inspect: async () => {
      inspections += 1;
      if (inspections === 1) {
        inspectionStarted();
        await gate;
      }
      return {
        token: TOKEN,
        identity: "pons-v2",
        protocolPhase: "not_graduated",
        monitorState: "observed",
        marketReady: false,
        riskDataStatus: "known",
        reasons: [],
        curve: { status: "sufficient", tradeCount: 5, uniqueTraders: 3, bidirectional: true },
        timedOut: false,
        errors: [],
      };
    },
  });
  const running = runPendingChecks({ store, handlers, now: () => 20_000, limit: 1 });
  await started;

  const rescuedEventId = `4663:${"0x" + "12".repeat(32)}:4`;
  const current = store.snapshot().tokens[TOKEN.toLowerCase()];
  store.commitPonsRange({
    toBlock: 121,
    transitions: [{
      eventId: rescuedEventId,
      blockNumber: 121,
      token: TOKEN,
      nextToken: {
        ...current,
        protocolPhase: "rescued",
        monitorState: "killed",
        watchlist: false,
        killReason: "graduation-rescued-no-pool",
        facts: {
          ...current.facts,
          lifecycleEvents: [...current.facts.lifecycleEvents, rescuedEventId],
        },
        updatedAt: 21_000,
      },
      notifications: [],
      checks: [],
    }],
  });
  releaseInspection();

  const staleRun = await running;
  let state = store.snapshot();
  assert.equal(staleRun.completed, 0);
  assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "rescued");
  assert.equal(state.pendingChecks[`${EVENT_ID}:pons_inspection`].status, "pending");

  currentTime = 22_000;
  const retryRun = await runPendingChecks({ store, handlers, now: () => 22_000, limit: 1 });
  state = store.snapshot();
  assert.equal(retryRun.completed, 1);
  assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "rescued");
  assert.equal(state.tokens[TOKEN.toLowerCase()].facts.lifecycleEvents.at(-1), rescuedEventId);
  assert.equal(state.pendingChecks[`${EVENT_ID}:pons_inspection`].status, "completed");
});

test("Pons lifecycle commit retries instead of overwriting a concurrent inspection", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));

  let releaseScan;
  let scanStarted;
  const started = new Promise((resolve) => { scanStarted = resolve; });
  const gate = new Promise((resolve) => { releaseScan = resolve; });
  const sweptEvent = {
    ...launchEvent(),
    kind: "launch_swept",
    eventId: `4663:${"0x" + "34".repeat(32)}:2`,
    blockNumber: 121,
    args: { quoteOut: "10", tokenOut: "20" },
  };
  const lifecycleRun = watchPonsRange(dependencies(store, {
    fromBlock: 121,
    toBlock: 121,
    now: () => 21_000,
    scanRange: async () => {
      scanStarted();
      await gate;
      return [sweptEvent];
    },
    readLaunch: async () => launchRecord(1),
  }));
  await started;

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
      curve: { status: "sufficient", tradeCount: 5, uniqueTraders: 3, bidirectional: true },
      timedOut: false,
      errors: [],
    }),
  });
  const inspection = await runPendingChecks({ store, handlers, now: () => 20_000, limit: 1 });
  assert.equal(inspection.completed, 1);
  releaseScan();

  await assert.rejects(lifecycleRun, /Pons token state changed during range preview/);
  let state = store.snapshot();
  assert.equal(state.cursors.ponsV2, 120);
  assert.equal(state.tokens[TOKEN.toLowerCase()].monitorState, "killed");
  assert.equal(state.tokens[TOKEN.toLowerCase()].facts.inspection.reasons[0], "cannot-sell");

  await watchPonsRange(dependencies(store, {
    fromBlock: 121,
    toBlock: 121,
    now: () => 22_000,
    scanRange: async () => [sweptEvent],
    readLaunch: async () => launchRecord(1),
  }));
  state = store.snapshot();
  assert.equal(state.cursors.ponsV2, 121);
  assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "swept");
  assert.equal(state.tokens[TOKEN.toLowerCase()].monitorState, "killed");
  assert.equal(state.tokens[TOKEN.toLowerCase()].facts.inspection.reasons[0], "cannot-sell");
});

test("pending checks can request an expected business retry without throwing", async () => {
  const store = tempStore();
  store.scheduleCheck({
    id: "candidate-recheck:business",
    type: "candidate_recheck",
    dueAt: 1_000,
  });

  const result = await runPendingChecks({
    store,
    handlers: {
      candidate_recheck: async () => ({ retryAt: 5_000, lastError: "sellability pending" }),
    },
    now: () => 2_000,
  });

  const saved = store.snapshot().pendingChecks["candidate-recheck:business"];
  assert.deepEqual(result, {
    selected: 1,
    completed: 0,
    retried: 1,
    failed: 0,
    nextBucketCursor: 1,
  });
  assert.equal(saved.status, "pending");
  assert.equal(saved.attempts, 1);
  assert.equal(saved.nextAttemptAt, 5_000);
  assert.equal(saved.lastError, "sellability pending");
});

test("candidate check errors use retry offsets anchored to first analysis", async () => {
  const store = tempStore();
  store.scheduleCheck({
    id: "candidate-recheck:anchored",
    type: "candidate_recheck",
    dueAt: 121_000,
    firstAnalyzedAt: 1_000,
    retryOffsetsMs: [120_000, 300_000, 600_000],
    maxAttempts: 3,
  });

  const result = await runPendingChecks({
    store,
    handlers: { candidate_recheck: async () => { throw new Error("RPC unavailable"); } },
    now: () => 121_000,
  });

  const saved = store.snapshot().pendingChecks["candidate-recheck:anchored"];
  assert.deepEqual(result, {
    selected: 1,
    completed: 0,
    retried: 1,
    failed: 0,
    nextBucketCursor: 1,
  });
  assert.equal(saved.attempts, 1);
  assert.equal(saved.nextAttemptAt, 301_000);
  assert.match(saved.lastError, /RPC unavailable/);
});

test("pending checks return the next fair-scheduling bucket", async () => {
  const store = tempStore();
  store.scheduleCheck({
    id: "candidate-recovery:cursor",
    type: "candidate_recovery",
    dueAt: 1_000,
  });
  const result = await runPendingChecks({
    store,
    handlers: { candidate_recovery: async () => undefined },
    now: () => 2_000,
    limit: 1,
    startBucket: 2,
  });
  assert.equal(result.selected, 1);
  assert.equal(result.nextBucketCursor, 0);
});

test("inspection pending checks atomically update risk state and enqueue a transition", async () => {
  const store = tempStore();
  await watchPonsRange(dependencies(store));
  let inspections = 0;
  const handlers = createInspectionCheckHandlers({
    provider: {},
    store,
    now: () => 20_000,
    inspect: async () => {
      inspections += 1;
      return {
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
      };
    },
  });
  const result = await runPendingChecks({ store, handlers, now: () => 20_000, limit: 1 });
  const state = store.snapshot();
  assert.equal(inspections, 1);
  assert.equal(result.completed, 1);
  assert.equal(state.tokens[TOKEN.toLowerCase()].monitorState, "killed");
  assert.equal(state.tokens[TOKEN.toLowerCase()].killReason, "cannot-sell");
  assert.equal(state.pendingChecks[`${EVENT_ID}:pons_inspection`].status, "completed");
  assert.ok(state.outbox[`${EVENT_ID}:pons_inspection:hard_kill`]);
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
  assert.match(state.pendingChecks[`${EVENT_ID}:pons_inspection`].lastError, /holders/);
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
  const discoveryProvider = { role: "discovery" };
  const result = await runPonsWatchIteration(runtime, {
    provider: discoveryProvider,
    store,
    settings: { ponsConfirmations: 2, lineAMaxAgeMinutes: 20 },
    getBlockNumber: async () => 125,
    findFirstBlockAtOrAfter: async () => 120,
    scanRange: async (provider, fromBlock, toBlock) => {
      assert.equal(provider, discoveryProvider);
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
  assert.ok(state.pendingChecks[`${EVENT_ID}:pons_inspection`]);
});

test("a Pons discovery fallback restarts the whole range and commits only the fallback head", async () => {
  const store = tempStore();
  store.commitPonsRange({ toBlock: 90, transitions: [] });
  const runtime = { lastBlock: 90 };
  const official = { name: "official", head: 102 };
  const analysis = { name: "analysis", head: 98 };
  const ranges = [];

  await runPonsWatchIteration(runtime, {
    provider: official,
    store,
    settings: { ponsConfirmations: 0, lineAMaxAgeMinutes: 20 },
    runDiscoverySession: async (work) => {
      await assert.rejects(() => work(official), /official logs failed/);
      return work(analysis);
    },
    getBlockNumber: async (provider) => provider.head,
    findFirstBlockAtOrAfter: async () => 1,
    scanRange: async (provider, fromBlock, toBlock) => {
      ranges.push([provider.name, fromBlock, toBlock]);
      if (provider === official) throw new Error("official logs failed");
      return [];
    },
    readLaunch: async () => {
      throw new Error("readLaunch should not be called for an empty range");
    },
    now: () => 10_000,
  });

  assert.deepEqual(ranges, [
    ["official", 91, 102],
    ["analysis", 91, 98],
  ]);
  assert.equal(store.getPonsCursor(), 98);
  assert.equal(runtime.lastBlock, 98);
});

test("the Pons watch loop retries the same range after a transient launch read failure", async () => {
  const { runPonsWatchLoop } = await import("../src/scanner.js");
  assert.equal(typeof runPonsWatchLoop, "function");

  const store = tempStore();
  const runtime = { lastBlock: null };
  const errors = [];
  const ranges = [];
  const stop = new Error("stop test loop");
  let reads = 0;
  let sleeps = 0;

  await assert.rejects(
    () => runPonsWatchLoop(runtime, {
      provider: {},
      store,
      settings: { ponsConfirmations: 2, lineAMaxAgeMinutes: 20, pollMs: 123 },
      getBlockNumber: async () => 125,
      findFirstBlockAtOrAfter: async () => 120,
      scanRange: async (_provider, fromBlock, toBlock) => {
        ranges.push([fromBlock, toBlock]);
        return [launchEvent()];
      },
      readLaunch: async () => {
        reads += 1;
        if (reads === 1) throw new Error("Pons launch read failed: exceeded maximum retry limit");
        return launchRecord();
      },
      now: () => 10_000,
      sleep: async (milliseconds) => {
        sleeps += 1;
        assert.equal(milliseconds, 123);
        if (sleeps === 2) throw stop;
      },
      log: () => {},
      logError: (message) => errors.push(message),
    }),
    (error) => error === stop
  );

  assert.equal(reads, 2);
  assert.deepEqual(ranges, [[120, 123], [120, 123]]);
  assert.equal(store.getPonsCursor(), 123);
  assert.equal(runtime.lastBlock, 123);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /pons watch failed:.*exceeded maximum retry limit/);
});

test("auxiliary discovery does not infer LONG from a non-Pons factory result", async () => {
  const event = {
    token: TOKEN,
    quote: ADDR.WETH,
    venue: "uniswap-v4",
    poolId: `0x${"aa".repeat(32)}`,
  };
  const ordinary = await classifyAuxiliaryCandidate(event, {
    provider: {},
    readLaunch: async () => ({ ...launchRecord(), exists: false }),
  });
  assert.equal(ordinary.pad, "uniswap-native");

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

  const programmingError = new ReferenceError("readLaunch binding is missing");
  await assert.rejects(
    () => classifyAuxiliaryCandidate(event, {
      provider: {},
      readLaunch: async () => { throw programmingError; },
    }),
    (error) => error === programmingError
  );
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
  const discoveryProvider = { role: "discovery" };
  const base = {
    provider: discoveryProvider,
    store,
    now: () => 3_600_000,
    getBlockNumber: async (provider) => {
      assert.equal(provider, discoveryProvider);
      return 100;
    },
    findFirstBlockAtOrAfter: async (_target, _head, provider) => {
      assert.equal(provider, discoveryProvider);
      return 50;
    },
    scanRange: async (provider) => {
      assert.equal(provider, discoveryProvider);
      return [
        { kind: "token_launched" },
        { kind: "token_launched" },
      ];
    },
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

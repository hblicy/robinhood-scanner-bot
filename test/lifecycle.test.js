import test from "node:test";
import assert from "node:assert/strict";
import { ZeroAddress, getAddress } from "ethers";
import {
  admitWatchlist,
  canGreen,
  createPonsTokenState,
  evaluateLineA,
  reducePonsEvent,
} from "../src/lifecycle.js";

const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const CURVE = getAddress("0x2222222222222222222222222222222222222222");
const DEPLOYER = getAddress("0x3333333333333333333333333333333333333333");

function record(overrides = {}) {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: DEPLOYER,
    pairToken: ZeroAddress,
    poolFee: 0,
    tickSpacing: 200,
    phase: 0,
    exists: true,
    ...overrides,
  };
}

function launched(overrides = {}) {
  return {
    kind: "token_launched",
    eventId: `4663:${"0x" + "ab".repeat(32)}:1`,
    token: TOKEN,
    blockNumber: 100,
    createdAt: 1_000,
    args: { curve: CURVE, deployer: DEPLOYER, pairToken: ZeroAddress },
    ...overrides,
  };
}

const limits = {
  ignoreSeconds: 10,
  minAgeSeconds: 60,
  maxAgeMinutes: 20,
  minFlowTrades: 5,
  minFlowUniqueTraders: 3,
  maxSingleTraderPct: 80,
  maxDeployerLaunches24h: 20,
  maxBundlePct: 30,
  maxInternalPct: 30,
};

function lineAInput(overrides = {}) {
  return {
    identity: "pons-v2",
    ageSeconds: 120,
    name: "Good Cat",
    symbol: "GCAT",
    deployerLaunches24h: 2,
    bundleStatus: "known",
    bundlePct: 10,
    internalStatus: "known",
    internalPct: 10,
    sellability: "observed",
    flow: {
      sampleStatus: "sufficient",
      tradeCount: 8,
      uniqueTraders: 5,
      buyCount: 5,
      sellCount: 3,
      maxTraderPct: 37.5,
      washPattern: false,
    },
    holderCount: 8,
    holdersIncreasing: true,
    narrativeReason: "cat meme",
    ...overrides,
  };
}

test("creates an observed Pons token without conflating protocol and monitor state", () => {
  const state = createPonsTokenState(launched(), record(), 2_000);
  assert.equal(state.pad, "pons-v2");
  assert.equal(state.protocolPhase, "not_graduated");
  assert.equal(state.monitorState, "observed");
  assert.equal(state.marketReady, "unknown");
  assert.equal(state.watchlist, false);
  assert.equal(state.birthAt, 1_000);
});

test("reduces sweep, graduation and rescued phases without inventing market readiness", () => {
  const initial = createPonsTokenState(launched(), record(), 2_000);
  const swept = reducePonsEvent(initial, {
    kind: "launch_swept",
    eventId: `4663:${"0x" + "bc".repeat(32)}:2`,
    token: TOKEN,
    args: { quoteOut: "25", tokenOut: "75" },
  }, record({ phase: 1 }), 3_000);
  assert.equal(swept.protocolPhase, "swept");
  assert.equal(swept.monitorState, "observed");

  const graduated = reducePonsEvent(swept, {
    kind: "pool_graduated",
    eventId: `4663:${"0x" + "cd".repeat(32)}:3`,
    token: TOKEN,
    args: { positionId: "9", tokenAmount: "50", pairTokenAmount: "25" },
  }, record({ phase: 2 }), 4_000);
  assert.equal(graduated.protocolPhase, "pool_created");
  assert.equal(graduated.monitorState, "decay");
  assert.equal(graduated.marketReady, false);
  assert.equal(graduated.positionId, "9");

  const rescued = reducePonsEvent(swept, {
    kind: "reconcile",
    eventId: `4663:${"0x" + "de".repeat(32)}:4`,
    token: TOKEN,
    args: {},
  }, record({ phase: 3 }), 5_000);
  assert.equal(rescued.protocolPhase, "rescued");
  assert.equal(rescued.monitorState, "killed");
  assert.equal(rescued.watchlist, false);
  assert.equal(rescued.killReason, "graduation-rescued-no-pool");
});

test("rejects protocol phase regression and never revives rescued tokens", () => {
  const initial = createPonsTokenState(launched(), record({ phase: 3 }), 2_000);
  assert.equal(initial.monitorState, "killed");
  const stillRescued = reducePonsEvent(initial, {
    kind: "pool_graduated",
    eventId: "later",
    token: TOKEN,
    args: { positionId: "1" },
  }, record({ phase: 2 }), 3_000);
  assert.equal(stillRescued.protocolPhase, "rescued");
  assert.equal(stillRescued.monitorState, "killed");

  const graduated = createPonsTokenState(launched(), record({ phase: 2 }), 2_000);
  assert.throws(() => reducePonsEvent(graduated, {
    kind: "reconcile",
    eventId: "older",
    token: TOKEN,
    args: {},
  }, record({ phase: 1 }), 3_000), /phase regression/);
});

test("Line A admits a fully supported bidirectional candidate", () => {
  const result = evaluateLineA(lineAInput(), limits);
  assert.equal(result.watchlistEligible, true);
  assert.equal(result.monitorState, "watchlisted");
  assert.equal(result.killReason, null);
  assert.equal(result.riskDataStatus, "known");
});

test("unknown bundle evidence may be watchlisted but cannot turn green", () => {
  const result = evaluateLineA(lineAInput({
    bundleStatus: "unknown",
    bundlePct: null,
    internalStatus: "unknown",
    internalPct: null,
  }), limits);
  assert.equal(result.watchlistEligible, true);
  assert.equal(result.riskDataStatus, "unknown");
  assert.equal(canGreen({
    ...createPonsTokenState(launched(), record({ phase: 2 }), 2_000),
    monitorState: "decay",
    riskDataStatus: result.riskDataStatus,
    admissionHeatDecision: "打",
    lineA: { passed: true },
    lineB: { passed: true },
    lineC: { passed: true },
    marketReady: true,
  }), false);
});

test("insufficient trade samples are unknown rather than hard-killed", () => {
  const result = evaluateLineA(lineAInput({
    flow: {
      sampleStatus: "insufficient",
      tradeCount: 4,
      uniqueTraders: 2,
      buyCount: 4,
      sellCount: 0,
      maxTraderPct: 100,
      washPattern: false,
    },
  }), limits);
  assert.equal(result.monitorState, "observed");
  assert.equal(result.watchlistEligible, false);
  assert.equal(result.killReason, null);
  assert.match(result.reasons.join(" "), /sample insufficient/);
});

test("Line A hard-kills only when deterministic thresholds are crossed", () => {
  const cases = [
    [lineAInput({ name: "Official Robinhood Airdrop" }), "forbidden-name"],
    [lineAInput({ deployerLaunches24h: 21 }), "serial-deployer"],
    [lineAInput({ bundlePct: 30.01 }), "bundle-over-30pct"],
    [lineAInput({ internalPct: 31 }), "internal-over-30pct"],
    [lineAInput({ sellability: "blocked" }), "cannot-sell"],
    [lineAInput({ holderCount: 3 }), "holders-at-most-3"],
    [lineAInput({ flow: { ...lineAInput().flow, sellCount: 0 } }), "all-buy-no-sell"],
    [lineAInput({ flow: { ...lineAInput().flow, maxTraderPct: 81, washPattern: true } }), "wash-trading"],
  ];
  for (const [input, reason] of cases) {
    const result = evaluateLineA(input, limits);
    assert.equal(result.monitorState, "killed", reason);
    assert.equal(result.killReason, reason);
    assert.equal(result.watchlistEligible, false);
  }
});

test("early, old, unexplained and non-primary candidates stay observed", () => {
  for (const input of [
    lineAInput({ ageSeconds: 9 }),
    lineAInput({ ageSeconds: 21 * 60 }),
    lineAInput({ narrativeReason: null }),
    lineAInput({ identity: "pons-v1" }),
    lineAInput({ holdersIncreasing: false }),
  ]) {
    const result = evaluateLineA(input, limits);
    assert.equal(result.monitorState, "observed");
    assert.equal(result.watchlistEligible, false);
    assert.equal(result.killReason, null);
  }
});

test("watchlist admission never displaces an active candidate", () => {
  const current = [
    { token: "0x1", monitorState: "watchlisted" },
    { token: "0x2", monitorState: "curve_dead", curveDeadAt: 1_000 },
    { token: "0x3", monitorState: "decay" },
  ];
  const full = admitWatchlist(current, { token: "0x4", watchlistEligible: true }, 3, 2_000, 14_400_000);
  assert.equal(full.admitted, false);
  assert.deepEqual(full.watchlist.map((item) => item.token), ["0x1", "0x2", "0x3"]);

  const recyclable = admitWatchlist([
    ...current.slice(0, 2),
    { token: "0x3", monitorState: "killed" },
  ], { token: "0x4", watchlistEligible: true }, 3, 2_000, 14_400_000);
  assert.equal(recyclable.admitted, true);
  assert.deepEqual(recyclable.watchlist.map((item) => item.token), ["0x1", "0x2", "0x4"]);
});

test("curve-dead slots are recyclable only after the four-hour grace", () => {
  const now = 20_000_000;
  const current = [
    { token: "0x1", monitorState: "watchlisted" },
    { token: "0x2", monitorState: "curve_dead", curveDeadAt: now - 14_400_001 },
    { token: "0x3", monitorState: "decay" },
  ];
  const result = admitWatchlist(current, { token: "0x4", watchlistEligible: true }, 3, now, 14_400_000);
  assert.equal(result.admitted, true);
  assert.deepEqual(result.watchlist.map((item) => item.token), ["0x1", "0x3", "0x4"]);
});

test("green requires known risk, every line, admission heat and a ready graduated market", () => {
  const state = {
    ...createPonsTokenState(launched(), record({ phase: 2 }), 2_000),
    monitorState: "decay",
    riskDataStatus: "known",
    admissionHeatDecision: "打",
    lineA: { passed: true },
    lineB: { passed: true },
    lineC: { passed: true },
    marketReady: true,
  };
  assert.equal(canGreen(state), true);
  assert.equal(canGreen({ ...state, marketReady: false }), false);
  assert.equal(canGreen({ ...state, admissionHeatDecision: "不打" }), false);
  assert.equal(canGreen({ ...state, lineC: { passed: false } }), false);
  assert.equal(canGreen({ ...state, protocolPhase: "rescued" }), false);
});

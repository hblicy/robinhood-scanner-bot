import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCandidateRouteStats,
  formatCandidateRouteStats,
  incrementCandidateRouteStat,
  routeCandidate,
  scoreCandidateUpperBound,
} from "../src/candidate-gate.js";

const thresholds = {
  maxAgeMinutes: 30,
  minScore: 70,
  minLiquidityUsd: 10_000,
  maxMcapUsd: 500_000,
  maxTop10Pct: 50,
  maxDeployerTokens: 5,
  maxTaxBps: 1_000,
};

function candidate(overrides = {}) {
  return {
    chain: "base",
    venue: "uniswap-v2-base",
    source: "gecko",
    createdAt: 1_000,
    observedAt: 1_000 + 5 * 60_000,
    market: {
      scoreKnown: true,
      mcapUsd: 1_000_000,
      liquidityUsd: 1_000,
      volume5m: 0,
      volume1h: 0,
      buys5m: 0,
      sells5m: 0,
    },
    ...overrides,
  };
}

describe("candidate RPC gate", () => {
  it("records an unresolved launchpad candidate before any paid deep check", () => {
    let capabilityReads = 0;
    const result = routeCandidate(candidate({
      sourceKind: "launchpad",
      metadata: { poolResolved: false },
    }), {
      thresholds,
      venueRegistry: {
        route: () => { capabilityReads += 1; return { action: "analyze", reason: null }; },
      },
      supportsSellability: () => true,
    });
    assert.deepEqual(result, { action: "record-only", reason: "pool-not-resolved" });
    assert.equal(capabilityReads, 0);
  });

  it("applies venue capability before sellability and scoring", () => {
    let sellabilityReads = 0;
    const result = routeCandidate(candidate(), {
      thresholds,
      venueRegistry: { route: () => ({ action: "record-only", reason: "venue-security-unsupported" }) },
      supportsSellability: () => { sellabilityReads += 1; return true; },
    });
    assert.deepEqual(result, { action: "record-only", reason: "venue-security-unsupported" });
    assert.equal(sellabilityReads, 0);
  });

  it("records paid candidates without analysis when the monthly budget is exhausted", () => {
    const result = routeCandidate(candidate(), {
      thresholds,
      rpcUsageBudget: { snapshot: () => ({ stage: "exhausted" }) },
      supportsSellability: () => true,
    });
    assert.deepEqual(result, { action: "record-only", reason: "rpc-budget-exhausted" });
  });

  it("keeps verified stock-reference candidates prioritized at the critical stage", () => {
    const budget = { snapshot: () => ({ stage: "critical" }) };
    assert.equal(routeCandidate(candidate(), {
      thresholds,
      rpcUsageBudget: budget,
      supportsSellability: () => true,
    }).reason, "rpc-budget-critical");
    assert.equal(routeCandidate(candidate({ referenceAssetKind: "stock" }), {
      thresholds,
      rpcUsageBudget: budget,
      supportsSellability: () => true,
    }).action, "analyze");
  });

  it("skips venues without strict sellability support before analysis", () => {
    const result = routeCandidate(candidate({ venue: "uniswap-v4-base" }), {
      thresholds,
      supportsSellability: () => false,
    });
    assert.deepEqual(result, { action: "skip", reason: "unsupported-sellability-venue" });
  });

  it("skips only when the known upper bound is below the deep-inspection line", () => {
    const result = routeCandidate(candidate(), {
      thresholds: { ...thresholds, minScore: 71 },
      supportsSellability: () => true,
    });
    assert.equal(result.action, "skip");
    assert.equal(result.reason, "prefilter-score-upper-bound");
    assert.equal(result.upperBound, 60);
    assert.equal(result.deepInspectionFloor, 61);
  });

  it("allows an upper bound equal to MIN_SCORE - 10", () => {
    const result = routeCandidate(candidate(), {
      thresholds,
      supportsSellability: () => true,
    });
    assert.equal(result.action, "analyze");
    assert.equal(result.upperBound, 60);
    assert.equal(result.deepInspectionFloor, 60);
  });

  it("fails open when Gecko score inputs are incomplete", () => {
    const value = candidate({ market: { scoreKnown: false, mcapUsd: 0 } });
    assert.equal(scoreCandidateUpperBound(value, thresholds), null);
    assert.deepEqual(routeCandidate(value, {
      thresholds,
      supportsSellability: () => true,
    }), { action: "analyze", upperBound: null, deepInspectionFloor: 60 });
  });

  it("fails open when normalized market facts contain invalid negative values", () => {
    const value = candidate({ market: { ...candidate().market, liquidityUsd: -1 } });
    assert.equal(scoreCandidateUpperBound(value, thresholds), null);
  });

  it("does not prefilter non-Gecko candidates without complete market facts", () => {
    const value = candidate({ source: "onchain", market: undefined });
    assert.equal(scoreCandidateUpperBound(value, thresholds), null);
  });

  it("tracks only declared aggregate routes", () => {
    const stats = createCandidateRouteStats();
    incrementCandidateRouteStat(stats, "paid_deep_checks");
    incrementCandidateRouteStat(stats, "paid_deep_checks");
    assert.equal(stats.paid_deep_checks, 2);
    assert.match(formatCandidateRouteStats(stats), /deep=2/);
    assert.throws(() => incrementCandidateRouteStat(stats, "typo"), /unknown candidate route stat/i);
  });
});

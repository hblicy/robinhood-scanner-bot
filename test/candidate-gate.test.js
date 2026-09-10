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

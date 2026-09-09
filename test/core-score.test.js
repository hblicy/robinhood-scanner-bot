import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCORE_MAXIMA, scoreCandidate } from "../src/core/score.js";

const thresholds = {
  maxAgeMinutes: 30,
  minLiquidityUsd: 1_500,
  maxMcapUsd: 1_500_000,
  maxTop10Pct: 55,
  maxTaxBps: 500,
  maxDeployerTokens: 8,
  requireSocial: false,
};

describe("common candidate score", () => {
  it("defines fixed categories that total exactly 100 points", () => {
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
    assert.equal(Object.values(SCORE_MAXIMA).reduce((sum, value) => sum + value, 0), 100);
  });

  it("awards no points for unknown facts", () => {
    const result = scoreCandidate({}, thresholds);
    assert.equal(result.score, 0);
    assert.deepEqual(
      Object.fromEntries(Object.entries(result.categories).map(([key, value]) => [key, value.points])),
      Object.fromEntries(Object.keys(SCORE_MAXIMA).map((key) => [key, 0]))
    );
    assert.equal(result.redFlags.length, 0);
  });

  it("counts distinct labeled holders rather than repeated transactions", () => {
    const one = scoreCandidate({
      walletSignalsStatus: "known",
      walletSignalMatches: [
        { address: "0x1111111111111111111111111111111111111111", tx: "0xa" },
        { address: "0x1111111111111111111111111111111111111111", tx: "0xb" },
      ],
    }, thresholds);
    const two = scoreCandidate({
      walletSignalsStatus: "known",
      walletSignalMatches: [
        { address: "0x1111111111111111111111111111111111111111" },
        { address: "0x2222222222222222222222222222222222222222" },
      ],
    }, thresholds);
    assert.equal(one.categories.smartWallets.points, 5);
    assert.equal(two.categories.smartWallets.points, 8);
  });
});

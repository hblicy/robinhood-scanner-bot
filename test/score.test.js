import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreFromFacts } from "../src/analyze.js";

function base(over = {}) {
  return {
    ageMinutes: 8,
    hasTwitter: true,
    hasTelegram: true,
    narrativeHits: ["cat", "hood"],
    buys5m: 20,
    sells5m: 8,
    volume5m: 12000,
    mcapUsd: 45000,
    liquidityUsd: 18000,
    top10Pct: 22,
    holderCount: 80,
    creatorDumping: false,
    creatorPct: 1.2,
    honeypot: false,
    buyTaxBps: 0,
    sellTaxBps: 0,
    lpBurnedPct: 100,
    lpLocked: true,
    mintable: false,
    owner: "0x0000000000000000000000000000000000000000",
    deployerTokens: 1,
    ...over,
  };
}

describe("scoreFromFacts", () => {
  it("scores a clean early token as green", () => {
    const r = scoreFromFacts(base());
    assert.equal(r.verdict, "green");
    assert.ok(r.score >= 75);
    assert.equal(r.red.length, 0);
  });

  it("flags honeypots as skip", () => {
    const r = scoreFromFacts(base({ honeypot: true, honeypotReason: "cannot sell" }));
    assert.equal(r.verdict, "skip");
    assert.ok(r.red.some((x) => /蜜罐/.test(x)));
  });

  it("flags extreme holder concentration", () => {
    const r = scoreFromFacts(base({ top10Pct: 88, lpBurnedPct: 0, lpLocked: false }));
    assert.ok(r.red.some((x) => /集中/.test(x)));
    assert.ok(r.score < 75);
  });

  it("penalizes serial deployers", () => {
    const good = scoreFromFacts(base({ deployerTokens: 1 }));
    const bad = scoreFromFacts(base({ deployerTokens: 40 }));
    assert.ok(bad.score < good.score);
    assert.ok(bad.red.some((x) => /垃圾/.test(x)));
  });

  it("does not mark green when honeypot sim is unfinished", () => {
    const r = scoreFromFacts(base({ honeypot: null }));
    assert.notEqual(r.verdict, "green");
  });
});

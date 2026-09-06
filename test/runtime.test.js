import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { candidateKey, handleCandidate } from "../src/runtime.js";

describe("scanner runtime", () => {
  it("keys candidates by venue, pool and token", () => {
    assert.notEqual(
      candidateKey({ venue: "uniswap-v2", pool: "0xA", token: "0x1" }),
      candidateKey({ venue: "uniswap-v2", pool: "0xB", token: "0x1" })
    );
  });

  it("keeps one-shot scan processing read-only", async () => {
    let trades = 0;
    let seen = 0;
    const report = {
      verdict: "green",
      score: 90,
      venue: "uniswap-v2",
      token: "0x1",
      meta: { symbol: "SAFE" },
      honeypot: { honeypot: false },
    };
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { allowTrading: false, persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => report,
        markSeen: () => { seen += 1; },
        alertReport: async () => {},
        maybeTrade: async () => { trades += 1; },
        log: () => {},
      }
    );
    assert.equal(seen, 0);
    assert.equal(trades, 0);
  });

  it("allows paper-ready reports to reach paper simulation without marking them green", async () => {
    let trades = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { allowTrading: true, persistSeen: true, tradeMode: "paper" },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "review",
          paperReady: true,
          score: 80,
          venue: "uniswap-v2",
          token: "0x1",
          pool: "0xA",
          meta: { symbol: "PAPER" },
          honeypot: { honeypot: null },
        }),
        markSeen: () => {},
        alertReport: async () => {},
        maybeTrade: async () => { trades += 1; },
        log: () => {},
      }
    );
    assert.equal(trades, 1);
  });
});

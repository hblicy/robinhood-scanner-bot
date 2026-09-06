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

  it("keys V4 candidates by pool id", () => {
    assert.notEqual(
      candidateKey({ venue: "uniswap-v4", pool: null, poolId: "0xaaa", token: "0x1" }),
      candidateKey({ venue: "uniswap-v4", pool: null, poolId: "0xbbb", token: "0x1" })
    );
  });

  it("keeps one-shot scan processing read-only", async () => {
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
      { persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => report,
        markSeen: () => { seen += 1; },
        alertReport: async () => {},
        log: () => {},
      }
    );
    assert.equal(seen, 0);
  });

  it("does not mark a candidate seen when its alert ultimately fails", async () => {
    let seen = 0;
    await assert.rejects(
      () => handleCandidate(
        { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
        { persistSeen: true },
        {
          now: () => 1,
          maxAgeMinutes: 30,
          minScore: 55,
          analyze: async () => ({
            verdict: "green",
            score: 90,
            venue: "uniswap-v2",
            pool: "0xA",
            token: "0x1",
            meta: { symbol: "SAFE" },
            honeypot: {},
          }),
          markSeen: () => { seen += 1; },
          alertReport: async () => { throw new Error("telegram unavailable"); },
          log: () => {},
        }
      ),
      /telegram unavailable/
    );
    assert.equal(seen, 0);
  });

  it("marks an alerted candidate only after delivery succeeds", async () => {
    const order = [];
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: true },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "green",
          score: 90,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "SAFE" },
          honeypot: {},
        }),
        markSeen: () => { order.push("seen"); },
        alertReport: async () => { order.push("alert"); },
        log: () => {},
      }
    );
    assert.deepEqual(order, ["alert", "seen"]);
  });
});

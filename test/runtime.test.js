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

  it("skips candidates immediately after the configured age window", async () => {
    let analyzed = 0;
    const seen = [];
    const now = 31 * 60_000;
    const result = await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: 0.9 * 60_000, source: "test" },
      { persistSeen: true },
      {
        now: () => now,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => { analyzed += 1; },
        markSeen: (_key, payload) => { seen.push(payload); },
        alertReport: async () => {},
        log: () => {},
      }
    );
    assert.equal(result, null);
    assert.equal(analyzed, 0);
    assert.equal(seen[0].skipped, "too-old");
  });

  it("analyzes a candidate exactly on the age boundary", async () => {
    let analyzed = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: 1, source: "test" },
      { persistSeen: false },
      {
        now: () => 30 * 60_000 + 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async (candidate) => {
          analyzed += 1;
          return { ...candidate, verdict: "skip", score: 0, meta: { symbol: "OLD" }, honeypot: {} };
        },
        markSeen: () => {},
        alertReport: async () => {},
        log: () => {},
      }
    );
    assert.equal(analyzed, 1);
  });

  it("uses discovery time for the age gate when processing was queued", async () => {
    let analyzed = 0;
    await handleCandidate(
      {
        venue: "uniswap-v2",
        pool: "0xA",
        token: "0x1",
        createdAt: 1,
        observedAt: 30 * 60_000 + 1,
        source: "test",
      },
      { persistSeen: false },
      {
        now: () => 31 * 60_000 + 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async (candidate) => {
          analyzed += 1;
          return { ...candidate, verdict: "skip", score: 0, meta: { symbol: "QUEUED" }, honeypot: {} };
        },
        markSeen: () => {},
        alertReport: async () => {},
        log: () => {},
      }
    );
    assert.equal(analyzed, 1);
  });

  it("includes auxiliary error sources in quiet skip logs", async () => {
    const logs = [];
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async (candidate) => ({
          ...candidate,
          verdict: "skip",
          score: 0,
          meta: { symbol: "QUIET" },
          honeypot: {},
          errorSources: [{ source: "Blockscout holders" }],
        }),
        markSeen: () => {},
        alertReport: async () => {},
        log: (line) => { logs.push(line); },
      }
    );
    assert.match(logs.join("\n"), /Blockscout holders/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { candidateKey, handleCandidate } from "../src/runtime.js";

const CONFIRMED_SELLABILITY = {
  status: "confirmed",
  reason: "sellable",
  buyerSamples: 1,
  ladderSamples: 1,
  meaningfulSellers: 3,
};

describe("scanner runtime", () => {
  it("persists post-analysis state before marking the candidate seen", async () => {
    const order = [];
    const event = { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" };
    let callbackReport;
    let callbackEvent;

    await handleCandidate(event, { persistSeen: true }, {
      now: () => 1,
      maxAgeMinutes: 30,
      minScore: 55,
      analyze: async () => {
        order.push("analyze");
        return {
          ...event,
          score: 50,
          verdict: "skip",
          meta: { symbol: "PENDING" },
          honeypot: { honeypot: null },
          sellability: { status: "unknown", reason: "insufficient-meaningful-sells" },
        };
      },
      onAnalyzed: async (report, analyzedEvent) => {
        order.push("schedule");
        callbackReport = report;
        callbackEvent = analyzedEvent;
      },
      markSeen: () => { order.push("seen"); },
      alertReport: async () => {},
      log: () => {},
    });

    assert.deepEqual(order, ["analyze", "schedule", "seen"]);
    assert.equal(callbackReport.sellability.status, "unknown");
    assert.equal(callbackEvent, event);
  });

  it("does not mark seen when post-analysis persistence fails", async () => {
    let seen = 0;
    const event = { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" };
    await assert.rejects(() => handleCandidate(event, { persistSeen: true }, {
      now: () => 1,
      maxAgeMinutes: 30,
      minScore: 55,
      analyze: async () => ({
        ...event,
        score: 50,
        verdict: "skip",
        meta: { symbol: "PENDING" },
        honeypot: { honeypot: null },
        sellability: { status: "unknown", reason: "insufficient-meaningful-sells" },
      }),
      onAnalyzed: async () => { throw new Error("state write failed"); },
      markSeen: () => { seen += 1; },
      alertReport: async () => {},
      log: () => {},
    }), /state write failed/);
    assert.equal(seen, 0);
  });

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

  it("keeps unknown sellability silent even at score 100", async () => {
    let seen = 0;
    let alerted = 0;
    const report = {
      verdict: "green",
      score: 100,
      venue: "uniswap-v2",
      token: "0x1",
      meta: { symbol: "SAFE" },
      honeypot: { honeypot: false },
      sellability: { status: "unknown", reason: "evidence-unavailable" },
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
        alertReport: async () => { alerted += 1; },
        log: () => {},
      }
    );
    assert.equal(seen, 0);
    assert.equal(alerted, 0);
  });

  it("keeps missing sellability fields silent", async () => {
    let alerted = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "review",
          score: 100,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "MISSING" },
          honeypot: {},
        }),
        markSeen: () => {},
        alertReport: async () => { alerted += 1; },
        log: () => {},
      }
    );
    assert.equal(alerted, 0);
  });

  it("keeps future sellability silent even at score 100 and green verdict", async () => {
    let alerted = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "green",
          score: 100,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "FUTURE" },
          honeypot: {},
          sellability: { status: "future", reason: "planned-rollout" },
        }),
        markSeen: () => {},
        alertReport: async () => { alerted += 1; },
        log: () => {},
      }
    );
    assert.equal(alerted, 0);
  });

  for (const [name, sellability, honeypot] of [
    ["missing counts", { status: "confirmed", reason: "sellable" }, false],
    ["negative counts", { ...CONFIRMED_SELLABILITY, meaningfulSellers: -1 }, false],
    ["non-integer counts", { ...CONFIRMED_SELLABILITY, buyerSamples: 1.5 }, false],
    ["legacy honeypot conflict", CONFIRMED_SELLABILITY, true],
  ]) {
    it(`keeps malformed confirmed sellability silent: ${name}`, async () => {
      let alerted = 0;
      const result = await handleCandidate(
        { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
        { persistSeen: false },
        {
          now: () => 1,
          maxAgeMinutes: 30,
          minScore: 55,
          analyze: async () => ({
            verdict: "green",
            score: 100,
            venue: "uniswap-v2",
            pool: "0xA",
            token: "0x1",
            meta: { symbol: "MALFORMED" },
            honeypot: { honeypot },
            sellability,
          }),
          markSeen: () => {},
          alertReport: async () => { alerted += 1; },
          log: () => {},
        }
      );
      assert.equal(alerted, 0);
      assert.equal(result.sellability.status, "unknown");
      assert.equal(result.sellability.reason, "sellable");
    });
  }

  it("marks unknown sellability seen once when persistence is enabled", async () => {
    let seen = 0;
    let alerted = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: true },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "green",
          score: 100,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "UNKNOWN" },
          honeypot: {},
          sellability: { status: "unknown", reason: "evidence-unavailable" },
        }),
        markSeen: () => { seen += 1; },
        alertReport: async () => { alerted += 1; },
        log: () => {},
      }
    );
    assert.equal(seen, 1);
    assert.equal(alerted, 0);
  });

  it("alerts blocked sellability candidates even when they otherwise skip", async () => {
    let alerted = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "skip",
          score: 0,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "BLOCKED" },
          honeypot: { honeypot: false },
          sellability: { status: "blocked", reason: "hidden-balance-mutation" },
        }),
        markSeen: () => {},
        alertReport: async () => { alerted += 1; },
        log: () => {},
      }
    );
    assert.equal(alerted, 1);
  });

  it("alerts blocked sellability despite a legacy true conflict", async () => {
    let alerted = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "skip",
          score: 0,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "BLOCKED" },
          honeypot: { honeypot: true },
          sellability: { status: "blocked", reason: "hidden-balance-mutation" },
        }),
        markSeen: () => {},
        alertReport: async () => { alerted += 1; },
        log: () => {},
      }
    );
    assert.equal(alerted, 1);
  });

  it("keeps confirmed sellability quiet below the score floor", async () => {
    let alerted = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "skip",
          score: 54,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "CONFIRMED" },
          honeypot: { honeypot: false },
          sellability: CONFIRMED_SELLABILITY,
        }),
        markSeen: () => {},
        alertReport: async () => { alerted += 1; },
        log: () => {},
      }
    );
    assert.equal(alerted, 0);
  });

  it("alerts confirmed sellability at the score floor", async () => {
    let alerted = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "skip",
          score: 55,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "CONFIRMED" },
          honeypot: { honeypot: false },
          sellability: CONFIRMED_SELLABILITY,
        }),
        markSeen: () => {},
        alertReport: async () => { alerted += 1; },
        log: () => {},
      }
    );
    assert.equal(alerted, 1);
  });

  it("keeps confirmed review candidates silent below the score floor", async () => {
    let alerted = 0;
    await handleCandidate(
      { venue: "uniswap-v2", pool: "0xA", token: "0x1", createdAt: null, source: "test" },
      { persistSeen: false },
      {
        now: () => 1,
        maxAgeMinutes: 30,
        minScore: 55,
        analyze: async () => ({
          verdict: "review",
          score: 54,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "CONFIRMED" },
          honeypot: { honeypot: false },
          sellability: CONFIRMED_SELLABILITY,
        }),
        markSeen: () => {},
        alertReport: async () => { alerted += 1; },
        log: () => {},
      }
    );
    assert.equal(alerted, 0);
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
          honeypot: { honeypot: false },
          sellability: CONFIRMED_SELLABILITY,
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

  it("marks a confirmed green candidate seen without alerting below the score floor", async () => {
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
          score: 54,
          venue: "uniswap-v2",
          pool: "0xA",
          token: "0x1",
          meta: { symbol: "SAFE" },
          honeypot: { honeypot: false },
          sellability: CONFIRMED_SELLABILITY,
        }),
        markSeen: () => { order.push("seen"); },
        alertReport: async () => { order.push("alert"); },
        log: () => {},
      }
    );
    assert.deepEqual(order, ["seen"]);
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

  it("keeps stable sellability reasons in quiet skip logs", async () => {
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
          sellability: {
            status: "unknown",
            reason: "insufficient-meaningful-sells",
            details: ["secret router path"],
          },
        }),
        markSeen: () => {},
        alertReport: async () => {},
        log: (line) => { logs.push(line); },
      }
    );
    assert.match(logs.join("\n"), /Blockscout holders/);
    assert.match(logs.join("\n"), /sellability=unknown:insufficient-meaningful-sells/);
    assert.doesNotMatch(logs.join("\n"), /secret router path/);
  });

  it("sanitizes unsafe sellability reasons in quiet skip logs", async () => {
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
          sellability: {
            status: "unknown",
            reason: "bad\n\x1b[31mhttps://example.com/中文",
            details: ["secret router path"],
          },
        }),
        markSeen: () => {},
        alertReport: async () => {},
        log: (line) => { logs.push(line); },
      }
    );
    const log = logs.at(-1) || "";
    assert.equal(logs.length, 2);
    assert.match(log, /sellability=unknown:evidence-unavailable/);
    assert.doesNotMatch(log, /secret router path/);
    assert.doesNotMatch(log, /https:\/\/example\.com/);
    assert.doesNotMatch(log, /\x1b\[31m/);
    assert.doesNotMatch(log, /[\r\n]/);
    assert.doesNotMatch(log, /中文/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyze, RetryableAnalysisError } from "../src/analyze.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const QUOTE = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const POOL = "0x3333333333333333333333333333333333333333";
const NOW = Date.parse("2026-09-06T00:30:00Z");

const event = {
  source: "onchain",
  venue: "uniswap-v2",
  pool: POOL,
  token: TOKEN,
  quote: QUOTE,
  createdAt: NOW - 5 * 60_000,
};

function dependencies(overrides = {}) {
  return {
    now: () => NOW,
    readTokenMeta: async () => ({ name: "Safe", symbol: "SAFE", decimals: 18, totalSupply: 1000n }),
    readOwner: async () => null,
    bytecodeFlags: async () => ({ hasCode: true }),
    dexScreener: async (_token, binding) => ({
      marketBound: Boolean(binding.pool && binding.quote),
      pairCreatedAt: event.createdAt,
      quoteSymbol: "WETH",
      liquidityUsd: 10_000,
      mcapUsd: 50_000,
    }),
    blockscoutToken: async () => ({ holders: 0, totalSupply: 1000n }),
    blockscoutHolders: async () => [],
    blockscoutCreator: async () => null,
    readV2Pool: async () => ({ burnedPct: 0 }),
    readCreatorBalance: async () => 0n,
    deployerHistory: async () => ({ created: null, known: false }),
    honeypotCheck: async () => ({
      honeypot: null,
      complete: false,
      reason: "read-only evidence incomplete",
      buyTaxBps: null,
      sellTaxBps: null,
    }),
    ...overrides,
  };
}

describe("analyze data completeness", () => {
  it("preserves the original cause for a core dependency failure", async () => {
    const rootCause = new Error("original rpc failure");
    await assert.rejects(
      () => analyze(event, dependencies({
        readTokenMeta: async () => { throw rootCause; },
      })),
      (error) => {
        assert.equal(error.cause, rootCause);
        return true;
      }
    );
  });

  for (const [source, override] of [
    ["token metadata", { readTokenMeta: async () => { throw new Error("rpc down"); } }],
    ["bytecode", { bytecodeFlags: async () => { throw new Error("rpc down"); } }],
    ["DexScreener pool", { dexScreener: async () => { throw new Error("http down"); } }],
    ["DexScreener pool", { dexScreener: async () => null }],
  ]) {
    it(`raises a retryable error when ${source} is unavailable`, async () => {
      await assert.rejects(
        () => analyze(event, dependencies(override)),
        (error) => {
          assert.ok(error instanceof RetryableAnalysisError);
          assert.equal(error.code, "RETRYABLE_ANALYSIS");
          assert.match(error.message, new RegExp(source, "i"));
          assert.match(error.message, /0x1111111111111111111111111111111111111111/i);
          return true;
        }
      );
    });
  }

  it("keeps auxiliary failures in the report", async () => {
    const unavailable = async () => { throw new Error("service unavailable"); };
    const report = await analyze(event, dependencies({
      readOwner: unavailable,
      blockscoutToken: unavailable,
      blockscoutHolders: unavailable,
      blockscoutCreator: unavailable,
      readV2Pool: unavailable,
      honeypotCheck: unavailable,
    }));
    const sources = report.errorSources.map(({ source }) => source);
    assert.ok(sources.includes("owner"));
    assert.ok(sources.includes("Blockscout token"));
    assert.ok(sources.includes("Blockscout holders"));
    assert.ok(sources.includes("Blockscout creator"));
    assert.ok(sources.includes("V2 pool"));
    assert.ok(sources.includes("honeypot"));
  });

  it("requires market data for V4 but never calls it an exact binding", async () => {
    const report = await analyze(
      { ...event, venue: "uniswap-v4", pool: null, poolId: `0x${"ab".repeat(32)}` },
      dependencies({
        dexScreener: async (_token, binding) => {
          assert.deepEqual(binding, {});
          return { marketBound: false, liquidityUsd: 10_000, mcapUsd: 50_000 };
        },
      })
    );
    assert.equal(report.marketBound, false);
    assert.notEqual(report.verdict, "green");
  });

  it("passes chain and pool provenance to the sellability inspection path", async () => {
    const pairCreatedAt = NOW - 8 * 60_000;
    let honeypotInput;
    await analyze(
      { ...event, blockNumber: 123, createdAt: NOW - 1 * 60_000 },
      dependencies({
        dexScreener: async () => ({ marketBound: true, pairCreatedAt }),
        honeypotCheck: async (value) => {
          honeypotInput = value;
          return { honeypot: null, complete: false, reason: "incomplete" };
        },
      })
    );
    assert.deepEqual(honeypotInput, {
      token: TOKEN,
      quote: QUOTE,
      venue: "uniswap-v2",
      pool: POOL,
      holders: [],
      blockNumber: 123,
      pairCreatedAt,
      decimals: 18,
    });
  });

  it("falls back to the event creation time when market data has no pair creation time", async () => {
    let honeypotInput;
    await analyze(
      { ...event, createdAt: NOW - 9 * 60_000 },
      dependencies({
        dexScreener: async () => ({ marketBound: true, pairCreatedAt: null }),
        honeypotCheck: async (value) => {
          honeypotInput = value;
          return { honeypot: null, complete: false, reason: "incomplete" };
        },
      })
    );
    assert.equal(honeypotInput.pairCreatedAt, NOW - 9 * 60_000);
  });

  it("reports sellability facts and safely falls back for old honeypot mocks", async () => {
    const report = await analyze(event, dependencies({
      honeypotCheck: async () => ({ honeypot: null, complete: false, reason: "legacy inspector unavailable" }),
    }));
    assert.deepEqual(report.sellability, {
      status: "unknown",
      reason: "legacy inspector unavailable",
      buyerSamples: 0,
      ladderSamples: 0,
      meaningfulSellers: 0,
      details: [],
    });
    assert.equal(report.facts.sellabilityStatus, "unknown");
    assert.equal(report.facts.sellabilityReason, "legacy inspector unavailable");
    assert.equal(report.facts.sellabilityBuyerSamples, 0);
    assert.equal(report.facts.sellabilityLadderSamples, 0);
    assert.equal(report.facts.sellabilityMeaningfulSellers, 0);
  });

  it("does not reward a legacy safe result when sellability evidence is missing", async () => {
    const report = await analyze(event, dependencies({
      honeypotCheck: async () => ({
        honeypot: false,
        complete: true,
        sellOk: true,
        reason: "legacy safe result",
        buyTaxBps: 0,
        sellTaxBps: 0,
      }),
    }));
    const honeypotCheck = report.checks.find((check) => check.key === "honeypot");
    assert.equal(report.sellability.status, "unknown");
    assert.equal(report.honeypot.honeypot, null);
    assert.equal(report.honeypot.complete, false);
    assert.equal(report.honeypot.sellOk, null);
    assert.equal(report.facts.honeypot, null);
    assert.equal(honeypotCheck.pts, 0);
    assert.doesNotMatch(honeypotCheck.detail, /买税/);
  });

  it("skips a token when sellability is blocked", async () => {
    const report = await analyze(event, dependencies({
      honeypotCheck: async () => ({
        honeypot: true,
        complete: true,
        sellOk: false,
        reason: "sell-transfer-blocked",
        sellability: {
          status: "blocked",
          reason: "sell-transfer-blocked",
          buyerSamples: 1,
          ladderSamples: 1,
          meaningfulSellers: 0,
          details: [],
        },
      }),
    }));
    assert.equal(report.verdict, "skip");
    assert.ok(report.red.includes("蜜罐 / 无法卖出"));
  });

  it("allows confirmed sellability to preserve the honeypot safety score", async () => {
    const report = await analyze(event, dependencies({
      honeypotCheck: async () => ({
        honeypot: false,
        complete: true,
        sellOk: true,
        reason: "confirmed real sells",
        buyTaxBps: null,
        sellTaxBps: null,
        sellability: {
          status: "confirmed",
          reason: null,
          buyerSamples: 3,
          ladderSamples: 2,
          meaningfulSellers: 3,
          details: [],
        },
      }),
    }));
    const honeypotCheck = report.checks.find((check) => check.key === "honeypot");
    assert.equal(report.facts.honeypot, false);
    assert.equal(honeypotCheck.pts, 10);
    assert.match(honeypotCheck.detail, /税率未知/);
    assert.doesNotMatch(honeypotCheck.detail, /0bps/);
  });

  it("shows exact zero taxes when confirmed sellability supplies them", async () => {
    const report = await analyze(event, dependencies({
      honeypotCheck: async () => ({
        honeypot: false,
        complete: true,
        sellOk: true,
        reason: "confirmed real sells",
        buyTaxBps: 0,
        sellTaxBps: 0,
        sellability: {
          status: "confirmed",
          reason: null,
          buyerSamples: 3,
          ladderSamples: 2,
          meaningfulSellers: 3,
          details: [],
        },
      }),
    }));
    assert.match(report.checks.find((check) => check.key === "honeypot").detail, /买税 0bps \/ 卖税 0bps/);
  });
});

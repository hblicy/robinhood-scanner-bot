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
});

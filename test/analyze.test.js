import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyze, RetryableAnalysisError } from "../src/analyze.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const QUOTE = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const POOL = "0x3333333333333333333333333333333333333333";
const NOW = Date.parse("2026-09-06T00:30:00Z");
const WALLET_CATALOG = { status: "unconfigured", labels: new Map() };

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
    minScore: 0,
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
    walletCatalog: WALLET_CATALOG,
    ...overrides,
  };
}

describe("analyze data completeness", () => {
  it("uses the selected chain scoring thresholds", async () => {
    const report = await analyze(event, dependencies({
      scoreThresholds: {
        maxAgeMinutes: 3,
        minLiquidityUsd: 1_500,
        maxMcapUsd: 1_500_000,
        maxTop10Pct: 55,
        maxTaxBps: 500,
        maxDeployerTokens: 8,
        requireSocial: false,
      },
    }));
    assert.equal(report.categories.age.points, 5);
  });

  it("skips deep sellability inspection when the preliminary score cannot reach the final floor", async () => {
    let honeypotCalls = 0;
    const report = await analyze(event, dependencies({
      minScore: 70,
      honeypotCheck: async () => {
        honeypotCalls += 1;
        throw new Error("deep inspection should not run");
      },
    }));

    assert.equal(honeypotCalls, 0);
    assert.equal(report.sellability.status, "unknown");
    assert.equal(report.sellability.reason, "prefilter-score");
    assert.equal(report.errorSources.some(({ source }) => source === "honeypot"), false);
  });

  it("runs deep inspection at exactly ten points below the final floor", async () => {
    let honeypotCalls = 0;
    const report = await analyze(event, dependencies({
      minScore: 50,
      honeypotCheck: async () => {
        honeypotCalls += 1;
        return { honeypot: null, complete: false, reason: "insufficient evidence" };
      },
    }));

    assert.equal(report.score, 40);
    assert.equal(honeypotCalls, 1);
    assert.equal(report.sellability.reason, "insufficient evidence");
  });

  it("passes the wallet catalog into deep inspection and maps normalized signals", async () => {
    const walletCatalog = {
      status: "known",
      labels: new Map([[TOKEN.toLowerCase(), { label: "Alpha", type: "kol", source: "manual" }]]),
    };
    let receivedCatalog;
    const report = await analyze(event, dependencies({
      walletCatalog,
      honeypotCheck: async (value) => {
        receivedCatalog = value.walletCatalog;
        return {
          honeypot: null,
          complete: false,
          reason: "insufficient-meaningful-sells",
          sellability: {
            status: "unknown",
            reason: "insufficient-meaningful-sells",
            buyerSamples: 1,
            ladderSamples: 1,
            meaningfulSellers: 0,
            walletSignals: {
              status: "known",
              count: 1,
              matches: [{ label: "Alpha", type: "kol", source: "manual" }],
            },
          },
        };
      },
    }));

    assert.equal(receivedCatalog, walletCatalog);
    assert.deepEqual(report.walletSignals, {
      status: "known",
      count: 1,
      matches: [{ label: "Alpha", type: "kol", source: "manual" }],
    });
    assert.equal(report.facts.walletSignalsStatus, "known");
    assert.equal(report.facts.walletSignalCount, 1);
  });

  it("does not use wallet labels to cross the deep-inspection prefilter", async () => {
    let honeypotCalls = 0;
    await analyze(event, dependencies({
      minScore: 51,
      walletCatalog: {
        status: "known",
        labels: new Map([[TOKEN.toLowerCase(), { label: "Alpha", type: "kol", source: "manual" }]]),
      },
      honeypotCheck: async () => {
        honeypotCalls += 1;
        return { honeypot: null, complete: false, reason: "unexpected" };
      },
    }));
    assert.equal(honeypotCalls, 0);
  });

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

  for (const [source, override] of [
    ["owner", { readOwner: async () => { throw Object.assign(new Error("limited"), { status: 429 }); } }],
    ["V2 pool", { readV2Pool: async () => { throw Object.assign(new Error("limited"), { status: 429 }); } }],
    ["creator balance", {
      blockscoutCreator: async () => ({ creator: "0x2222222222222222222222222222222222222222" }),
      readCreatorBalance: async () => { throw Object.assign(new Error("limited"), { status: 429 }); },
    }],
    ["honeypot", { honeypotCheck: async () => { throw Object.assign(new Error("limited"), { status: 429 }); } }],
  ]) {
    it(`propagates an analysis RPC limit from ${source}`, async () => {
      await assert.rejects(
        () => analyze(event, dependencies(override)),
        (error) => {
          assert.ok(error instanceof RetryableAnalysisError);
          assert.equal(error.source, source);
          assert.equal(error.cause?.status, 429);
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
      {
        ...event,
        blockNumber: 123,
        createdAt: NOW - 1 * 60_000,
        poolId: `0x${"ab".repeat(32)}`,
        referenceAssetKind: "stock",
        referenceAssetIssuer: "Robinhood",
        assetSource: "official-catalog",
        assetVerifiedAt: NOW - 60_000,
        referenceRestrictions: ["eu-only"],
      },
      dependencies({
        dexScreener: async () => ({ marketBound: true, pairCreatedAt }),
        honeypotCheck: async (value) => {
          honeypotInput = value;
          return { honeypot: null, complete: false, reason: "incomplete" };
        },
      })
    );
    assert.deepEqual(honeypotInput, {
      chain: "robinhood",
      token: TOKEN,
      quote: QUOTE,
      venue: "uniswap-v2",
      pool: POOL,
      poolId: `0x${"ab".repeat(32)}`,
      holders: [],
      blockNumber: 123,
      pairCreatedAt,
      decimals: 18,
      walletCatalog: WALLET_CATALOG,
      metadata: {},
      referenceAssetKind: "stock",
      referenceAssetIssuer: "Robinhood",
      assetSource: "official-catalog",
      assetVerifiedAt: NOW - 60_000,
      referenceRestrictions: ["eu-only"],
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
      walletSignals: { status: "unconfigured", count: 0, matches: [] },
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

  for (const [name, sellability, legacyHoneypot] of [
    ["missing counts", { status: "confirmed", reason: "sellable" }, false],
    ["negative counts", {
      status: "confirmed",
      reason: "sellable",
      buyerSamples: 1,
      ladderSamples: 1,
      meaningfulSellers: -1,
    }, false],
    ["non-integer counts", {
      status: "confirmed",
      reason: "sellable",
      buyerSamples: 1.5,
      ladderSamples: 1,
      meaningfulSellers: 3,
    }, false],
    ["legacy honeypot conflict", {
      status: "confirmed",
      reason: "sellable",
      buyerSamples: 1,
      ladderSamples: 1,
      meaningfulSellers: 3,
    }, true],
  ]) {
    it(`normalizes malformed confirmed evidence before scoring: ${name}`, async () => {
      const report = await analyze(event, dependencies({
        honeypotCheck: async () => ({
          honeypot: legacyHoneypot,
          complete: true,
          sellOk: true,
          reason: "legacy result",
          sellability,
        }),
      }));
      const honeypotCheck = report.checks.find((check) => check.key === "honeypot");
      assert.equal(report.sellability.status, "unknown");
      assert.equal(report.honeypot.honeypot, null);
      assert.equal(report.honeypot.complete, false);
      assert.equal(report.honeypot.sellOk, null);
      assert.equal(report.honeypot.reason, report.sellability.reason);
      assert.equal(report.facts.sellabilityStatus, "unknown");
      assert.equal(honeypotCheck.pts, 0);
    });
  }

  it("keeps blocked evidence blocked despite a legacy false conflict", async () => {
    const report = await analyze(event, dependencies({
      honeypotCheck: async () => ({
        honeypot: false,
        complete: true,
        sellOk: true,
        reason: "legacy conflict",
        sellability: {
          status: "blocked",
          reason: "hidden-balance-mutation",
          buyerSamples: 1,
          ladderSamples: 1,
          meaningfulSellers: 3,
          details: [],
        },
      }),
    }));
    assert.equal(report.sellability.status, "blocked");
    assert.equal(report.honeypot.honeypot, true);
    assert.equal(report.honeypot.complete, true);
    assert.equal(report.honeypot.sellOk, false);
    assert.equal(report.verdict, "skip");
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

  it("keeps confirmed sellability as a gate instead of awarding score points", async () => {
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
    assert.equal(honeypotCheck.pts, 0);
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

  it("preserves launchpad tax evidence carried by the sellability adapter", async () => {
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
          buyTaxBps: 100,
          sellTaxBps: 200,
        },
      }),
    }));

    assert.equal(report.facts.buyTaxBps, 100);
    assert.equal(report.facts.sellTaxBps, 200);
  });
});

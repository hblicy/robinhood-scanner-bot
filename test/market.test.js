import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  geckoNewPools,
  getDexPaprikaPool,
  getDexPaprikaTopPools,
  getDexPaprikaTransactions,
  normalizeMarketEvidence,
  searchDexPaprikaPools,
  selectDexPair,
  summarizeDeployerHistory,
} from "../src/market.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const QUOTE = "0x2222222222222222222222222222222222222222";
const EXACT_POOL = "0x3333333333333333333333333333333333333333";
const WRONG_POOL = "0x4444444444444444444444444444444444444444";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NOW = Date.parse("2026-09-06T00:30:00Z");

function geckoRow(createdAt) {
  return {
    attributes: {
      address: EXACT_POOL,
      pool_created_at: createdAt,
      transactions: { m5: { buys: 2, sells: 1 } },
    },
    relationships: {
      base_token: { data: { id: `robinhood_${TOKEN}` } },
      quote_token: { data: { id: `robinhood_${WETH}` } },
      dex: { data: { id: "uniswap-v2" } },
    },
  };
}

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

function pair(pairAddress, liquidity, quote = QUOTE) {
  return {
    chainId: "robinhood",
    pairAddress,
    baseToken: { address: TOKEN },
    quoteToken: { address: quote },
    liquidity: { usd: liquidity },
  };
}

describe("selectDexPair", () => {
  it("selects a bound pair when the target token is on the quote side", () => {
    const reversed = {
      ...pair(EXACT_POOL, 100),
      baseToken: { address: QUOTE, symbol: "STOCK" },
      quoteToken: { address: TOKEN, symbol: "MEME" },
    };
    assert.equal(selectDexPair([reversed], {
      token: TOKEN,
      pool: EXACT_POOL,
      quote: QUOTE,
    }), reversed);
  });

  it("selects only the exact event pool and quote", () => {
    const selected = selectDexPair([pair(WRONG_POOL, 1_000_000), pair(EXACT_POOL, 100)], {
      token: TOKEN,
      pool: EXACT_POOL,
      quote: QUOTE,
    });
    assert.equal(selected.pairAddress.toLowerCase(), EXACT_POOL.toLowerCase());
  });

  it("returns null when the exact pool is absent", () => {
    assert.equal(
      selectDexPair([pair(WRONG_POOL, 1_000_000)], { token: TOKEN, pool: EXACT_POOL, quote: QUOTE }),
      null
    );
  });

  it("returns null when the exact pool has a different quote", () => {
    assert.equal(
      selectDexPair([pair(EXACT_POOL, 100, WRONG_POOL)], { token: TOKEN, pool: EXACT_POOL, quote: QUOTE }),
      null
    );
  });

  it("selects the highest-liquidity pair only when no binding is requested", () => {
    const selected = selectDexPair([pair(EXACT_POOL, 100), pair(WRONG_POOL, 1_000_000)], {
      token: TOKEN,
    });
    assert.equal(selected.pairAddress.toLowerCase(), WRONG_POOL.toLowerCase());
  });

  it("selects only pairs from the active chain", () => {
    const basePair = { ...pair(EXACT_POOL, 100), chainId: "base" };
    assert.equal(selectDexPair([basePair], { token: TOKEN, chain: "robinhood" }), null);
    assert.equal(selectDexPair([basePair], { token: TOKEN, chain: "base" }), basePair);
  });
});

describe("summarizeDeployerHistory", () => {
  it("keeps a full page unknown because older deployments may be truncated", () => {
    const txs = Array.from({ length: 200 }, () => ({ contractAddress: "" }));
    assert.equal(summarizeDeployerHistory(txs, 50, 200).known, false);
  });

  it("marks a short final page complete", () => {
    const txs = [{ contractAddress: TOKEN }, { contractAddress: "" }];
    const result = summarizeDeployerHistory(txs, 50, 200);
    assert.equal(result.known, true);
    assert.equal(result.created, 1);
  });
});

describe("geckoNewPools", () => {
  it("uses an injected classifier and preserves stock reference metadata", async () => {
    const row = geckoRow(new Date(NOW).toISOString());
    const [event] = await geckoNewPools(1, {
      fetchImpl: async () => jsonResponse({ data: [row] }),
      now: () => NOW,
      maxAgeMinutes: 30,
      classifyPair: () => ({
        candidateKind: "meme",
        targetToken: TOKEN,
        referenceAsset: WETH,
        targetSide: "base",
        referenceAssetKind: "stock",
        referenceAssetIssuer: "Robinhood",
      }),
    });
    assert.equal(event.token, event.targetToken);
    assert.equal(event.quote, event.referenceAsset);
    assert.equal(event.referenceAssetKind, "stock");
  });

  it("returns only pools inside the strict age window", async () => {
    const recent = new Date(NOW - 5 * 60_000).toISOString();
    const old = new Date(NOW - 31 * 60_000).toISOString();
    const events = await geckoNewPools(1, {
      fetchImpl: async () => jsonResponse({ data: [geckoRow(recent), geckoRow(old)] }),
      now: () => NOW,
      maxAgeMinutes: 30,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].createdAt, Date.parse(recent));
    assert.equal(events[0].market.scoreKnown, false);
  });

  it("marks Gecko scoring facts complete only when every required raw field exists", async () => {
    const row = geckoRow(new Date(NOW).toISOString());
    Object.assign(row.attributes, {
      market_cap_usd: "70000",
      reserve_in_usd: "26000",
      volume_usd: { m5: "13000", h1: "20000" },
    });
    const [event] = await geckoNewPools(1, {
      fetchImpl: async () => jsonResponse({ data: [row] }),
      now: () => NOW,
      maxAgeMinutes: 30,
    });
    assert.equal(event.market.scoreKnown, true);

    delete row.attributes.transactions.m5.sells;
    const [incomplete] = await geckoNewPools(1, {
      fetchImpl: async () => jsonResponse({ data: [row] }),
      now: () => NOW,
      maxAgeMinutes: 30,
    });
    assert.equal(incomplete.market.scoreKnown, false);
  });

  for (const [field, mutate] of [
    ["negative liquidity", (row) => { row.attributes.reserve_in_usd = "-1"; }],
    ["fractional buys", (row) => { row.attributes.transactions.m5.buys = "1.5"; }],
    ["malformed market cap", (row) => { row.attributes.market_cap_usd = "bad"; }],
  ]) {
    it(`keeps invalid Gecko score facts unknown: ${field}`, async () => {
      const row = geckoRow(new Date(NOW).toISOString());
      Object.assign(row.attributes, {
        market_cap_usd: "70000",
        reserve_in_usd: "26000",
        volume_usd: { m5: "13000", h1: "20000" },
      });
      mutate(row);
      const [event] = await geckoNewPools(1, {
        fetchImpl: async () => jsonResponse({ data: [row] }),
        now: () => NOW,
        maxAgeMinutes: 30,
      });
      assert.equal(event.market.scoreKnown, false);
    });
  }

  it("normalizes only the Robinhood Uniswap V2 Gecko venue alias", async () => {
    const known = geckoRow(new Date(NOW).toISOString());
    known.relationships.dex.data.id = "uniswap-v2-robinhood";
    const unknown = geckoRow(new Date(NOW).toISOString());
    unknown.attributes.address = WRONG_POOL;
    unknown.relationships.dex.data.id = "mystery-dex";

    const events = await geckoNewPools(1, {
      fetchImpl: async () => jsonResponse({ data: [known, unknown] }),
      now: () => NOW,
      maxAgeMinutes: 30,
    });

    assert.equal(events[0].venue, "uniswap-v2");
    assert.equal(events[1].venue, "mystery-dex");
  });

  for (const value of [undefined, "not-a-date"]) {
    it(`rejects an invalid pool_created_at value: ${String(value)}`, async () => {
      await assert.rejects(
        () => geckoNewPools(1, {
          fetchImpl: async () => jsonResponse({ data: [geckoRow(value)] }),
          now: () => NOW,
          maxAgeMinutes: 30,
        }),
        /pool_created_at.*page 1/i
      );
    });
  }

  it("rejects a later page failure instead of returning partial results", async () => {
    let calls = 0;
    await assert.rejects(
      () => geckoNewPools(2, {
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? jsonResponse({ data: [geckoRow(new Date(NOW).toISOString())] })
            : jsonResponse({}, { ok: false, status: 503 });
        },
        now: () => NOW,
        maxAgeMinutes: 30,
      }),
      /Gecko page 2.*503/i
    );
    assert.equal(calls, 2);
  });

  it("rejects a malformed token relationship instead of silently skipping it", async () => {
    const row = geckoRow(new Date(NOW).toISOString());
    row.relationships.base_token.data.id = "robinhood_not-an-address";
    await assert.rejects(
      () => geckoNewPools(1, {
        fetchImpl: async () => jsonResponse({ data: [row] }),
        now: () => NOW,
        maxAgeMinutes: 30,
      }),
      /base_token.*page 1.*row 0/i
    );
  });

  it("rejects a malformed pool address instead of returning an unbound event", async () => {
    const row = geckoRow(new Date(NOW).toISOString());
    row.attributes.address = "not-an-address";
    await assert.rejects(
      () => geckoNewPools(1, {
        fetchImpl: async () => jsonResponse({ data: [row] }),
        now: () => NOW,
        maxAgeMinutes: 30,
      }),
      /pool address.*page 1.*row 0/i
    );
  });

  it("keeps a V4 pool id separate from the address-valued pool field", async () => {
    const row = geckoRow(new Date(NOW).toISOString());
    const poolId = `0x${"ab".repeat(32)}`;
    row.attributes.address = poolId;
    row.relationships.dex.data.id = "uniswap-v4-robinhood";
    row.relationships.quote_token.data.id = "robinhood_0x0000000000000000000000000000000000000000";
    const events = await geckoNewPools(1, {
      fetchImpl: async () => jsonResponse({ data: [row] }),
      now: () => NOW,
      maxAgeMinutes: 30,
    });
    assert.equal(events[0].pool, null);
    assert.equal(events[0].poolId, poolId);
  });

  it("accepts pools.trade V4 ids and skips bytes32 ids from unsupported venues", async () => {
    const row = geckoRow(new Date(NOW).toISOString());
    const poolId = `0x${"cd".repeat(32)}`;
    row.attributes.address = poolId;
    row.relationships.dex.data.id = "uniswap-pools-trade";
    row.relationships.quote_token.data.id = "robinhood_0x0000000000000000000000000000000000000000";
    const events = await geckoNewPools(1, {
      fetchImpl: async () => jsonResponse({ data: [row] }),
      now: () => NOW,
      maxAgeMinutes: 30,
    });
    assert.equal(events[0].poolId, poolId);

    row.relationships.dex.data.id = "mystery-dex";
    const following = geckoRow(new Date(NOW).toISOString());
    following.attributes.address = WRONG_POOL;
    const filtered = await geckoNewPools(1, {
      fetchImpl: async () => jsonResponse({ data: [row] }),
      now: () => NOW,
      maxAgeMinutes: 30,
    });
    assert.deepEqual(filtered, []);

    const continued = await geckoNewPools(1, {
      fetchImpl: async () => jsonResponse({ data: [row, following] }),
      now: () => NOW,
      maxAgeMinutes: 30,
    });
    assert.equal(continued.length, 1);
    assert.equal(continued[0].pool.toLowerCase(), WRONG_POOL.toLowerCase());
  });
});

describe("DexPaprika read-only adapters", () => {
  const poolId = `0x${"ab".repeat(32)}`;
  const fixture = {
    id: poolId,
    chain: "robinhood",
    dex_id: "uniswap_v4",
    dex_name: "Uniswap V4",
    created_at: "2026-09-06T00:00:00.000Z",
    liquidity_usd: 12_000,
    volume_usd: 5_000,
    price_usd: 0.0001,
    last_updated: "2026-09-06T00:10:00.000Z",
    tokens: [
      { id: TOKEN, symbol: "DOG", decimals: 18 },
      { id: WETH, symbol: "WETH", decimals: 18 },
    ],
  };

  it("uses documented Robinhood pool endpoints and normalizes their schema", async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes("/transactions")) {
        return jsonResponse({ transactions: [
          { id: "buy-1", type: "buy", block_timestamp: 100 },
          { id: "sell-1", type: "sell", block_timestamp: 101 },
        ] });
      }
      if (url.includes(`/tokens/${TOKEN}/pools`)) return jsonResponse({ pools: [fixture] });
      if (url.endsWith(`/pools/${poolId}`)) return jsonResponse(fixture);
      return jsonResponse({ pools: [fixture] });
    };

    const top = await getDexPaprikaTopPools({ fetchImpl, limit: 10 });
    const searched = await searchDexPaprikaPools(TOKEN, { fetchImpl, limit: 5 });
    const pool = await getDexPaprikaPool(poolId, { fetchImpl });
    const transactions = await getDexPaprikaTransactions(poolId, { fetchImpl, limit: 20 });

    assert.equal(top[0].poolId, poolId);
    assert.equal(searched[0].tokens[0].address.toLowerCase(), TOKEN.toLowerCase());
    assert.equal(pool.liquidityUsd, 12_000);
    assert.deepEqual(transactions.map((item) => item.direction), ["buy", "sell"]);
    assert.ok(urls.some((url) => /networks\/robinhood\/pools\?/.test(url)));
    assert.ok(urls.some((url) => url.includes(`/networks/robinhood/tokens/${TOKEN}/pools`)));
    assert.ok(urls.some((url) => url.endsWith(`/networks/robinhood/pools/${poolId}`)));
  });

  it("keeps missing or malformed market fields unknown instead of zero", async () => {
    await assert.rejects(() => getDexPaprikaPool(poolId, {
      fetchImpl: async () => jsonResponse({ id: poolId, tokens: [] }),
    }), /DexPaprika pool schema/);
    await assert.rejects(() => getDexPaprikaPool(poolId, {
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 429 }),
    }), /DexPaprika pool.*HTTP 429/);
  });

  it("requires a bound pool with bidirectional transactions for market readiness", () => {
    const evidence = normalizeMarketEvidence({
      expected: { token: TOKEN, pairToken: WETH, poolId },
      pools: [fixture],
      transactions: [
        { direction: "buy", poolId },
        { direction: "sell", poolId },
      ],
      errors: [],
    });
    assert.equal(evidence.marketReady, true);
    assert.equal(evidence.poolId, poolId);

    const unbound = normalizeMarketEvidence({
      expected: { token: TOKEN, pairToken: WETH, poolId },
      pools: [{ ...fixture, id: `0x${"ef".repeat(32)}` }],
      transactions: [],
      errors: [],
    });
    assert.equal(unbound.marketReady, false);

    const unknown = normalizeMarketEvidence({
      expected: { token: TOKEN, pairToken: WETH, poolId },
      pools: [],
      transactions: [],
      errors: [{ source: "DexPaprika", message: "rate limited" }],
    });
    assert.equal(unknown.marketReady, "unknown");
  });

  it("flags two-times liquidity disagreement and uses the smaller value", () => {
    const evidence = normalizeMarketEvidence({
      expected: { token: TOKEN, pairToken: WETH, poolId },
      pools: [
        { ...fixture, source: "gecko", liquidity_usd: 30_000 },
        { ...fixture, source: "dexpaprika", liquidity_usd: 10_000 },
      ],
      transactions: [
        { direction: "buy", poolId },
        { direction: "sell", poolId },
      ],
      errors: [],
    });
    assert.equal(evidence.conflict, true);
    assert.equal(evidence.liquidityUsd, 10_000);
  });
});

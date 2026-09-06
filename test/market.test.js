import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { geckoNewPools, selectDexPair, summarizeDeployerHistory } from "../src/market.js";

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
});

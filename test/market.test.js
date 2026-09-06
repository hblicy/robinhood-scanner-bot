import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectDexPair, summarizeDeployerHistory } from "../src/market.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const QUOTE = "0x2222222222222222222222222222222222222222";
const EXACT_POOL = "0x3333333333333333333333333333333333333333";
const WRONG_POOL = "0x4444444444444444444444444444444444444444";

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

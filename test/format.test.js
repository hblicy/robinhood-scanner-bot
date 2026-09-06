import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAlert } from "../src/notify.js";

describe("formatAlert", () => {
  it("renders the checklist without throwing", () => {
    const text = formatAlert({
      token: "0x1111111111111111111111111111111111111111",
      venue: "uniswap-v2",
      creator: "0x2222222222222222222222222222222222222222",
      meta: { symbol: "CAT", name: "Cash Cat" },
      facts: {
        ageMinutes: 4.2,
        mcapUsd: 42000,
        liquidityUsd: 12000,
        volume5m: 3000,
        buys5m: 12,
        sells5m: 3,
        hasTwitter: true,
        hasTelegram: false,
        narrativeHits: ["cat"],
        top10Pct: 28,
        holderCount: 40,
        creatorPct: 2,
        deployerTokens: 1,
        honeypot: false,
        buyTaxBps: 0,
        sellTaxBps: 0,
        lpLocked: true,
        lpBurnedPct: 100,
      },
      score: 82,
      verdict: "green",
      red: [],
      checks: [{ key: "age", ok: true, pts: 15, detail: "4.2 分钟" }],
      links: {
        dex: "https://dexscreener.com/robinhood/0x1",
        explorer: "https://robinhoodchain.blockscout.com/token/0x1",
        gmgn: "https://gmgn.ai/robinhood/token/0x1",
      },
      dex: { quoteSymbol: "WETH" },
    });
    assert.match(text, /CAT/);
    assert.match(text, /82\/100/);
    assert.match(text, /DexScreener/);
    assert.match(text, /不自动买入/);
  });
});

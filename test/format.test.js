import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAlert } from "../src/notify.js";

function makeReport(overrides = {}) {
  const {
    facts: factsOverride,
    sellability: sellabilityOverride,
    links: linksOverride,
    dex: dexOverride,
    ...rest
  } = overrides;

  const report = {
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
      lpBurnedPct: 100,
      lpUnknown: false,
      ...factsOverride,
    },
    score: 82,
    verdict: "green",
    red: [],
    checks: [{ key: "age", ok: true, pts: 15, detail: "4.2 分钟" }],
    links: {
      dex: "https://dexscreener.com/robinhood/0x1",
      explorer: "https://robinhoodchain.blockscout.com/token/0x1",
      gmgn: "https://gmgn.ai/robinhood/token/0x1",
      ...linksOverride,
    },
    dex: { quoteSymbol: "WETH", ...dexOverride },
    ...rest,
  };

  if (sellabilityOverride === null) {
    delete report.sellability;
  } else {
    report.sellability = {
      status: "confirmed",
      reason: "confirmed real sells",
      buyerSamples: 12,
      ladderSamples: 4,
      meaningfulSellers: 3,
      ...(sellabilityOverride || {}),
    };
  }

  return report;
}

describe("formatAlert", () => {
  it("renders the checklist without throwing", () => {
    const text = formatAlert(makeReport());
    assert.match(text, /CAT/);
    assert.match(text, /82\/100/);
    assert.match(text, /卖出安全<\/b> 已确认/);
    assert.match(text, /原因 confirmed real sells/);
    assert.match(text, /买家样本 12  额度样本 4  真实卖家 3/);
    assert.match(text, /风险 未发现阻断/);
    assert.match(text, /DexScreener/);
    assert.match(text, /不包含模拟或实盘交易功能/);
  });

  it("renders unknown safety facts without claiming they passed", () => {
    const text = formatAlert(makeReport({
      creator: null,
      meta: { symbol: "UNK", name: "Unknown" },
      facts: {
        ageMinutes: null,
        mcapUsd: 0,
        liquidityUsd: 0,
        volume5m: 0,
        buys5m: 0,
        sells5m: 0,
        hasTwitter: false,
        hasTelegram: false,
        narrativeHits: [],
        top10Pct: null,
        holderCount: null,
        creatorPct: null,
        deployerTokens: null,
        honeypot: null,
        buyTaxBps: null,
        sellTaxBps: null,
        lpUnknown: true,
        lpBurnedPct: null,
      },
      sellability: null,
      score: 0,
      verdict: "review",
      red: [],
      checks: [],
      links: { dex: "https://example.test", explorer: "https://example.test", gmgn: "https://example.test" },
      dex: null,
      errorSources: [
        { source: "Blockscout holders", error: "https://user:SECRET@example.test/private" },
      ],
    }));
    assert.match(text, /年龄<\/b> 未知/);
    assert.match(text, /税 未知\/未知bps/);
    assert.match(text, /LP 未验证/);
    assert.match(text, /卖出安全<\/b> 未确认/);
    assert.match(text, /原因 evidence-unavailable/);
    assert.match(text, /买家样本 0  额度样本 0  真实卖家 0/);
    assert.match(text, /风险 未确认/);
    assert.doesNotMatch(text, /已锁/);
    assert.match(text, /数据异常.*Blockscout holders/);
    assert.doesNotMatch(text, /SECRET|private/);
  });

  it("renders blocked sellability evidence with the blocked risk wording", () => {
    const text = formatAlert(makeReport({
      verdict: "skip",
      score: 12,
      facts: {
        honeypot: true,
        buyTaxBps: 0,
        sellTaxBps: 0,
        lpUnknown: false,
        lpBurnedPct: 100,
      },
      sellability: {
        status: "blocked",
        reason: "hidden-balance-mutation",
        buyerSamples: 1,
        ladderSamples: 0,
        meaningfulSellers: 0,
      },
    }));
    assert.match(text, /卖出安全<\/b> 已阻断/);
    assert.match(text, /hidden-balance-mutation/);
    assert.match(text, /买家样本 1  额度样本 0  真实卖家 0/);
    assert.match(text, /风险 已阻断/);
  });

  it("does not claim pass or blocked risk when sellability is unknown", () => {
    const text = formatAlert(makeReport({
      verdict: "review",
      score: 0,
      meta: { symbol: "UNK", name: "Unknown" },
      creator: null,
      facts: {
        honeypot: null,
        buyTaxBps: null,
        sellTaxBps: null,
        lpUnknown: true,
        lpBurnedPct: null,
      },
      sellability: {
        status: "unknown",
        reason: "insufficient-meaningful-sells",
        buyerSamples: 5,
        ladderSamples: 2,
        meaningfulSellers: 2,
      },
    }));
    assert.match(text, /卖出安全<\/b> 未确认/);
    assert.match(text, /insufficient-meaningful-sells/);
    assert.match(text, /买家样本 5  额度样本 2  真实卖家 2/);
    assert.match(text, /风险 未确认/);
    assert.doesNotMatch(text, /卖出安全.*通过/);
    assert.doesNotMatch(text, /风险 未发现阻断/);
    assert.doesNotMatch(text, /可小仓试/);
  });

  it("treats illegal sellability data as unconfirmed and escapes the reason", () => {
    const text = formatAlert(makeReport({
      verdict: "review",
      score: 0,
      creator: null,
      facts: {
        honeypot: null,
        buyTaxBps: null,
        sellTaxBps: null,
        lpUnknown: true,
        lpBurnedPct: null,
      },
      sellability: {
        status: "future",
        reason: "<tag>&",
        buyerSamples: -1,
        ladderSamples: "nope",
        meaningfulSellers: -3,
      },
    }));
    assert.match(text, /卖出安全<\/b> 未确认/);
    assert.match(text, /&lt;tag&gt;&amp;/);
    assert.doesNotMatch(text, /<tag>&/);
    assert.match(text, /买家样本 0  额度样本 0  真实卖家 0/);
    assert.match(text, /风险 未确认/);
  });
});

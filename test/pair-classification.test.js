import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "ethers";
import { createAssetCatalog } from "../src/assets/catalog.js";
import { createPairClassifier } from "../src/assets/pair.js";
import { chooseTargetPair } from "../src/venues/solana/instructions.js";

const STOCK = "0x1111111111111111111111111111111111111111";
const MEME = "0x2222222222222222222222222222222222222222";
const UNKNOWN = "0x3333333333333333333333333333333333333333";
const WETH = "0x4444444444444444444444444444444444444444";
const USDC = "0x5555555555555555555555555555555555555555";

const catalog = createAssetCatalog({
  schemaVersion: 1,
  chain: "base",
  family: "evm",
  source: { id: "fixture", url: "https://example.com/assets.json", verifiedAt: 1 },
  assets: [{
    address: STOCK,
    symbol: "NVDAc",
    kind: "stock",
    issuer: "Coinbase",
    sourceId: "base-official-stocks",
    sourceUrl: "https://www.base.org/stocks",
    verifiedAt: 1,
    restrictions: ["regional-restrictions-may-apply"],
  }],
});
const classify = createPairClassifier({
  catalog,
  nativeQuotes: [WETH, USDC],
  normalizeAddress: getAddress,
});

describe("pair classification", () => {
  it("selects the meme side when the verified stock is token0 or token1", () => {
    const stockFirst = classify(STOCK, MEME);
    const stockSecond = classify(MEME, STOCK);
    assert.equal(stockFirst.targetToken, getAddress(MEME));
    assert.equal(stockFirst.targetSide, "token1");
    assert.equal(stockSecond.referenceAsset, getAddress(STOCK));
    assert.equal(stockSecond.targetSide, "token0");
    assert.equal(stockSecond.referenceAssetKind, "stock");
    assert.equal(stockSecond.referenceAssetIssuer, "Coinbase");
    assert.deepEqual(stockSecond.referenceRestrictions, ["regional-restrictions-may-apply"]);
  });

  it("supports base and quote side labels", () => {
    const result = classify(STOCK, MEME, { leftSide: "base", rightSide: "quote" });
    assert.equal(result.targetSide, "quote");
  });

  it("does not trust a stock-looking ticker without a catalog address match", () => {
    assert.equal(classify(MEME, UNKNOWN), null);
  });

  it("marks stock versus stable as reference liquidity instead of a meme", () => {
    assert.equal(classify(STOCK, USDC).candidateKind, "reference-liquidity");
  });

  it("retains generic meme versus native discovery", () => {
    const result = classify(MEME, WETH);
    assert.equal(result.candidateKind, "meme");
    assert.equal(result.referenceAsset, getAddress(WETH));
    assert.equal(result.referenceAssetKind, "native");
  });

  it("lets Solana instruction adapters use the same injected classification", () => {
    let sides = null;
    const result = chooseTargetPair("stockMint", "memeMint", (_left, _right, options) => {
      sides = options;
      return {
      candidateKind: "meme",
      targetToken: "memeMint",
      referenceAsset: "stockMint",
      targetSide: "quote",
      referenceAssetKind: "stock",
      };
    });
    assert.equal(result.token, "memeMint");
    assert.equal(result.quoteToken, "stockMint");
    assert.equal(result.targetIsA, false);
    assert.deepEqual(sides, { leftSide: "base", rightSide: "quote" });
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { analyzeSolanaCandidate } from "../src/solana/analyze.js";

const address = () => Keypair.generate().publicKey.toBase58();

describe("Solana analysis", () => {
  it("reuses observed transactions and awards points for a labelled bound buyer", async () => {
    const token = address();
    const quote = address();
    const pool = address();
    const baseVault = address();
    const quoteVault = address();
    const buyer = address();
    let reads = 0;
    const transactions = [{
      transaction: {
        transaction: { message: { accountKeys: [buyer, baseVault, quoteVault] } },
        meta: {
          err: null,
          preTokenBalances: [
            { accountIndex: 0, mint: token, owner: buyer, uiTokenAmount: { amount: "0" } },
            { accountIndex: 1, mint: token, owner: pool, uiTokenAmount: { amount: "100" } },
            { accountIndex: 0, mint: quote, owner: buyer, uiTokenAmount: { amount: "10" } },
            { accountIndex: 2, mint: quote, owner: pool, uiTokenAmount: { amount: "100" } },
          ],
          postTokenBalances: [
            { accountIndex: 0, mint: token, owner: buyer, uiTokenAmount: { amount: "5" } },
            { accountIndex: 1, mint: token, owner: pool, uiTokenAmount: { amount: "95" } },
            { accountIndex: 0, mint: quote, owner: buyer, uiTokenAmount: { amount: "9" } },
            { accountIndex: 2, mint: quote, owner: pool, uiTokenAmount: { amount: "101" } },
          ],
        },
      },
    }];
    const event = {
      token, quoteToken: quote, pool, venue: "raydium-cpmm", creator: null,
      createdAt: Date.now(), lifecyclePhase: "new_pool",
      referenceAsset: quote,
      referenceAssetKind: "stock",
      referenceAssetIssuer: "Backed",
      assetSource: "backed-xstocks-api-v2",
      assetVerifiedAt: 1_789_000_000_000,
      referenceRestrictions: ["scaled-ui-multiplier"],
      metadata: { baseVault, quoteVault },
    };
    const report = await analyzeSolanaCandidate(event, {
      config: {
        profile: { name: "Solana", explorer: "https://solscan.io", quotes: [{ address: quote, symbol: "Q" }] },
        settings: { maxAgeMinutes: 30, minScore: 70, maxMcapUsd: 1_000_000, minLiquidityUsd: 1, maxTop10Pct: 50, maxDeployerTokens: 5, maxTaxBps: 500 },
      },
      connection: {},
      inspectMint: async () => ({ status: "complete", mintAuthority: null, redFlags: [] }),
      dexScreener: async () => ({ symbol: "TEST", name: "Test", buys5m: 1, sells5m: 0, volume5m: 1, mcapUsd: 1, liquidityUsd: 1, marketBound: true }),
      securityRegistry: { inspect: async (_candidate, dependencies) => {
        await dependencies.getObservedSellTransactions();
        return { status: "unknown", reason: "insufficient-meaningful-sells" };
      } },
      walletCatalog: { status: "known", labels: new Map([[buyer, { label: "Alpha", type: "kol", source: "gmgn" }]]) },
      getObservedTransactions: async () => { reads++; return transactions; },
    });
    assert.equal(reads, 1);
    assert.equal(report.walletSignals.count, 1);
    assert.equal(report.facts.walletSignalCount, 1);
    assert.equal(report.facts.walletSignalMatches[0].address, buyer);
    assert.equal(report.referenceAsset, quote);
    assert.equal(report.referenceAssetKind, "stock");
    assert.equal(report.referenceAssetIssuer, "Backed");
    assert.equal(report.referenceAssetStandard, "xStocks");
    assert.equal(report.assetSource, "backed-xstocks-api-v2");
    assert.deepEqual(report.referenceRestrictions, ["scaled-ui-multiplier"]);
  });
});

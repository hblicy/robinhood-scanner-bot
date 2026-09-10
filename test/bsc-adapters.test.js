import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EVM_PROFILES } from "../src/chains/evm-profiles.js";
import { scanEvmRange } from "../src/evm/discovery.js";
import {
  createPancakeInfinityAdapter,
  createPancakeV2Adapter,
  createPancakeV3Adapter,
} from "../src/venues/evm/pancakeswap.js";
import { createFourMemeAdapter } from "../src/venues/evm/four-meme.js";

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/evm/${name}.json`, import.meta.url)), "utf8"));
}

const logs = {
  v2: fixture("pancake-v2-pair-created"),
  v3: fixture("pancake-v3-pool-created"),
  infinity: fixture("pancake-infinity-initialize"),
  launch: fixture("four-meme-launch"),
  graduated: fixture("four-meme-graduated"),
};
const profile = EVM_PROFILES.bsc;
const quotes = profile.quotes.map(({ address }) => address);

describe("BSC discovery adapters", () => {
  it("uses the injected pair classifier for Infinity pools", () => {
    const infinity = createPancakeInfinityAdapter({
      id: "pancakeswap-infinity-cl-bsc",
      address: logs.infinity.address,
      classifyPair: (token, quote) => ({
        candidateKind: "meme",
        targetToken: token,
        referenceAsset: quote,
        targetSide: "token0",
        referenceAssetKind: "stock",
      }),
    }).parse(logs.infinity);
    assert.equal(infinity.token, infinity.targetToken);
    assert.equal(infinity.quoteToken, infinity.referenceAsset);
    assert.equal(infinity.referenceAssetKind, "stock");
  });

  it("normalizes real PancakeSwap V2, V3, and Infinity logs distinctly", () => {
    const v2 = createPancakeV2Adapter({ id: "pancakeswap-v2-bsc", address: logs.v2.address, quoteAddresses: quotes }).parse(logs.v2);
    const v3 = createPancakeV3Adapter({ id: "pancakeswap-v3-bsc", address: logs.v3.address, quoteAddresses: quotes }).parse(logs.v3);
    const infinity = createPancakeInfinityAdapter({ id: "pancakeswap-infinity-cl-bsc", address: logs.infinity.address, quoteAddresses: quotes }).parse(logs.infinity);

    assert.equal(v2.token.toLowerCase(), "0x228237ce07dda81df356529ea211237f260a7777");
    assert.equal(v2.pool.toLowerCase(), "0x09ed564e57b9b40a23fab895f1ca8b65fa47c80d");
    assert.equal(v3.token.toLowerCase(), "0x7e0965ed494c7d05d335edc6bfc31e05cabfda61");
    assert.equal(v3.metadata.fee, 10_000);
    assert.equal(infinity.token.toLowerCase(), "0x7c8d5502b544ddaf8852fc46d1174e34876d545c");
    assert.equal(infinity.poolId, logs.infinity.topics[1]);
    assert.equal(infinity.pool.toLowerCase(), logs.infinity.address);
    assert.equal(infinity.metadata.fee, 1_240);
  });

  it("resolves a Four.meme launch quote without treating it as an alertable pool", async () => {
    const adapter = createFourMemeAdapter({
      id: "four-meme-v2-bsc",
      address: logs.launch.address,
      wrappedNative: profile.wrappedNative,
      resolveTokenInfo: async () => ({ quote: profile.wrappedNative, tokenManager: logs.launch.address }),
      resolveMigrationPool: async () => null,
    });
    const event = await adapter.parse(logs.launch, { provider: {} });
    assert.equal(event.token.toLowerCase(), "0x928b49071f87c31dee58f2f8657f2c9fb4b6ffff");
    assert.equal(event.creator.toLowerCase(), "0x413e5eef86fd16f91c1ab80c0e52138faa69987d");
    assert.equal(event.quoteToken, profile.wrappedNative);
    assert.equal(event.pool.toLowerCase(), logs.launch.address);
    assert.equal(event.lifecyclePhase, "new_launch");
    assert.equal(event.metadata.poolResolved, false);
  });

  it("enriches a Four.meme launch through the injected pair classifier", async () => {
    const adapter = createFourMemeAdapter({
      id: "four-meme-v2-bsc",
      address: logs.launch.address,
      wrappedNative: profile.wrappedNative,
      classifyPair: () => ({
        candidateKind: "meme",
        targetToken: "0x2222222222222222222222222222222222222222",
        referenceAsset: "0x1111111111111111111111111111111111111111",
        targetSide: "token1",
        referenceAssetKind: "stock",
        referenceAssetIssuer: "BTech Holdings",
      }),
      resolveTokenInfo: async () => ({ quote: profile.wrappedNative, tokenManager: logs.launch.address }),
      resolveMigrationPool: async () => null,
    });
    const event = await adapter.parse(logs.launch, { provider: {} });
    assert.equal(event.token, event.targetToken);
    assert.equal(event.referenceAssetKind, "stock");
  });

  it("binds a Four.meme graduation to the pool created in the same transaction", async () => {
    const pool = "0xbe07012f5d2c9e85c5d2bbb7ae44b6f96ada7183";
    const adapter = createFourMemeAdapter({
      id: "four-meme-v2-bsc",
      address: logs.graduated.address,
      wrappedNative: profile.wrappedNative,
      resolveTokenInfo: async () => { throw new Error("not used"); },
      resolveMigrationPool: async ({ transactionHash }) => {
        assert.equal(transactionHash, logs.graduated.transactionHash);
        return pool;
      },
    });
    const event = await adapter.parse(logs.graduated, { provider: {} });
    assert.equal(event.token.toLowerCase(), "0xeb5d7f3ad0d2fce5d4608425a0a82ef6d7e560ad");
    assert.equal(event.quoteToken, profile.wrappedNative);
    assert.equal(event.pool.toLowerCase(), pool);
    assert.equal(event.lifecyclePhase, "graduated");
    assert.equal(event.metadata.poolResolved, true);
  });

  it("wraps a required Four.meme factory read with full event context", async () => {
    const adapter = createFourMemeAdapter({
      id: "four-meme-v2-bsc",
      address: logs.launch.address,
      wrappedNative: profile.wrappedNative,
      resolveTokenInfo: async () => { throw new Error("factory read unavailable"); },
      resolveMigrationPool: async () => null,
    });
    await assert.rejects(
      scanEvmRange({
        chain: { ...profile, venues: [{ id: adapter.id }] },
        provider: {},
        fromBlock: Number(logs.launch.blockNumber),
        toBlock: Number(logs.launch.blockNumber),
        adapters: [adapter],
        getLogs: async () => [logs.launch],
        getBlockTimes: async () => new Map(),
      }),
      /bsc.*four-meme-v2-bsc.*0x733a5fe.*3bb942.*log 504/i
    );
  });
});

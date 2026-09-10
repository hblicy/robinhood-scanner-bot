import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanEvmRange } from "../src/evm/discovery.js";
import {
  createUniswapV2Adapter,
  createUniswapV3Adapter,
  createUniswapV4Adapter,
} from "../src/venues/evm/uniswap.js";
import { EVM_PROFILES } from "../src/chains/evm-profiles.js";

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/evm/${name}.json`, import.meta.url)), "utf8"));
}

const logs = [
  fixture("uniswap-v2-pair-created"),
  fixture("uniswap-v3-pool-created"),
  fixture("uniswap-v4-initialize"),
];
const quoteAddresses = EVM_PROFILES.base.quotes.map(({ address }) => address);
const adapters = [
  createUniswapV2Adapter({
    id: "uniswap-v2-base",
    address: logs[0].address,
    quoteAddresses,
  }),
  createUniswapV3Adapter({
    id: "uniswap-v3-base",
    address: logs[1].address,
    quoteAddresses,
  }),
  createUniswapV4Adapter({
    id: "uniswap-v4-base",
    address: logs[2].address,
    quoteAddresses,
  }),
];
const chain = {
  ...EVM_PROFILES.base,
  venues: adapters.map(({ id }) => ({ id })),
};

describe("generic EVM discovery", () => {
  it("uses an injected pair classifier for Uniswap pools", () => {
    const adapter = createUniswapV2Adapter({
      id: "uniswap-v2-base",
      address: logs[0].address,
      classifyPair: () => ({
        candidateKind: "meme",
        targetToken: "0x2222222222222222222222222222222222222222",
        referenceAsset: "0x1111111111111111111111111111111111111111",
        targetSide: "token1",
        referenceAssetKind: "stock",
      }),
    });
    const event = adapter.parse(logs[0]);
    assert.equal(event.token, event.targetToken);
    assert.equal(event.quoteToken, event.referenceAsset);
    assert.equal(event.referenceAssetKind, "stock");
  });

  it("groups filters, pins one provider, sorts logs, and normalizes exact Uniswap fields", async () => {
    const provider = { role: "discovery" };
    let request;
    const events = await scanEvmRange({
      chain,
      provider,
      fromBlock: 100,
      toBlock: 110,
      adapters,
      getLogs: async (options) => {
        request = options;
        return [...logs].reverse();
      },
      getBlockTimes: async ({ provider: seenProvider, blockNumbers }) => {
        assert.equal(seenProvider, provider);
        assert.deepEqual(blockNumbers, [101]);
        return new Map([[101, 1_000]]);
      },
    });

    assert.equal(request.provider, provider);
    assert.deepEqual(
      request.address.map((address) => address.toLowerCase()).sort(),
      logs.map(({ address }) => address.toLowerCase()).sort()
    );
    assert.equal(request.topics[0].length, 3);
    assert.deepEqual(events.map(({ venue }) => venue), [
      "uniswap-v4-base",
      "uniswap-v3-base",
      "uniswap-v2-base",
    ]);
    assert.ok(events.every((event) => event.chain === "base"));
    assert.ok(events.every((event) => event.sourceProvenance));
    assert.equal(events[0].pool, logs[2].address);
    assert.equal(events[0].poolId, `0x${"ab".repeat(32)}`);
    assert.equal(events[0].metadata.fee, 3000);
    assert.equal(events[1].pool, "0x3333333333333333333333333333333333333333");
    assert.equal(events[1].metadata.fee, 3000);
    assert.equal(events[2].eventIndex, 1);
    assert.equal(events[2].createdAt, 1_000);
  });

  it("ignores adapters not registered by the selected chain", async () => {
    const events = await scanEvmRange({
      chain: { ...chain, venues: [{ id: "uniswap-v3-base" }] },
      provider: {},
      fromBlock: 100,
      toBlock: 110,
      adapters,
      getLogs: async () => logs,
      getBlockTimes: async () => new Map([[101, 1_000]]),
    });
    assert.deepEqual(events.map(({ venue }) => venue), ["uniswap-v3-base"]);
  });

  it("wraps parse failures with chain, venue, block, transaction, and log context", async () => {
    const malformed = { ...logs[1], data: "0x", index: 9 };
    await assert.rejects(
      () => scanEvmRange({
        chain,
        provider: {},
        fromBlock: 100,
        toBlock: 110,
        adapters,
        getLogs: async () => [malformed],
        getBlockTimes: async () => new Map([[101, 1_000]]),
      }),
      /base.*uniswap-v3-base.*101.*020202.*9/i
    );
  });
});

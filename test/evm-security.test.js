import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEvmSecurityRegistry,
  createLaunchpadSecurityEntry,
  createObservedSellSecurityEntry,
  createV2SecurityEntry,
} from "../src/security/evm/index.js";
import { observeSellReceipts } from "../src/security/evm/observed-sells.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/evm/observed-sell-receipts.json", import.meta.url)));

function candidate(overrides = {}) {
  return {
    chain: "base",
    venue: "uniswap-v3-base",
    token: fixture.token,
    quoteToken: fixture.quote,
    pool: fixture.pool,
    metadata: {},
    ...overrides,
  };
}

describe("EVM security registry", () => {
  it("routes by exact chain and venue and keeps unsupported discovery venues unknown", async () => {
    const registry = createEvmSecurityRegistry([{
      chain: "base",
      venue: "uniswap-v3-base",
      inspect: async () => ({ status: "confirmed", marker: "base-v3" }),
    }]);

    assert.equal((await registry.inspect(candidate())).marker, "base-v3");
    assert.equal(registry.supports(candidate()), true);
    assert.equal(registry.supports(candidate({ chain: "ethereum" })), false);
    assert.deepEqual((await registry.inspect(candidate({ chain: "ethereum" }))).status, "unknown");
    assert.deepEqual((await registry.inspect(candidate({ venue: "clanker-v4-base" }))).reason, "unsupported-venue");
  });

  it("turns a verified binding mismatch into a blocked result", async () => {
    const entry = createObservedSellSecurityEntry({
      chain: "base",
      venue: "uniswap-v3-base",
      bind: async () => ({ ok: false, reason: "pool-binding-mismatch" }),
    });
    const registry = createEvmSecurityRegistry([entry]);

    const result = await registry.inspect(candidate());
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "pool-binding-mismatch");
  });

  it("adapts the existing V2 inspection without losing chain-specific contracts", async () => {
    const factoryAddress = "0x5555555555555555555555555555555555555555";
    let received;
    const entry = createV2SecurityEntry({
      chain: "bsc",
      venue: "pancakeswap-v2-bsc",
      factoryAddress,
      wrappedNative: fixture.quote,
    });
    const registry = createEvmSecurityRegistry([entry]);
    const result = await registry.inspect(candidate({
      chain: "bsc",
      venue: "pancakeswap-v2-bsc",
    }), {
      inspectV2Sellability: async (context, options) => {
        received = { context, options };
        return { status: "unknown", reason: "insufficient-meaningful-sells" };
      },
    });

    assert.equal(result.reason, "insufficient-meaningful-sells");
    assert.equal(received.context.venue, "pancakeswap-v2-bsc");
    assert.equal(received.context.quote, fixture.quote);
    assert.equal(received.options.expectedVenue, "pancakeswap-v2-bsc");
    assert.equal(received.options.factoryAddress, factoryAddress);
  });

  it("requires launchpad-specific resolved-pool binding", async () => {
    let bindCalls = 0;
    const entry = createLaunchpadSecurityEntry({
      chain: "bsc",
      venue: "four-meme-v2-bsc",
      isPoolResolved: (value) => value.metadata.poolResolved === true,
      bind: async () => {
        bindCalls++;
        return { ok: true, pool: fixture.pool };
      },
      meaningfulThreshold: 50n,
    });
    const registry = createEvmSecurityRegistry([entry]);

    const result = await registry.inspect(candidate({
      chain: "bsc",
      venue: "four-meme-v2-bsc",
      metadata: { poolResolved: false },
    }));
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "pool-not-resolved");
    assert.equal(bindCalls, 0);
  });
});

describe("observed EVM sells", () => {
  it("requires token inflow and quote outflow in successful bound receipts", () => {
    const result = observeSellReceipts({
      ...fixture,
      meaningfulThreshold: 50n,
      excludedAddresses: [fixture.router],
      quoteRecipientAddresses: [fixture.router],
    });

    assert.equal(result.meaningfulSellers, 3);
    assert.equal(result.quoteOutflowReceipts, 3);
  });

  it("does not count dust, failed receipts, system senders, or missing quote outflow", () => {
    const [complete] = fixture.receipts;
    const dust = structuredClone(complete);
    dust.from = "0xdddddddddddddddddddddddddddddddddddddddd";
    dust.logs[0].topics[1] = "0x000000000000000000000000dddddddddddddddddddddddddddddddddddddddd";
    dust.logs[0].data = `0x${1n.toString(16).padStart(64, "0")}`;
    const failed = { ...structuredClone(complete), status: 0 };
    const noQuote = structuredClone(complete);
    noQuote.from = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    noQuote.logs = noQuote.logs.slice(0, 1);

    const result = observeSellReceipts({
      ...fixture,
      receipts: [complete, dust, failed, noQuote],
      meaningfulThreshold: 50n,
      excludedAddresses: [fixture.router, complete.from],
      quoteRecipientAddresses: [fixture.router],
    });

    assert.equal(result.meaningfulSellers, 0);
    assert.equal(result.quoteOutflowReceipts, 0);
  });

  it("does not count unrelated quote recipients or quote returned to the bound pool", () => {
    const unrelated = structuredClone(fixture.receipts[0]);
    unrelated.logs[1].topics[2] = "0x0000000000000000000000009999999999999999999999999999999999999999";
    const returned = structuredClone(fixture.receipts[0]);
    returned.logs.push({
      ...structuredClone(returned.logs[1]),
      topics: [returned.logs[1].topics[0], returned.logs[1].topics[2], returned.logs[1].topics[1]],
    });

    for (const receipt of [unrelated, returned]) {
      const result = observeSellReceipts({
        ...fixture,
        receipts: [receipt],
        meaningfulThreshold: 50n,
        excludedAddresses: [fixture.router],
        quoteRecipientAddresses: [fixture.router],
      });
      assert.equal(result.meaningfulSellers, 0);
      assert.equal(result.quoteOutflowReceipts, 0);
    }
  });

  it("keeps one meaningful seller unknown instead of confirming sellability", async () => {
    const entry = createObservedSellSecurityEntry({
      chain: "base",
      venue: "uniswap-v3-base",
      bind: async () => ({ ok: true, pool: fixture.pool, vaults: [] }),
      meaningfulThreshold: 50n,
      excludedAddresses: [fixture.router],
      quoteRecipientAddresses: [fixture.router],
    });
    const registry = createEvmSecurityRegistry([entry]);

    const result = await registry.inspect(candidate(), {
      getObservedSellReceipts: async () => fixture.receipts.slice(0, 1),
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
    assert.equal(result.meaningfulSellers, 1);
  });

  it("confirms three independent meaningful sellers after binding", async () => {
    const entry = createObservedSellSecurityEntry({
      chain: "base",
      venue: "uniswap-v3-base",
      bind: async () => ({ ok: true, pool: fixture.pool, vaults: [] }),
      meaningfulThreshold: 50n,
      excludedAddresses: [fixture.router],
      quoteRecipientAddresses: [fixture.router],
    });
    const registry = createEvmSecurityRegistry([entry]);

    const result = await registry.inspect(candidate(), {
      getObservedSellReceipts: async () => fixture.receipts,
    });
    assert.equal(result.status, "confirmed");
    assert.equal(result.evidenceMode, "observed-sells");
    assert.equal(result.meaningfulSellers, 3);
    assert.equal(result.quoteOutflowReceipts, 3);
  });
});

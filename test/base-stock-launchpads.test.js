import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { getAddress } from "ethers";
import { EVM_PROFILES } from "../src/chains/evm-profiles.js";
import { createAssetCatalog } from "../src/assets/catalog.js";
import { createPairClassifier } from "../src/assets/pair.js";
import { createStonksExchangeAdapter } from "../src/venues/evm/stonks-exchange.js";
import { createStonksExchangeSecurityEntry } from "../src/security/evm/stonks-exchange.js";

function json(relative) {
  return JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), "utf8"));
}

const manifest = json("../config/venues/base.json");
const assets = createAssetCatalog(json("../config/assets/base.json"));
const fixture = json("fixtures/evm/base-stonks-exchange-launch.json");
const classifyPair = createPairClassifier({
  catalog: assets,
  nativeQuotes: EVM_PROFILES.base.quotes.map(({ address }) => address),
  normalizeAddress: getAddress,
});

describe("Base stock launchpads", () => {
  it("records an explicit evidence state for every requested platform", () => {
    const byId = new Map(manifest.venues.map((venue) => [venue.id, venue]));
    assert.equal(byId.get("o1-base").identityStatus, "disabled-unverified");
    assert.equal(byId.get("o1-base").disabledReason, "stock-pair-route-not-supported");
    assert.equal(byId.get("stonks-exchange-base").identityStatus, "verified");
    assert.equal(byId.get("stonks-exchange-base").securityCapability, "supported");
    assert.ok(byId.get("stonks-exchange-base").verifiedContracts.length >= 5);
    assert.equal(byId.get("basestonk-base").identityStatus, "disabled-unverified");
    assert.equal(byId.get("basestonk-base").disabledReason, "missing-public-contract-registry");
    assert.deepEqual(byId.get("basestonk-base").verifiedContracts, []);
  });

  it("pins the verified Stonks Exchange suite in the Base profile", () => {
    const venue = EVM_PROFILES.base.venues.find(({ id }) => id === "stonks-exchange-base");
    assert.ok(venue);
    assert.equal(venue.contracts.launcher, getAddress("0x4714f6EC81639Ca59EEBE634490a4d8671DCe7B4"));
    assert.equal(venue.contracts.feeLocker, getAddress("0x71D1D363176723f85d98B8B430DF33cde89f0A7f"));
    assert.equal(venue.contracts.uniswapV3Factory, getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD"));
    assert.equal(venue.deploymentBlock, 50_140_059);
  });

  it("parses a real stock-paired TokenLaunched event with an exact V3 pool", () => {
    const venue = EVM_PROFILES.base.venues.find(({ id }) => id === "stonks-exchange-base");
    const adapter = createStonksExchangeAdapter({
      id: venue.id,
      ...venue.contracts,
      classifyPair,
    });
    const event = adapter.parse(fixture);
    assert.equal(event.token, getAddress("0x8bc9D1aD1B225e28190bade2b4F707df3E4bd48e"));
    assert.equal(event.referenceAsset, getAddress("0xb200000000000000000000C2e324d24d7eEcd1fb"));
    assert.equal(event.referenceAssetKind, "stock");
    assert.equal(event.assetSource, "base-official-stocks");
    assert.equal(event.pool, getAddress("0xB33d2d8F723a64870337514C84787dF71862f42B"));
    assert.equal(event.creator, getAddress("0x22fAf1b7C4A8B49B91B4b525E3DF40DECE77F7ab"));
    assert.equal(event.metadata.poolResolved, true);
    assert.equal(event.metadata.launcherImplementation, venue.contracts.launcherImplementation);
  });

  it("blocks a Stonks candidate when launcher state does not bind the emitted pool", async () => {
    const venue = EVM_PROFILES.base.venues.find(({ id }) => id === "stonks-exchange-base");
    const parsed = createStonksExchangeAdapter({
      id: venue.id,
      ...venue.contracts,
      classifyPair,
    }).parse(fixture);
    const security = createStonksExchangeSecurityEntry(venue, {
      assetCatalog: assets,
      readLaunchState: async () => ({
        token: parsed.token,
        creator: parsed.creator,
        pool: "0x1111111111111111111111111111111111111111",
        quote: parsed.quoteToken,
        tokenId: parsed.metadata.tokenId,
        fee: parsed.metadata.fee,
        factoryPool: parsed.pool,
      }),
    });
    const result = await security.inspect({
      ...parsed,
      chain: "base",
      venue: venue.id,
      quoteToken: parsed.referenceAsset,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "pool-binding-mismatch");
  });

  it("uses one whole target token as the minimum observed sell sample", async () => {
    const venue = EVM_PROFILES.base.venues.find(({ id }) => id === "stonks-exchange-base");
    const parsed = createStonksExchangeAdapter({
      id: venue.id,
      ...venue.contracts,
      classifyPair,
    }).parse(fixture);
    const state = {
      token: parsed.token,
      creator: parsed.creator,
      pool: parsed.pool,
      quote: parsed.referenceAsset,
      tokenId: parsed.metadata.tokenId,
      fee: parsed.metadata.fee,
      implementation: parsed.metadata.launcherImplementation,
      factoryPool: parsed.pool,
    };
    let threshold;
    const security = createStonksExchangeSecurityEntry(venue, {
      assetCatalog: assets,
      readLaunchState: async () => state,
    });
    const result = await security.inspect({
      ...parsed,
      chain: "base",
      venue: venue.id,
      quoteToken: parsed.referenceAsset,
      decimals: 18,
    }, {
      getObservedSellReceipts: async (_candidate, binding) => {
        threshold = binding.meaningfulThreshold;
        return [];
      },
    });
    assert.equal(threshold, 10n ** 18n);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });

  it("blocks a Stonks candidate when the launcher proxy no longer points to the pinned implementation", async () => {
    const venue = EVM_PROFILES.base.venues.find(({ id }) => id === "stonks-exchange-base");
    const parsed = createStonksExchangeAdapter({
      id: venue.id,
      ...venue.contracts,
      classifyPair,
    }).parse(fixture);
    const security = createStonksExchangeSecurityEntry(venue, {
      assetCatalog: assets,
      readLaunchState: async () => ({
        token: parsed.token,
        creator: parsed.creator,
        pool: parsed.pool,
        quote: parsed.referenceAsset,
        tokenId: parsed.metadata.tokenId,
        fee: parsed.metadata.fee,
        implementation: "0x1111111111111111111111111111111111111111",
        factoryPool: parsed.pool,
      }),
    });
    const result = await security.inspect({
      ...parsed,
      chain: "base",
      venue: venue.id,
      quoteToken: parsed.referenceAsset,
      decimals: 18,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "pool-binding-mismatch");
  });
});

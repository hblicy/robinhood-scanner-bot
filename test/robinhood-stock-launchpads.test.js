import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";
import { EVM_PROFILES } from "../src/chains/evm-profiles.js";
import { createAssetCatalog } from "../src/assets/catalog.js";
import { createPairClassifier } from "../src/assets/pair.js";
import { createO1Adapter } from "../src/venues/evm/o1.js";
import { createO1SecurityEntry } from "../src/security/evm/o1.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

describe("Robinhood stock launchpads", () => {
  it("pins the official O1 Robinhood launch suite", () => {
    const o1 = EVM_PROFILES.robinhood.venues.find(({ id }) => id === "o1-v4-robinhood");
    assert.ok(o1);
    assert.equal(o1.contracts.factory, getAddress("0xcE9C48cFa068947f77738c81Be406B53338E5B0d"));
    assert.equal(o1.contracts.hook, getAddress("0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc"));
    assert.equal(o1.contracts.poolManager, getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"));
    assert.equal(o1.deploymentBlock, 48_880_218);
    assert.match(o1.sourceUrl, /^https:\/\/docs\.o1\.exchange\//);
  });

  it("vendors the verified Launched event without inventing parameter names", () => {
    const document = json("config/abis/o1-launch-factory.json");
    const launched = document.abi.find((entry) => entry.type === "event" && entry.name === "Launched");
    assert.deepEqual(launched.inputs.map(({ name, type, indexed }) => ({ name, type, indexed })), [
      { name: "token", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "originalCreator", type: "address", indexed: true },
      { name: "quoteToken", type: "address", indexed: false },
      { name: "launchSupply", type: "uint256", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
    ]);
  });

  it("loads all verified O1 Robinhood stock quotes and rejects an unknown address", () => {
    const catalog = createAssetCatalog(json("config/assets/robinhood.json"));
    assert.equal(catalog.assets.length, 194);
    assert.equal(catalog.lookup("0x86923f96303D656E4aa86D9d42D1e57ad2023fdC").symbol, "AMD");
    assert.equal(catalog.lookup("0x1000000000000000000000000000000000000001"), null);
  });

  it("parses a real O1 launch and binds its registered stock quote", () => {
    const profile = EVM_PROFILES.robinhood;
    const venue = profile.venues.find(({ id }) => id === "o1-v4-robinhood");
    const catalog = createAssetCatalog(json("config/assets/robinhood.json"));
    const classifyPair = createPairClassifier({
      catalog,
      nativeQuotes: profile.quotes.map(({ address }) => address),
      normalizeAddress: getAddress,
    });
    const adapter = createO1Adapter({ ...venue.contracts, classifyPair, version: venue.version });
    const event = adapter.parse(json("test/fixtures/evm/o1-token-launched.json"));

    assert.equal(event.token, "0x149c347232EB1d8344508A50a93450FCe87F4701");
    assert.equal(event.quoteToken, "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8");
    assert.equal(event.lifecyclePhase, "new_launch");
    assert.equal(event.referenceAssetKind, "stock");
    assert.equal(event.metadata.poolResolved, true);
    assert.equal(event.poolId, "0x6498034854ad1423aa1bcf5d099a6de2e90c9251f6ae39f1883c3571da3a9a5f");
  });

  it("returns unknown when the O1 quote is absent from the trusted asset catalog", async () => {
    const profile = EVM_PROFILES.robinhood;
    const venue = profile.venues.find(({ id }) => id === "o1-v4-robinhood");
    const security = createO1SecurityEntry({
      chain: profile.key,
      venue: venue.id,
      ...venue.contracts,
      assetCatalog: createAssetCatalog(json("config/assets/robinhood.json")),
      now: () => 60_000,
    });
    const result = await security.inspect({
      chain: profile.key,
      venue: venue.id,
      token: "0x149c347232EB1d8344508A50a93450FCe87F4701",
      quoteToken: "0x1000000000000000000000000000000000000001",
      pool: venue.contracts.poolManager,
      poolId: `0x${"64".repeat(32)}`,
      createdAt: 0,
      metadata: {
        poolResolved: true,
        factory: venue.contracts.factory,
        hook: venue.contracts.hook,
        poolManager: venue.contracts.poolManager,
      },
    });

    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "asset-unverified");
  });

  it("keeps O1 launches unknown during the 20 second anti-snipe window", async () => {
    const profile = EVM_PROFILES.robinhood;
    const venue = profile.venues.find(({ id }) => id === "o1-v4-robinhood");
    const security = createO1SecurityEntry({
      chain: profile.key,
      venue: venue.id,
      ...venue.contracts,
      assetCatalog: createAssetCatalog(json("config/assets/robinhood.json")),
      now: () => 25_000,
    });
    const result = await security.inspect({
      chain: profile.key,
      venue: venue.id,
      token: "0x149c347232EB1d8344508A50a93450FCe87F4701",
      quoteToken: "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8",
      pool: venue.contracts.poolManager,
      poolId: "0x6498034854ad1423aa1bcf5d099a6de2e90c9251f6ae39f1883c3571da3a9a5f",
      createdAt: 10_000,
      metadata: {
        poolResolved: true,
        factory: venue.contracts.factory,
        hook: venue.contracts.hook,
        poolManager: venue.contracts.poolManager,
      },
    });

    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "launch-cooldown");
  });
});

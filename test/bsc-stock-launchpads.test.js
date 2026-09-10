import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, getAddress } from "ethers";
import { EVM_PROFILES } from "../src/chains/evm-profiles.js";
import { createAssetCatalog } from "../src/assets/catalog.js";
import { createPairClassifier } from "../src/assets/pair.js";
import { createFlapAdapter } from "../src/venues/evm/flap.js";
import { createFlapSecurityEntry } from "../src/security/evm/flap.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
const profile = EVM_PROFILES.bsc;
const catalog = createAssetCatalog(json("config/assets/bsc.json"));
const classifyPair = createPairClassifier({
  catalog,
  nativeQuotes: profile.quotes.map(({ address }) => address),
  normalizeAddress: getAddress,
});

describe("BSC stock launchpads", () => {
  it("pins the official current Flap Portal suite and records the docs version separately", () => {
    const flap = profile.venues.find(({ id }) => id === "flap-v5-bsc");
    assert.ok(flap);
    assert.equal(flap.contracts.portal, getAddress("0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0"));
    assert.equal(flap.contracts.vaultPortal, getAddress("0x90497450f2a706f1951b5bdda52B4E5d16f34C06"));
    assert.equal(flap.protocolVersion, "v5.23.0");
    assert.equal(flap.docsVersion, "v5.14.16");
  });

  it("vendors only official discovery events and matches the real topics", () => {
    const document = json("config/abis/flap-portal.json");
    assert.equal(document.scope, "discovery-events");
    const iface = new Interface(document.abi);
    assert.equal(iface.getEvent("TokenCreated").topicHash, json("test/fixtures/evm/flap-token-created.json").topics[0]);
    assert.equal(iface.getEvent("LaunchedToDEX").topicHash, json("test/fixtures/evm/flap-migrated.json").topics[0]);
  });

  it("parses a real tax-token launch, resolves its stock quote, and leaves the pool unresolved", async () => {
    const venue = profile.venues.find(({ id }) => id === "flap-v5-bsc");
    const fixture = json("test/fixtures/evm/flap-token-created.json");
    const adapter = createFlapAdapter({
      id: venue.id,
      ...venue.contracts,
      wrappedNative: profile.wrappedNative,
      classifyPair,
      getTransactionReceipt: async (transactionHash) => {
        assert.equal(transactionHash, fixture.transactionHash);
        return fixture.receipt;
      },
    });
    const event = await adapter.parse(fixture, { provider: {} });

    assert.equal(event.token, getAddress("0x01baac8ab67a8de5fecdfd45d9042316027f7777"));
    assert.equal(event.quoteToken, getAddress("0x5b1910eAaD6450E50f816082Aa078C41F10C292f"));
    assert.equal(event.referenceAssetKind, "stock");
    assert.equal(event.lifecyclePhase, "new_launch");
    assert.equal(event.metadata.poolResolved, false);
    assert.equal(event.metadata.taxModel, "tax-v3");
    assert.equal(event.metadata.configuredTaxBps, 100);
  });

  it("binds a real migration event to its emitted DEX pool and strict token context", async () => {
    const venue = profile.venues.find(({ id }) => id === "flap-v5-bsc");
    const fixture = json("test/fixtures/evm/flap-migrated.json");
    const adapter = createFlapAdapter({
      id: venue.id,
      ...venue.contracts,
      wrappedNative: profile.wrappedNative,
      classifyPair: (left, right) => ({
        candidateKind: "meme",
        targetToken: right,
        referenceAsset: left,
        targetSide: "token1",
        pairDirection: "token1/token0",
        targetAssetKind: "meme",
        referenceAssetKind: "stock",
        referenceAssetIssuer: "Invesqo",
        assetSource: "real-flap-migration-fixture",
        assetVerifiedAt: 1788969600000,
        referenceRestrictions: [],
      }),
      resolvePoolTokens: async () => ({
        token0: "0x205812CdBed920aFf76C6580abD681a46D11efc7",
        token1: "0xf8313779108ac7fcd02f9ba891051fd2f6987777",
      }),
      resolveTokenContext: async () => ({ tokenVersion: 6, configuredTaxBps: 100 }),
    });
    const event = await adapter.parse(fixture, { provider: {} });

    assert.equal(event.pool, getAddress("0x229a5a590f27b876b62087674d36d9b48a0c1c50"));
    assert.equal(event.lifecyclePhase, "graduated");
    assert.equal(event.metadata.poolResolved, true);
    assert.equal(event.metadata.taxModel, "tax-v3");
  });

  it("rejects a migration when Portal state points at a different pool", async () => {
    const venue = profile.venues.find(({ id }) => id === "flap-v5-bsc");
    const fixture = json("test/fixtures/evm/flap-migrated.json");
    const adapter = createFlapAdapter({
      id: venue.id,
      ...venue.contracts,
      wrappedNative: profile.wrappedNative,
      classifyPair: (token0, token1) => ({
        candidateKind: "meme",
        targetToken: token1,
        referenceAsset: token0,
        targetSide: "token1",
        referenceAssetKind: "stock",
      }),
      resolvePoolTokens: async () => ({
        token0: "0x205812CdBed920aFf76C6580abD681a46D11efc7",
        token1: "0xf8313779108ac7fcd02f9ba891051fd2f6987777",
      }),
      resolveTokenContext: async () => ({
        tokenVersion: 6,
        buyTaxBps: 100,
        sellTaxBps: 200,
        configuredTaxBps: 200,
        quoteToken: "0x205812CdBed920aFf76C6580abD681a46D11efc7",
        pool: "0x1111111111111111111111111111111111111111",
      }),
    });

    await assert.rejects(
      adapter.parse(fixture, { provider: {} }),
      /Flap Portal pool mismatch.*15500ed/i
    );
  });

  it("keeps unregistered stock quotes and missing tax details unknown", async () => {
    const venue = profile.venues.find(({ id }) => id === "flap-v5-bsc");
    const security = createFlapSecurityEntry(venue, { assetCatalog: catalog, maxTaxBps: 500 });
    const base = {
      chain: "bsc",
      venue: venue.id,
      token: "0xf8313779108ac7fcd02f9ba891051fd2f6987777",
      pool: "0x229a5a590f27b876b62087674d36d9b48a0c1c50",
      metadata: { poolResolved: true, taxModel: "tax-v3", configuredTaxBps: 100 },
    };

    const unknownQuote = await security.inspect({
      ...base,
      quoteToken: "0x1000000000000000000000000000000000000001",
    });
    const missingTax = await security.inspect({
      ...base,
      quoteToken: "0x5b1910eAaD6450E50f816082Aa078C41F10C292f",
      metadata: { poolResolved: true },
    });

    assert.equal(unknownQuote.status, "unknown");
    assert.equal(unknownQuote.reason, "asset-unverified");
    assert.equal(missingTax.status, "unknown");
    assert.equal(missingTax.reason, "tax-config-unavailable");
  });

  it("blocks configured tax above MAX_TAX_BPS before observed-sell checks", async () => {
    const venue = profile.venues.find(({ id }) => id === "flap-v5-bsc");
    const security = createFlapSecurityEntry(venue, { assetCatalog: catalog, maxTaxBps: 500 });
    const result = await security.inspect({
      chain: "bsc",
      venue: venue.id,
      token: "0xf8313779108ac7fcd02f9ba891051fd2f6987777",
      quoteToken: "0x5b1910eAaD6450E50f816082Aa078C41F10C292f",
      pool: "0x229a5a590f27b876b62087674d36d9b48a0c1c50",
      metadata: {
        poolResolved: true,
        taxModel: "tax-v3",
        buyTaxBps: 100,
        sellTaxBps: 501,
        configuredTaxBps: 501,
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "excessive-tax");
  });
});

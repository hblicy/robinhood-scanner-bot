import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAssetCatalog } from "../src/assets/catalog.js";
import { createAssetCatalogCache } from "../src/assets/cache.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const QUOTE = "0x2222222222222222222222222222222222222222";

function validDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    chain: "base",
    family: "evm",
    source: {
      id: "base-official-stocks",
      url: "https://www.base.org/stocks",
      verifiedAt: 1,
    },
    assets: [{
      address: TOKEN.toLowerCase(),
      symbol: "NVDAc",
      kind: "stock",
      issuer: "Coinbase",
      sourceId: "base-official-stocks",
      sourceUrl: "https://www.base.org/stocks",
      verifiedAt: 1,
    }],
    ...overrides,
  };
}

describe("trusted asset catalog", () => {
  it("indexes verified EVM assets by normalized address", () => {
    const catalog = createAssetCatalog(validDocument());
    assert.equal(catalog.lookup(TOKEN).issuer, "Coinbase");
    assert.equal(catalog.lookup(TOKEN).address, TOKEN);
    assert.equal(catalog.has(QUOTE), false);
  });

  it("indexes verified Solana assets without changing the mint", () => {
    const mint = "So11111111111111111111111111111111111111112";
    const catalog = createAssetCatalog(validDocument({
      chain: "solana",
      family: "solana",
      assets: [{
        address: mint,
        symbol: "xSOL",
        kind: "crypto",
        issuer: "Backed",
        sourceId: "backed-xstocks",
        sourceUrl: "https://api.backed.fi/api/v1/token",
        verifiedAt: 1,
      }],
    }));
    assert.equal(catalog.lookup(mint).address, mint);
  });

  it("rejects duplicate, malformed and unverified asset records", () => {
    const duplicate = validDocument({
      assets: [validDocument().assets[0], validDocument().assets[0]],
    });
    assert.throws(() => createAssetCatalog(duplicate), /duplicate asset/i);
    assert.throws(() => createAssetCatalog(validDocument({
      assets: [{ ...validDocument().assets[0], sourceUrl: "http://example.com" }],
    })), /source/i);
    assert.throws(() => createAssetCatalog(validDocument({
      assets: [{ ...validDocument().assets[0], issuer: "" }],
    })), /issuer/i);
  });

  it("allows an explicitly disabled empty catalog", () => {
    const catalog = createAssetCatalog(validDocument({
      source: {
        id: "no-verified-stock-source",
        url: null,
        verifiedAt: 0,
        status: "disabled-unverified",
      },
      assets: [],
    }));
    assert.equal(catalog.assets.length, 0);
    assert.equal(catalog.source.status, "disabled-unverified");
  });

  it("loads the runtime snapshot before the shipped catalog", () => {
    const reads = [];
    const cache = createAssetCatalogCache({
      readJson(path) {
        reads.push(path);
        return path === "runtime.json" ? validDocument() : null;
      },
      atomicWriteJson() {},
    });
    assert.equal(cache.load({ shippedPath: "shipped.json", runtimePath: "runtime.json" }).assets.length, 1);
    assert.deepEqual(reads, ["runtime.json"]);
  });

  it("keeps the last valid snapshot when refresh validation fails", async () => {
    const current = createAssetCatalog(validDocument());
    const writes = [];
    const cache = createAssetCatalogCache({
      readJson() { return null; },
      atomicWriteJson(path, value) { writes.push([path, value]); },
    });
    const result = await cache.refresh({
      current,
      runtimePath: "runtime.json",
      load: async () => validDocument({ schemaVersion: 2 }),
    });
    assert.equal(result.catalog, current);
    assert.equal(result.status, "stale");
    assert.match(result.error.message, /schemaVersion/);
    assert.equal(writes.length, 0);
  });
});

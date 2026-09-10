import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createAssetCatalog } from "../src/assets/catalog.js";
import { mergeVerifiedAssetRows } from "../scripts/refresh-asset-catalog.js";

const catalog = createAssetCatalog(JSON.parse(fs.readFileSync(
  new URL("../config/assets/bsc.json", import.meta.url),
  "utf8"
)));
const sources = JSON.parse(fs.readFileSync(
  new URL("fixtures/assets/bsc-stock-sources.json", import.meta.url),
  "utf8"
));

describe("BSC trusted stock assets", () => {
  it("keeps official provenance on every admitted asset", () => {
    assert.equal(catalog.assets.filter(({ issuer }) => issuer === "BTech Holdings").length, 5);
    assert.ok(catalog.assets.filter(({ issuer }) => issuer === "Backed").length > 0);
    for (const asset of catalog.assets) {
      assert.ok(["BTech Holdings", "Backed"].includes(asset.issuer));
      if (asset.issuer === "BTech Holdings") {
        assert.match(asset.sourceUrl, /^https:\/\/www\.binance\.com\//);
      } else {
        assert.equal(asset.sourceUrl, "https://api.xstocks.fi/api/v2/public/assets");
      }
      assert.ok(asset.sourceId);
      assert.ok(asset.verifiedAt > 0);
    }
    assert.equal(catalog.lookup("0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436").symbol, "NVDAB");
  });

  it("does not admit ticker-only lookalikes and records disabled 4Stock evidence", () => {
    assert.equal(catalog.lookup("0x1000000000000000000000000000000000000001"), null);
    const fourStock = sources.sources.find(({ id }) => id === "four-meme-4stock");
    assert.equal(fourStock.status, "disabled-unverified");
    assert.equal(fourStock.disabledReason, "missing-stable-official-full-address-manifest");
  });

  it("rejects mutually exclusive issuers for the same address during refresh", () => {
    const common = {
      address: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436",
      symbol: "NVDAB",
      kind: "stock",
      sourceId: "source-a",
      sourceUrl: "https://example.com/a",
      verifiedAt: 1,
    };
    assert.throws(() => mergeVerifiedAssetRows([
      { ...common, issuer: "BTech Holdings" },
      { ...common, issuer: "Four.meme", sourceId: "source-b", sourceUrl: "https://example.com/b" },
    ]), /issuer conflict/i);
  });
});

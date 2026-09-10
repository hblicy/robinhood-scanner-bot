import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { refreshAssetCatalog } from "../scripts/refresh-asset-catalog.js";
import { fetchJson } from "../src/assets/sources/http-json.js";

const TOKEN = "0x1111111111111111111111111111111111111111";

function jsonResponse(body, { status = 200, contentType = "application/json" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    async json() { return body; },
  };
}

describe("asset catalog refresh", () => {
  it("writes a sorted catalog only after every remote record validates", async () => {
    const written = [];
    const result = await refreshAssetCatalog({
      chain: "robinhood",
      family: "evm",
      sourceId: "verified-fixture",
      sourceUrl: "https://example.com/robinhood-stock-quotes.json",
      fetchImpl: async () => jsonResponse([
        { address: TOKEN, symbol: "NVDA", issuer: "Robinhood" },
      ]),
      write: async (document) => written.push(document),
      now: () => 1_789_000_000_000,
    });
    assert.equal(result.assets.length, 1);
    assert.equal(written.length, 1);
    assert.equal(written[0].assets[0].kind, "stock");
    assert.equal(written[0].source.verifiedAt, 1_789_000_000_000);
  });

  it("does not write a partial catalog after one invalid row", async () => {
    const written = [];
    await assert.rejects(() => refreshAssetCatalog({
      chain: "base",
      family: "evm",
      sourceId: "verified-fixture",
      sourceUrl: "https://example.com/base-stocks.json",
      fetchImpl: async () => jsonResponse([
        { address: TOKEN, symbol: "GOOD", issuer: "Coinbase" },
        { address: "bad", symbol: "BAD", issuer: "Coinbase" },
      ]),
      write: async (document) => written.push(document),
      now: () => 1_789_000_000_000,
    }), /invalid/i);
    assert.equal(written.length, 0);
  });

  it("wraps HTTP and schema failures without losing the cause", async () => {
    await assert.rejects(() => fetchJson("https://example.com/assets.json", {
      fetchImpl: async () => jsonResponse({}, { status: 503 }),
    }), (error) => error.code === "asset-registry-unavailable" && error.cause != null);

    await assert.rejects(() => fetchJson("https://example.com/assets.json", {
      fetchImpl: async () => jsonResponse({}, { contentType: "text/html" }),
    }), /asset-registry-unavailable/);
  });
});

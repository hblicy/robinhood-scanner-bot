import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseBaseStocksPage,
  refreshBaseStockCatalog,
} from "../scripts/refresh-asset-catalog.js";

const html = fs.readFileSync(
  new URL("fixtures/assets/base-official-stocks.html", import.meta.url),
  "utf8"
);

describe("Base official B20 assets", () => {
  it("extracts only full Base stock contract links from the official page", () => {
    const document = parseBaseStocksPage(html, { now: () => 1_789_000_000_000 });
    assert.equal(document.assets.length, 10);
    assert.ok(document.assets.every(({ address }) => /^0x[0-9a-fA-F]{40}$/.test(address)));
    assert.ok(document.assets.every(({ issuer, kind }) => issuer === "Coinbase" && kind === "stock"));
    assert.ok(document.assets.every(({ sourceId }) => sourceId === "base-official-stocks"));
    assert.equal(document.assets.find(({ symbol }) => symbol === "NVDAc")?.address,
      "0xb20000000000000000000078ee7ce2fE4908108C");
  });

  it("fails closed when the official page contains symbols but no full addresses", () => {
    assert.throws(
      () => parseBaseStocksPage("<div>NVDAc 0xb200...108C</div>"),
      /full contract address/i
    );
  });

  it("rejects a full token address linked from an untrusted domain", () => {
    assert.throws(
      () => parseBaseStocksPage("<h3>NVDAc</h3><a href=\"https://example.com/token/0xb20000000000000000000078ee7ce2fE4908108C\">token</a>"),
      /full contract address/i
    );
  });

  it("verifies bytecode for every official address before writing", async () => {
    const reads = [];
    let written = null;
    const result = await refreshBaseStockCatalog({
      fetchImpl: async () => new Response(html),
      readBytecode: async (address) => {
        reads.push(address);
        return "0x6000";
      },
      write: async (document) => { written = document; },
      now: () => 1_789_000_000_000,
    });
    assert.equal(reads.length, 10);
    assert.deepEqual(written, result);
    assert.equal(result.assets.length, 10);
  });

  it("keeps the existing catalog untouched when any address has no bytecode", async () => {
    let reads = 0;
    let written = false;
    await assert.rejects(() => refreshBaseStockCatalog({
      fetchImpl: async () => new Response(html),
      readBytecode: async () => (++reads === 4 ? "0x" : "0x6000"),
      write: async () => { written = true; },
      now: () => 1_789_000_000_000,
    }), /bytecode/i);
    assert.equal(written, false);
  });
});

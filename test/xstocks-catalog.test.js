import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import {
  parseXStocksAssets,
  refreshXStocksCatalogs,
} from "../src/assets/sources/xstocks.js";
import { formatAssetRefreshResult } from "../scripts/refresh-asset-catalog.js";

const fixture = JSON.parse(fs.readFileSync(
  new URL("fixtures/assets/xstocks-assets-response.json", import.meta.url),
  "utf8"
));

describe("xStocks official asset catalog", () => {
  it("extracts each requested network from the v2 public assets schema", () => {
    const solana = parseXStocksAssets(fixture, {
      network: "Solana",
      chain: "solana",
      family: "solana",
      now: () => 1_789_000_000_000,
    });
    const ethereum = parseXStocksAssets(fixture, {
      network: "Ethereum",
      chain: "ethereum",
      family: "evm",
      now: () => 1_789_000_000_000,
    });
    const bsc = parseXStocksAssets(fixture, {
      network: "BinanceSmartChain",
      chain: "bsc",
      family: "evm",
      now: () => 1_789_000_000_000,
    });

    assert.equal(solana.assets.length, 2);
    assert.ok(solana.assets.every(({ address }) => new PublicKey(address)));
    assert.ok(ethereum.assets.every(({ address }) => address.startsWith("0x")));
    assert.ok(bsc.assets.every(({ address }) => address.startsWith("0x")));
    assert.ok([...solana.assets, ...ethereum.assets, ...bsc.assets]
      .every(({ kind, issuer, sourceId }) => kind === "stock"
        && issuer === "Backed"
        && sourceId === "backed-xstocks-api-v2"));
  });

  it("rejects duplicate addresses and rows without deployment provenance", () => {
    const duplicate = structuredClone(fixture);
    duplicate.nodes[1].deployments[0].address = duplicate.nodes[0].deployments[0].address;
    assert.throws(() => parseXStocksAssets(duplicate, {
      network: "Solana", chain: "solana", family: "solana",
    }), /duplicate asset/i);

    const missingNetwork = structuredClone(fixture);
    delete missingNetwork.nodes[0].deployments[0].network;
    assert.throws(() => parseXStocksAssets(missingNetwork, {
      network: "Solana", chain: "solana", family: "solana",
    }), /network/i);
  });

  it("validates every chain before writing any catalog", async () => {
    const writes = [];
    await assert.rejects(() => refreshXStocksCatalogs({
      pages: [fixture],
      readers: {
        solana: async () => ({ exists: true, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }),
        ethereum: async () => "0x6000",
        bsc: async (address) => address.endsWith("4444") ? "0x" : "0x6000",
      },
      existingDocuments: {},
      write: async (chain, document) => writes.push([chain, document]),
      now: () => 1_789_000_000_000,
    }), /bytecode/i);
    assert.equal(writes.length, 0);
  });

  it("merges verified xStocks into an existing BSC stock catalog", async () => {
    const writes = [];
    const result = await refreshXStocksCatalogs({
      pages: [fixture],
      readers: {
        solana: async () => ({ exists: true, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }),
        ethereum: async () => "0x6000",
        bsc: async () => "0x6000",
      },
      existingDocuments: {
        bsc: {
          schemaVersion: 1,
          chain: "bsc",
          family: "evm",
          source: {
            id: "existing",
            url: "https://example.com/bsc",
            verifiedAt: 1,
            status: "verified-partial"
          },
          assets: [{
            address: "0x5555555555555555555555555555555555555555",
            symbol: "NVDAB",
            kind: "stock",
            issuer: "BTech Holdings",
            sourceId: "existing",
            sourceUrl: "https://example.com/bsc",
            verifiedAt: 1
          }]
        }
      },
      write: async (chain, document) => writes.push([chain, document]),
      now: () => 1_789_000_000_000,
    });
    assert.equal(writes.length, 3);
    assert.equal(result.bsc.assets.length, 3);
    assert.ok(result.bsc.assets.some(({ issuer }) => issuer === "BTech Holdings"));
  });

  it("formats a multi-chain refresh result without assuming a single catalog", () => {
    assert.equal(formatAssetRefreshResult({
      solana: { assets: [{}, {}] },
      ethereum: { assets: [{}] },
      bsc: { assets: [{}, {}, {}] },
    }), "asset catalogs refreshed: solana=2 ethereum=1 bsc=3");
  });
});

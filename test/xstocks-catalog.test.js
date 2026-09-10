import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  parseXStocksAssets,
  refreshXStocksCatalogs,
} from "../src/assets/sources/xstocks.js";
import {
  formatAssetRefreshResult,
  atomicWriteJsonBatch,
  recoverAtomicJsonBatch,
  loadRefreshEnvironment,
} from "../scripts/refresh-asset-catalog.js";

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
      publish: async (documents) => writes.push(documents),
      now: () => 1_789_000_000_000,
    }), /bytecode/i);
    assert.equal(writes.length, 0);
  });

  it("merges verified xStocks into an existing BSC stock catalog", async () => {
    const publications = [];
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
      publish: async (documents) => publications.push(documents),
      now: () => 1_789_000_000_000,
    });
    assert.equal(publications.length, 1);
    assert.deepEqual(publications[0], result);
    assert.equal(result.bsc.assets.length, 3);
    assert.ok(result.bsc.assets.some(({ issuer }) => issuer === "BTech Holdings"));
  });

  it("publishes the three verified catalogs as one batch", async () => {
    const publications = [];
    await assert.rejects(() => refreshXStocksCatalogs({
      pages: [fixture],
      readers: {
        solana: async () => ({ exists: true, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }),
        ethereum: async () => "0x6000",
        bsc: async () => "0x6000",
      },
      existingDocuments: {},
      publish: async (documents) => {
        publications.push(documents);
        throw new Error("disk full");
      },
      now: () => 1_789_000_000_000,
    }), /disk full/i);
    assert.equal(publications.length, 1);
    assert.deepEqual(Object.keys(publications[0]), ["solana", "ethereum", "bsc"]);
  });

  it("rolls back every catalog when a batch rename fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xstocks-batch-"));
    const originals = Object.fromEntries(["solana", "ethereum", "bsc"].map((chain) => [
      chain,
      { chain, generation: "old" },
    ]));
    try {
      for (const [chain, document] of Object.entries(originals)) {
        fs.writeFileSync(path.join(directory, `${chain}.json`), JSON.stringify(document), "utf8");
      }
      let failed = false;
      const fsImpl = {
        ...fs,
        renameSync(from, to) {
          if (!failed && to.endsWith("ethereum.json")) {
            failed = true;
            throw new Error("disk full");
          }
          return fs.renameSync(from, to);
        },
      };
      assert.throws(() => atomicWriteJsonBatch(
        Object.fromEntries(Object.keys(originals).map((chain) => [chain, { chain, generation: "new" }])),
        { directory, fsImpl, transactionId: "test" }
      ), /batch publish failed.*disk full/i);
      for (const [chain, original] of Object.entries(originals)) {
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, `${chain}.json`), "utf8")), original);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves every old catalog when staging a batch fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xstocks-stage-"));
    const originals = Object.fromEntries(["solana", "ethereum", "bsc"].map((chain) => [
      chain,
      { chain, generation: "old" },
    ]));
    try {
      for (const [chain, document] of Object.entries(originals)) {
        fs.writeFileSync(path.join(directory, `${chain}.json`), JSON.stringify(document), "utf8");
      }
      let failed = false;
      const fsImpl = {
        ...fs,
        writeFileSync(file, ...args) {
          if (!failed && file.includes("ethereum.json") && file.endsWith(".tmp")) {
            failed = true;
            throw new Error("stage failed");
          }
          return fs.writeFileSync(file, ...args);
        },
      };
      assert.throws(() => atomicWriteJsonBatch(
        Object.fromEntries(Object.keys(originals).map((chain) => [chain, { chain, generation: "new" }])),
        { directory, fsImpl, transactionId: "test" }
      ), /batch publish failed.*stage failed/i);
      for (const [chain, original] of Object.entries(originals)) {
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, `${chain}.json`), "utf8")), original);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers all old catalogs from a journal left by an interrupted commit", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xstocks-recover-"));
    const transactionId = "interrupted";
    const chains = ["solana", "ethereum", "bsc"];
    try {
      for (const chain of chains) {
        const target = path.join(directory, `${chain}.json`);
        fs.writeFileSync(target, JSON.stringify({ chain, generation: chain === "solana" ? "new" : "old" }), "utf8");
        fs.writeFileSync(`${target}.${transactionId}.bak`, JSON.stringify({ chain, generation: "old" }), "utf8");
      }
      fs.writeFileSync(path.join(directory, ".xstocks-refresh-transaction.json"), JSON.stringify({
        schemaVersion: 1,
        transactionId,
        entries: chains.map((chain) => ({ chain, hadTarget: true })),
      }), "utf8");

      assert.equal(recoverAtomicJsonBatch({ directory }), true);
      for (const chain of chains) {
        const target = path.join(directory, `${chain}.json`);
        assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { chain, generation: "old" });
        assert.equal(fs.existsSync(`${target}.${transactionId}.bak`), false);
      }
      assert.equal(fs.existsSync(path.join(directory, ".xstocks-refresh-transaction.json")), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("formats a multi-chain refresh result without assuming a single catalog", () => {
    assert.equal(formatAssetRefreshResult({
      solana: { assets: [{}, {}] },
      ethereum: { assets: [{}] },
      bsc: { assets: [{}, {}, {}] },
    }), "asset catalogs refreshed: solana=2 ethereum=1 bsc=3");
  });

  it("loads refresh RPC settings from .env and lets process values override them", () => {
    const env = loadRefreshEnvironment({
      file: new URL("fixtures/refresh.env", import.meta.url),
      processEnv: { SOLANA_RPC_URL: "https://from-process.example" },
    });
    assert.equal(env.SOLANA_RPC_URL, "https://from-process.example");
    assert.equal(env.BSC_ANALYSIS_RPC_URL, "https://bsc-from-file.example");
  });
});

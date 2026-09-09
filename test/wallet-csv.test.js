import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importWalletCsvFiles, serializeWalletCatalog } from "../src/wallets/catalog.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "wallets");
const evmA = path.join(fixtures, "evm-a.csv");
const evmB = path.join(fixtures, "evm-b.csv");
const solana = path.join(fixtures, "solana.csv");

describe("wallet CSV catalog", () => {
  it("merges EVM duplicates, tags, sources and source chains", () => {
    const catalog = importWalletCsvFiles([evmA, evmB], { family: "evm" });
    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.family, "evm");
    assert.equal(catalog.wallets.length, 2);
    assert.deepEqual(catalog.wallets[0].sourceChains, ["base", "bsc", "ethereum", "robinhood"]);
    assert.equal(catalog.wallets.find((wallet) => wallet.tags.includes("kol")).type, "kol");
    assert.equal(catalog.wallets.find((wallet) => !wallet.tags.includes("kol")).type, "smart_money");
    assert.equal(catalog.rejected.length, 1);
    assert.equal(catalog.rejected[0].row, 5);
    assert.equal(catalog.rejected[0].reason, "invalid-address");
  });

  it("emits byte-identical deterministic JSON regardless of input order", () => {
    const forward = serializeWalletCatalog(importWalletCsvFiles([evmA, evmB], { family: "evm" }));
    const reverse = serializeWalletCatalog(importWalletCsvFiles([evmB, evmA], { family: "evm" }));
    assert.equal(forward, reverse);
  });

  it("validates Base58 Solana addresses and merges classifications", () => {
    const catalog = importWalletCsvFiles([solana], { family: "solana" });
    assert.equal(catalog.family, "solana");
    assert.equal(catalog.wallets.length, 2);
    assert.equal(catalog.wallets[0].address.includes("0x"), false);
    assert.equal(catalog.wallets.find((wallet) => wallet.address.startsWith("So1")).type, "kol");
    assert.equal(catalog.wallets.find((wallet) => wallet.address.startsWith("Vote")).type, "smart_money");
    assert.deepEqual(catalog.rejected.map((item) => item.reason).sort(), ["invalid-address", "invalid-chain"]);
  });
});

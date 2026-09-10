import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { SOLANA_PROFILE } from "../src/chains/solana-profile.js";
import { createPumpAdapters } from "../src/venues/solana/pump.js";
import { createAssetCatalog } from "../src/assets/catalog.js";
import { createPairClassifier } from "../src/assets/pair.js";

const PUMP = SOLANA_PROFILE.programs.find((program) => program.id === "pump-bonding-curve");
const SWAP = SOLANA_PROFILE.programs.find((program) => program.id === "pumpswap");
const WSOL = SOLANA_PROFILE.wrappedNative;

function keys(count, first) {
  return [first, ...Array.from({ length: count - 1 }, () => Keypair.generate().publicKey.toBase58())];
}

function context(program, discriminator, accountKeys, accounts) {
  return {
    signature: "5".repeat(64),
    slot: 123,
    blockTime: 1_000,
    transaction: {
      transaction: {
        message: {
          accountKeys,
          instructions: [{
            programIdIndex: 0,
            accounts,
            data: bs58.encode(Buffer.from(discriminator)),
          }],
        },
      },
      meta: { err: null },
    },
    program,
  };
}

describe("Pump Solana adapters", () => {
  it("parses Pump create and migration from pinned account layouts", () => {
    const [pump] = createPumpAdapters(SOLANA_PROFILE);
    const createKeys = keys(16, PUMP.programId);
    const created = pump.parseTransaction(context(PUMP, [24, 30, 200, 40, 5, 28, 7, 119], createKeys,
      Array.from({ length: 14 }, (_, index) => index + 1)));
    assert.equal(created.length, 1);
    assert.equal(created[0].token, createKeys[1]);
    assert.equal(created[0].pool, createKeys[3]);
    assert.equal(created[0].creator, createKeys[8]);
    assert.equal(created[0].lifecyclePhase, "new_launch");

    const migrateKeys = keys(28, PUMP.programId);
    migrateKeys[15] = WSOL;
    const migrated = pump.parseTransaction(context(PUMP, [155, 234, 231, 146, 236, 158, 162, 30], migrateKeys,
      Array.from({ length: 25 }, (_, index) => index + 1)));
    assert.equal(migrated[0].token, migrateKeys[3]);
    assert.equal(migrated[0].pool, migrateKeys[10]);
    assert.equal(migrated[0].lifecyclePhase, "graduated");
    assert.equal(migrated[0].metadata.quoteVault, migrateKeys[19]);
  });

  it("parses PumpSwap pool creation and ignores trades as new candidates", () => {
    const [, pumpswap] = createPumpAdapters(SOLANA_PROFILE);
    const accountKeys = keys(21, SWAP.programId);
    accountKeys[5] = WSOL;
    const created = pumpswap.parseTransaction(context(SWAP, [233, 146, 209, 142, 207, 104, 64, 188], accountKeys,
      Array.from({ length: 18 }, (_, index) => index + 1)));
    assert.equal(created[0].token, accountKeys[4]);
    assert.equal(created[0].quoteToken, WSOL);
    assert.equal(created[0].pool, accountKeys[1]);
    assert.equal(created[0].lifecyclePhase, "new_pool");

    const trade = pumpswap.parseTransaction(context(SWAP, [102, 6, 61, 18, 1, 218, 235, 234], accountKeys,
      Array.from({ length: 18 }, (_, index) => index + 1)));
    assert.deepEqual(trade, []);
  });

  it("selects the meme when an xStock is the PumpSwap base mint", () => {
    const stock = Keypair.generate().publicKey.toBase58();
    const catalog = createAssetCatalog({
      schemaVersion: 1,
      chain: "solana",
      family: "solana",
      source: { id: "fixture", url: "https://example.com/xstocks", verifiedAt: 1 },
      assets: [{ address: stock, symbol: "AAPLx", kind: "stock", issuer: "Backed", sourceId: "fixture", sourceUrl: "https://example.com/xstocks", verifiedAt: 1 }],
    });
    const classifyPair = createPairClassifier({
      catalog,
      nativeQuotes: SOLANA_PROFILE.quotes.map(({ address }) => address),
      normalizeAddress: (value) => value,
    });
    const [, pumpswap] = createPumpAdapters(SOLANA_PROFILE, { classifyPair });
    const accountKeys = keys(21, SWAP.programId);
    accountKeys[4] = stock;
    const meme = accountKeys[5];
    const [event] = pumpswap.parseTransaction(context(SWAP, [233, 146, 209, 142, 207, 104, 64, 188], accountKeys,
      Array.from({ length: 18 }, (_, index) => index + 1)));
    assert.equal(event.token, meme);
    assert.equal(event.quoteToken, stock);
    assert.equal(event.targetSide, "quote");
    assert.equal(event.referenceAssetKind, "stock");
  });

  it("rejects a recognized instruction whose account layout is truncated", () => {
    const [pump] = createPumpAdapters(SOLANA_PROFILE);
    const accountKeys = keys(4, PUMP.programId);
    assert.throws(
      () => pump.parseTransaction(context(PUMP, [24, 30, 200, 40, 5, 28, 7, 119], accountKeys, [1, 2])),
      /unsupported-idl-revision.*pump-bonding-curve.*5555/i
    );
  });
});

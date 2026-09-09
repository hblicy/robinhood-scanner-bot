import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { SOLANA_PROFILE } from "../src/chains/solana-profile.js";
import { createRaydiumAdapters } from "../src/venues/solana/raydium.js";

const WSOL = SOLANA_PROFILE.wrappedNative;
const quote = new Set(SOLANA_PROFILE.quotes.map((item) => item.address));

function disc(name) {
  return [...createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)];
}

function make(program, discriminator, count, positions) {
  const accountKeys = [program.programId, ...Array.from({ length: count }, () => Keypair.generate().publicKey.toBase58())];
  for (const [position, value] of Object.entries(positions)) accountKeys[Number(position) + 1] = value;
  return {
    accountKeys,
    context: {
      signature: "6".repeat(64),
      slot: 456,
      blockTime: 2_000,
      program,
      transaction: {
        transaction: { message: { accountKeys, instructions: [{
          programIdIndex: 0,
          accounts: Array.from({ length: count }, (_, index) => index + 1),
          data: bs58.encode(Buffer.from(discriminator)),
        }] } },
        meta: { err: null },
      },
    },
  };
}

describe("Raydium Solana adapters", () => {
  it("parses LaunchLab, CPMM, CLMM and AMM v4 creation layouts", () => {
    const adapters = createRaydiumAdapters(SOLANA_PROFILE);
    const cases = [
      ["raydium-launchlab", [67, 153, 175, 39, 218, 16, 38, 32], 18, { 7: WSOL }, 6, 5],
      ["raydium-cpmm", [175, 175, 109, 31, 13, 152, 155, 237], 20, { 5: WSOL }, 4, 3],
      ["raydium-clmm", disc("create_pool"), 13, { 4: WSOL }, 3, 2],
      ["raydium-amm-v4", [1], 21, { 9: WSOL }, 8, 4],
    ];
    for (const [id, discriminator, count, positions, tokenPosition, poolPosition] of cases) {
      const adapter = adapters.find((item) => item.id === id);
      const fixture = make(adapter, discriminator, count, positions);
      const events = adapter.parseTransaction(fixture.context);
      assert.equal(events.length, 1, id);
      assert.equal(events[0].token, fixture.accountKeys[tokenPosition + 1], id);
      assert.equal(events[0].pool, fixture.accountKeys[poolPosition + 1], id);
      assert.equal(quote.has(events[0].quoteToken), true, id);
    }
  });

  it("ignores pools when neither side is a configured quote", () => {
    const adapter = createRaydiumAdapters(SOLANA_PROFILE).find((item) => item.id === "raydium-cpmm");
    const fixture = make(adapter, [175, 175, 109, 31, 13, 152, 155, 237], 20, {});
    assert.deepEqual(adapter.parseTransaction(fixture.context), []);
  });

  it("rejects mismatched executing programs", () => {
    const adapter = createRaydiumAdapters(SOLANA_PROFILE).find((item) => item.id === "raydium-clmm");
    const fixture = make(adapter, disc("create_pool"), 13, { 4: WSOL });
    fixture.context.transaction.transaction.message.accountKeys[0] = SOLANA_PROFILE.programs[0].programId;
    assert.throws(() => adapter.parseTransaction(fixture.context), /program-owner-mismatch/);
  });
});

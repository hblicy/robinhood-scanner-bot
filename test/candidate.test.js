import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCandidate,
  rawEventKey,
  candidateKey,
  notificationKey,
} from "../src/core/candidate.js";

const input = {
  chain: "base",
  chainFamily: "evm",
  venue: "uniswap-v3-base",
  sourceKind: "dex",
  token: "0x1111111111111111111111111111111111111111",
  quoteToken: "0x2222222222222222222222222222222222222222",
  pool: "0x3333333333333333333333333333333333333333",
  poolId: null,
  creator: null,
  blockOrSlot: 100,
  transactionId: `0x${"4".repeat(64)}`,
  eventIndex: 2,
  createdAt: 1_000,
  lifecyclePhase: "new_pool",
  sourceProvenance: "uniswap-v3@1",
};

describe("normalized candidate", () => {
  it("normalizes EVM addresses and creates chain-aware keys", () => {
    const value = normalizeCandidate(input);
    assert.equal(value.chain, "base");
    assert.ok(Object.isFrozen(value));
    assert.match(rawEventKey(value), /^base\|0x[0-9a-f]{64}\|2$/);
    assert.match(candidateKey(value), /^base\|uniswap-v3-base\|/);
    assert.match(notificationKey(value, "candidate", 1), /^base\|/);
  });

  it("does not collide across chains", () => {
    const base = normalizeCandidate(input);
    const ethereum = normalizeCandidate({ ...input, chain: "ethereum" });
    assert.notEqual(candidateKey(base), candidateKey(ethereum));
  });

  it("prefers a non-address pool ID without lowercasing Solana identities", () => {
    const solana = normalizeCandidate({
      ...input,
      chain: "solana",
      chainFamily: "solana",
      token: "So11111111111111111111111111111111111111112",
      quoteToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      pool: "SysvarRent111111111111111111111111111111111",
      poolId: "MixedCasePoolId",
      transactionId: "5".repeat(64),
      creator: null,
    });
    assert.equal(candidateKey(solana), "solana|uniswap-v3-base|MixedCasePoolId");
    assert.equal(rawEventKey(solana), `solana|${"5".repeat(64)}|2`);
  });

  it("validates identities according to the selected chain family", () => {
    const solana = {
      ...input,
      chain: "solana",
      chainFamily: "solana",
      token: "So11111111111111111111111111111111111111112",
      quoteToken: "11111111111111111111111111111111",
      pool: "Vote111111111111111111111111111111111111111",
      transactionId: "5".repeat(64),
    };
    assert.doesNotThrow(() => normalizeCandidate(solana));
    assert.throws(() => normalizeCandidate({ ...solana, token: "0x1111111111111111111111111111111111111111" }), /token/);
    assert.throws(() => normalizeCandidate({ ...solana, transactionId: "0OIl" }), /transactionId/);
    assert.throws(() => normalizeCandidate({ ...input, token: solana.token }), /address/i);
  });

  it("rejects missing provenance and invalid event identity", () => {
    assert.throws(() => normalizeCandidate({ ...input, sourceProvenance: "" }));
    assert.throws(() => normalizeCandidate({ ...input, eventIndex: -1 }));
    assert.throws(() => normalizeCandidate({ ...input, transactionId: "0x1234" }));
    assert.throws(() => normalizeCandidate({ ...input, chain: "solana" }), /family/i);
  });
});

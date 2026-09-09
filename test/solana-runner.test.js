import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { runSolanaOnce } from "../src/solana/runner.js";

const PROGRAM = Keypair.generate().publicKey.toBase58();
const TOKEN = Keypair.generate().publicKey.toBase58();
const QUOTE = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();

function candidate() {
  return {
    chain: "solana", chainFamily: "solana", venue: "test", sourceKind: "dex",
    token: TOKEN, quoteToken: QUOTE, pool: POOL, poolId: null, creator: null,
    blockOrSlot: 11, transactionId: "6".repeat(64), eventIndex: 0, createdAt: null,
    lifecyclePhase: "new_pool", sourceProvenance: "test@fixture", metadata: {},
  };
}

function report(status, score = 80) {
  return {
    token: TOKEN, pool: POOL, poolId: null, venue: "test", meta: { symbol: "TEST" },
    score, verdict: "review", red: [], checks: [], facts: {}, links: {},
    honeypot: { honeypot: status === "blocked" },
    sellability: {
      status, reason: status === "unknown" ? "evidence-unavailable" : null,
      buyerSamples: 0, ladderSamples: 0,
      meaningfulSellers: status === "confirmed" ? 3 : 0,
      evidenceMode: "observed-sells", bindingVerified: status !== "unknown",
      quoteOutflowReceipts: status === "confirmed" ? 3 : 0,
    },
  };
}

describe("Solana runner", () => {
  it("bootstraps missing cursors silently without historical transaction reads", async () => {
    let transactions = 0;
    let alerts = 0;
    const committed = [];
    const config = {
      venues: [{ id: "test", programId: PROGRAM }],
      rpcContext: { discoverySessions: { run: (work) => work({
        getSlot: async () => 10,
        getSignaturesForAddress: async () => [{ signature: "5".repeat(64), slot: 10 }],
        getTransaction: async () => { transactions++; },
      }) } },
      store: {
        getSolanaProgramCursor: () => null,
        commitSolanaProgramRange: (value) => committed.push(value),
      },
      services: { alertReport: async () => { alerts++; } },
    };
    const result = await runSolanaOnce(config, { persist: true });
    assert.equal(result.mode, "recovery");
    assert.equal(transactions, 0);
    assert.equal(alerts, 0);
    assert.equal(committed.length, 1);
  });

  for (const [status, expectedAlerts] of [["confirmed", 1], ["blocked", 1], ["unknown", 0]]) {
    it(`applies the strict live gate to ${status} evidence`, async () => {
      let alerts = 0;
      const venue = { id: "test", programId: PROGRAM, parseTransaction: () => [candidate()] };
      const config = {
        venues: [venue],
        settings: { alertMode: "live", maxAgeMinutes: 30, minScore: 70 },
        rpcContext: { discoverySessions: { run: (work) => work({
          getSlot: async () => 11,
          getSignaturesForAddress: async () => [
            { signature: "6".repeat(64), slot: 11, err: null },
            { signature: "5".repeat(64), slot: 10, err: null },
          ],
          getTransaction: async () => ({ blockTime: 1, transaction: { message: { accountKeys: [], instructions: [] } }, meta: { err: null } }),
        }) } },
        store: {
          getSolanaProgramCursor: () => ({ signature: "5".repeat(64), slot: 10 }),
          hasSeen: () => false,
          markSeen: () => {},
          commitSolanaProgramRange: () => {},
        },
        services: { analyze: async () => report(status, 100), alertReport: async () => { alerts++; } },
      };
      await runSolanaOnce(config, { persist: true });
      assert.equal(alerts, expectedAlerts);
    });
  }

  it("skips an already-seen candidate before analysis", async () => {
    let analyses = 0;
    const venue = { id: "test", programId: PROGRAM, parseTransaction: () => [candidate()] };
    const config = {
      venues: [venue],
      settings: { alertMode: "live", maxAgeMinutes: 30, minScore: 70 },
      rpcContext: { discoverySessions: { run: (work) => work({
        getSlot: async () => 11,
        getSignaturesForAddress: async () => [
          { signature: "6".repeat(64), slot: 11, err: null },
          { signature: "5".repeat(64), slot: 10, err: null },
        ],
        getTransaction: async () => ({ blockTime: 1 }),
      }) } },
      store: {
        getSolanaProgramCursor: () => ({ signature: "5".repeat(64), slot: 10 }),
        hasSeen: () => true,
        markSeen: () => {},
        commitSolanaProgramRange: () => {},
      },
      services: { analyze: async () => { analyses++; return report("confirmed"); }, alertReport: async () => {} },
    };
    await runSolanaOnce(config, { persist: true });
    assert.equal(analyses, 0);
  });
});

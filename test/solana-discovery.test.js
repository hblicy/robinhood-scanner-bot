import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDiscoverySessionRunner } from "../src/discovery-session.js";
import {
  reconcileProgram,
  reconcilePrograms,
  subscribePrograms,
} from "../src/solana/discovery.js";
import { createSolanaRpcContext } from "../src/solana/rpc.js";

const PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

function fakeConnection({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async getSlot() {
      calls.push("slot");
      if (fail) throw Object.assign(new Error("429 rate limited"), { status: 429 });
      return 103;
    },
    async getSignaturesForAddress(_program, options) {
      calls.push(`signatures:${options.before || "head"}`);
      return [
        { signature: "new", slot: 103, err: null },
        { signature: "middle", slot: 102, err: null },
        { signature: "old", slot: 101, err: null },
      ];
    },
    async getTransaction(signature) {
      calls.push(`tx:${signature}`);
      return { signature };
    },
  };
}

describe("Solana discovery", () => {
  it("processes newest-first signature pages oldest-first and stops at the anchor", async () => {
    const connection = fakeConnection();
    const result = await reconcileProgram({
      connection,
      program: { id: "pump", programId: PROGRAM },
      cursor: { signature: "old", slot: 101 },
      parseTransaction: ({ signature }) => [{ signature }],
    });
    assert.deepEqual(result.events.map((event) => event.signature), ["middle", "new"]);
    assert.deepEqual(connection.calls, ["slot", "signatures:head", "tx:middle", "tx:new"]);
    assert.deepEqual(result.newestProcessed, { signature: "new", slot: 103 });
  });

  it("restarts the whole uncommitted reconciliation on fallback", async () => {
    const primary = fakeConnection({ fail: true });
    const fallback = fakeConnection();
    const sessions = createDiscoverySessionRunner({
      primary,
      fallback,
      shouldFallback: () => true,
      cooldownMs: 1_000,
      log: () => {},
    });
    const results = await reconcilePrograms({
      sessions,
      programs: [{ id: "pump", programId: PROGRAM }],
      cursors: {},
      parseTransaction: ({ signature }) => [{ signature }],
    });
    assert.deepEqual(primary.calls, ["slot"]);
    assert.equal(fallback.calls[0], "slot");
    assert.equal(results[0].safeSlot, 103);
  });

  it("advances past failed signatures without fetching their transactions", async () => {
    const connection = fakeConnection();
    connection.getSignaturesForAddress = async () => [
      { signature: "failed", slot: 103, err: { InstructionError: [0, "Custom"] } },
      { signature: "old", slot: 101, err: null },
    ];
    const result = await reconcileProgram({
      connection,
      program: { id: "pump", programId: PROGRAM },
      cursor: { signature: "old", slot: 101 },
      parseTransaction: () => [],
    });
    assert.deepEqual(result.newestProcessed, { signature: "failed", slot: 103 });
    assert.equal(connection.calls.some((call) => call === "tx:failed"), false);
  });

  it("does not advance the cursor when a confirmed transaction is temporarily unavailable", async () => {
    const connection = fakeConnection();
    connection.getTransaction = async () => null;
    await assert.rejects(() => reconcileProgram({
      connection,
      program: { id: "pump", programId: PROGRAM },
      cursor: { signature: "old", slot: 101 },
      parseTransaction: () => [],
    }), /transaction unavailable.*middle/i);
  });

  it("deduplicates WebSocket hints and exposes an unsubscribe function", async () => {
    let listener;
    let removed = null;
    const connection = {
      onLogs(_program, callback) {
        listener = callback;
        return 7;
      },
      async removeOnLogsListener(id) {
        removed = id;
      },
    };
    const hints = [];
    const stop = subscribePrograms({
      connection,
      programs: [{ id: "pump", programId: PROGRAM }],
      onHint: (hint) => hints.push(hint),
    });
    listener({ signature: "same", err: null }, { slot: 10 });
    listener({ signature: "same", err: null }, { slot: 10 });
    assert.equal(hints.length, 1);
    await stop();
    assert.equal(removed, 7);
  });

  it("reuses one read-only connection for identical HTTP endpoints", () => {
    const built = [];
    const context = createSolanaRpcContext({
      rpc: {
        discoveryUrl: "https://rpc.example/",
        analysisUrl: "https://rpc.example",
        wsUrl: "",
        discoveryCups: 40,
        analysisCups: 80,
        cooldownMs: 1_000,
      },
    }, {
      createConnection: (url) => {
        built.push(url);
        return fakeConnection();
      },
    });
    assert.equal(built.length, 1);
    assert.equal(context.analysisConnection, context.discoveryPrimary);
    assert.equal("sendTransaction" in context.analysisConnection, false);
  });
});

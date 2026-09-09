import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFailoverProvider } from "../src/rpc-failover.js";
import { withRetry } from "../src/chain.js";

function provider(name, calls, implementation = async () => name) {
  return {
    async getBlockNumber(...args) {
      calls.push([name, "getBlockNumber", args]);
      return implementation(...args);
    },
  };
}

describe("discovery RPC failover", () => {
  it("uses only the primary while the circuit is closed", async () => {
    const calls = [];
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => 10),
      fallback: provider("analysis", calls, async () => 11),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 10);
    assert.deepEqual(calls.map(([name]) => name), ["official"]);
  });

  it("falls back once and bypasses the primary during cooldown", async () => {
    const calls = [];
    let now = 0;
    const failure = Object.assign(new Error("rate limited"), { status: 429 });
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => { throw failure; }),
      fallback: provider("analysis", calls, async () => 20),
      shouldFallback: (error) => error === failure,
      cooldownMs: 60_000,
      now: () => now,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 20);
    now = 30_000;
    assert.equal(await routed.getBlockNumber(), 20);
    assert.deepEqual(calls.map(([name]) => name), ["official", "analysis", "analysis"]);
  });

  it("probes once after cooldown and restores the primary", async () => {
    const calls = [];
    let now = 0;
    let officialCalls = 0;
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => {
        officialCalls += 1;
        if (officialCalls === 1) throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
        return 30;
      }),
      fallback: provider("analysis", calls, async () => 20),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 20);
    now = 60_000;
    assert.equal(await routed.getBlockNumber(), 30);
    assert.equal(await routed.getBlockNumber(), 30);
    assert.deepEqual(calls.map(([name]) => name), ["official", "analysis", "official", "official"]);
  });

  it("renews cooldown when the half-open probe still fails", async () => {
    const calls = [];
    let now = 0;
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => {
        throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
      }),
      fallback: provider("analysis", calls, async () => 20),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 20);
    now = 60_000;
    assert.equal(await routed.getBlockNumber(), 20);
    now = 90_000;
    assert.equal(await routed.getBlockNumber(), 20);
    assert.deepEqual(calls.map(([name]) => name), [
      "official", "analysis", "official", "analysis", "analysis",
    ]);
  });

  it("allows only one half-open probe", async () => {
    const calls = [];
    let now = 0;
    let resolveProbe;
    let officialCalls = 0;
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => {
        officialCalls += 1;
        if (officialCalls === 1) throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
        return new Promise((resolve) => { resolveProbe = resolve; });
      }),
      fallback: provider("analysis", calls, async () => 20),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: () => {},
    });
    assert.equal(await routed.getBlockNumber(), 20);
    now = 60_000;
    const probe = routed.getBlockNumber();
    const concurrent = routed.getBlockNumber();
    assert.equal(await concurrent, 20);
    resolveProbe(30);
    assert.equal(await probe, 30);
    assert.deepEqual(calls.map(([name]) => name), ["official", "analysis", "official", "analysis"]);
  });

  it("does not fall back for permanent errors", async () => {
    const calls = [];
    const permanent = Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
    const routed = createFailoverProvider({
      primary: provider("official", calls, async () => { throw permanent; }),
      fallback: provider("analysis", calls),
      shouldFallback: () => false,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    await assert.rejects(() => routed.getBlockNumber(), (error) => error === permanent);
    assert.deepEqual(calls.map(([name]) => name), ["official"]);
  });

  it("preserves both errors when primary and fallback fail", async () => {
    const primaryError = new Error("official unavailable");
    const fallbackError = new Error("analysis unavailable");
    const routed = createFailoverProvider({
      primary: provider("official", [], async () => { throw primaryError; }),
      fallback: provider("analysis", [], async () => { throw fallbackError; }),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    await assert.rejects(
      () => routed.getBlockNumber(),
      (error) => error instanceof AggregateError
        && error.errors[0] === primaryError
        && error.errors[1] === fallbackError
    );
  });

  it("preserves the opening primary error across fallback-only retries", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const waits = [];
    const primaryError = Object.assign(new Error("official rate limited"), { status: 429 });
    const fallbackError = new Error("analysis unavailable");
    const routed = createFailoverProvider({
      primary: provider("official", [], async () => {
        primaryCalls += 1;
        throw primaryError;
      }),
      fallback: provider("analysis", [], async () => {
        fallbackCalls += 1;
        throw fallbackError;
      }),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });

    await assert.rejects(
      () => withRetry(() => routed.getBlockNumber(), 3, async (ms) => waits.push(ms)),
      (error) => error instanceof AggregateError
        && error.errors[0] === primaryError
        && error.errors[1] === fallbackError
    );
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 3);
    assert.deepEqual(waits, [1000, 2000]);
  });

  it("logs only state changes and redacts URLs", async () => {
    const logs = [];
    let now = 0;
    let fail = true;
    const routed = createFailoverProvider({
      primary: provider("official", [], async () => {
        if (fail) throw new Error("timeout at https://rpc.example/private-key");
        return 30;
      }),
      fallback: provider("analysis", [], async () => 20),
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: (message) => logs.push(message),
    });
    await routed.getBlockNumber();
    await routed.getBlockNumber();
    now = 60_000;
    fail = false;
    await routed.getBlockNumber();
    assert.equal(logs.length, 2);
    assert.match(logs[0], /熔断|fallback/i);
    assert.match(logs[1], /恢复|recover/i);
    assert.doesNotMatch(logs.join("\n"), /rpc\.example|private-key/);
  });
});

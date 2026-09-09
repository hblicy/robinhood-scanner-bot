import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDiscoverySessionRunner } from "../src/discovery-session.js";

describe("discovery session runner", () => {
  it("pins every read in one successful session to primary", async () => {
    const primary = { name: "official" };
    const fallback = { name: "analysis" };
    const seen = [];
    const sessions = createDiscoverySessionRunner({
      primary,
      fallback,
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    const value = await sessions.run(async (provider) => {
      seen.push(provider.name, provider.name);
      return 102;
    });
    assert.equal(value, 102);
    assert.deepEqual(seen, ["official", "official"]);
  });

  it("restarts the complete callback on fallback", async () => {
    const primary = { name: "official" };
    const fallback = { name: "analysis" };
    const attempts = [];
    const sessions = createDiscoverySessionRunner({
      primary,
      fallback,
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    const value = await sessions.run(async (provider) => {
      attempts.push(provider.name);
      if (provider === primary) {
        throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
      }
      return 98;
    });
    assert.equal(value, 98);
    assert.deepEqual(attempts, ["official", "analysis"]);
  });

  it("does not self-fallback when fallback is absent", async () => {
    const primary = { name: "shared" };
    let calls = 0;
    const sessions = createDiscoverySessionRunner({
      primary,
      fallback: null,
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    await assert.rejects(
      () => sessions.run(async () => {
        calls += 1;
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }),
      /rate limited/
    );
    assert.equal(calls, 1);
  });

  it("uses fallback during cooldown and probes primary once after cooldown", async () => {
    let now = 0;
    let fail = true;
    const calls = [];
    const primary = { name: "official" };
    const fallback = { name: "analysis" };
    const sessions = createDiscoverySessionRunner({
      primary,
      fallback,
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: () => {},
    });
    const work = async (provider) => {
      calls.push(provider.name);
      if (provider === primary && fail) throw new Error("temporary");
      return provider.name;
    };
    assert.equal(await sessions.run(work), "analysis");
    now = 30_000;
    assert.equal(await sessions.run(work), "analysis");
    now = 60_000;
    fail = false;
    assert.equal(await sessions.run(work), "official");
    assert.deepEqual(calls, ["official", "analysis", "analysis", "official"]);
  });

  it("does not fall back for permanent errors", async () => {
    const permanent = Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
    let fallbackCalls = 0;
    const sessions = createDiscoverySessionRunner({
      primary: { name: "official" },
      fallback: { name: "analysis" },
      shouldFallback: () => false,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    await assert.rejects(
      () => sessions.run(async (provider) => {
        if (provider.name === "analysis") fallbackCalls += 1;
        throw permanent;
      }),
      (error) => error === permanent
    );
    assert.equal(fallbackCalls, 0);
  });

  it("preserves both errors when primary and fallback fail", async () => {
    const primaryError = Object.assign(new Error("official timeout"), { code: "TIMEOUT" });
    const fallbackError = new Error("analysis unavailable");
    const sessions = createDiscoverySessionRunner({
      primary: { name: "official" },
      fallback: { name: "analysis" },
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => 0,
      log: () => {},
    });
    await assert.rejects(
      () => sessions.run(async (provider) => {
        if (provider.name === "official") throw primaryError;
        throw fallbackError;
      }),
      (error) => error instanceof AggregateError
        && error.errors[0] === primaryError
        && error.errors[1] === fallbackError
    );
  });

  it("logs only state changes and redacts endpoint secrets", async () => {
    let now = 0;
    let fail = true;
    const logs = [];
    const primary = { name: "official" };
    const sessions = createDiscoverySessionRunner({
      primary,
      fallback: { name: "analysis" },
      shouldFallback: () => true,
      cooldownMs: 60_000,
      now: () => now,
      log: (message) => logs.push(message),
    });
    const work = async (provider) => {
      if (provider === primary && fail) {
        throw new Error("timeout at https://rpc.example/private-key");
      }
      return provider.name;
    };
    await sessions.run(work);
    await sessions.run(work);
    now = 60_000;
    fail = false;
    await sessions.run(work);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /熔断/);
    assert.match(logs[1], /恢复/);
    assert.doesNotMatch(logs.join("\n"), /rpc\.example|private-key/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AnalysisRpcCooldownError,
  bindAnalysisCircuit,
  createAnalysisRpcCircuit,
} from "../src/analysis-rpc-circuit.js";

describe("analysis RPC circuit", () => {
  it("opens on 429, skips during cooldown, and notifies once until recovery", async () => {
    let now = 1_000;
    let notices = 0;
    let calls = 0;
    const circuit = createAnalysisRpcCircuit({ now: () => now, cooldownMs: 10_000 });
    const limited = Object.assign(new Error("Too Many Requests"), { status: 429 });

    await assert.rejects(
      () => circuit.run(async () => { calls += 1; throw limited; }, {
        onOpen: async () => { notices += 1; },
      }),
      (error) => error === limited
    );
    assert.equal(notices, 1);
    assert.deepEqual(await circuit.run(async () => { calls += 1; }), { status: "cooldown" });
    assert.equal(calls, 1);

    now = 11_000;
    await assert.rejects(
      () => circuit.run(async () => { calls += 1; throw limited; }, {
        onOpen: async () => { notices += 1; },
      }),
      (error) => error === limited
    );
    assert.equal(notices, 1);

    now = 21_000;
    assert.deepEqual(await circuit.run(async () => { calls += 1; return "ok"; }), {
      status: "ok",
      value: "ok",
    });
    await assert.rejects(
      () => circuit.run(async () => { calls += 1; throw limited; }, {
        onOpen: async () => { notices += 1; },
      }),
      (error) => error === limited
    );
    assert.equal(notices, 2);
  });

  it("allows only one probe after cooldown", async () => {
    let now = 0;
    const circuit = createAnalysisRpcCircuit({ now: () => now, cooldownMs: 10 });
    await assert.rejects(
      () => circuit.run(async () => { throw Object.assign(new Error("429"), { status: 429 }); }),
      /429/
    );
    now = 10;
    let release;
    const probe = circuit.run(() => new Promise((resolve) => { release = resolve; }));
    assert.deepEqual(await circuit.run(async () => "must-not-run"), { status: "cooldown" });
    release("recovered");
    assert.deepEqual(await probe, { status: "ok", value: "recovered" });
  });

  it("does not open for non-rate-limit failures", async () => {
    const circuit = createAnalysisRpcCircuit();
    const failure = new TypeError("programming error");
    await assert.rejects(() => circuit.run(async () => { throw failure; }), (error) => error === failure);
    assert.deepEqual(await circuit.run(async () => 1), { status: "ok", value: 1 });
  });

  it("does not mistake a DexScreener 429 for an analysis RPC limit", async () => {
    const circuit = createAnalysisRpcCircuit();
    const externalLimit = Object.assign(new Error("DexScreener unavailable"), {
      code: "RETRYABLE_ANALYSIS",
      source: "DexScreener pool",
      cause: Object.assign(new Error("HTTP 429"), { status: 429 }),
    });
    await assert.rejects(() => circuit.run(async () => { throw externalLimit; }), (error) => error === externalLimit);
    assert.deepEqual(await circuit.run(async () => 1), { status: "ok", value: 1 });
  });

  it("exposes a typed local cooldown without calling analysis", async () => {
    let calls = 0;
    const circuit = createAnalysisRpcCircuit({ cooldownMs: 10_000 });
    const analyze = bindAnalysisCircuit({
      circuit,
      analyze: async () => {
        calls += 1;
        throw Object.assign(new Error("limited"), { status: 429 });
      },
    });
    await assert.rejects(() => analyze({}), /limited/);
    await assert.rejects(() => analyze({}), (error) => error instanceof AnalysisRpcCooldownError);
    assert.equal(calls, 1);
  });
});

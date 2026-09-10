import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRpcUsageBudget, intervalForRpcBudget } from "../src/rpc-usage-budget.js";

const NOW = Date.parse("2026-09-10T00:00:00Z");

describe("monthly RPC usage budget", () => {
  it("persists calls by method and enters configured degradation stages", () => {
    const persisted = [];
    const budget = createRpcUsageBudget({
      limit: 100,
      initial: { month: "2026-09", total: 79, methods: {} },
      persist: (state) => persisted.push(state),
      now: () => NOW,
    });
    budget.record("eth_getLogs");
    assert.equal(budget.snapshot().stage, "throttled");
    for (let index = 0; index < 15; index += 1) budget.record("eth_call");
    assert.equal(budget.snapshot().stage, "critical");
    for (let index = 0; index < 5; index += 1) budget.record("eth_call");
    assert.equal(budget.snapshot().stage, "exhausted");
    assert.throws(() => budget.assertAllowed("analysis"), /rpc-budget-exhausted/);
    assert.doesNotThrow(() => budget.assertAllowed("discovery-public"));
    assert.equal(budget.flush(), true);
    assert.equal(budget.flush(), false);
    assert.equal(persisted[0].methods.eth_getLogs, 1);
    assert.equal(persisted[0].methods.eth_call, 20);
  });

  it("starts a new counter when the UTC billing month changes", () => {
    const budget = createRpcUsageBudget({
      limit: 100,
      initial: { month: "2026-08", total: 100, methods: { eth_call: 100 } },
      now: () => NOW,
    });
    assert.equal(budget.snapshot().month, "2026-09");
    assert.equal(budget.snapshot().total, 0);
    assert.deepEqual(budget.snapshot().methods, {});
  });

  it("rotates the counter while a watch process remains alive across a UTC month", () => {
    let clock = NOW;
    const budget = createRpcUsageBudget({
      limit: 100,
      initial: { month: "2026-09", total: 99, methods: { eth_call: 99 } },
      now: () => clock,
    });
    assert.equal(budget.snapshot().stage, "critical");
    clock = Date.parse("2026-10-01T00:00:01Z");
    assert.equal(budget.snapshot().month, "2026-10");
    assert.equal(budget.snapshot().total, 0);
    assert.doesNotThrow(() => budget.assertAllowed("analysis"));
    budget.record("eth_getLogs");
    assert.equal(budget.snapshot().methods.eth_getLogs, 1);
  });

  it("restores a same-month snapshot and rejects invalid limits", () => {
    const budget = createRpcUsageBudget({
      limit: 100,
      initial: { month: "2026-09", total: 12, methods: { eth_call: 12 } },
      now: () => NOW,
    });
    assert.equal(budget.snapshot().total, 12);
    assert.throws(() => createRpcUsageBudget({ limit: 0 }), /limit/);
  });

  it("slows supplemental market polling after the throttled threshold", () => {
    assert.equal(intervalForRpcBudget(15_000, null), 15_000);
    assert.equal(intervalForRpcBudget(15_000, { snapshot: () => ({ stage: "normal" }) }), 15_000);
    assert.equal(intervalForRpcBudget(15_000, { snapshot: () => ({ stage: "throttled" }) }), 30_000);
    assert.equal(intervalForRpcBudget(15_000, { snapshot: () => ({ stage: "critical" }) }), 30_000);
  });
});

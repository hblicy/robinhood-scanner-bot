import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRpcUsageBudget } from "../src/rpc-usage-budget.js";

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

  it("restores a same-month snapshot and rejects invalid limits", () => {
    const budget = createRpcUsageBudget({
      limit: 100,
      initial: { month: "2026-09", total: 12, methods: { eth_call: 12 } },
      now: () => NOW,
    });
    assert.equal(budget.snapshot().total, 12);
    assert.throws(() => createRpcUsageBudget({ limit: 0 }), /limit/);
  });
});

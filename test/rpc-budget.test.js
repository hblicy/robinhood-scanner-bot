import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createBudgetedProvider,
  createRpcScheduler,
  RPC_CU,
} from "../src/rpc-budget.js";

describe("RPC CU scheduling", () => {
  it("reserves non-overlapping start times for concurrent work", async () => {
    const waits = [];
    let now = 0;
    const schedule = createRpcScheduler({
      cuPerSecond: 100,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });

    const result = await Promise.all([
      schedule(20, async () => "a"),
      schedule(20, async () => "b"),
      schedule(20, async () => "c"),
    ]);

    assert.deepEqual(result, ["a", "b", "c"]);
    assert.deepEqual(waits, [200, 200]);
  });

  it("charges the documented costs while preserving provider results", async () => {
    const charged = [];
    const provider = {
      async getLogs(request) { return [request]; },
      async call(request) { return request.data; },
    };
    const budgeted = createBudgetedProvider(provider, async (cost, operation) => {
      charged.push(cost);
      return operation();
    });

    assert.deepEqual(await budgeted.getLogs({ fromBlock: 1, toBlock: 1 }), [{ fromBlock: 1, toBlock: 1 }]);
    assert.equal(await budgeted.call({ data: "0x1234" }), "0x1234");
    assert.deepEqual(charged, [RPC_CU.getLogs, RPC_CU.call]);
  });

  it("propagates the original provider error", async () => {
    const failure = new Error("RPC unavailable");
    const budgeted = createBudgetedProvider({
      async getLogs() { throw failure; },
    }, async (_cost, operation) => operation());

    await assert.rejects(() => budgeted.getLogs({}), (error) => error === failure);
  });
});

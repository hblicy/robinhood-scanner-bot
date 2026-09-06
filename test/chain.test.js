import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachBlockTimes } from "../src/chain.js";

describe("attachBlockTimes", () => {
  it("uses event block timestamps and caches duplicate block lookups", async () => {
    let calls = 0;
    const events = [
      { blockNumber: 10, createdAt: null },
      { blockNumber: 10, createdAt: null },
      { blockNumber: 11, createdAt: null },
    ];
    const result = await attachBlockTimes(events, {
      getBlock: async (number) => {
        calls += 1;
        return { timestamp: number === 10 ? 123 : 124 };
      },
    });
    assert.equal(result[0].createdAt, 123000);
    assert.equal(result[1].createdAt, 123000);
    assert.equal(result[2].createdAt, 124000);
    assert.equal(calls, 2);
  });

  it("keeps age unknown when a block timestamp is unavailable", async () => {
    const result = await attachBlockTimes([{ blockNumber: 10, createdAt: null }], {
      getBlock: async () => null,
    });
    assert.equal(result[0].createdAt, null);
  });
});

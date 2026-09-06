import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { V4_PM_ABI } from "../src/abis.js";
import { attachBlockTimes, getLogsChunked, parseV4PoolLog } from "../src/chain.js";

describe("getLogsChunked", () => {
  it("does not truncate logs at queue capacity", async () => {
    const provider = {
      getLogs: async ({ fromBlock }) => [
        { blockNumber: fromBlock, transactionHash: `0x${String(fromBlock).padStart(64, "0")}` },
      ],
    };
    const logs = await getLogsChunked({
      address: "0x1111111111111111111111111111111111111111",
      topics: [],
      fromBlock: 1,
      toBlock: 4,
      chunk: 1,
      limit: 2,
      provider,
    });
    assert.equal(logs.length, 4);
  });
});

describe("V4 pool discovery", () => {
  it("keeps the pool id separate from the address-valued pool field", () => {
    const iface = new Interface(V4_PM_ABI);
    const poolId = `0x${"ab".repeat(32)}`;
    const encoded = iface.encodeEventLog(iface.getEvent("Initialize"), [
      poolId,
      "0x0000000000000000000000000000000000000000",
      "0x1111111111111111111111111111111111111111",
      3000,
      60,
      "0x0000000000000000000000000000000000000000",
      1n,
      0,
    ]);
    const parsed = parseV4PoolLog({
      ...encoded,
      blockNumber: 10,
      transactionHash: `0x${"01".repeat(32)}`,
    });
    assert.equal(parsed.pool, null);
    assert.equal(parsed.poolId, poolId);
  });
});

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

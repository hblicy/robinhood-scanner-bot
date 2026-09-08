import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { PAIR_V2_ABI, V4_PM_ABI } from "../src/abis.js";
import { ADDR } from "../src/config.js";
import {
  attachBlockTimes,
  bytecodeFlags,
  findFirstBlockAtOrAfter,
  getLogsChunked,
  isRateLimitError,
  readOwnerFromContract,
  readV2PoolFromContract,
  parseV4PoolLog,
  scanOnchain,
  withRetry,
} from "../src/chain.js";

describe("withRetry backoff", () => {
  it("uses one- and two-second backoff for nested rate limits", async () => {
    const waits = [];
    const limited = Object.assign(new Error("request failed"), {
      error: { status: 429, message: "too many requests" },
    });
    await assert.rejects(
      () => withRetry(async () => { throw limited; }, 3, async (ms) => waits.push(ms)),
      (error) => error === limited
    );
    assert.deepEqual(waits, [1000, 2000]);
  });

  it("uses rate-limit backoff for a numeric JSON-RPC code 429", async () => {
    const waits = [];
    const limited = Object.assign(new Error("request failed"), {
      error: { code: 429, message: "request failed" },
    });
    await assert.rejects(
      () => withRetry(async () => { throw limited; }, 3, async (ms) => waits.push(ms)),
      (error) => error === limited
    );
    assert.deepEqual(waits, [1000, 2000]);
  });

  it("keeps short backoff for ordinary failures", async () => {
    const waits = [];
    const failure = new Error("temporary RPC failure");
    await assert.rejects(
      () => withRetry(async () => { throw failure; }, 3, async (ms) => waits.push(ms)),
      (error) => error === failure
    );
    assert.deepEqual(waits, [400, 800]);
  });

  it("recognizes common provider throughput messages", () => {
    for (const message of [
      "rate limit exceeded",
      "too many requests",
      "compute units exceeded",
      "throughput limit exceeded",
    ]) {
      assert.equal(isRateLimitError(new Error(message)), true, message);
    }
    assert.equal(isRateLimitError(new Error("execution reverted")), false);
  });
});

describe("bytecodeFlags", () => {
  it("reads token code at the supplied fixed block", async () => {
    const calls = [];
    const provider = {
      async getCode(...args) {
        calls.push(args);
        return "0x1234";
      },
    };
    const result = await bytecodeFlags("0x1111111111111111111111111111111111111111", {
      provider,
      blockTag: 77,
    });
    assert.equal(result.hasCode, true);
    assert.deepEqual(calls, [["0x1111111111111111111111111111111111111111", 77]]);
  });
});

describe("findFirstBlockAtOrAfter", () => {
  it("finds the first block inside the age window with logarithmic lookups", async () => {
    let calls = 0;
    const block = await findFirstBlockAtOrAfter(1550_000, 100, {
      getBlock: async (number) => {
        calls += 1;
        return { timestamp: 1000 + number * 10 };
      },
    });

    assert.equal(block, 55);
    assert.ok(calls <= 7, `expected at most 7 lookups, got ${calls}`);
  });

  it("fails when a block timestamp cannot be read", async () => {
    await assert.rejects(
      () => findFirstBlockAtOrAfter(1000, 10, { getBlock: async () => null }),
      /timestamp.*block/i
    );
  });

  it("retries a transient block lookup", async () => {
    const attempts = new Map();
    const block = await findFirstBlockAtOrAfter(1050_000, 10, {
      getBlock: async (number) => {
        const count = (attempts.get(number) || 0) + 1;
        attempts.set(number, count);
        if (number === 5 && count === 1) throw new Error("temporary RPC failure");
        return { timestamp: 1000 + number * 10 };
      },
    }, (fn) => withRetry(fn, 3, async () => {}));
    assert.equal(block, 5);
    assert.equal(attempts.get(5), 2);
  });
});

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

  it("uses Alchemy Free-compatible ten-block default chunks", async () => {
    const ranges = [];
    await getLogsChunked({
      address: ADDR.V2_FACTORY,
      topics: [],
      fromBlock: 1,
      toBlock: 23,
      provider: {
        getLogs: async ({ fromBlock, toBlock }) => {
          ranges.push([fromBlock, toBlock]);
          return [];
        },
      },
    });
    assert.deepEqual(ranges, [[1, 10], [11, 20], [21, 23]]);
  });

  it("splits a rejected large range without losing blocks", async () => {
    const logs = await getLogsChunked({
      address: ADDR.V2_FACTORY,
      topics: [],
      fromBlock: 1,
      toBlock: 2000,
      provider: {
        getLogs: async ({ fromBlock, toBlock }) => {
          if (toBlock - fromBlock + 1 > 1000) throw new Error("range too large");
          return Array.from({ length: toBlock - fromBlock + 1 }, (_, i) => ({ blockNumber: fromBlock + i }));
        },
      },
      retry: async (fn) => fn(),
    });
    assert.equal(logs.length, 2000);
    assert.equal(new Set(logs.map(({ blockNumber }) => blockNumber)).size, 2000);
  });

  it("splits provider range errors below forty blocks", async () => {
    const ranges = [];
    const logs = await getLogsChunked({
      address: ADDR.V2_FACTORY,
      topics: [],
      fromBlock: 1,
      toBlock: 12,
      chunk: 12,
      provider: {
        getLogs: async ({ fromBlock, toBlock }) => {
          ranges.push([fromBlock, toBlock]);
          if (toBlock > fromBlock) throw new Error("range too large");
          return [{ blockNumber: fromBlock }];
        },
      },
      retry: async (fn) => fn(),
    });
    assert.equal(logs.length, 12);
    assert.equal(new Set(logs.map(({ blockNumber }) => blockNumber)).size, 12);
    assert.ok(ranges.some(([fromBlock, toBlock]) => fromBlock === toBlock));
  });

  it("enforces one maxLogs budget across ordinary chunks", async () => {
    await assert.rejects(
      () => getLogsChunked({
        address: ADDR.V2_FACTORY,
        topics: [],
        fromBlock: 1,
        toBlock: 3,
        chunk: 1,
        maxLogs: 2,
        provider: {
          getLogs: async ({ fromBlock }) => [{ blockNumber: fromBlock }],
        },
      }),
      /log budget exceeded: max 2/
    );
  });

  it("passes only the remaining maxLogs budget into a split range", async () => {
    await assert.rejects(
      () => getLogsChunked({
        address: ADDR.V2_FACTORY,
        topics: [],
        fromBlock: 1,
        toBlock: 80,
        chunk: 80,
        maxLogs: 3,
        provider: {
          getLogs: async ({ fromBlock, toBlock }) => {
            if (toBlock - fromBlock + 1 > 40) throw new Error("range too large");
            return [{ blockNumber: fromBlock }, { blockNumber: toBlock }];
          },
        },
        retry: async (fn) => fn(),
      }),
      /log budget exceeded: max 1/
    );
  });

  it("does not split a permanent authorization failure", async () => {
    let calls = 0;
    const denied = Object.assign(new Error("HTTP 403 forbidden"), { status: 403 });
    await assert.rejects(
      () => getLogsChunked({
        address: ADDR.V2_FACTORY,
        topics: [],
        fromBlock: 1,
        toBlock: 2000,
        provider: {
          getLogs: async () => { calls += 1; throw denied; },
        },
        retry: (fn) => withRetry(fn, 3, async () => {}),
      }),
      (error) => error === denied
    );
    assert.equal(calls, 3);
  });
});

describe("V2 pair ABI", () => {
  it("exposes the standard Swap event", () => {
    const event = new Interface(PAIR_V2_ABI).getEvent("Swap");
    assert.equal(event.format("sighash"), "Swap(address,uint256,uint256,uint256,uint256,address)");
  });
});

describe("optional contract reads", () => {
  it("propagates transport errors while probing owner methods", async () => {
    const unavailable = Object.assign(new Error("rpc offline"), { code: "NETWORK_ERROR" });
    await assert.rejects(
      () => readOwnerFromContract({ owner: async () => { throw unavailable; } }),
      (error) => error === unavailable
    );
  });

  it("does not treat a nested rate limit as a contract revert", async () => {
    const rateLimit = Object.assign(new Error("request failed"), {
      code: "CALL_EXCEPTION",
      error: { status: 429, message: "too many requests" },
    });
    await assert.rejects(
      () => readOwnerFromContract({ owner: async () => { throw rateLimit; } }),
      (error) => error === rateLimit
    );
  });

  it("propagates LP balance lookup failures", async () => {
    const unavailable = Object.assign(new Error("rpc offline"), { code: "NETWORK_ERROR" });
    const contract = {
      token0: async () => "0x1111111111111111111111111111111111111111",
      token1: async () => "0x2222222222222222222222222222222222222222",
      getReserves: async () => [1n, 1n],
      totalSupply: async () => 2n,
      balanceOf: async () => { throw unavailable; },
    };
    await assert.rejects(
      () => readV2PoolFromContract(contract),
      (error) => error === unavailable
    );
  });
});

describe("scanOnchain parsing", () => {
  for (const [venue, address] of [
    ["uniswap-v2", ADDR.V2_FACTORY],
    ["uniswap-v3", ADDR.V3_FACTORY],
    ["uniswap-v4", ADDR.V4_POOL_MANAGER],
  ]) {
    it(`fails the range for a malformed ${venue} factory log`, async () => {
      const malformed = {
        topics: ["0xdeadbeef"],
        data: "0x",
        blockNumber: 123,
        transactionHash: `0x${"01".repeat(32)}`,
      };
      await assert.rejects(
        () => scanOnchain(100, 123, {
          getLogs: async ({ address: requested }) => requested === address ? [malformed] : [],
          attachTimes: async (events) => events,
        }),
        new RegExp(`${venue}.*123.*${"01".repeat(4)}`, "i")
      );
    });
  }
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

  it("fails when an event block timestamp is unavailable", async () => {
    await assert.rejects(
      () => attachBlockTimes([{ blockNumber: 10, createdAt: null }], {
        getBlock: async () => null,
      }, async (fn) => fn()),
      /timestamp.*block 10/i
    );
  });
});

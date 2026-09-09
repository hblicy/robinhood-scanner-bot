import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runEvmRangeOnce, watchEvm } from "../src/evm/runner.js";

const candidate = {
  chain: "base",
  chainFamily: "evm",
  venue: "uniswap-v3-base",
  sourceKind: "dex",
  token: "0x1111111111111111111111111111111111111111",
  quoteToken: "0x2222222222222222222222222222222222222222",
  pool: "0x3333333333333333333333333333333333333333",
  poolId: null,
  creator: null,
  blockOrSlot: 100,
  transactionId: `0x${"a".repeat(64)}`,
  eventIndex: 1,
  createdAt: 1_000,
  lifecyclePhase: "new_pool",
  sourceProvenance: "uniswap-v3-base@1",
  metadata: {},
};

function setup(overrides = {}) {
  let cursor = overrides.cursor ?? null;
  const seen = new Set();
  const alerts = [];
  const store = {
    getOnchainCursor: () => cursor,
    setOnchainCursor: (value) => { cursor = value; },
    hasSeen: (key) => seen.has(key),
    markSeen: (key) => { seen.add(key); },
  };
  const config = {
    profile: { key: "base", name: "Base", id: 8453, confirmations: 2, venues: [] },
    settings: { minScore: 70, confirmationBlocks: 2, alertMode: "live" },
    store,
    venues: [],
    rpcContext: {
      analysisProvider: { role: "analysis" },
      discoverySessions: { run: async (work) => work({ role: "discovery" }) },
    },
  };
  const dependencies = {
    now: () => 2_000,
    getBlockNumber: async () => 102,
    findFirstBlockAtOrAfter: async () => 90,
    scanRange: async () => [candidate],
    analyze: async (event) => ({
      ...event,
      chainName: "Base",
      meta: { symbol: "TOKEN" },
      score: 75,
      verdict: "review",
      red: [],
      honeypot: { honeypot: false },
      sellability: {
        status: "confirmed",
        reason: null,
        buyerSamples: 1,
        ladderSamples: 1,
        meaningfulSellers: 3,
      },
    }),
    alertReport: async (report) => alerts.push(report.token),
    log: () => {},
    ...overrides.dependencies,
  };
  return { config, dependencies, alerts, seen, cursor: () => cursor };
}

describe("generic EVM range runner", () => {
  it("restores an empty chain cursor silently on the first backfill", async () => {
    const value = setup();
    const result = await runEvmRangeOnce(value.config, { persist: true }, value.dependencies);

    assert.equal(result.mode, "recovery");
    assert.equal(value.cursor(), 100);
    assert.equal(value.alerts.length, 0);
    assert.equal(value.seen.size, 1);
  });

  it("alerts a confirmed candidate only after recovery has a committed cursor", async () => {
    let boundaryReads = 0;
    const value = setup({
      cursor: 99,
      dependencies: {
        findFirstBlockAtOrAfter: async () => {
          boundaryReads++;
          return 90;
        },
      },
    });
    const result = await runEvmRangeOnce(value.config, { persist: true }, value.dependencies);

    assert.equal(result.mode, "live");
    assert.equal(value.cursor(), 100);
    assert.deepEqual(value.alerts, [candidate.token]);
    assert.equal(boundaryReads, 0);
  });

  it("does not advance the cursor when candidate analysis fails", async () => {
    const value = setup({
      cursor: 99,
      dependencies: { analyze: async () => { throw new Error("analysis failed"); } },
    });

    await assert.rejects(
      runEvmRangeOnce(value.config, { persist: true }, value.dependencies),
      /analysis failed/
    );
    assert.equal(value.cursor(), 99);
  });

  it("keeps a one-shot scan read-only", async () => {
    const value = setup({ cursor: 99 });
    await runEvmRangeOnce(value.config, { persist: false }, value.dependencies);
    assert.equal(value.cursor(), 99);
    assert.equal(value.seen.size, 0);
    assert.deepEqual(value.alerts, [candidate.token]);
  });

  it("retries a recoverable discovery failure without exiting the watcher", async () => {
    const value = setup({ cursor: 99 });
    let runs = 0;
    let released = 0;
    const stop = new Error("stop-test");
    value.dependencies.getBlockNumber = async () => {
      runs++;
      if (runs === 1) throw Object.assign(new Error("429 rate limited https://secret.example/key"), { status: 429 });
      return 102;
    };
    value.dependencies.acquireLock = async () => async () => { released++; };
    let sleeps = 0;
    value.dependencies.sleep = async () => {
      sleeps++;
      if (sleeps === 2) throw stop;
    };
    const logs = [];
    value.dependencies.log = (message) => logs.push(message);

    await assert.rejects(() => watchEvm(value.config, value.dependencies), (error) => error === stop);
    assert.equal(runs, 2);
    assert.equal(released, 1);
    assert.match(logs[0], /discovery retry/i);
    assert.doesNotMatch(logs[0], /secret\.example/);
  });
});

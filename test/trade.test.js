import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  confirmExit,
  confirmPaperExit,
  createSingleFlightTick,
  executeLiveBuy,
  exitPosition,
  reconcilePendingBuy,
  validateLiveReport,
  verifyRouterBinding,
} from "../src/trade.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const POOL = "0x3333333333333333333333333333333333333333";
const WALLET = "0x5555555555555555555555555555555555555555";

function report(overrides = {}) {
  return {
    token: TOKEN,
    quote: WETH,
    path: [WETH, TOKEN],
    pool: POOL,
    venue: "uniswap-v2",
    verdict: "green",
    tradeReady: true,
    marketBound: true,
    meta: { symbol: "SAFE" },
    facts: { mcapUsd: 1000 },
    dex: { priceUsd: 1, pairAddress: POOL, quoteAddress: WETH },
    ...overrides,
  };
}

function sequence(values) {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

describe("live trade safety", () => {
  it("rejects incomplete, unbound or non-WETH live reports", () => {
    assert.throws(() => validateLiveReport(report({ tradeReady: false })), /security checks are incomplete/);
    assert.throws(() => validateLiveReport(report({ marketBound: false })), /market is not bound/);
    assert.throws(
      () => validateLiveReport(report({ dex: { pairAddress: TOKEN, quoteAddress: WETH } })),
      /DexScreener pair/
    );
    assert.throws(
      () => validateLiveReport(report({ quote: TOKEN, path: [TOKEN, WETH] })),
      /WETH quoted/
    );
  });

  it("stores the balance delta and uses a non-zero buy minimum", async () => {
    const saved = [];
    let prepareArgs;
    const deps = {
      liveAllowed: () => true,
      amountIn: 10n,
      slippageBps: 1200,
      gasLimit: 450000,
      now: () => 1000,
      wallet: { address: WALLET },
      token: { balanceOf: sequence([10n, 110n]) },
      router: {
        WETH: async () => WETH,
        factory: async () => "0x7777777777777777777777777777777777777777",
        getAmountsOut: async () => [10n, 1000n],
      },
      factory: { getPair: async () => POOL },
      expectedFactory: "0x7777777777777777777777777777777777777777",
      listPositions: () => [],
      prepareBuy: async (...args) => {
        prepareArgs = args;
        return {
          hash: "0xbuy",
          broadcast: async () => {
            assert.equal(saved.at(-1).pending.txHash, "0xbuy");
            return { hash: "0xbuy", wait: async () => ({ hash: "0xbuy", status: 1 }) };
          },
        };
      },
      upsertPosition: (p) => {
        saved.push(structuredClone(p));
        return p;
      },
      addTrade: () => {},
      notify: async () => {},
    };
    const position = await executeLiveBuy(report(), deps);
    assert.equal(position.initialTokenAmount, "100");
    assert.equal(position.remainingTokenAmount, "100");
    assert.equal(position.state, "open");
    assert.equal(prepareArgs[0], 880n);
    assert.ok(saved.some((p) => p.state === "buy_pending"));
  });

  it("verifies the fixed router resolves to the scored event pool", async () => {
    await assert.rejects(
      () => verifyRouterBinding(report(), {
        router: {
          WETH: async () => WETH,
          factory: async () => "0x7777777777777777777777777777777777777777",
        },
        expectedFactory: "0x7777777777777777777777777777777777777777",
        factory: { getPair: async () => TOKEN },
      }),
      /Router pair does not match/
    );
  });

  it("does not overwrite an existing active position for the same token", async () => {
    await assert.rejects(
      () => executeLiveBuy(report(), {
        liveAllowed: () => true,
        listPositions: () => [{ token: TOKEN, state: "open" }],
      }),
      /active position already exists/
    );
  });

  it("does not mutate or persist a live position when the gate is off", async () => {
    const position = {
      token: TOKEN,
      mode: "live",
      schemaVersion: 2,
      state: "open",
      initialTokenAmount: "100",
      remainingTokenAmount: "100",
    };
    const before = structuredClone(position);
    let writes = 0;
    await assert.rejects(
      () => exitPosition(position, { sellPct: 100, stage: "sl", reason: "stop", price: 0.5 }, {
        liveAllowed: () => false,
        upsertPosition: () => { writes += 1; },
      }),
      /live trading gate is off/
    );
    assert.deepEqual(position, before);
    assert.equal(writes, 0);
  });

  it("checks the live gate before constructing wallet dependencies", async () => {
    const position = {
      token: TOKEN,
      mode: "live",
      schemaVersion: 2,
      state: "open",
      initialTokenAmount: "100",
      remainingTokenAmount: "100",
    };
    await assert.rejects(
      () => exitPosition(position, { sellPct: 100, stage: "sl", reason: "stop", price: 0.5 }),
      /live trading gate is off/
    );
  });

  it("sells an absolute share of the initial position and confirms atomically", async () => {
    const writes = [];
    let approved;
    let sold;
    const position = {
      token: TOKEN,
      symbol: "SAFE",
      quote: WETH,
      path: [WETH, TOKEN],
      pool: POOL,
      venue: "uniswap-v2",
      mode: "live",
      schemaVersion: 2,
      state: "open",
      initialTokenAmount: "100",
      remainingTokenAmount: "70",
      tp1Done: true,
      tp2Done: false,
    };
    const deps = {
      liveAllowed: () => true,
      slippageBps: 1200,
      gasLimit: 450000,
      now: () => 2000,
      wallet: { address: WALLET },
      token: {
        balanceOf: sequence([70n, 40n]),
        allowance: async () => 0n,
        approve: async (_router, amount) => {
          approved = amount;
          return { wait: async () => ({ status: 1 }) };
        },
      },
      routerAddress: "0x6666666666666666666666666666666666666666",
      router: {
        getAmountsOut: async () => [30n, 1000n],
      },
      prepareSell: async (amount, minOut) => {
        sold = { amount, minOut };
        return {
          hash: "0xsell",
          broadcast: async () => {
            assert.equal(writes.at(-1).pending.txHash, "0xsell");
            return { hash: "0xsell", wait: async () => ({ hash: "0xsell", status: 1 }) };
          },
        };
      },
      upsertPosition: (p) => { writes.push(structuredClone(p)); return p; },
      removePosition: () => {},
      addTrade: () => {},
      notify: async () => {},
    };
    const updated = await exitPosition(position, {
      sellPct: 30,
      stage: "tp2",
      reason: "take profit",
      price: 2,
    }, deps);
    assert.equal(approved, 30n);
    assert.deepEqual(sold, { amount: 30n, minOut: 880n });
    assert.equal(updated.remainingTokenAmount, "40");
    assert.equal(updated.tp2Done, true);
    assert.equal(updated.state, "open");
    assert.ok(writes.some((p) => p.state === "exit_pending"));
  });

  it("persists the TP flag in the confirmed transition", () => {
    const updated = confirmExit(
      { state: "exit_pending", initialTokenAmount: "100", remainingTokenAmount: "70", tp1Done: false },
      { stage: "tp1", soldAmount: 30n }
    );
    assert.equal(updated.tp1Done, true);
    assert.equal(updated.remainingTokenAmount, "40");
    assert.equal(updated.state, "open");
  });

  it("recovers a confirmed pending buy into an open tracked position", async () => {
    const writes = [];
    const pending = {
      schemaVersion: 2,
      state: "buy_pending",
      token: TOKEN,
      wallet: WALLET,
      initialTokenAmount: undefined,
      pending: { txHash: "0xbuy", balanceBefore: "10" },
    };
    const updated = await reconcilePendingBuy(pending, {
      provider: { getTransactionReceipt: async () => ({ status: 1, hash: "0xbuy" }) },
      token: { balanceOf: async () => 110n },
      upsertPosition: (p) => { writes.push(p); return p; },
      addTrade: () => {},
    });
    assert.equal(updated.state, "open");
    assert.equal(updated.initialTokenAmount, "100");
    assert.equal(updated.remainingTokenAmount, "100");
    assert.equal(writes.at(-1).state, "open");
  });

  it("keeps paper exits on percentage accounting without live dependencies", () => {
    const updated = confirmPaperExit(
      { state: "open", remainingPct: 70, tp1Done: true, tp2Done: false },
      { sellPct: 30, stage: "tp2" }
    );
    assert.equal(updated.remainingPct, 40);
    assert.equal(updated.tp2Done, true);
    assert.equal(updated.state, "open");
  });

  it("coalesces overlapping position ticks", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let release;
    const blocker = new Promise((resolve) => { release = resolve; });
    const run = createSingleFlightTick(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await blocker;
      concurrent -= 1;
    });
    const first = run();
    const second = run();
    assert.equal(await second, false);
    release();
    assert.equal(await first, true);
    assert.equal(maxConcurrent, 1);
  });
});

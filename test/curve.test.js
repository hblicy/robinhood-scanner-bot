import test from "node:test";
import assert from "node:assert/strict";
import { Interface, getAddress, zeroPadValue } from "ethers";
import { PONS_CURVE_ABI, PONS_FACTORY_ABI } from "../src/abis.js";
import { ADDR } from "../src/config.js";
import {
  countDeployerLaunches24h,
  hydrateTraderAddresses,
  loadCurveTrades,
  summarizeCurveFlow,
} from "../src/curve.js";

const curveIface = new Interface(PONS_CURVE_ABI);
const factoryIface = new Interface(PONS_FACTORY_ABI);
const CURVE = getAddress("0x2222222222222222222222222222222222222222");
const USER_A = getAddress("0x1111111111111111111111111111111111111111");
const USER_B = getAddress("0x3333333333333333333333333333333333333333");
const USER_C = getAddress("0x4444444444444444444444444444444444444444");
const DEPLOYER = getAddress("0x5555555555555555555555555555555555555555");

function log(name, actor, recipient, index = 0) {
  const values = name === "CurveBuy"
    ? [actor, recipient, 10n, 20n, 1n, 0n]
    : [actor, recipient, 20n, 9n, 1n, 0n];
  const encoded = curveIface.encodeEventLog(curveIface.getEvent(name), values);
  return {
    address: CURVE,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 100 + index,
    transactionIndex: 0,
    index,
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
  };
}

function trade(direction, trader, index, overrides = {}) {
  return {
    direction,
    trader,
    actor: trader,
    recipient: trader,
    blockNumber: 100 + index,
    transactionIndex: 0,
    logIndex: index,
    transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
    createdAt: 1_000 + index * 1_000,
    traderEvidence: "tx.from",
    ...overrides,
  };
}

test("loads and normalizes CurveBuy and CurveSell in chain order", async () => {
  let filter;
  const trades = await loadCurveTrades({}, CURVE, 100, 102, {
    getLogs: async (input) => {
      filter = input;
      return [log("CurveSell", USER_B, USER_B, 2), log("CurveBuy", USER_A, USER_A, 1)];
    },
    attachTimes: async (events) => events.map((event) => ({ ...event, createdAt: event.blockNumber * 1000 })),
  });
  assert.equal(filter.address, CURVE);
  assert.equal(filter.topics[0].length, 2);
  assert.deepEqual(trades.map((item) => item.direction), ["buy", "sell"]);
  assert.equal(trades[0].quoteAmount, "10");
  assert.equal(trades[1].tokenAmount, "20");
});

test("requires five trades and three normalized traders", () => {
  const insufficient = summarizeCurveFlow([
    trade("buy", USER_A, 1),
    trade("buy", USER_A, 2),
    trade("sell", USER_B, 3),
    trade("buy", USER_B, 4),
  ]);
  assert.equal(insufficient.sampleStatus, "insufficient");
  assert.equal(insufficient.sellability, "observed");

  const sufficient = summarizeCurveFlow([
    trade("buy", USER_A, 1),
    trade("buy", USER_B, 2),
    trade("sell", USER_C, 3),
    trade("buy", USER_A, 4),
    trade("sell", USER_B, 5),
  ]);
  assert.equal(sufficient.sampleStatus, "sufficient");
  assert.equal(sufficient.bidirectional, true);
  assert.equal(sufficient.uniqueTraders, 3);
});

test("marks over-80-percent round trips as wash trading", () => {
  const trades = [];
  for (let index = 0; index < 9; index += 1) {
    trades.push(trade(index % 2 ? "sell" : "buy", USER_A, index + 1));
  }
  trades.push(trade("buy", USER_B, 10));
  trades.push(trade("sell", USER_C, 11));
  const summary = summarizeCurveFlow(trades);
  assert.equal(summary.sampleStatus, "sufficient");
  assert.ok(summary.maxTraderPct > 80);
  assert.equal(summary.washPattern, true);
});

test("uses tx.from unless it is a known router", async () => {
  const direct = { ...trade("buy", null, 1), actor: USER_B, recipient: USER_C };
  const routed = { ...trade("sell", null, 2), actor: USER_B, recipient: USER_C };
  const transactions = new Map([
    [direct.transactionHash, { from: USER_A, to: CURVE }],
    [routed.transactionHash, { from: ADDR.PONS_ROUTER, to: CURVE }],
  ]);
  const hydrated = await hydrateTraderAddresses({
    getTransaction: async (hash) => transactions.get(hash),
  }, [direct, routed], { knownRouters: [ADDR.PONS_ROUTER] });
  assert.equal(hydrated[0].trader, USER_A);
  assert.equal(hydrated[0].traderEvidence, "tx.from");
  assert.equal(hydrated[1].trader, USER_B);
  assert.equal(hydrated[1].traderEvidence, "event.actor via known router");
});

test("does not count protocol and burn addresses as independent traders", () => {
  const summary = summarizeCurveFlow([
    trade("buy", USER_A, 1),
    trade("sell", USER_B, 2),
    trade("buy", USER_C, 3),
    trade("buy", ADDR.PONS_ROUTER, 4),
    trade("sell", ADDR.DEAD, 5),
  ], { excludedAddresses: [ADDR.PONS_ROUTER, ADDR.DEAD] });
  assert.equal(summary.uniqueTraders, 3);
  assert.equal(summary.normalizedTradeCount, 3);
});

test("keeps no-sell history unknown rather than claiming a simulation", () => {
  const summary = summarizeCurveFlow([
    trade("buy", USER_A, 1),
    trade("buy", USER_B, 2),
    trade("buy", USER_C, 3),
    trade("buy", USER_A, 4),
    trade("buy", USER_B, 5),
  ]);
  assert.equal(summary.sampleStatus, "sufficient");
  assert.equal(summary.sellability, "unknown");
  assert.equal(summary.bidirectional, false);
});

test("counts deployer launches in the rolling 24-hour block window", async () => {
  let filter;
  const deployerTopic = zeroPadValue(DEPLOYER, 32).toLowerCase();
  const count = await countDeployerLaunches24h({
    getBlockNumber: async () => 500,
  }, DEPLOYER, 86_500_000, {
    findStartBlock: async (target, head) => {
      assert.equal(target, 100_000);
      assert.equal(head, 500);
      return 400;
    },
    getLogs: async (input) => {
      filter = input;
      return [{}, {}, {}];
    },
  });
  assert.equal(count, 3);
  assert.equal(filter.address, ADDR.PONS_FACTORY);
  assert.equal(filter.fromBlock, 400);
  assert.equal(filter.toBlock, 500);
  assert.equal(filter.topics[3].toLowerCase(), deployerTopic);
  assert.equal(filter.topics[0], factoryIface.getEvent("TokenLaunched").topicHash);
});

test("preserves transaction context when trader hydration fails", async () => {
  const item = trade("buy", null, 9);
  await assert.rejects(() => hydrateTraderAddresses({
    getTransaction: async () => { throw new Error("rate limited"); },
  }, [item]), new RegExp(`cannot read transaction ${item.transactionHash}.*rate limited`));
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { ADDR } from "../src/config.js";
import { ERC20_ABI, PAIR_V2_ABI, V2_FACTORY_ABI } from "../src/abis.js";
import {
  SELLABILITY,
  decodeTransferCall,
  evaluateLedgerBalance,
  evaluateTransferLadder,
  finalizeSellability,
  inspectSellability,
  normalizeSellabilityEvidence,
  resolveStartBlock,
  sellabilityResult,
  validateV2PoolBinding,
} from "../src/sellability.js";

const TOKEN = "0x0000000000000000000000000000000000010011";
const QUOTE = "0x0000000000000000000000000000000000010022";
const POOL = "0x0000000000000000000000000000000000010033";
const OTHER_POOL = "0x0000000000000000000000000000000000010034";
const BUYERS = [
  "0x0000000000000000000000000000000000010041",
  "0x0000000000000000000000000000000000010042",
  "0x0000000000000000000000000000000000010043",
  "0x0000000000000000000000000000000000010044",
  "0x0000000000000000000000000000000000010045",
  "0x0000000000000000000000000000000000010046",
];
const iface = new Interface(ERC20_ABI);
const pairIface = new Interface(PAIR_V2_ABI);
const factoryIface = new Interface(V2_FACTORY_ABI);

function sameAddressForTest(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function transferLog({ token = TOKEN, from, to, value, blockNumber = 10, index = 0, transactionHash = "0x01" }) {
  const encoded = iface.encodeEventLog(iface.getEvent("Transfer"), [from, to, value]);
  return { address: token, ...encoded, blockNumber, index, transactionHash };
}

function swapLog({
  pool = POOL,
  sender = ADDR.V2_ROUTER,
  to = ADDR.V2_ROUTER,
  amount0In = 0n,
  amount1In = 0n,
  amount0Out = 0n,
  amount1Out = 0n,
  blockNumber = 10,
  index = 0,
  transactionHash = "0x01",
} = {}) {
  const encoded = pairIface.encodeEventLog(pairIface.getEvent("Swap"), [
    sender,
    amount0In,
    amount1In,
    amount0Out,
    amount1Out,
    to,
  ]);
  return { address: pool, ...encoded, blockNumber, index, transactionHash };
}

function receipt({ status = 1, from = null, logs = [] } = {}) {
  return { status, from, logs };
}

function fakeProvider({
  logs = [],
  balances = new Map(),
  codes = new Map(),
  calls = [],
  receipts = new Map(),
  errors = {},
  factoryPair = POOL,
  pairTokens = [TOKEN, QUOTE],
  logRequests = [],
  codeRequests = [],
  stats = { headReads: 0 },
} = {}) {
  return {
    calls,
    logRequests,
    codeRequests,
    stats,
    async getBlockNumber() { stats.headReads++; if (errors.head) throw errors.head; return 100; },
    async getLogs(request) { logRequests.push(request); if (errors.logs) throw errors.logs; return logs; },
    async getCode(address, blockTag) {
      codeRequests.push({ address, blockTag });
      if (errors.code) throw errors.code;
      return codes.get(address.toLowerCase()) ?? "0x";
    },
    async call(request) {
      calls.push(request);
      if (request.to.toLowerCase() === ADDR.V2_FACTORY.toLowerCase()) {
        if (errors.factory) throw errors.factory;
        const parsed = factoryIface.parseTransaction({ data: request.data });
        return factoryIface.encodeFunctionResult(parsed.name, [factoryPair]);
      }
      if (request.to.toLowerCase() === POOL.toLowerCase()) {
        if (errors.pair) throw errors.pair;
        const parsed = pairIface.parseTransaction({ data: request.data });
        if (parsed?.name === "token0") return pairIface.encodeFunctionResult("token0", [pairTokens[0]]);
        if (parsed?.name === "token1") return pairIface.encodeFunctionResult("token1", [pairTokens[1]]);
      }
      if (errors.balance && request.data.startsWith(iface.getFunction("balanceOf").selector)) throw errors.balance;
      const parsed = iface.parseTransaction({ data: request.data });
      if (parsed.name === "balanceOf") return iface.encodeFunctionResult("balanceOf", [balances.get(parsed.args[0].toLowerCase()) ?? 0n]);
      if (errors.call) throw errors.call;
      return calls.transferResults?.shift() ?? iface.encodeFunctionResult("transfer", [true]);
    },
    async getTransactionReceipt(hash) { if (errors.receipt) throw errors.receipt; return receipts.get(hash) ?? null; },
  };
}

function context(extra = {}) {
  return { token: TOKEN, quote: QUOTE, pool: POOL, venue: "uniswap-v2", decimals: 0, blockNumber: 0, ...extra };
}

function threeSellerEvidence({
  sellers = BUYERS.slice(0, 3),
  receiptFrom = (seller) => seller,
  receiptStatus = 1,
  swapPool = POOL,
  amountIn = 2n,
  quoteOut = 5n,
  transferValue = 2n,
  poolBalance = 0n,
  direction = "sell",
  tokenIsToken0 = true,
  quoteToken = QUOTE,
  includeSwap = true,
  includeQuote = true,
} = {}) {
  const logs = sellers.flatMap((seller, index) => {
    const hash = `0xsell${index}`;
    return [
      transferLog({ from: POOL, to: seller, value: 100n, transactionHash: `0xbuy${index}` }),
      transferLog({ from: seller, to: POOL, value: transferValue, blockNumber: 20 + index, transactionHash: hash }),
    ];
  });
  const receipts = new Map(sellers.map((seller, index) => {
    const hash = `0xsell${index}`;
    const swap = direction === "sell"
      ? swapLog({
        pool: swapPool,
        amount0In: tokenIsToken0 ? amountIn : 0n,
        amount1In: tokenIsToken0 ? 0n : amountIn,
        amount0Out: tokenIsToken0 ? 0n : quoteOut,
        amount1Out: tokenIsToken0 ? quoteOut : 0n,
        index: 3,
        transactionHash: hash,
      })
      : swapLog({
        pool: swapPool,
        amount0In: tokenIsToken0 ? 0n : quoteOut,
        amount1In: tokenIsToken0 ? quoteOut : 0n,
        amount0Out: tokenIsToken0 ? amountIn : 0n,
        amount1Out: tokenIsToken0 ? 0n : amountIn,
        index: 3,
        transactionHash: hash,
      });
    return [hash, receipt({
      status: receiptStatus,
      from: receiptFrom(seller, index),
      logs: [
        transferLog({ token: TOKEN, from: seller, to: POOL, value: transferValue, index: 1, transactionHash: hash }),
        ...(includeQuote ? [transferLog({ token: quoteToken, from: POOL, to: ADDR.V2_ROUTER, value: quoteOut, index: 2, transactionHash: hash })] : []),
        ...(includeSwap ? [swap] : []),
      ],
    })];
  }));
  const balances = new Map([
    ...sellers.map((seller) => [seller.toLowerCase(), 100n - transferValue]),
    [POOL.toLowerCase(), poolBalance],
  ]);
  return { logs, receipts, balances };
}

describe("sellability evidence normalization", () => {
  const confirmed = {
    status: SELLABILITY.CONFIRMED,
    reason: "sellable",
    buyerSamples: 1,
    ladderSamples: 1,
    meaningfulSellers: 3,
    details: ["bound evidence"],
  };

  it("confirms only complete non-negative integer evidence with legacy false", () => {
    assert.deepEqual(normalizeSellabilityEvidence(confirmed, false), confirmed);
    assert.equal(normalizeSellabilityEvidence(confirmed, true).status, SELLABILITY.UNKNOWN);
    assert.equal(normalizeSellabilityEvidence(confirmed, null).status, SELLABILITY.UNKNOWN);
  });

  for (const [field, value] of [
    ["buyerSamples", -1],
    ["ladderSamples", 1.5],
    ["meaningfulSellers", undefined],
  ]) {
    it(`rejects confirmed evidence with an invalid ${field}`, () => {
      const result = normalizeSellabilityEvidence({ ...confirmed, [field]: value }, false);
      assert.equal(result.status, SELLABILITY.UNKNOWN);
      assert.equal(result.reason, "sellable");
      assert.equal(result[field], 0);
    });
  }

  it("keeps blocked evidence authoritative across legacy conflicts", () => {
    const blocked = { ...confirmed, status: SELLABILITY.BLOCKED, reason: "hidden-balance-mutation" };
    assert.equal(normalizeSellabilityEvidence(blocked, false).status, SELLABILITY.BLOCKED);
    assert.equal(normalizeSellabilityEvidence(blocked, true).status, SELLABILITY.BLOCKED);
  });
});

describe("sellability core", () => {
  it("freezes the public status enum", () => {
    assert.deepEqual(SELLABILITY, {
      CONFIRMED: "confirmed",
      UNKNOWN: "unknown",
      BLOCKED: "blocked",
    });
    assert.throws(() => {
      SELLABILITY.CONFIRMED = "changed";
    }, TypeError);
  });

  it("builds a normalized result payload", () => {
    assert.deepEqual(sellabilityResult("blocked", "hidden-balance-mutation"), {
      status: "blocked",
      reason: "hidden-balance-mutation",
      buyerSamples: 0,
      ladderSamples: 0,
      meaningfulSellers: 0,
      details: [],
    });
  });

  it("blocks a hidden balance mutation when missing exceeds one percent", () => {
    const result = evaluateLedgerBalance({
      ledgerBalance: 328585691549515n,
      reportedBalance: 50n,
      oneToken: 1_000_000_000n,
    });

    assert.deepEqual(result, {
      blocked: true,
      reason: "hidden-balance-mutation",
    });
  });

  it("keeps a one percent ledger difference unblocked without coercing bigint", () => {
    const ledgerBalance = 10n ** 30n;

    assert.deepEqual(
      evaluateLedgerBalance({
        ledgerBalance,
        reportedBalance: (ledgerBalance * 99n) / 100n,
        oneToken: 1n,
      }),
      {
        blocked: false,
        reason: null,
      }
    );
  });

  it("blocks a difference above one percent without coercing bigint", () => {
    const ledgerBalance = 10n ** 30n;

    assert.deepEqual(
      evaluateLedgerBalance({
        ledgerBalance,
        reportedBalance: (ledgerBalance * 9899n) / 10000n,
        oneToken: 1n,
      }),
      {
        blocked: true,
        reason: "hidden-balance-mutation",
      }
    );
  });

  it("does not block a sub-token ledger mismatch", () => {
    assert.deepEqual(
      evaluateLedgerBalance({
        ledgerBalance: 999n,
        reportedBalance: 0n,
        oneToken: 1000n,
      }),
      {
        blocked: false,
        reason: null,
      }
    );
  });

  it("blocks a ladder when the first sell attempt fails", () => {
    assert.deepEqual(
      evaluateTransferLadder([
        { percent: 1, ok: false },
        { percent: 10, ok: true },
        { percent: 50, ok: true },
      ]),
      {
        blocked: true,
        reason: "sell-transfer-blocked",
      }
    );
  });

  it("treats a null lower ladder and later false as transfer blocked", () => {
    assert.deepEqual(
      evaluateTransferLadder([
        { percent: 1, ok: null },
        { percent: 10, ok: false },
      ]),
      {
        blocked: true,
        reason: "sell-transfer-blocked",
      }
    );
  });

  it("treats equal percent success and failure as transfer blocked", () => {
    assert.deepEqual(
      evaluateTransferLadder([
        { percent: 10, ok: true },
        { percent: 10, ok: false },
      ]),
      {
        blocked: true,
        reason: "sell-transfer-blocked",
      }
    );
  });

  it("blocks a later larger sell attempt even when inputs are out of order", () => {
    assert.deepEqual(
      evaluateTransferLadder([
        { percent: 50, ok: false },
        { percent: 10, ok: true },
        { percent: 1, ok: true },
      ]),
      {
        blocked: true,
        reason: "sell-size-limited",
      }
    );
  });

  it("reports ladder evidence unavailable when the ladder has no false result", () => {
    assert.deepEqual(
      evaluateTransferLadder([
        { percent: 1, ok: true },
        { percent: 10, ok: null },
        { percent: 50, ok: true },
      ]),
      {
        blocked: false,
        reason: "evidence-unavailable",
      }
    );
  });

  it("keeps a fully passing ladder unblocked", () => {
    assert.deepEqual(
      evaluateTransferLadder([
        { percent: 1, ok: true },
        { percent: 10, ok: true },
        { percent: 50, ok: true },
      ]),
      {
        blocked: false,
        reason: null,
      }
    );
  });

  it("returns unknown when buyer or ladder sample counts are not positive integers", () => {
    for (const input of [
      { buyerSamples: 0, ladderSamples: 2 },
      { buyerSamples: 2, ladderSamples: 0 },
      { buyerSamples: -1, ladderSamples: 2 },
      { buyerSamples: 2, ladderSamples: -1 },
      { buyerSamples: 2.5, ladderSamples: 2 },
      { buyerSamples: 2, ladderSamples: 2.5 },
      { buyerSamples: NaN, ladderSamples: 2 },
      { buyerSamples: 2, ladderSamples: NaN },
      { buyerSamples: null, ladderSamples: 2 },
      { buyerSamples: 2, ladderSamples: null },
    ]) {
      assert.deepEqual(
        finalizeSellability({
          ...input,
          sellers: new Set(["a", "b", "c"]),
        }),
        {
          status: "unknown",
          reason: "evidence-unavailable",
          buyerSamples: input.buyerSamples,
          ladderSamples: input.ladderSamples,
          meaningfulSellers: 3,
          details: [],
        }
      );
    }
  });

  it("returns unknown when sellers is not a Set", () => {
    assert.deepEqual(
      finalizeSellability({
        buyerSamples: 2,
        ladderSamples: 2,
        sellers: ["a", "b", "c"],
      }),
      {
        status: "unknown",
        reason: "evidence-unavailable",
        buyerSamples: 2,
        ladderSamples: 2,
        meaningfulSellers: 0,
        details: [],
      }
    );
    assert.deepEqual(
      finalizeSellability({
        buyerSamples: 2,
        ladderSamples: 2,
        sellers: 3,
      }),
      {
        status: "unknown",
        reason: "evidence-unavailable",
        buyerSamples: 2,
        ladderSamples: 2,
        meaningfulSellers: 0,
        details: [],
      }
    );
  });

  it("returns unknown for fewer than three meaningful sellers", () => {
    assert.deepEqual(
      finalizeSellability({
        buyerSamples: 2,
        ladderSamples: 1,
        sellers: new Set(["a", "a", "b"]),
        details: ["only two sellers"],
      }),
      {
        status: "unknown",
        reason: "insufficient-meaningful-sells",
        buyerSamples: 2,
        ladderSamples: 1,
        meaningfulSellers: 2,
        details: ["only two sellers"],
      }
    );
  });

  it("ignores invalid Set members when counting meaningful sellers", () => {
    assert.deepEqual(
      finalizeSellability({
        buyerSamples: 3,
        ladderSamples: 3,
        sellers: new Set([null, "", " ", "a", "b"]),
        details: ["invalid members present"],
      }),
      {
        status: "unknown",
        reason: "insufficient-meaningful-sells",
        buyerSamples: 3,
        ladderSamples: 3,
        meaningfulSellers: 2,
        details: ["invalid members present"],
      }
    );
  });

  it("confirms only after three meaningful sellers and positive evidence", () => {
    assert.deepEqual(
      finalizeSellability({
        buyerSamples: 4,
        ladderSamples: 3,
        sellers: new Set(["a", "b", "c", "c"]),
        details: ["ledger ok", "ladder ok"],
      }),
      {
        status: "confirmed",
        reason: null,
        buyerSamples: 4,
        ladderSamples: 3,
        meaningfulSellers: 3,
        details: ["ledger ok", "ladder ok"],
      }
    );
  });
});

describe("V2 sellability evidence", () => {
  it("does not touch a provider for unsupported venues or missing pools", async () => {
    let calls = 0;
    const provider = { getBlockNumber: async () => { calls++; return 1; } };
    for (const input of [context({ venue: "uniswap-v3" }), context({ pool: null })]) {
      const result = await inspectSellability(input, { provider });
      assert.deepEqual(result.status, "unknown");
      assert.equal(result.reason, "unsupported-venue");
    }
    assert.equal(calls, 0);
  });

  it("resolves creation block from event, timestamp fallback, or no evidence", async () => {
    let asked = null;
    const provider = { name: "injected provider" };
    const retry = async (operation) => operation();
    assert.equal(await resolveStartBlock({ blockNumber: 7, pairCreatedAt: 1 }, 9, async () => { throw new Error("unused"); }), 7);
    assert.equal(await resolveStartBlock({ pairCreatedAt: 123 }, 9, async (...args) => { asked = args; return 6; }, provider, retry), 6);
    assert.deepEqual(asked, [123, 9, provider, retry]);
    assert.equal(await resolveStartBlock({}, 9), null);
    const result = await inspectSellability(context({ blockNumber: null, pairCreatedAt: null }), { provider: fakeProvider() });
    assert.equal(result.reason, "evidence-unavailable");
    assert.match(result.details[0], /pool creation block unavailable/);
  });

  it("pins every observable read to an injected analysis block", async () => {
    const provider = fakeProvider({
      logs: [transferLog({ from: POOL, to: BUYERS[0], value: 100n })],
      balances: new Map([[BUYERS[0].toLowerCase(), 100n]]),
    });
    const result = await inspectSellability(context({ analysisBlock: 77 }), { provider });
    assert.equal(result.status, "unknown");
    assert.equal(provider.stats.headReads, 0);
    assert.ok(provider.logRequests.length > 0);
    assert.ok(provider.logRequests.every(({ toBlock }) => toBlock === 77));
    assert.ok(provider.calls.length > 0);
    assert.ok(provider.calls.every(({ blockTag }) => blockTag === 77));
    assert.ok(provider.codeRequests.length > 0);
    assert.ok(provider.codeRequests.every(({ blockTag }) => blockTag === 77));
  });

  it("returns unavailable when the resolved start is after the analysis block", async () => {
    const provider = fakeProvider();
    const result = await inspectSellability(context({ analysisBlock: 77, blockNumber: 78 }), { provider });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "evidence-unavailable");
    assert.equal(provider.logRequests.length, 0);
  });

  it("rejects a factory or pair binding mismatch before reading token logs", async () => {
    for (const provider of [
      fakeProvider({ factoryPair: OTHER_POOL }),
      fakeProvider({ pairTokens: [TOKEN, OTHER_POOL] }),
    ]) {
      const result = await inspectSellability(context(), { provider });
      assert.equal(result.status, "unknown");
      assert.equal(result.reason, "pool-binding-mismatch");
      assert.equal(provider.logRequests.length, 0);
    }
  });

  it("reuses a matching prevalidated pool binding without repeating factory or pair reads", async () => {
    const provider = fakeProvider();
    const bindingEvidence = await validateV2PoolBinding(context({ analysisBlock: 77 }), { provider });
    assert.equal(bindingEvidence.ok, true);
    assert.equal(provider.calls.length, 3);

    const result = await inspectSellability(context({ analysisBlock: 77 }), {
      provider,
      poolBinding: bindingEvidence.binding,
    });
    assert.equal(result.status, "unknown");
    const bindingTargets = provider.calls.filter(({ to }) =>
      sameAddressForTest(to, ADDR.V2_FACTORY) || sameAddressForTest(to, POOL)
    );
    assert.equal(bindingTargets.length, 3);
  });

  it("treats malformed factory and pair address results as unavailable evidence", async () => {
    for (const target of ["getPair", "token0", "token1"]) {
      const provider = fakeProvider();
      const originalCall = provider.call;
      provider.call = async (request) => {
        if (target === "getPair" && sameAddressForTest(request.to, ADDR.V2_FACTORY)) return "0x";
        if (sameAddressForTest(request.to, POOL) && request.data === pairIface.encodeFunctionData(target, [])) return "0x";
        return originalCall(request);
      };
      const result = await inspectSellability(context(), { provider });
      assert.equal(result.status, "unknown", target);
      assert.equal(result.reason, "evidence-unavailable", target);
      assert.match(result.details.join(" "), new RegExp(`${target}.*${target === "getPair" ? ADDR.V2_FACTORY : POOL}`, "i"), target);
    }
  });

  it("converts a pool binding RPC failure into unavailable evidence", async () => {
    const result = await inspectSellability(context(), {
      provider: fakeProvider({ errors: { factory: new Error("factory rpc failed") } }),
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "evidence-unavailable");
  });

  it("passes a 10000 Transfer-log budget and rejects an oversized injected result", async () => {
    let request;
    const repeated = transferLog({ from: POOL, to: BUYERS[0], value: 1n });
    const result = await inspectSellability(context(), {
      provider: fakeProvider(),
      getLogs: async (value) => {
        request = value;
        return Array.from({ length: 10001 }, () => repeated);
      },
    });
    assert.equal(request.maxLogs, 10000);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "evidence-unavailable");
    assert.match(result.details.join(" "), /log budget exceeded/i);
  });

  it("decodes ERC20 transfer booleans and empty returns", () => {
    assert.equal(decodeTransferCall(iface.encodeFunctionResult("transfer", [true])), true);
    assert.equal(decodeTransferCall(iface.encodeFunctionResult("transfer", [false])), false);
    assert.equal(decodeTransferCall("0x"), null);
    assert.equal(decodeTransferCall(""), null);
  });

  it("blocks the SNOWBALL hidden balance mutation with exact buyer evidence", async () => {
    const provider = fakeProvider({
      logs: [transferLog({ from: POOL, to: BUYERS[0], value: 328585691549515n })],
      balances: new Map([[BUYERS[0].toLowerCase(), 50n]]),
    });
    const result = await inspectSellability(context({ decimals: 9 }), { provider });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "hidden-balance-mutation");
    assert.equal(result.buyerSamples, 1);
    assert.match(result.details.join(" "), new RegExp(BUYERS[0], "i"));
    assert.match(result.details.join(" "), /328585691549515/);
    assert.match(result.details.join(" "), /reported=50/);
  });

  it("classifies false, revert, empty, and limited transfer ladder results", async () => {
    const logs = [transferLog({ from: POOL, to: BUYERS[0], value: 100n })];
    for (const [transferResults, expected] of [
      [[iface.encodeFunctionResult("transfer", [false])], "sell-transfer-blocked"],
      [["0x"], "evidence-unavailable"],
      [[iface.encodeFunctionResult("transfer", [true]), iface.encodeFunctionResult("transfer", [false])], "sell-size-limited"],
    ]) {
      const provider = fakeProvider({ logs, balances: new Map([[BUYERS[0].toLowerCase(), 100n]]) });
      provider.calls.transferResults = [...transferResults];
      const result = await inspectSellability(context(), { provider });
      assert.equal(result.reason, expected);
    }
    const provider = fakeProvider({ logs, balances: new Map([[BUYERS[0].toLowerCase(), 100n]]), errors: { call: Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" }) } });
    assert.equal((await inspectSellability(context(), { provider })).reason, "sell-transfer-blocked");
  });

  it("runs every balance and transfer call through the injected retry wrapper", async () => {
    const calls = [];
    const provider = fakeProvider({
      logs: [transferLog({ from: POOL, to: BUYERS[0], value: 100n })],
      balances: new Map([[BUYERS[0].toLowerCase(), 100n]]),
      calls,
    });
    let retryDepth = 0;
    let callsInsideRetry = 0;
    const originalCall = provider.call;
    provider.call = async (request) => {
      if (retryDepth > 0) callsInsideRetry++;
      return originalCall(request);
    };
    const retry = async (operation) => {
      retryDepth++;
      try {
        return await operation();
      } finally {
        retryDepth--;
      }
    };

    await inspectSellability(context(), { provider, retry });
    assert.equal(callsInsideRetry, calls.length);
    assert.equal(calls.filter((request) => request.data.startsWith(iface.getFunction("transfer").selector)).length, 4);
  });

  it("uses a nonzero amount for every transfer ladder step with one whole token", async () => {
    const calls = [];
    const provider = fakeProvider({
      logs: [transferLog({ from: POOL, to: BUYERS[0], value: 1n })],
      balances: new Map([[BUYERS[0].toLowerCase(), 1n]]),
      calls,
    });

    await inspectSellability(context({ decimals: 0 }), { provider });
    const amounts = calls
      .filter((request) => request.data.startsWith(iface.getFunction("transfer").selector))
      .map((request) => iface.parseTransaction({ data: request.data }).args[1]);
    assert.deepEqual(amounts, [1n, 1n, 1n, 1n]);
  });

  it("includes the opening balance when checking the buyer ledger", async () => {
    const logs = [transferLog({ from: POOL, to: BUYERS[0], value: 100n, blockNumber: 5 })];
    const makeProvider = (headBalance) => {
      const provider = fakeProvider({ logs, balances: new Map([[BUYERS[0].toLowerCase(), headBalance]]) });
      const originalCall = provider.call;
      provider.call = async (request) => {
        if (sameAddressForTest(request.to, TOKEN) &&
          request.data.startsWith(iface.getFunction("balanceOf").selector) &&
          iface.parseTransaction({ data: request.data }).args[0].toLowerCase() === BUYERS[0].toLowerCase() &&
          request.blockTag === 4) {
          return iface.encodeFunctionResult("balanceOf", [100n]);
        }
        return originalCall(request);
      };
      return provider;
    };
    const blocked = await inspectSellability(context({ analysisBlock: 77, blockNumber: 5 }), { provider: makeProvider(150n) });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.reason, "hidden-balance-mutation");
    assert.match(blocked.details.join(" "), /expectedBalance=200/);

    const normal = await inspectSellability(context({ analysisBlock: 77, blockNumber: 5 }), { provider: makeProvider(200n) });
    assert.notEqual(normal.reason, "hidden-balance-mutation");
  });

  it("returns unavailable when the opening balance read fails", async () => {
    const provider = fakeProvider({
      logs: [transferLog({ from: POOL, to: BUYERS[0], value: 100n, blockNumber: 5 })],
      balances: new Map([[BUYERS[0].toLowerCase(), 200n]]),
    });
    const originalCall = provider.call;
    provider.call = async (request) => {
      if (sameAddressForTest(request.to, TOKEN) && request.blockTag === 4) throw new Error("historical state unavailable");
      return originalCall(request);
    };
    const result = await inspectSellability(context({ analysisBlock: 77, blockNumber: 5 }), { provider });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "evidence-unavailable");
    assert.match(result.details.join(" "), /historical state unavailable/);
  });

  it("requires quote evidence to have net pool outflow", async () => {
    const sales = BUYERS.slice(0, 3).flatMap((seller, i) => [
      transferLog({ from: POOL, to: seller, value: 100n, transactionHash: `0xe${i}` }),
      transferLog({ from: seller, to: POOL, value: 2n, blockNumber: 20 + i, transactionHash: `0xf${i}` }),
    ]);
    const receipts = new Map(BUYERS.slice(0, 3).map((seller, i) => {
      const hash = `0xf${i}`;
      const router = ADDR.V2_ROUTER;
      const logs = i === 0
        ? [transferLog({ token: QUOTE, from: POOL, to: POOL, value: 5n, index: 2, transactionHash: hash })]
        : [
          transferLog({ token: QUOTE, from: POOL, to: router, value: 5n, index: 2, transactionHash: hash }),
          transferLog({ token: QUOTE, from: router, to: POOL, value: i === 1 ? 5n : 6n, index: 3, transactionHash: hash }),
        ];
      return [hash, receipt({
        from: seller,
        logs: [
          transferLog({ token: TOKEN, from: seller, to: POOL, value: 2n, index: 1, transactionHash: hash }),
          ...logs,
          swapLog({ amount0In: 2n, amount1Out: 5n, index: 4, transactionHash: hash }),
        ],
      })];
    }));
    const provider = fakeProvider({ logs: sales, balances: new Map(BUYERS.slice(0, 3).map((buyer) => [buyer.toLowerCase(), 98n])), receipts });
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });

  it("shares a bounded EOA code lookup cache across buyer and seller evidence", async () => {
    const logs = [
      transferLog({ from: POOL, to: BUYERS[0], value: 100n }),
      transferLog({ from: BUYERS[0], to: POOL, value: 2n, blockNumber: 20, transactionHash: "0xcode" }),
    ];
    const provider = fakeProvider({ logs, balances: new Map([[BUYERS[0].toLowerCase(), 98n]]) });
    let codeCalls = 0;
    const originalCode = provider.getCode;
    provider.getCode = async (address, blockTag) => { codeCalls++; return originalCode(address, blockTag); };
    await inspectSellability(context(), { provider });
    assert.equal(codeCalls, 1);
  });

  it("returns unavailable evidence when the shared EOA lookup budget is exhausted", async () => {
    const addresses = Array.from({ length: 51 }, (_, index) => `0x${(0x100000 + index).toString(16).padStart(40, "0")}`);
    const codes = new Map(addresses.map((address) => [address.toLowerCase(), "0x1234"]));
    const provider = fakeProvider({
      logs: addresses.map((address, index) => transferLog({ from: POOL, to: address, value: 1n, blockNumber: index + 5 })),
      codes,
    });
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "evidence-unavailable");
    assert.match(result.details.join(" "), /EOA code lookup budget exhausted/);
  });

  it("confirms three distinct receipt-bound EOAs with exact-pool sell Swaps and quote outflow", async () => {
    const provider = fakeProvider(threeSellerEvidence());
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "confirmed");
    assert.equal(result.meaningfulSellers, 3);
    assert.equal(result.buyerSamples, 3);
    assert.equal(result.ladderSamples, 3);
  });

  it("does not count a sell when its quote output is fully returned to the pool later in the receipt", async () => {
    const evidence = threeSellerEvidence();
    for (const [hash, receiptValue] of evidence.receipts) {
      receiptValue.logs.push(transferLog({
        token: QUOTE,
        from: ADDR.V2_ROUTER,
        to: POOL,
        value: 5n,
        index: 4,
        transactionHash: hash,
      }));
    }
    const result = await inspectSellability(context(), { provider: fakeProvider(evidence) });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });

  it("does not count a sell followed by an equal reverse buy in the same receipt", async () => {
    const evidence = threeSellerEvidence();
    let sellerIndex = 0;
    for (const [hash, receiptValue] of evidence.receipts) {
      const seller = BUYERS[sellerIndex++];
      receiptValue.logs.push(
        transferLog({ token: QUOTE, from: seller, to: POOL, value: 5n, index: 4, transactionHash: hash }),
        transferLog({ token: TOKEN, from: POOL, to: seller, value: 2n, index: 5, transactionHash: hash }),
        swapLog({ amount1In: 5n, amount0Out: 2n, index: 6, transactionHash: hash }),
      );
    }
    const result = await inspectSellability(context(), { provider: fakeProvider(evidence) });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });

  it("binds a shared transaction hash to receipt.from even when a later unrelated transfer is seen first", async () => {
    const evidence = threeSellerEvidence();
    evidence.logs.push(...BUYERS.slice(0, 3).map((_, index) => transferLog({
      from: BUYERS[index + 3],
      to: POOL,
      value: 2n,
      blockNumber: 30 + index,
      transactionHash: `0xsell${index}`,
    })));
    const provider = fakeProvider(evidence);
    let receiptReads = 0;
    const originalReceipt = provider.getTransactionReceipt;
    provider.getTransactionReceipt = async (hash) => { receiptReads++; return originalReceipt(hash); };
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "confirmed");
    assert.equal(result.meaningfulSellers, 3);
    assert.equal(receiptReads, 3);
  });

  it("confirms a token1 sell when any exact-pool Swap in the receipt is meaningful", async () => {
    const evidence = threeSellerEvidence({ tokenIsToken0: false });
    for (const receiptValue of evidence.receipts.values()) {
      receiptValue.logs.unshift(swapLog({ amount0In: 5n, amount1Out: 2n }));
    }
    const result = await inspectSellability(context(), {
      provider: fakeProvider({ ...evidence, pairTokens: [QUOTE, TOKEN] }),
    });
    assert.equal(result.status, "confirmed");
    assert.equal(result.meaningfulSellers, 3);
  });

  it("normalizes native and zero quotes to WETH for pool binding and quote outflow", async () => {
    for (const quote of [ADDR.NATIVE, ADDR.ZERO]) {
      const evidence = threeSellerEvidence({ quoteToken: ADDR.WETH });
      const provider = fakeProvider({ ...evidence, pairTokens: [TOKEN, ADDR.WETH] });
      const result = await inspectSellability(context({ quote }), { provider });
      const factoryCall = provider.calls.find(({ to }) => to.toLowerCase() === ADDR.V2_FACTORY.toLowerCase());
      const parsed = factoryIface.parseTransaction({ data: factoryCall.data });
      assert.equal(parsed.args[1], ADDR.WETH);
      assert.equal(result.status, "confirmed");
    }
  });

  it("does not confirm token and quote Transfers without an exact-pool Swap", async () => {
    const provider = fakeProvider(threeSellerEvidence({ includeSwap: false }));
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });

  it("does not let a dust seller borrow another account's token input", async () => {
    const evidence = threeSellerEvidence({ transferValue: 1n, amountIn: 100n, poolBalance: 20_000n });
    for (const receiptValue of evidence.receipts.values()) {
      receiptValue.logs.unshift(transferLog({
        token: TOKEN,
        from: BUYERS[5],
        to: POOL,
        value: 100n,
        index: 0,
      }));
    }
    const provider = fakeProvider(evidence);
    let receiptReads = 0;
    const originalReceipt = provider.getTransactionReceipt;
    provider.getTransactionReceipt = async (hash) => { receiptReads++; return originalReceipt(hash); };
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "unknown");
    assert.equal(receiptReads, 0);
  });

  it("does not associate seller input that occurs after the Swap", async () => {
    const evidence = threeSellerEvidence();
    let index = 0;
    for (const [hash, receiptValue] of evidence.receipts) {
      const seller = BUYERS[index++];
      receiptValue.logs = [
        transferLog({ token: QUOTE, from: POOL, to: ADDR.V2_ROUTER, value: 5n, index: 0, transactionHash: hash }),
        swapLog({ amount0In: 2n, amount1Out: 5n, index: 1, transactionHash: hash }),
        transferLog({ token: TOKEN, from: seller, to: POOL, value: 2n, index: 2, transactionHash: hash }),
      ];
    }
    const result = await inspectSellability(context(), { provider: fakeProvider(evidence) });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });

  it("does not carry seller input across a previous exact-pool Swap segment", async () => {
    const evidence = threeSellerEvidence();
    let index = 0;
    for (const [hash, receiptValue] of evidence.receipts) {
      const seller = BUYERS[index++];
      receiptValue.logs = [
        transferLog({ token: TOKEN, from: seller, to: POOL, value: 2n, index: 1, transactionHash: hash }),
        swapLog({ amount1In: 5n, amount0Out: 2n, index: 2, transactionHash: hash }),
        transferLog({ token: QUOTE, from: POOL, to: ADDR.V2_ROUTER, value: 5n, index: 3, transactionHash: hash }),
        swapLog({ amount0In: 2n, amount1Out: 5n, index: 4, transactionHash: hash }),
      ];
    }
    const result = await inspectSellability(context(), { provider: fakeProvider(evidence) });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });

  it("does not let 30 newer dust Transfers exhaust the receipt budget", async () => {
    const evidence = threeSellerEvidence({ poolBalance: 20_000n });
    evidence.logs.push(...Array.from({ length: 30 }, (_, index) => transferLog({
      from: `0x${(0x300000 + index).toString(16).padStart(40, "0")}`,
      to: POOL,
      value: 1n,
      blockNumber: 30 + index,
      transactionHash: `0xdust${index}`,
    })));
    const provider = fakeProvider(evidence);
    let receiptReads = 0;
    const originalReceipt = provider.getTransactionReceipt;
    provider.getTransactionReceipt = async (hash) => { receiptReads++; return originalReceipt(hash); };
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "confirmed");
    assert.equal(receiptReads, 3);
  });

  it("does not let 30 newer sells from one counted seller hide earlier distinct sellers", async () => {
    const evidence = threeSellerEvidence();
    for (let index = 0; index < 30; index++) {
      const hash = `0xrepeat${index}`;
      evidence.logs.push(transferLog({
        from: BUYERS[3],
        to: POOL,
        value: 2n,
        blockNumber: 30 + index,
        transactionHash: hash,
      }));
      evidence.receipts.set(hash, receipt({
        from: BUYERS[3],
        logs: [
          transferLog({ from: BUYERS[3], to: POOL, value: 2n, index: 1, transactionHash: hash }),
          transferLog({ token: QUOTE, from: POOL, to: ADDR.V2_ROUTER, value: 5n, index: 2, transactionHash: hash }),
          swapLog({ amount0In: 2n, amount1Out: 5n, index: 3, transactionHash: hash }),
        ],
      }));
    }
    const provider = fakeProvider(evidence);
    let receiptReads = 0;
    const originalReceipt = provider.getTransactionReceipt;
    provider.getTransactionReceipt = async (hash) => { receiptReads++; return originalReceipt(hash); };
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "confirmed");
    assert.equal(result.meaningfulSellers, 3);
    assert.equal(receiptReads, 3);
  });

  it("filters repeated contract sources before they consume the receipt budget", async () => {
    const contract = "0x0000000000000000000000000000000000010050";
    const evidence = threeSellerEvidence();
    evidence.logs.push(...Array.from({ length: 30 }, (_, index) => transferLog({
      from: contract,
      to: POOL,
      value: 2n,
      blockNumber: 30 + index,
      transactionHash: `0xcontract${index}`,
    })));
    const provider = fakeProvider({
      ...evidence,
      codes: new Map([[contract.toLowerCase(), "0x1234"]]),
    });
    let receiptReads = 0;
    const originalReceipt = provider.getTransactionReceipt;
    provider.getTransactionReceipt = async (hash) => { receiptReads++; return originalReceipt(hash); };
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "confirmed");
    assert.equal(result.meaningfulSellers, 3);
    assert.equal(receiptReads, 3);
    assert.equal(provider.codeRequests.filter(({ address }) => sameAddressForTest(address, contract)).length, 1);
  });

  it("does not count a receipt with missing or mismatched from", async () => {
    for (const receiptFrom of [
      () => null,
      (_seller, index) => BUYERS[index + 3],
    ]) {
      const result = await inspectSellability(context(), {
        provider: fakeProvider(threeSellerEvidence({ receiptFrom })),
      });
      assert.equal(result.status, "unknown");
      assert.equal(result.reason, "insufficient-meaningful-sells");
    }
  });

  it("does not count a precompile address as a seller", async () => {
    const precompile = "0x0000000000000000000000000000000000000001";
    const evidence = threeSellerEvidence({ sellers: [BUYERS[0], BUYERS[1], precompile] });
    const result = await inspectSellability(context(), { provider: fakeProvider(evidence) });
    assert.equal(result.status, "unknown");
    assert.equal(result.meaningfulSellers, 2);
  });

  it("does not count wrong-direction or dust exact-pool Swaps", async () => {
    for (const evidence of [
      threeSellerEvidence({ direction: "buy" }),
      threeSellerEvidence({ amountIn: 4n, transferValue: 10n, poolBalance: 50_000n }),
    ]) {
      const result = await inspectSellability(context(), { provider: fakeProvider(evidence) });
      assert.equal(result.status, "unknown");
      assert.equal(result.reason, "insufficient-meaningful-sells");
    }
  });

  it("does not count a Swap emitted by a pool other than context.pool", async () => {
    const result = await inspectSellability(context(), {
      provider: fakeProvider(threeSellerEvidence({ swapPool: OTHER_POOL })),
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "insufficient-meaningful-sells");
  });

  it("does not confirm dust, failed receipts, missing quote output, or repeated sellers", async () => {
    const base = [transferLog({ from: POOL, to: BUYERS[0], value: 100n })];
    const variants = [
      { value: 0n, rec: receipt({ logs: [transferLog({ token: QUOTE, from: POOL, to: ADDR.V2_ROUTER, value: 1n })] }) },
      { value: 2n, rec: receipt({ status: 0, logs: [transferLog({ token: QUOTE, from: POOL, to: ADDR.V2_ROUTER, value: 1n })] }) },
      { value: 2n, rec: receipt({ logs: [] }) },
    ];
    for (const { value, rec } of variants) {
      const hash = "0xf1";
      const provider = fakeProvider({ logs: [...base, transferLog({ from: BUYERS[0], to: POOL, value, transactionHash: hash })], balances: new Map([[BUYERS[0].toLowerCase(), 100n - value]]), receipts: new Map([[hash, rec]]) });
      assert.equal((await inspectSellability(context(), { provider })).status, "unknown");
    }
    const repeated = [0, 1, 2].map((i) => transferLog({ from: BUYERS[0], to: POOL, value: 2n, transactionHash: `0xb${i}` }));
    const provider = fakeProvider({ logs: [...base, ...repeated], balances: new Map([[BUYERS[0].toLowerCase(), 94n]]), receipts: new Map(repeated.map((l) => [l.transactionHash, receipt({ logs: [transferLog({ token: QUOTE, from: POOL, to: ADDR.V2_ROUTER, value: 1n, transactionHash: l.transactionHash })] })])) });
    assert.equal((await inspectSellability(context(), { provider })).reason, "insufficient-meaningful-sells");
  });

  it("caps buyers, ladder wallets, and receipt reads", async () => {
    const logs = [
      ...BUYERS.flatMap((buyer, i) => [transferLog({ from: POOL, to: buyer, value: 100n, blockNumber: i + 1, transactionHash: `0xc${i}` })]),
      ...Array.from({ length: 31 }, (_, i) => transferLog({
        from: `0x${(0x200000 + i).toString(16).padStart(40, "0")}`,
        to: POOL,
        value: 2n,
        blockNumber: 30 + i,
        transactionHash: `0xd${i}`,
      })),
    ];
    const calls = [];
    let receiptCount = 0;
    const provider = fakeProvider({ logs, balances: new Map(BUYERS.map((b) => [b.toLowerCase(), 100n])), calls, receipts: new Map() });
    const original = provider.getTransactionReceipt;
    provider.getTransactionReceipt = async (hash) => { receiptCount++; return original(hash); };
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.buyerSamples, 5);
    assert.equal(result.ladderSamples, 3);
    assert.equal(receiptCount, 30);
    const transferCalls = calls.filter((request) => request.data.startsWith(iface.getFunction("transfer").selector));
    assert.equal(transferCalls.length, 12);
  });

  it("converts RPC failures into sanitized unavailable evidence", async () => {
    for (const [key, makeProvider] of [
      ["logs", () => fakeProvider({ errors: { logs: new Error("logs https://secret.example/key") } })],
      ["code", () => fakeProvider({ logs: [transferLog({ from: POOL, to: BUYERS[0], value: 100n })], errors: { code: new Error("code https://secret.example/key") } })],
      ["balance", () => fakeProvider({ logs: [transferLog({ from: POOL, to: BUYERS[0], value: 100n })], errors: { balance: new Error("balance https://secret.example/key") } })],
      ["receipt", () => fakeProvider({ logs: [transferLog({ from: POOL, to: BUYERS[0], value: 100n }), transferLog({ from: BUYERS[0], to: POOL, value: 2n, transactionHash: "0xee" })], balances: new Map([[BUYERS[0].toLowerCase(), 100n]]), errors: { receipt: new Error("receipt https://secret.example/key") } })],
    ]) {
      const result = await inspectSellability(context(), { provider: makeProvider() });
      assert.equal(result.status, "unknown", key);
      assert.equal(result.reason, "evidence-unavailable", key);
      assert.match(result.details.join(" "), new RegExp(key), key);
      assert.doesNotMatch(result.details.join(" "), /secret\.example/, key);
    }
  });
});

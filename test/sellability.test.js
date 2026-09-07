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
  resolveStartBlock,
  sellabilityResult,
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
  return { address: pool, ...encoded, transactionHash };
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
        transactionHash: hash,
      })
      : swapLog({
        pool: swapPool,
        amount0In: tokenIsToken0 ? 0n : quoteOut,
        amount1In: tokenIsToken0 ? quoteOut : 0n,
        amount0Out: tokenIsToken0 ? amountIn : 0n,
        amount1Out: tokenIsToken0 ? 0n : amountIn,
        transactionHash: hash,
      });
    return [hash, receipt({
      status: receiptStatus,
      from: receiptFrom(seller, index),
      logs: [
        ...(includeSwap ? [swap] : []),
        ...(includeQuote ? [transferLog({ token: quoteToken, from: POOL, to: ADDR.V2_ROUTER, value: quoteOut, transactionHash: hash })] : []),
      ],
    })];
  }));
  const balances = new Map([
    ...sellers.map((seller) => [seller.toLowerCase(), 100n - transferValue]),
    [POOL.toLowerCase(), poolBalance],
  ]);
  return { logs, receipts, balances };
}

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

  it("does not read buyer balances from a block before the analysis head", async () => {
    const logs = [transferLog({ from: POOL, to: BUYERS[0], value: 100n, blockNumber: 5 })];
    const provider = fakeProvider({ logs, balances: new Map([[BUYERS[0].toLowerCase(), 100n]]) });
    await inspectSellability(context({ analysisBlock: 77, blockNumber: 5 }), { provider });
    const balanceCalls = provider.calls.filter((request) => request.data.startsWith(iface.getFunction("balanceOf").selector));
    assert.ok(balanceCalls.length > 0);
    assert.ok(balanceCalls.every(({ blockTag }) => blockTag === 77));
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
        ? [transferLog({ token: QUOTE, from: POOL, to: POOL, value: 5n, transactionHash: hash })]
        : [
          transferLog({ token: QUOTE, from: POOL, to: router, value: 5n, transactionHash: hash }),
          transferLog({ token: QUOTE, from: router, to: POOL, value: i === 1 ? 5n : 6n, transactionHash: hash }),
        ];
      return [hash, receipt({
        from: seller,
        logs: [swapLog({ amount0In: 2n, amount1Out: 5n, transactionHash: hash }), ...logs],
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

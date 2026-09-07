import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { ADDR } from "../src/config.js";
import { ERC20_ABI } from "../src/abis.js";
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

const TOKEN = "0x0000000000000000000000000000000000000011";
const QUOTE = "0x0000000000000000000000000000000000000022";
const POOL = "0x0000000000000000000000000000000000000033";
const BUYERS = [
  "0x0000000000000000000000000000000000000041",
  "0x0000000000000000000000000000000000000042",
  "0x0000000000000000000000000000000000000043",
  "0x0000000000000000000000000000000000000044",
  "0x0000000000000000000000000000000000000045",
  "0x0000000000000000000000000000000000000046",
];
const iface = new Interface(ERC20_ABI);

function transferLog({ token = TOKEN, from, to, value, blockNumber = 10, index = 0, transactionHash = "0x01" }) {
  const encoded = iface.encodeEventLog(iface.getEvent("Transfer"), [from, to, value]);
  return { address: token, ...encoded, blockNumber, index, transactionHash };
}

function receipt({ status = 1, logs = [] } = {}) {
  return { status, logs };
}

function fakeProvider({ logs = [], balances = new Map(), codes = new Map(), calls = [], receipts = new Map(), errors = {} } = {}) {
  return {
    calls,
    async getBlockNumber() { if (errors.head) throw errors.head; return 100; },
    async getLogs() { if (errors.logs) throw errors.logs; return logs; },
    async getCode(address) { if (errors.code) throw errors.code; return codes.get(address.toLowerCase()) ?? "0x"; },
    async call(request) {
      calls.push(request);
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

  it("includes a buyer's pre-window balance when detecting hidden mutations", async () => {
    const logs = [transferLog({ from: POOL, to: BUYERS[0], value: 100n, blockNumber: 5 })];
    const makeProvider = (headBalance) => {
      const provider = fakeProvider({ logs, balances: new Map([[BUYERS[0].toLowerCase(), headBalance]]) });
      const originalCall = provider.call;
      provider.call = async (request) => {
        const parsed = iface.parseTransaction({ data: request.data });
        if (parsed.name === "balanceOf" && parsed.args[0].toLowerCase() === BUYERS[0].toLowerCase() && request.blockTag === 4) {
          return iface.encodeFunctionResult("balanceOf", [100n]);
        }
        return originalCall(request);
      };
      return provider;
    };
    const blocked = await inspectSellability(context({ blockNumber: 5 }), { provider: makeProvider(150n) });
    assert.equal(blocked.reason, "hidden-balance-mutation");
    assert.match(blocked.details.join(" "), /expectedBalance=200/);

    const normal = await inspectSellability(context({ blockNumber: 5 }), { provider: makeProvider(200n) });
    assert.notEqual(normal.reason, "hidden-balance-mutation");
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
      return [hash, receipt({ logs })];
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
    provider.getCode = async (address) => { codeCalls++; return originalCode(address); };
    await inspectSellability(context(), { provider });
    assert.equal(codeCalls, 1);
  });

  it("returns unavailable evidence when the shared EOA lookup budget is exhausted", async () => {
    const addresses = Array.from({ length: 51 }, (_, index) => `0x${(1000 + index).toString(16).padStart(40, "0")}`);
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

  it("requires three distinct non-dust successful sales with quote transfers", async () => {
    const sales = BUYERS.slice(0, 3).flatMap((seller, i) => {
      const hash = `0x0${i + 1}`;
      return [transferLog({ from: POOL, to: seller, value: 100n, transactionHash: `0xa${i}` }), transferLog({ from: seller, to: POOL, value: 2n, blockNumber: 20 + i, transactionHash: hash })];
    });
    const receipts = new Map(BUYERS.slice(0, 3).map((seller, i) => [
      `0x0${i + 1}`,
      receipt({ logs: [
        ...(i === 0 ? [{ address: QUOTE, topics: ["0xdeadbeef"], data: "0x" }] : []),
        transferLog({ token: QUOTE, from: POOL, to: ADDR.V2_ROUTER, value: 5n, transactionHash: `0x0${i + 1}` }),
      ] }),
    ]));
    const provider = fakeProvider({ logs: sales, balances: new Map(BUYERS.slice(0, 3).map((b) => [b.toLowerCase(), 98n])), receipts });
    const result = await inspectSellability(context(), { provider });
    assert.equal(result.status, "confirmed");
    assert.equal(result.meaningfulSellers, 3);
    assert.equal(result.buyerSamples, 3);
    assert.equal(result.ladderSamples, 3);
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
        from: `0x${(100 + i).toString(16).padStart(40, "0")}`,
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

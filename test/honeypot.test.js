import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { PAIR_V2_ABI, V2_FACTORY_ABI, V2_ROUTER_ABI } from "../src/abis.js";
import { honeypotCheck, rawCall } from "../src/analyze.js";
import { ADDR } from "../src/config.js";

const input = {
  token: "0x1111111111111111111111111111111111111111",
  quote: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  venue: "uniswap-v2",
  pool: "0x3333333333333333333333333333333333333333",
  holders: [],
};
const routerIface = new Interface(V2_ROUTER_ABI);
const pairIface = new Interface(PAIR_V2_ABI);
const factoryIface = new Interface(V2_FACTORY_ABI);
const boundPool = {
  token: input.token,
  quote: input.quote,
  pool: input.pool,
  tokenIsToken0: true,
  analysisBlock: 77,
};

function withBoundPool(overrides = {}) {
  return {
    validateV2PoolBinding: async () => ({
      ok: true,
      reason: null,
      binding: boundPool,
      details: [],
    }),
    ...overrides,
  };
}

const confirmedSellability = async () => ({
  status: "confirmed",
  reason: "receipt-bound",
  buyerSamples: 3,
  ladderSamples: 3,
  meaningfulSellers: 3,
  details: [],
});

describe("honeypotCheck", () => {
  it("passes the injected wallet catalog into sellability inspection", async () => {
    const walletCatalog = { status: "known", labels: new Map() };
    let receivedCatalog;
    await honeypotCheck({ ...input, walletCatalog }, withBoundPool({
      provider: { getBlockNumber: async () => 77 },
      bytecodeFlags: async () => ({ hasCode: true }),
      quoteRoundTrip: async () => ({ buyOk: true, sellOk: true }),
      inspectSellability: async (_value, options) => {
        receivedCatalog = options.walletCatalog;
        return confirmedSellability();
      },
    }));
    assert.equal(receivedCatalog, walletCatalog);
  });

  it("rejects unsupported or missing-pool venues before touching any dependency", async () => {
    for (const candidate of [
      { ...input, venue: "uniswap-v3" },
      { ...input, pool: null },
      { ...input, pool: "0x0000000000000000000000000000000000000000" },
      { ...input, pool: "not-an-address" },
    ]) {
      let calls = 0;
      const touched = async () => { calls++; return { hasCode: false }; };
      const result = await honeypotCheck(candidate, {
        provider: { getBlockNumber: touched },
        getBlockNumber: touched,
        bytecodeFlags: touched,
        quoteRoundTrip: touched,
        inspectSellability: touched,
        validateV2PoolBinding: touched,
      });
      assert.equal(result.honeypot, null);
      assert.equal(result.complete, false);
      assert.equal(result.sellOk, null);
      assert.equal(result.reason, "unsupported-venue");
      assert.equal(result.sellability.status, "unknown");
      assert.equal(result.sellability.reason, "unsupported-venue");
      assert.equal(calls, 0);
    }
  });

  it("uses one analysis block for sellability, bytecode, and quote evidence", async () => {
    const provider = { getBlockNumber: async () => { headReads++; return 77; } };
    const order = [];
    const optionSamples = [];
    let headReads = 0;
    let inspectInput;
    const result = await honeypotCheck(input, withBoundPool({
      provider,
      validateV2PoolBinding: async (value) => {
        order.push("binding");
        assert.equal(value.analysisBlock, 77);
        return { ok: true, reason: null, binding: boundPool, details: [] };
      },
      inspectSellability: async (value) => {
        order.push("sellability");
        inspectInput = value;
        return {
          status: "confirmed",
          reason: "receipt-bound",
          buyerSamples: 3,
          ladderSamples: 3,
          meaningfulSellers: 3,
          details: [],
        };
      },
      bytecodeFlags: async (_token, options) => {
        order.push("bytecode");
        optionSamples.push(options);
        return { hasCode: true };
      },
      quoteRoundTrip: async (_token, _quote, options) => {
        order.push("quote");
        optionSamples.push(options);
        return { buyOk: true, sellOk: true };
      },
    }));
    assert.equal(result.honeypot, false);
    assert.equal(headReads, 1);
    assert.equal(inspectInput.analysisBlock, 77);
    assert.deepEqual(optionSamples, [
      { provider, blockTag: 77 },
      { provider, blockTag: 77 },
    ]);
    assert.deepEqual(order, ["binding", "bytecode", "quote", "sellability"]);
  });

  it("validates the exact pool once and reuses that binding for historical evidence", async () => {
    let headReads = 0;
    const bindingCalls = [];
    const optionSamples = [];
    const provider = {
      async getBlockNumber() { headReads++; return 77; },
      async call(request) {
        bindingCalls.push(request);
        if (request.to.toLowerCase() === ADDR.V2_FACTORY.toLowerCase()) {
          return factoryIface.encodeFunctionResult("getPair", [input.pool]);
        }
        const parsed = pairIface.parseTransaction({ data: request.data });
        if (parsed.name === "token0") return pairIface.encodeFunctionResult("token0", [input.token]);
        if (parsed.name === "token1") return pairIface.encodeFunctionResult("token1", [input.quote]);
        throw new Error(`unexpected pair call ${parsed.name}`);
      },
    };
    let receivedBinding;
    const result = await honeypotCheck(input, {
      provider,
      retry: async (fn) => fn(),
      bytecodeFlags: async (_token, options) => {
        optionSamples.push(options);
        return { hasCode: true };
      },
      quoteRoundTrip: async (_token, _quote, options) => {
        optionSamples.push(options);
        return { buyOk: true, sellOk: true };
      },
      inspectSellability: async (_value, dependencies) => {
        receivedBinding = dependencies.poolBinding;
        return {
          status: "unknown",
          reason: "insufficient-meaningful-sells",
          buyerSamples: 1,
          ladderSamples: 1,
          meaningfulSellers: 0,
          details: [],
        };
      },
    });
    assert.equal(result.sellability.status, "unknown");
    assert.equal(headReads, 1);
    assert.equal(bindingCalls.length, 3);
    assert.ok(bindingCalls.every(({ blockTag }) => blockTag === 77));
    assert.deepEqual(receivedBinding, {
      token: input.token,
      quote: input.quote,
      pool: input.pool,
      tokenIsToken0: true,
      analysisBlock: 77,
    });
    assert.deepEqual(optionSamples, [
      { provider, blockTag: 77 },
      { provider, blockTag: 77 },
    ]);
  });

  it("keeps binding mismatch or unavailable evidence unknown without bytecode, quote, or history calls", async () => {
    for (const [name, call, reason] of [
      ["mismatch", async () => factoryIface.encodeFunctionResult("getPair", [ADDR.ZERO]), "pool-binding-mismatch"],
      ["unavailable", async () => { throw new Error("binding rpc down"); }, "evidence-unavailable"],
    ]) {
      let downstreamCalls = 0;
      const result = await honeypotCheck(input, {
        provider: { call, getBlockNumber: async () => 77 },
        retry: async (fn) => fn(),
        bytecodeFlags: async () => { downstreamCalls++; return { hasCode: false }; },
        quoteRoundTrip: async () => { downstreamCalls++; return { buyOk: false, sellOk: false }; },
        inspectSellability: async () => { downstreamCalls++; return confirmedSellability(); },
      });
      assert.equal(result.honeypot, null, name);
      assert.equal(result.complete, false, name);
      assert.equal(result.sellability.status, "unknown", name);
      assert.equal(result.reason, reason, name);
      assert.equal(downstreamCalls, 0, name);
    }
  });

  it("passes the fixed blockTag to both default router quote calls", async () => {
    const quoteCalls = [];
    const provider = {
      async getBlockNumber() { return 77; },
      async call(request) {
        quoteCalls.push(request);
        const parsed = routerIface.parseTransaction({ data: request.data });
        const amountIn = BigInt(parsed.args[0]);
        return routerIface.encodeFunctionResult("getAmountsOut", [[amountIn, amountIn * 2n]]);
      },
    };
    const result = await honeypotCheck(input, withBoundPool({
      provider,
      bytecodeFlags: async () => ({ hasCode: true }),
      inspectSellability: confirmedSellability,
    }));
    assert.equal(result.honeypot, false);
    assert.equal(quoteCalls.length, 2);
    assert.ok(quoteCalls.every(({ blockTag }) => blockTag === 77));
  });

  for (const [name, flags, quoteResult, reason, expectedQuoteCalls] of [
    ["no contract code", { hasCode: false }, { buyOk: true, sellOk: true }, "no-contract-code", 0],
    ["failed buy quote", { hasCode: true }, { buyOk: false, sellOk: null }, "buy-quote-unavailable", 1],
    ["failed sell quote", { hasCode: true }, { buyOk: true, sellOk: false }, "sell-quote-zero", 1],
  ]) {
    it(`keeps ${name} blocked even when historical sellability would be unknown`, async () => {
      let quoteCalls = 0;
      let inspectCalls = 0;
      const result = await honeypotCheck(input, withBoundPool({
        getBlockNumber: async () => 77,
        bytecodeFlags: async () => flags,
        quoteRoundTrip: async () => { quoteCalls++; return quoteResult; },
        inspectSellability: async () => {
          inspectCalls++;
          return {
            status: "unknown",
            reason: "evidence-unavailable",
            buyerSamples: 0,
            ladderSamples: 0,
            meaningfulSellers: 0,
            details: [],
          };
        },
      }));
      assert.equal(result.honeypot, true);
      assert.equal(result.complete, true);
      assert.equal(result.sellOk, false);
      assert.equal(result.sellability.status, "blocked");
      assert.equal(result.reason, reason);
      assert.equal(quoteCalls, expectedQuoteCalls);
      assert.equal(inspectCalls, 0);
    });
  }

  it("does not mark successful quotes as complete when sellability is unknown", async () => {
    const result = await honeypotCheck(input, withBoundPool({
      getBlockNumber: async () => 77,
      bytecodeFlags: async () => ({ hasCode: true, blacklist: false, pausable: false }),
      quoteRoundTrip: async () => ({ buyOk: true, sellOk: true }),
      inspectSellability: async () => ({
        status: "unknown",
        reason: "evidence-unavailable",
        buyerSamples: 0,
        ladderSamples: 0,
        meaningfulSellers: 0,
        details: [],
      }),
    }));
    assert.equal(result.honeypot, null);
    assert.equal(result.complete, false);
    assert.equal(result.buyTaxBps, null);
    assert.equal(result.sellTaxBps, null);
  });

  for (const [status, expected] of [
    ["blocked", { honeypot: true, complete: true, sellOk: false }],
    ["confirmed", { honeypot: false, complete: true, sellOk: true }],
    ["unknown", { honeypot: null, complete: false, sellOk: null }],
  ]) {
    it(`maps ${status} sellability evidence to the legacy honeypot fields`, async () => {
      const result = await honeypotCheck(input, withBoundPool({
        getBlockNumber: async () => 77,
        bytecodeFlags: async () => ({ hasCode: true }),
        quoteRoundTrip: async () => ({ buyOk: true, sellOk: true }),
        inspectSellability: async () => ({
          status,
          reason: `${status}-reason`,
          buyerSamples: 2,
          ladderSamples: 1,
          meaningfulSellers: status === "confirmed" ? 3 : 0,
          details: ["evidence"],
        }),
      }));
      assert.equal(result.honeypot, expected.honeypot);
      assert.equal(result.complete, expected.complete);
      assert.equal(result.sellOk, expected.sellOk);
      assert.equal(result.reason, `${status}-reason`);
      assert.deepEqual(result.sellability, {
        status,
        reason: `${status}-reason`,
        buyerSamples: 2,
        ladderSamples: 1,
        meaningfulSellers: status === "confirmed" ? 3 : 0,
        details: ["evidence"],
        walletSignals: { status: "unconfigured", count: 0, matches: [] },
      });
    });
  }

  it("keeps V3 and V4 checks unknown when sellability is unsupported", async () => {
    for (const venue of ["uniswap-v3", "uniswap-v4"]) {
      const result = await honeypotCheck({ ...input, venue, pool: venue === "uniswap-v4" ? null : input.pool }, {
        bytecodeFlags: async () => ({ hasCode: true }),
        inspectSellability: async () => ({
          status: "unknown",
          reason: "unsupported-venue",
          buyerSamples: 0,
          ladderSamples: 0,
          meaningfulSellers: 0,
          details: [],
        }),
      });
      assert.equal(result.honeypot, null);
      assert.equal(result.complete, false);
      assert.equal(result.sellOk, null);
      assert.equal(result.sellability.reason, "unsupported-venue");
    }
  });

  it("returns standard unknown evidence for unsupported V3 and V4 venues", async () => {
    for (const venue of ["uniswap-v3", "uniswap-v4"]) {
      const result = await honeypotCheck({ ...input, venue, pool: venue === "uniswap-v4" ? null : input.pool }, {
        bytecodeFlags: async () => ({ hasCode: true }),
      });
      assert.equal(result.honeypot, null);
      assert.equal(result.complete, false);
      assert.equal(result.sellOk, null);
      assert.equal(result.sellability.status, "unknown");
      assert.equal(result.sellability.reason, "unsupported-venue");
    }
  });

  it("does not treat successful V2 quotes as confirmed sellability", async () => {
    const result = await honeypotCheck(input, withBoundPool({
      getBlockNumber: async () => 77,
      bytecodeFlags: async () => ({ hasCode: true }),
      quoteRoundTrip: async () => ({ buyOk: true, sellOk: true }),
      inspectSellability: async () => ({
        status: "unknown",
        reason: "insufficient-meaningful-sells",
        buyerSamples: 1,
        ladderSamples: 1,
        meaningfulSellers: 0,
        details: [],
      }),
    }));
    assert.equal(result.honeypot, null);
    assert.equal(result.complete, false);
    assert.equal(result.sellOk, null);
  });

  it("normalizes a native quote before inspecting sellability", async () => {
    let inspectInput;
    await honeypotCheck({ ...input, quote: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, withBoundPool({
      getBlockNumber: async () => 77,
      bytecodeFlags: async () => ({ hasCode: true }),
      quoteRoundTrip: async () => ({ buyOk: true, sellOk: true }),
      inspectSellability: async (value) => {
        inspectInput = value;
        return {
          status: "unknown",
          reason: "evidence-unavailable",
          buyerSamples: 0,
          ladderSamples: 0,
          meaningfulSellers: 0,
          details: [],
        };
      },
    }));
    assert.equal(inspectInput.quote, input.quote);
  });

  it("attaches blocked sellability to no-code and failed V2 quote evidence", async () => {
    const cases = [
      [{ hasCode: false }, null, "no-contract-code"],
      [{ hasCode: true }, { buyOk: false, reason: "buy quote reverted" }, "buy-quote-unavailable"],
      [{ hasCode: true }, { buyOk: true, sellOk: false, reason: "sell quote reverted" }, "sell-quote-zero"],
    ];
    for (const [flags, quoteResult, reason] of cases) {
      const result = await honeypotCheck(input, withBoundPool({
        getBlockNumber: async () => 77,
        bytecodeFlags: async () => flags,
        quoteRoundTrip: async () => quoteResult,
        inspectSellability: confirmedSellability,
      }));
      assert.equal(result.honeypot, true);
      assert.equal(result.complete, true);
      assert.equal(result.sellOk, false);
      assert.equal(result.sellability.status, "blocked");
      assert.equal(result.sellability.reason, reason);
    }
  });

  it("keeps concrete quote failures as negative evidence", async () => {
    const result = await honeypotCheck(input, withBoundPool({
      getBlockNumber: async () => 77,
      bytecodeFlags: async () => ({ hasCode: true }),
      quoteRoundTrip: async () => ({ buyOk: false, sellOk: null, reason: "buy quote reverted" }),
      inspectSellability: confirmedSellability,
    }));
    assert.equal(result.honeypot, true);
    assert.equal(result.reason, "buy-quote-unavailable");
    assert.deepEqual(result.sellability.details, ["buy quote reverted"]);
  });

  it("does not convert transport failures into honeypot evidence", async () => {
    const transportError = Object.assign(new Error("upstream timed out"), { code: "NETWORK_ERROR" });
    await assert.rejects(
      () => rawCall(
        { from: input.pool, to: input.token, data: "0x" },
        undefined,
        {
          provider: { send: async () => { throw transportError; } },
          retry: async (fn) => fn(),
        }
      ),
      (error) => error === transportError
    );
  });

  it("keeps an execution revert as concrete transfer evidence", async () => {
    const result = await rawCall(
      { from: input.pool, to: input.token, data: "0x" },
      undefined,
      {
        provider: {
          send: async () => {
            throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
          },
        },
        retry: async (fn) => fn(),
      }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /reverted/i);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { honeypotCheck, rawCall } from "../src/analyze.js";

const input = {
  token: "0x1111111111111111111111111111111111111111",
  quote: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  venue: "uniswap-v2",
  pool: "0x3333333333333333333333333333333333333333",
  holders: [],
};

describe("honeypotCheck", () => {
  it("does not mark successful quotes as complete when sellability is unknown", async () => {
    const result = await honeypotCheck(input, {
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
    });
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
      const result = await honeypotCheck(input, {
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
      });
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

  it("does not treat successful V2 quotes as confirmed sellability", async () => {
    const result = await honeypotCheck(input, {
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
    });
    assert.equal(result.honeypot, null);
    assert.equal(result.complete, false);
    assert.equal(result.sellOk, null);
  });

  it("normalizes a native quote before inspecting sellability", async () => {
    let inspectInput;
    await honeypotCheck({ ...input, quote: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, {
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
    });
    assert.equal(inspectInput.quote, input.quote);
  });

  it("attaches blocked sellability to no-code and failed V2 quote evidence", async () => {
    const cases = [
      [{ hasCode: false }, null, "no-contract-code"],
      [{ hasCode: true }, { buyOk: false, reason: "buy quote reverted" }, "buy-quote-unavailable"],
      [{ hasCode: true }, { buyOk: true, sellOk: false, reason: "sell quote reverted" }, "sell-quote-zero"],
    ];
    for (const [flags, quoteResult, reason] of cases) {
      const result = await honeypotCheck(input, {
        bytecodeFlags: async () => flags,
        quoteRoundTrip: async () => quoteResult,
      });
      assert.equal(result.honeypot, true);
      assert.equal(result.complete, true);
      assert.equal(result.sellOk, false);
      assert.equal(result.sellability.status, "blocked");
      assert.equal(result.sellability.reason, reason);
    }
  });

  it("keeps concrete quote failures as negative evidence", async () => {
    const result = await honeypotCheck(input, {
      bytecodeFlags: async () => ({ hasCode: true }),
      quoteRoundTrip: async () => ({ buyOk: false, sellOk: null, reason: "buy quote reverted" }),
    });
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

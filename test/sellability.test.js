import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SELLABILITY,
  evaluateLedgerBalance,
  evaluateTransferLadder,
  finalizeSellability,
  sellabilityResult,
} from "../src/sellability.js";

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

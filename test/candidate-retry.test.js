import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_RETRY_OFFSETS_MS,
  createCandidateRecheck,
  decideCandidateRecheck,
  shouldScheduleCandidateRecheck,
} from "../src/candidate-retry.js";

const v2Event = {
  source: "gecko",
  venue: "uniswap-v2",
  pool: "0x2222222222222222222222222222222222222222",
  token: "0x1111111111111111111111111111111111111111",
  createdAt: 1_000,
};

function sellability(status, reason, meaningfulSellers = 0) {
  return {
    status,
    reason,
    buyerSamples: 2,
    ladderSamples: 1,
    meaningfulSellers,
    details: [],
  };
}

function unknownReport(reason) {
  return { honeypot: { honeypot: null }, sellability: sellability("unknown", reason) };
}

const confirmedReport = {
  honeypot: { honeypot: false },
  sellability: sellability("confirmed", null, 3),
};
const blockedReport = {
  honeypot: { honeypot: true },
  sellability: sellability("blocked", "sell-transfer-blocked"),
};

describe("candidate retry policy", () => {
  it("schedules only supported ordinary V2 unknown evidence", () => {
    assert.equal(shouldScheduleCandidateRecheck(v2Event, unknownReport("insufficient-meaningful-sells")), true);
    assert.equal(shouldScheduleCandidateRecheck(v2Event, unknownReport("prefilter-score")), false);
    assert.equal(shouldScheduleCandidateRecheck(
      { ...v2Event, venue: "uniswap-v4" },
      unknownReport("unsupported-venue")
    ), false);
    assert.equal(shouldScheduleCandidateRecheck(v2Event, confirmedReport), false);
    assert.equal(shouldScheduleCandidateRecheck(v2Event, blockedReport), false);
  });

  it("uses absolute two-, five-, and ten-minute retry slots", () => {
    const check = createCandidateRecheck(v2Event, 1_000);
    assert.deepEqual(check.retryOffsetsMs, [...CANDIDATE_RETRY_OFFSETS_MS]);
    assert.equal(check.nextAttemptAt, 121_000);
    assert.equal(
      decideCandidateRecheck(
        { ...check, attempts: 0 },
        unknownReport("insufficient-meaningful-sells"),
        121_000,
        30
      ).retryAt,
      301_000
    );
    assert.equal(
      decideCandidateRecheck(
        { ...check, attempts: 1 },
        unknownReport("insufficient-meaningful-sells"),
        301_000,
        30
      ).retryAt,
      601_000
    );
    assert.equal(
      decideCandidateRecheck(
        { ...check, attempts: 2 },
        unknownReport("insufficient-meaningful-sells"),
        601_000,
        30
      ).complete,
      true
    );
  });

  it("stops when the original candidate age exceeds the configured window", () => {
    const oldEventCheck = createCandidateRecheck({ ...v2Event, createdAt: 1_000 }, 500_000);
    assert.equal(
      decideCandidateRecheck(oldEventCheck, unknownReport("insufficient-meaningful-sells"), 1_802_000, 30).complete,
      true
    );

    const missingCreatedAtCheck = createCandidateRecheck({ ...v2Event, createdAt: null }, 1_000);
    assert.equal(
      decideCandidateRecheck(
        missingCreatedAtCheck,
        unknownReport("insufficient-meaningful-sells"),
        1_802_000,
        30
      ).complete,
      true
    );
  });

  it("completes immediately when a recheck becomes confirmed or blocked", () => {
    const check = createCandidateRecheck(v2Event, 1_000);
    assert.deepEqual(decideCandidateRecheck(check, confirmedReport, 121_000, 30), { complete: true });
    assert.deepEqual(decideCandidateRecheck(check, blockedReport, 121_000, 30), { complete: true });
  });
});

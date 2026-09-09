import test from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_RECOVERY_OFFSETS_MS,
  RetryableCandidateError,
  activeCandidateRecoveryKeys,
  candidateRecoveryId,
  createCandidateRecovery,
  isRetryableCandidateFailure,
} from "../src/candidate-recovery.js";

const event = {
  chain: "robinhood",
  token: "0x1000000000000000000000000000000000000001",
  pool: "0x2000000000000000000000000000000000000002",
  source: "gecko",
  venue: "uniswap-v2",
  createdAt: 1_000,
};

test("candidate recovery uses a separate deterministic pending-check identity", () => {
  const check = createCandidateRecovery(event, 10_000, new Error("rate limited"));
  assert.equal(check.id, candidateRecoveryId(event));
  assert.match(check.id, /^candidate-recovery:/);
  assert.equal(check.type, "candidate_recovery");
  assert.equal(check.dueAt, 10_000 + CANDIDATE_RECOVERY_OFFSETS_MS[0]);
  assert.deepEqual(check.retryOffsetsMs, [120_000, 300_000, 600_000]);
  assert.equal(check.maxAttempts, 3);
  assert.match(check.lastError, /rate limited/);
});

test("candidate recovery restores pending and failed keys but not completed keys", () => {
  const id = candidateRecoveryId(event);
  const keys = activeCandidateRecoveryKeys({
    pendingChecks: {
      pending: { id, type: "candidate_recovery", status: "pending", event },
      failed: {
        id: `${id}:failed`,
        type: "candidate_recovery",
        status: "failed",
        event: {
          ...event,
          token: "0x3000000000000000000000000000000000000003",
          pool: "0x5000000000000000000000000000000000000005",
        },
      },
      done: {
        id: `${id}:done`,
        type: "candidate_recovery",
        status: "completed",
        event: {
          ...event,
          token: "0x4000000000000000000000000000000000000004",
          pool: "0x6000000000000000000000000000000000000006",
        },
      },
    },
  });
  assert.equal(keys.size, 2);
});

test("only expected transient candidate failures are retryable", () => {
  assert.equal(isRetryableCandidateFailure(new RetryableCandidateError("identity unavailable")), true);
  assert.equal(
    isRetryableCandidateFailure(Object.assign(new Error("metadata unavailable"), { code: "RETRYABLE_ANALYSIS" })),
    true
  );
  assert.equal(
    isRetryableCandidateFailure(Object.assign(new Error("too many requests"), { status: 429 })),
    true
  );
  assert.equal(isRetryableCandidateFailure(new ReferenceError("analyzeCandidate is not defined")), false);
});

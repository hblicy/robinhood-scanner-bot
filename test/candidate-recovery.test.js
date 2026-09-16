import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CANDIDATE_RECOVERY_OFFSETS_MS,
  RetryableCandidateError,
  activeCandidateRecoveryKeys,
  candidateRecoveryId,
  createCandidateRecovery,
  isRetryableCandidateFailure,
  syncCandidateRecoveryKeys,
} from "../src/candidate-recovery.js";
import { candidateKey } from "../src/runtime.js";
import { createStore } from "../src/store.js";
import { createCandidateRecoveryScheduler, runPendingChecks } from "../src/scanner.js";

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

test("candidate recovery restores only pending keys", () => {
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
      expired: {
        id: `${id}:expired`,
        type: "candidate_recovery",
        status: "expired",
        event: {
          ...event,
          token: "0x7000000000000000000000000000000000000007",
          pool: "0x8000000000000000000000000000000000000008",
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
  assert.equal(keys.size, 1);
  assert.equal(keys.has(candidateKey(event)), true);
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

test("a failed candidate recovery is reactivated and executed after rediscovery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-recovery-"));
  dirs.push(dir);
  const store = createStore({ dataDir: dir, now: () => 20_000 });
  const id = candidateRecoveryId(event);
  store.scheduleCheck(createCandidateRecovery(event, 1_000, new Error("first failure")));
  store.rescheduleCheck(id, {
    status: "failed",
    attempts: 3,
    nextAttemptAt: 601_000,
    lastError: "exhausted",
  });
  assert.equal(activeCandidateRecoveryKeys(store.snapshot()).size, 0);

  const recoveryKeys = new Set();
  const schedule = createCandidateRecoveryScheduler({
    store,
    recoveryKeys,
    now: () => 20_000,
  });
  const scheduled = await schedule(event, new Error("second failure"));

  assert.equal(scheduled.status, "pending");
  assert.equal(scheduled.attempts, 0);
  assert.equal(scheduled.nextAttemptAt, 140_000);
  assert.match(scheduled.lastError, /second failure/);
  assert.equal(recoveryKeys.has(candidateKey(event)), true);

  let executions = 0;
  const result = await runPendingChecks({
    store,
    handlers: { candidate_recovery: async () => { executions += 1; } },
    now: () => 140_000,
  });
  assert.equal(executions, 1);
  assert.equal(result.completed, 1);
  assert.equal(store.snapshot().pendingChecks[id].status, "completed");
});

test("an exhausted candidate recovery is released and reactivated in the same process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-recovery-live-"));
  dirs.push(dir);
  const store = createStore({ dataDir: dir, now: () => 10_000 });
  const recoveryKeys = new Set();
  const schedule = createCandidateRecoveryScheduler({
    store,
    recoveryKeys,
    now: () => 10_000,
  });
  await schedule(event, new Error("initial failure"));

  const handlers = { candidate_recovery: async () => { throw new Error("still unavailable"); } };
  for (const at of [130_000, 310_000, 610_000]) {
    await runPendingChecks({ store, handlers, now: () => at });
    syncCandidateRecoveryKeys(recoveryKeys, store.snapshot());
  }

  const id = candidateRecoveryId(event);
  assert.equal(store.snapshot().pendingChecks[id].status, "failed");
  assert.equal(recoveryKeys.has(candidateKey(event)), false);

  const reactivated = await createCandidateRecoveryScheduler({
    store,
    recoveryKeys,
    now: () => 700_000,
  })(event, new Error("rediscovered"));
  assert.equal(reactivated.status, "pending");
  assert.equal(reactivated.attempts, 0);
  assert.equal(recoveryKeys.has(candidateKey(event)), true);
});

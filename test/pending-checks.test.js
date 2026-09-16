import test from "node:test";
import assert from "node:assert/strict";
import { PENDING_CHECK_BUCKET_COUNT, selectDueChecks } from "../src/pending-checks.js";

function check(id, type, nextAttemptAt) {
  return { id, type, status: "pending", nextAttemptAt, createdAt: nextAttemptAt };
}

test("interleaves realtime, Pons and other due checks", () => {
  const entries = [
    check("candidate-old", "candidate_recovery", 1),
    check("candidate-new", "candidate_recheck", 5),
    check("pons-old", "pons_inspection", 2),
    check("pons-new", "holders", 4),
    check("other-old", "custom", 3),
  ];
  const selected = selectDueChecks(entries, { at: 10, limit: 20, startBucket: 0 });
  assert.deepEqual(selected.map(({ id }) => id), [
    "candidate-old",
    "pons-old",
    "other-old",
    "pons-new",
    "candidate-new",
  ]);
});

test("rotating start buckets prevents starvation when limit is one", () => {
  const entries = [
    check("candidate", "candidate_recovery", 1),
    check("pons", "pons_inspection", 1),
    check("other", "custom", 1),
  ];
  const ids = Array.from({ length: PENDING_CHECK_BUCKET_COUNT }, (_, startBucket) =>
    selectDueChecks(entries, { at: 10, limit: 1, startBucket })[0].id
  );
  assert.deepEqual(ids, ["candidate", "pons", "other"]);
});

test("selects only due pending checks", () => {
  const selected = selectDueChecks([
    check("due", "candidate_recovery", 10),
    check("future", "candidate_recovery", 11),
    { ...check("expired", "candidate_recovery", 1), status: "expired" },
    { ...check("failed", "candidate_recovery", 1), status: "failed" },
  ], { at: 10, limit: 20, startBucket: 0 });
  assert.deepEqual(selected.map(({ id }) => id), ["due"]);
});

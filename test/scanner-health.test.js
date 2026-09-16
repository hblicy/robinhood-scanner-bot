import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPendingReconciliation,
  formatScannerHealth,
  formatWorkerActivity,
} from "../src/scanner-health.js";

test("formats cursor and queue health without entry payloads or credentials", () => {
  const output = formatScannerHealth({
    cursors: { onchain: 100, ponsV2: 120 },
    pendingChecks: {
      one: {
        status: "pending",
        type: "pons_inspection",
        createdAt: 1_000,
        lastError: "https://rpc.example/secret-key",
      },
      two: { status: "expired", type: "holders", createdAt: 500 },
    },
    outbox: {
      notice: { status: "delivered", text: "token=telegram-secret" },
    },
  }, 4_000);
  assert.match(output, /onchain=100/);
  assert.match(output, /pons=120/);
  assert.match(output, /pending=1/);
  assert.match(output, /expired=1/);
  assert.match(output, /oldestPendingAgeMs=3000/);
  assert.doesNotMatch(output, /secret-key|telegram-secret/);
});

test("formats only non-zero worker activity fields", () => {
  assert.equal(
    formatWorkerActivity("outbox", { delivered: 1, suppressed: 0, retried: 2, failed: 0 }),
    "outbox delivered=1 retried=2"
  );
  assert.equal(formatWorkerActivity("outbox", { delivered: 0, retried: 0, failed: 0 }), null);
});

test("formats startup reconciliation reason counts", () => {
  const output = formatPendingReconciliation({
    scanned: 4,
    expired: 4,
    canonicalCreated: 0,
    reasons: { "outside-alert-window": 4 },
  });
  assert.equal(
    output,
    "pending-reconcile scanned=4 expired=4 canonicalCreated=0 reasons=outside-alert-window:4"
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { drainOutbox, nextRetryAt } from "../src/outbox.js";

test("uses bounded retry delays", () => {
  assert.equal(nextRetryAt(1_000, 1), 6_000);
  assert.equal(nextRetryAt(1_000, 2), 16_000);
  assert.equal(nextRetryAt(1_000, 3), 46_000);
  assert.equal(nextRetryAt(1_000, 99), 301_000);
});

test("delivers due notifications and marks them after send", async () => {
  const order = [];
  const store = {
    listDueOutbox: () => [{ id: "notice-1", text: "hello", attempts: 0 }],
    markOutboxDelivered: (id, at) => order.push(["delivered", id, at]),
    rescheduleOutbox: () => { throw new Error("unexpected retry"); },
  };
  const result = await drainOutbox({
    store,
    send: async (text, entry) => order.push(["send", text, entry.id]),
    now: () => 1_000,
  });
  assert.deepEqual(order, [
    ["send", "hello", "notice-1"],
    ["delivered", "notice-1", 1_000],
  ]);
  assert.deepEqual(result, { delivered: 1, retried: 0, failed: 0 });
});

test("reschedules failed notifications without throwing into the chain loop", async () => {
  const retries = [];
  const store = {
    listDueOutbox: () => [{ id: "notice-1", text: "hello", attempts: 0 }],
    markOutboxDelivered: () => { throw new Error("unexpected delivery"); },
    rescheduleOutbox: (id, retry) => retries.push([id, retry]),
  };
  const result = await drainOutbox({
    store,
    send: async () => { throw new Error("telegram unavailable"); },
    now: () => 1_000,
  });
  assert.equal(result.retried, 1);
  assert.equal(retries[0][0], "notice-1");
  assert.equal(retries[0][1].attempts, 1);
  assert.equal(retries[0][1].nextAttemptAt, 6_000);
  assert.match(retries[0][1].lastError, /telegram unavailable/);
});

test("moves exhausted notifications to a visible failed state", async () => {
  const retries = [];
  const store = {
    listDueOutbox: () => [{ id: "notice-1", text: "hello", attempts: 4 }],
    markOutboxDelivered: () => {},
    rescheduleOutbox: (_id, retry) => retries.push(retry),
  };
  const result = await drainOutbox({
    store,
    send: async () => { throw new Error("permanent failure"); },
    now: () => 1_000,
    maxAttempts: 5,
  });
  assert.equal(result.failed, 1);
  assert.equal(retries[0].status, "failed");
  assert.equal(retries[0].attempts, 5);
});

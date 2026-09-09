import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";

const dirs = [];
const TOKEN = "0x1111111111111111111111111111111111111111";
const EVENT_ID = `4663:${"0x" + "ab".repeat(32)}:7`;

function tokenState(overrides = {}) {
  return {
    token: TOKEN,
    pad: "pons-v2",
    protocolPhase: "not_graduated",
    monitorState: "watchlisted",
    marketReady: false,
    watchlist: true,
    updatedAt: 1000,
    ...overrides,
  };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-store-"));
  dirs.push(dir);
  return dir;
}

function write(dir, file, value) {
  fs.writeFileSync(path.join(dir, file), value);
}

function openStore(dir, overrides = {}) {
  return createStore({
    dataDir: dir,
    now: () => 1000,
    maxSeenEntries: 10,
    seenTtlMs: 100,
    ...overrides,
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createStore", () => {
  it("schedules a generic pending check idempotently without resetting retry state", () => {
    const store = openStore(tempDir());
    const check = {
      id: "candidate-recheck:key",
      type: "candidate_recheck",
      event: { token: TOKEN, venue: "uniswap-v2", pool: "0x2222222222222222222222222222222222222222" },
      firstAnalyzedAt: 1_000,
      dueAt: 121_000,
      retryOffsetsMs: [120_000, 300_000, 600_000],
      maxAttempts: 3,
    };

    store.scheduleCheck(check);
    store.rescheduleCheck(check.id, {
      status: "pending",
      attempts: 1,
      nextAttemptAt: 301_000,
      lastError: "pending",
    });
    store.scheduleCheck(check);

    const saved = store.snapshot().pendingChecks[check.id];
    assert.equal(saved.attempts, 1);
    assert.equal(saved.nextAttemptAt, 301_000);
  });

  it("preserves the initial pending-check error", () => {
    const store = openStore(tempDir());
    store.scheduleCheck({
      id: "candidate-recovery:test",
      type: "candidate_recovery",
      dueAt: 120_000,
      lastError: "server response 429 Too Many Requests",
    });

    assert.match(
      store.snapshot().pendingChecks["candidate-recovery:test"].lastError,
      /429/
    );
  });

  it("preserves historical positions and trades as opaque data", () => {
    const dir = tempDir();
    const positions = {
      [TOKEN.toLowerCase()]: { token: TOKEN, mode: "live", customLegacyField: { keep: true } },
    };
    const trades = [{ side: "buy", token: TOKEN, customLegacyField: [1, 2, 3] }];
    write(dir, "state.json", JSON.stringify({ schemaVersion: 3, seen: {}, positions, trades }));

    const store = openStore(dir);
    store.markSeen("pool", { score: 80 });
    store.setOnchainCursor(123);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.deepEqual(saved.positions, positions);
    assert.deepEqual(saved.trades, trades);
    assert.equal(saved.cursors.onchain, 123);
    assert.equal(openStore(dir).getOnchainCursor(), 123);
  });

  it("persists and reloads a monotonic onchain cursor", () => {
    const dir = tempDir();
    const store = openStore(dir);

    store.setOnchainCursor(123);

    assert.equal(store.getOnchainCursor(), 123);
    assert.equal(openStore(dir).getOnchainCursor(), 123);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(saved.cursors.onchain, 123);
  });

  it("rejects invalid or decreasing onchain cursors", () => {
    const store = openStore(tempDir());
    store.setOnchainCursor(123);
    assert.throws(() => store.setOnchainCursor(122), /cannot move backwards/);
    assert.throws(() => store.setOnchainCursor(1.5), /non-negative integer/);
    assert.throws(() => store.setOnchainCursor(-1), /non-negative integer/);
  });

  it("fails loudly for corrupt positions", () => {
    const dir = tempDir();
    write(dir, "positions.json", "{");
    assert.throws(
      () => createStore({ dataDir: dir, now: () => 1, maxSeenEntries: 10, seenTtlMs: 1000 }),
      /positions\.json/
    );
  });

  it("imports legacy positions without rewriting historical records", () => {
    const dir = tempDir();
    const positions = {
      [TOKEN.toLowerCase()]: { token: TOKEN, mode: "live", remainingPct: 70 },
    };
    write(
      dir,
      "positions.json",
      JSON.stringify(positions)
    );
    const original = fs.readFileSync(path.join(dir, "positions.json"), "utf8");
    createStore({ dataDir: dir, now: () => 1, maxSeenEntries: 10, seenTtlMs: 1000 });
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(persisted.schemaVersion, 5);
    assert.deepEqual(persisted.positions, positions);
    assert.equal(fs.readFileSync(path.join(dir, "positions.json"), "utf8"), original);
  });

  it("expires old seen entries and keeps only the newest configured entries", () => {
    const dir = tempDir();
    write(
      dir,
      "seen.json",
      JSON.stringify({
        old: { token: "old", updatedAt: 1 },
        a: { token: "a", updatedAt: 950 },
        b: { token: "b", updatedAt: 960 },
      })
    );
    const store = createStore({ dataDir: dir, now: () => 1000, maxSeenEntries: 2, seenTtlMs: 100 });
    assert.equal(store.hasSeen("old"), false);
    store.markSeen("c", { score: 1 });
    assert.equal(store.hasSeen("a"), false);
    assert.equal(store.hasSeen("b"), true);
    assert.equal(store.hasSeen("c"), true);
  });

  it("migrates all legacy files into one v4 state without deleting them", () => {
    const dir = tempDir();
    write(dir, "seen.json", JSON.stringify({ a: { token: "a", updatedAt: 999 } }));
    write(dir, "positions.json", JSON.stringify({}));
    write(dir, "trades.json", JSON.stringify([{ side: "buy", token: TOKEN }]));

    openStore(dir);

    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.schemaVersion, 5);
    assert.equal(state.seen.a.token, "a");
    assert.equal(state.trades.length, 1);
    assert.deepEqual(state.cursors, { onchain: null, ponsV2: null, solanaPrograms: {} });
    assert.deepEqual(state.tokens, {});
    assert.deepEqual(state.watchlist, []);
    assert.equal(state.heat, null);
    assert.deepEqual(state.appliedEvents, {});
    assert.deepEqual(state.outbox, {});
    assert.deepEqual(state.pendingChecks, {});
    assert.equal(fs.existsSync(path.join(dir, "seen.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "positions.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "trades.json")), true);
  });

  it("does not mutate in-memory state when an atomic write fails", () => {
    const dir = tempDir();
    let writes = 0;
    const store = openStore(dir, {
      writeState: (_dataDir, state) => {
        writes += 1;
        if (writes > 1) throw new Error("disk full");
        fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
      },
    });

    assert.throws(() => store.setOnchainCursor(123), /disk full/);
    assert.equal(store.getOnchainCursor(), null);
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.deepEqual(state.cursors, { onchain: null, ponsV2: null, solanaPrograms: {} });
  });

  it("keeps the real token address in a composite seen entry", () => {
    const dir = tempDir();
    const store = openStore(dir);
    const key = `uniswap-v2|0xpool|${TOKEN}`;
    store.markSeen(key, { token: TOKEN, score: 80 });
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.seen[key.toLowerCase()].token, TOKEN);
  });

  it("does not reuse or overwrite a fixed state.json.tmp file", () => {
    const dir = tempDir();
    const foreignTemp = path.join(dir, "state.json.tmp");
    fs.writeFileSync(foreignTemp, "foreign-writer");
    openStore(dir);
    assert.equal(fs.readFileSync(foreignTemp, "utf8"), "foreign-writer");
    const transientFiles = fs.readdirSync(dir).filter((name) => /^state\.json\..+\.tmp$/.test(name));
    assert.deepEqual(transientFiles, []);
  });

  it("migrates schema v3 to v4 without losing legacy fields", () => {
    const dir = tempDir();
    const positions = { [TOKEN.toLowerCase()]: { mode: "live", keep: true } };
    const trades = [{ token: TOKEN, side: "buy", keep: true }];
    write(dir, "state.json", JSON.stringify({
      schemaVersion: 3,
      seen: { old: { token: TOKEN, updatedAt: 999 } },
      positions,
      trades,
      cursors: { onchain: 91 },
    }));

    const store = openStore(dir);
    const state = store.snapshot();

    assert.equal(state.schemaVersion, 5);
    assert.deepEqual(state.positions, positions);
    assert.deepEqual(state.trades, trades);
    assert.equal(state.cursors.onchain, 91);
    assert.equal(state.cursors.ponsV2, null);
    assert.deepEqual(state.tokens, {});
    assert.deepEqual(state.watchlist, []);
    assert.deepEqual(state.outbox, {});
    assert.deepEqual(state.pendingChecks, {});
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"))).schemaVersion, 5);
  });

  it("migrates v4 state and atomically commits a Solana program cursor with applied events", () => {
    const dir = tempDir();
    write(dir, "state.json", JSON.stringify({
      schemaVersion: 4,
      seen: {},
      positions: {},
      trades: [],
      cursors: { onchain: 91, ponsV2: 92 },
      tokens: {},
      watchlist: [],
      heat: null,
      appliedEvents: { legacy: { appliedAt: 999 } },
      outbox: { keep: { id: "keep", status: "delivered" } },
      pendingChecks: {},
    }));

    const store = openStore(dir);
    store.commitSolanaProgramRange({
      programId: "pump",
      cursor: { signature: "sig", slot: 101, finalized: false, updatedAt: 1_000 },
      events: [{ eventId: "solana|sig|0", slot: 101 }],
    });
    const state = store.snapshot();
    assert.equal(state.schemaVersion, 5);
    assert.equal(state.cursors.onchain, 91);
    assert.equal(state.cursors.ponsV2, 92);
    assert.equal(state.cursors.solanaPrograms.pump.signature, "sig");
    assert.ok(state.appliedEvents.legacy);
    assert.ok(state.appliedEvents["solana|sig|0"]);
    assert.ok(state.outbox.keep);
  });

  it("atomically commits a Pons range and deduplicates replayed events", () => {
    const dir = tempDir();
    const store = openStore(dir);
    const transition = {
      eventId: EVENT_ID,
      token: TOKEN,
      nextToken: tokenState(),
      notifications: [{ id: `${EVENT_ID}:new_launch`, transitionType: "new_launch", text: "new" }],
      checks: [{ id: `${EVENT_ID}:holders`, type: "holders", dueAt: 1000 }],
    };

    store.commitPonsRange({ toBlock: 120, transitions: [transition] });
    store.commitPonsRange({ toBlock: 120, transitions: [transition] });

    const state = store.snapshot();
    assert.equal(state.cursors.ponsV2, 120);
    assert.deepEqual(state.watchlist, [TOKEN.toLowerCase()]);
    assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "not_graduated");
    assert.equal(Object.keys(state.appliedEvents).length, 1);
    assert.equal(Object.keys(state.outbox).length, 1);
    assert.equal(state.outbox[`${EVENT_ID}:new_launch`].status, "pending");
    assert.equal(Object.keys(state.pendingChecks).length, 1);
  });

  it("does not mutate token or cursor state when a Pons atomic write fails", () => {
    const dir = tempDir();
    let writes = 0;
    const store = openStore(dir, {
      writeState: (_dataDir, state) => {
        writes += 1;
        if (writes > 1) throw new Error("rename failed");
        fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
      },
    });

    assert.throws(() => store.commitPonsRange({
      toBlock: 120,
      transitions: [{ eventId: EVENT_ID, token: TOKEN, nextToken: tokenState() }],
    }), /rename failed/);

    const state = store.snapshot();
    assert.equal(state.cursors.ponsV2, null);
    assert.deepEqual(state.tokens, {});
    assert.deepEqual(state.appliedEvents, {});
  });

  it("transitions outbox and pending checks without losing adjacent entries", () => {
    const store = openStore(tempDir());
    store.commitPonsRange({
      toBlock: 120,
      transitions: [{
        eventId: EVENT_ID,
        token: TOKEN,
        nextToken: tokenState(),
        notifications: [
          { id: `${EVENT_ID}:new_launch`, transitionType: "new_launch", text: "one" },
          { id: `${EVENT_ID}:green`, transitionType: "green", text: "two" },
        ],
        checks: [
          { id: `${EVENT_ID}:holders`, type: "holders", dueAt: 1000 },
          { id: `${EVENT_ID}:market`, type: "market", dueAt: 1000 },
        ],
      }],
    });

    assert.equal(store.listDueOutbox(1000).length, 2);
    store.markOutboxDelivered(`${EVENT_ID}:new_launch`, 1100);
    store.rescheduleOutbox(`${EVENT_ID}:green`, {
      attempts: 1,
      nextAttemptAt: 1500,
      lastError: "timeout",
    });
    store.completeCheck(`${EVENT_ID}:holders`, 1200);
    store.rescheduleCheck(`${EVENT_ID}:market`, {
      attempts: 1,
      nextAttemptAt: 1600,
      lastError: "rate limited",
    });

    const state = store.snapshot();
    assert.equal(state.outbox[`${EVENT_ID}:new_launch`].status, "delivered");
    assert.equal(state.outbox[`${EVENT_ID}:green`].status, "pending");
    assert.equal(state.outbox[`${EVENT_ID}:green`].lastError, "timeout");
    assert.equal(state.pendingChecks[`${EVENT_ID}:holders`].status, "completed");
    assert.equal(state.pendingChecks[`${EVENT_ID}:market`].status, "pending");
    assert.equal(store.listDueOutbox(1499).length, 0);
    assert.equal(store.listDueChecks(1600).length, 1);
  });

  it("marks a queued notification suppressed without deleting its audit record", () => {
    const store = openStore(tempDir());
    store.commitPonsRange({
      toBlock: 10,
      transitions: [{
        eventId: EVENT_ID,
        blockNumber: 10,
        token: TOKEN,
        nextToken: tokenState(),
        notifications: [{
          id: `${EVENT_ID}:new_launch`,
          transitionType: "new_launch",
          text: "noise",
        }],
        checks: [],
      }],
    });

    store.markOutboxSuppressed(`${EVENT_ID}:new_launch`, 1_200);

    const entry = store.snapshot().outbox[`${EVENT_ID}:new_launch`];
    assert.equal(entry.status, "suppressed");
    assert.equal(entry.suppressedAt, 1_200);
    assert.equal(entry.deliveredAt, null);
    assert.equal(store.listDueOutbox(2_000).length, 0);
  });

  it("keeps applied events for seven days and while referenced by outbox", () => {
    const dir = tempDir();
    let clock = 1_000;
    const store = createStore({
      dataDir: dir,
      now: () => clock,
      maxSeenEntries: 10,
      seenTtlMs: 100,
      appliedEventTtlMs: 7 * 86_400_000,
    });
    store.commitPonsRange({
      toBlock: 120,
      transitions: [{
        eventId: EVENT_ID,
        token: TOKEN,
        nextToken: tokenState(),
        notifications: [{ id: `${EVENT_ID}:new_launch`, transitionType: "new_launch", text: "new" }],
      }],
    });
    store.markOutboxDelivered(`${EVENT_ID}:new_launch`, 1100);
    clock += 8 * 86_400_000;
    store.commitPonsRange({ toBlock: 121, transitions: [] });
    assert.ok(store.snapshot().appliedEvents[EVENT_ID]);
  });

  it("atomically applies a pending-check result to its token", () => {
    const store = openStore(tempDir());
    store.commitPonsRange({
      toBlock: 120,
      transitions: [{
        eventId: EVENT_ID,
        token: TOKEN,
        nextToken: tokenState(),
        checks: [{ id: `${EVENT_ID}:holders`, type: "holders", dueAt: 1000 }],
      }],
    });
    store.applyCheckResult(`${EVENT_ID}:holders`, {
      token: TOKEN,
      nextToken: tokenState({ facts: { holderCount: 9 } }),
      completedAt: 1200,
    });
    const state = store.snapshot();
    assert.equal(state.tokens[TOKEN.toLowerCase()].facts.holderCount, 9);
    assert.equal(state.pendingChecks[`${EVENT_ID}:holders`].status, "completed");
    assert.equal(state.pendingChecks[`${EVENT_ID}:holders`].completedAt, 1200);
  });

  it("atomically applies a pending-check result and its outbox notification", () => {
    const store = openStore(tempDir());
    const checkId = `${EVENT_ID}:curve_flow`;
    store.commitPonsRange({
      toBlock: 120,
      transitions: [{
        eventId: EVENT_ID,
        token: TOKEN,
        nextToken: tokenState(),
        checks: [{ id: checkId, type: "curve_flow", dueAt: 1000 }],
      }],
    });
    const notification = {
      id: `${checkId}:hard_kill`,
      eventId: EVENT_ID,
      transitionType: "hard_kill",
      token: TOKEN,
      text: "killed",
    };
    store.applyCheckResult(checkId, {
      token: TOKEN,
      nextToken: { ...store.snapshot().tokens[TOKEN.toLowerCase()], monitorState: "killed" },
      notification,
      completedAt: 1100,
    });
    const state = store.snapshot();
    assert.equal(state.pendingChecks[checkId].status, "completed");
    assert.equal(state.tokens[TOKEN.toLowerCase()].monitorState, "killed");
    assert.equal(state.outbox[notification.id].status, "pending");
  });

  it("atomically updates a reconciled token and its notification", () => {
    const store = openStore(tempDir());
    store.commitTokenUpdate({
      token: TOKEN,
      nextToken: tokenState({ protocolPhase: "rescued", monitorState: "killed", watchlist: false }),
      notification: { id: `reconcile:${TOKEN}:rescued`, text: "rescued", transitionType: "rescued" },
    });
    const state = store.snapshot();
    assert.equal(state.tokens[TOKEN.toLowerCase()].protocolPhase, "rescued");
    assert.ok(state.outbox[`reconcile:${TOKEN}:rescued`]);
  });

  it("persists a heat snapshot independently of lifecycle cursors", () => {
    const store = openStore(tempDir());
    store.setHeat({ decision: "打", admissionCap: 3, calculatedAt: 1000 });
    assert.deepEqual(store.getHeat(), { decision: "打", admissionCap: 3, calculatedAt: 1000 });
    assert.equal(store.getPonsCursor(), null);
  });

  it("atomically persists heat with an optional outbox notification", () => {
    const store = openStore(tempDir());
    store.commitHeat({
      heat: { decision: "不打", admissionCap: 1, calculatedAt: 1000 },
      notification: {
        id: "heat:0:no",
        transitionType: "heat_change",
        token: "market",
        text: "heat changed",
      },
    });
    const state = store.snapshot();
    assert.equal(state.heat.decision, "不打");
    assert.equal(state.outbox["heat:0:no"].status, "pending");
    assert.equal(state.cursors.ponsV2, null);
  });
});

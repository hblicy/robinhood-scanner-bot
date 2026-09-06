import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";

const dirs = [];
const TOKEN = "0x1111111111111111111111111111111111111111";

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
  it("fails loudly for corrupt positions", () => {
    const dir = tempDir();
    write(dir, "positions.json", "{");
    assert.throws(
      () => createStore({ dataDir: dir, now: () => 1, maxSeenEntries: 10, seenTtlMs: 1000 }),
      /positions\.json/
    );
  });

  it("migrates legacy live positions to needs_review", () => {
    const dir = tempDir();
    write(
      dir,
      "positions.json",
      JSON.stringify({ [TOKEN.toLowerCase()]: { token: TOKEN, mode: "live", remainingPct: 70 } })
    );
    const original = fs.readFileSync(path.join(dir, "positions.json"), "utf8");
    const store = createStore({ dataDir: dir, now: () => 1, maxSeenEntries: 10, seenTtlMs: 1000 });
    const position = store.listPositions()[0];
    assert.equal(position.state, "needs_review");
    assert.equal(position.schemaVersion, 2);
    assert.match(position.migrationReason, /verified token amount and route/);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(persisted.schemaVersion, 3);
    assert.equal(persisted.positions[TOKEN.toLowerCase()].state, "needs_review");
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

  it("migrates all legacy files into one v3 state without deleting them", () => {
    const dir = tempDir();
    write(dir, "seen.json", JSON.stringify({ a: { token: "a", updatedAt: 999 } }));
    write(dir, "positions.json", JSON.stringify({}));
    write(dir, "trades.json", JSON.stringify([{ side: "buy", token: TOKEN }]));

    openStore(dir);

    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.schemaVersion, 3);
    assert.equal(state.seen.a.token, "a");
    assert.equal(state.trades.length, 1);
    assert.equal(fs.existsSync(path.join(dir, "seen.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "positions.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "trades.json")), true);
  });

  it("commits a position and its trade in one state snapshot", () => {
    const dir = tempDir();
    const store = openStore(dir);

    store.commitPositionTrade(
      { token: TOKEN, state: "open" },
      { side: "buy", token: TOKEN }
    );

    assert.equal(store.listPositions().length, 1);
    assert.equal(store.listTrades().length, 1);
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.positions[TOKEN.toLowerCase()].state, "open");
    assert.equal(state.trades[0].side, "buy");
  });

  it("removes a closed position and appends its sell in one state snapshot", () => {
    const store = openStore(tempDir());
    store.upsertPosition({ token: TOKEN, state: "open" });

    store.commitPositionTrade(
      null,
      { side: "sell", token: TOKEN },
      { removeToken: TOKEN }
    );

    assert.equal(store.listPositions().length, 0);
    assert.equal(store.listTrades().length, 1);
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

    assert.throws(
      () => store.commitPositionTrade(
        { token: TOKEN, state: "open" },
        { side: "buy", token: TOKEN }
      ),
      /disk full/
    );
    assert.deepEqual(store.listPositions(), []);
    assert.deepEqual(store.listTrades(), []);
  });
});

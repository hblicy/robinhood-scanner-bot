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
    const store = createStore({ dataDir: dir, now: () => 1, maxSeenEntries: 10, seenTtlMs: 1000 });
    const position = store.listPositions()[0];
    assert.equal(position.state, "needs_review");
    assert.equal(position.schemaVersion, 2);
    assert.match(position.migrationReason, /verified token amount and route/);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "positions.json"), "utf8"));
    assert.equal(persisted[TOKEN.toLowerCase()].state, "needs_review");
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
});

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
    assert.equal(persisted.schemaVersion, 3);
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
    assert.deepEqual(state.cursors, {});
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
    assert.deepEqual(state.cursors, {});
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
});

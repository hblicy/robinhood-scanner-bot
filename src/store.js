import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SETTINGS } from "./config.js";

const STATE_VERSION = 3;

function readJson(dataDir, file, fallback) {
  const filePath = path.join(dataDir, file);
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new Error(`cannot parse state file ${filePath}`, { cause });
  }
}

function atomicWriteState(dataDir, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "state.json");
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function validateHistory(positions, trades, source = "state.json") {
  if (!positions || typeof positions !== "object" || Array.isArray(positions)) {
    throw new Error(`${source} positions must contain an object`);
  }
  if (!Array.isArray(trades)) throw new Error(`${source} trades must contain an array`);
}

function validateCursors(cursors) {
  if (!cursors || typeof cursors !== "object" || Array.isArray(cursors)) {
    throw new Error("state.json cursors must contain an object");
  }
  if (cursors.onchain != null && (!Number.isInteger(cursors.onchain) || cursors.onchain < 0)) {
    throw new Error("state.json onchain cursor must be a non-negative integer");
  }
}

export function createStore({
  dataDir,
  now = Date.now,
  maxSeenEntries = 10_000,
  seenTtlMs = 86_400_000,
  writeState = atomicWriteState,
}) {
  let state;
  const stateFile = path.join(dataDir, "state.json");
  if (fs.existsSync(stateFile)) {
    const loaded = readJson(dataDir, "state.json", null);
    if (!loaded || loaded.schemaVersion !== STATE_VERSION) {
      throw new Error(`state.json must use schemaVersion ${STATE_VERSION}`);
    }
    if (!loaded.seen || typeof loaded.seen !== "object" || Array.isArray(loaded.seen)) {
      throw new Error("state.json seen must contain an object");
    }
    const positions = loaded.positions === undefined ? {} : loaded.positions;
    const trades = loaded.trades === undefined ? [] : loaded.trades;
    const cursors = loaded.cursors === undefined ? {} : loaded.cursors;
    validateHistory(positions, trades);
    validateCursors(cursors);
    state = {
      schemaVersion: STATE_VERSION,
      seen: structuredClone(loaded.seen),
      positions: structuredClone(positions),
      trades: structuredClone(trades),
      cursors: structuredClone(cursors),
    };
  } else {
    const seen = readJson(dataDir, "seen.json", {});
    const rawPositions = readJson(dataDir, "positions.json", {});
    const trades = readJson(dataDir, "trades.json", []);
    if (!seen || typeof seen !== "object" || Array.isArray(seen)) {
      throw new Error("seen.json must contain an object");
    }
    validateHistory(rawPositions, trades, "legacy state");
    state = {
      schemaVersion: STATE_VERSION,
      seen,
      positions: rawPositions,
      trades,
      cursors: {},
    };
    writeState(dataDir, state);
  }

  function pruneSeen(seen) {
    const cutoff = now() - seenTtlMs;
    for (const [key, value] of Object.entries(seen)) {
      if (!value || !Number.isFinite(value.updatedAt) || value.updatedAt < cutoff) delete seen[key];
    }
    const newest = Object.entries(seen).sort(
      ([, a], [, b]) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
    );
    for (const [key] of newest.slice(maxSeenEntries)) delete seen[key];
  }

  function commit(mutator) {
    const draft = structuredClone(state);
    const result = mutator(draft);
    writeState(dataDir, draft);
    state = draft;
    return result == null ? result : structuredClone(result);
  }

  return {
    hasSeen(token) {
      const item = state.seen[String(token).toLowerCase()];
      return Boolean(item && Number.isFinite(item.updatedAt) && item.updatedAt >= now() - seenTtlMs);
    },

    markSeen(token, payload) {
      const key = String(token).toLowerCase();
      return commit((draft) => {
        draft.seen[key] = { ...(draft.seen[key] || {}), ...payload, token: key, updatedAt: now() };
        pruneSeen(draft.seen);
        return draft.seen[key] || null;
      });
    },

    getSeen(token) {
      const key = String(token).toLowerCase();
      const item = state.seen[key];
      return item && Number.isFinite(item.updatedAt) && item.updatedAt >= now() - seenTtlMs
        ? structuredClone(item)
        : null;
    },

    getOnchainCursor() {
      return state.cursors.onchain ?? null;
    },

    setOnchainCursor(blockNumber) {
      if (!Number.isInteger(blockNumber) || blockNumber < 0) {
        throw new Error("onchain cursor must be a non-negative integer");
      }
      const current = state.cursors.onchain;
      if (current != null && blockNumber < current) {
        throw new Error(`onchain cursor cannot move backwards from ${current} to ${blockNumber}`);
      }
      if (current === blockNumber) return blockNumber;
      return commit((draft) => {
        draft.cursors.onchain = blockNumber;
        return blockNumber;
      });
    },
  };
}

let defaultStore;

function getDefaultStore() {
  if (!defaultStore) {
    defaultStore = createStore({
      dataDir: DATA_DIR,
      maxSeenEntries: SETTINGS.maxSeenEntries || 10_000,
      seenTtlMs: SETTINGS.seenTtlMs || 86_400_000,
    });
  }
  return defaultStore;
}

export const hasSeen = (...args) => getDefaultStore().hasSeen(...args);
export const markSeen = (...args) => getDefaultStore().markSeen(...args);
export const getSeen = (...args) => getDefaultStore().getSeen(...args);
export const getOnchainCursor = (...args) => getDefaultStore().getOnchainCursor(...args);
export const setOnchainCursor = (...args) => getDefaultStore().setOnchainCursor(...args);

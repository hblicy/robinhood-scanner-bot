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

function migratePositions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("positions.json must contain an object");
  }
  const migrated = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || !value.token) {
      throw new Error(`positions.json contains invalid position ${key}`);
    }
    const position = value.schemaVersion === 2
      ? value
      : {
          ...value,
          schemaVersion: 2,
          state: "needs_review",
          migrationReason: "legacy position lacks verified token amount and route",
        };
    migrated[String(position.token).toLowerCase()] = position;
  }
  return migrated;
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
    if (!Array.isArray(loaded.trades)) throw new Error("state.json trades must contain an array");
    state = {
      schemaVersion: STATE_VERSION,
      seen: loaded.seen,
      positions: migratePositions(loaded.positions),
      trades: loaded.trades,
    };
  } else {
    const seen = readJson(dataDir, "seen.json", {});
    const rawPositions = readJson(dataDir, "positions.json", {});
    const trades = readJson(dataDir, "trades.json", []);
    if (!seen || typeof seen !== "object" || Array.isArray(seen)) {
      throw new Error("seen.json must contain an object");
    }
    if (!Array.isArray(trades)) throw new Error("trades.json must contain an array");
    state = {
      schemaVersion: STATE_VERSION,
      seen,
      positions: migratePositions(rawPositions),
      trades,
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
      return this.hasSeen(key) ? structuredClone(state.seen[key]) : null;
    },

    listPositions() {
      return structuredClone(Object.values(state.positions));
    },

    listTrades() {
      return structuredClone(state.trades);
    },

    upsertPosition(position) {
      return commit((draft) => {
        draft.positions[String(position.token).toLowerCase()] = structuredClone(position);
        return position;
      });
    },

    removePosition(token) {
      return commit((draft) => {
        delete draft.positions[String(token).toLowerCase()];
        return null;
      });
    },

    addTrade(trade) {
      return commit((draft) => {
        const saved = { ...trade, at: now() };
        draft.trades.push(saved);
        return saved;
      });
    },

    commitPositionTrade(position, trade, { removeToken = null } = {}) {
      if (!position && !removeToken) throw new Error("position or removeToken is required");
      if (!trade || typeof trade !== "object") throw new Error("trade is required");
      return commit((draft) => {
        if (removeToken) delete draft.positions[String(removeToken).toLowerCase()];
        if (position) {
          draft.positions[String(position.token).toLowerCase()] = structuredClone(position);
        }
        const saved = { ...trade, at: now() };
        draft.trades.push(saved);
        return { position, trade: saved };
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
export const listPositions = (...args) => getDefaultStore().listPositions(...args);
export const listTrades = (...args) => getDefaultStore().listTrades(...args);
export const upsertPosition = (...args) => getDefaultStore().upsertPosition(...args);
export const removePosition = (...args) => getDefaultStore().removePosition(...args);
export const addTrade = (...args) => getDefaultStore().addTrade(...args);
export const commitPositionTrade = (...args) => getDefaultStore().commitPositionTrade(...args);

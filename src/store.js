import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SETTINGS } from "./config.js";

function readJson(dataDir, file, fallback) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, file);
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new Error(`cannot parse state file ${filePath}`, { cause });
  }
}

function writeJson(dataDir, file, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, file);
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
}) {
  const seen = readJson(dataDir, "seen.json", {});
  const rawPositions = readJson(dataDir, "positions.json", {});
  const positions = migratePositions(rawPositions);
  const trades = readJson(dataDir, "trades.json", []);

  if (!seen || typeof seen !== "object" || Array.isArray(seen)) {
    throw new Error("seen.json must contain an object");
  }
  if (!Array.isArray(trades)) throw new Error("trades.json must contain an array");
  if (Object.values(rawPositions).some((position) => position?.schemaVersion !== 2)) {
    writeJson(dataDir, "positions.json", positions);
  }

  function pruneSeen() {
    const cutoff = now() - seenTtlMs;
    for (const [key, value] of Object.entries(seen)) {
      if (!value || !Number.isFinite(value.updatedAt) || value.updatedAt < cutoff) delete seen[key];
    }
    const newest = Object.entries(seen).sort(
      ([, a], [, b]) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
    );
    for (const [key] of newest.slice(maxSeenEntries)) delete seen[key];
  }

  pruneSeen();

  return {
    hasSeen(token) {
      pruneSeen();
      return Boolean(seen[String(token).toLowerCase()]);
    },

    markSeen(token, payload) {
      const key = String(token).toLowerCase();
      seen[key] = { ...(seen[key] || {}), ...payload, token: key, updatedAt: now() };
      pruneSeen();
      writeJson(dataDir, "seen.json", seen);
      return seen[key] || null;
    },

    getSeen(token) {
      pruneSeen();
      return seen[String(token).toLowerCase()] || null;
    },

    listPositions() {
      return Object.values(positions);
    },

    upsertPosition(position) {
      positions[String(position.token).toLowerCase()] = position;
      writeJson(dataDir, "positions.json", positions);
      return position;
    },

    removePosition(token) {
      delete positions[String(token).toLowerCase()];
      writeJson(dataDir, "positions.json", positions);
    },

    addTrade(trade) {
      const saved = { ...trade, at: now() };
      trades.push(saved);
      writeJson(dataDir, "trades.json", trades);
      return saved;
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
export const upsertPosition = (...args) => getDefaultStore().upsertPosition(...args);
export const removePosition = (...args) => getDefaultStore().removePosition(...args);
export const addTrade = (...args) => getDefaultStore().addTrade(...args);

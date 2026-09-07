import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, SETTINGS } from "./config.js";

const STATE_VERSION = 4;
const MIN_APPLIED_EVENT_TTL_MS = 7 * 86_400_000;

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
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, filePath);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
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
  if (cursors.ponsV2 != null && (!Number.isInteger(cursors.ponsV2) || cursors.ponsV2 < 0)) {
    throw new Error("state.json Pons V2 cursor must be a non-negative integer");
  }
}

function validateObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`state.json ${name} must contain an object`);
  }
}

function emptyLifecycleState() {
  return {
    tokens: {},
    watchlist: [],
    heat: null,
    appliedEvents: {},
    outbox: {},
    pendingChecks: {},
  };
}

export function migrateState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("state.json must contain an object");
  }
  if (![3, STATE_VERSION].includes(raw.schemaVersion)) {
    throw new Error(`state.json must use schemaVersion 3 or ${STATE_VERSION}`);
  }
  validateObject(raw.seen, "seen");
  const positions = raw.positions === undefined ? {} : raw.positions;
  const trades = raw.trades === undefined ? [] : raw.trades;
  validateHistory(positions, trades);
  const cursors = {
    onchain: raw.cursors?.onchain ?? null,
    ponsV2: raw.cursors?.ponsV2 ?? null,
  };
  validateCursors(cursors);

  if (raw.schemaVersion === 3) {
    return {
      schemaVersion: STATE_VERSION,
      seen: structuredClone(raw.seen),
      positions: structuredClone(positions),
      trades: structuredClone(trades),
      cursors,
      ...emptyLifecycleState(),
    };
  }

  const lifecycle = {
    tokens: raw.tokens ?? {},
    watchlist: raw.watchlist ?? [],
    heat: raw.heat ?? null,
    appliedEvents: raw.appliedEvents ?? {},
    outbox: raw.outbox ?? {},
    pendingChecks: raw.pendingChecks ?? {},
  };
  validateObject(lifecycle.tokens, "tokens");
  if (!Array.isArray(lifecycle.watchlist)) throw new Error("state.json watchlist must contain an array");
  validateObject(lifecycle.appliedEvents, "appliedEvents");
  validateObject(lifecycle.outbox, "outbox");
  validateObject(lifecycle.pendingChecks, "pendingChecks");
  return {
    schemaVersion: STATE_VERSION,
    seen: structuredClone(raw.seen),
    positions: structuredClone(positions),
    trades: structuredClone(trades),
    cursors,
    tokens: structuredClone(lifecycle.tokens),
    watchlist: structuredClone(lifecycle.watchlist),
    heat: structuredClone(lifecycle.heat),
    appliedEvents: structuredClone(lifecycle.appliedEvents),
    outbox: structuredClone(lifecycle.outbox),
    pendingChecks: structuredClone(lifecycle.pendingChecks),
  };
}

export function createStore({
  dataDir,
  now = Date.now,
  maxSeenEntries = 10_000,
  seenTtlMs = 86_400_000,
  appliedEventTtlMs = MIN_APPLIED_EVENT_TTL_MS,
  writeState = atomicWriteState,
}) {
  let state;
  const stateFile = path.join(dataDir, "state.json");
  if (fs.existsSync(stateFile)) {
    const loaded = readJson(dataDir, "state.json", null);
    state = migrateState(loaded);
    if (loaded.schemaVersion !== STATE_VERSION) writeState(dataDir, state);
  } else {
    const seen = readJson(dataDir, "seen.json", {});
    const rawPositions = readJson(dataDir, "positions.json", {});
    const trades = readJson(dataDir, "trades.json", []);
    if (!seen || typeof seen !== "object" || Array.isArray(seen)) {
      throw new Error("seen.json must contain an object");
    }
    validateHistory(rawPositions, trades, "legacy state");
    state = migrateState({
      schemaVersion: STATE_VERSION,
      seen,
      positions: rawPositions,
      trades,
      cursors: { onchain: null, ponsV2: null },
      ...emptyLifecycleState(),
    });
    writeState(dataDir, state);
  }

  const eventTtlMs = Math.max(MIN_APPLIED_EVENT_TTL_MS, appliedEventTtlMs);

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

  function pruneAppliedEvents(draft) {
    const cutoff = now() - eventTtlMs;
    const referenced = new Set([
      ...Object.values(draft.outbox).map((entry) => entry?.eventId).filter(Boolean),
      ...Object.values(draft.pendingChecks).map((entry) => entry?.eventId).filter(Boolean),
    ]);
    for (const [eventId, entry] of Object.entries(draft.appliedEvents)) {
      if (referenced.has(eventId)) continue;
      if (Number.isFinite(entry?.appliedAt) && entry.appliedAt < cutoff) {
        delete draft.appliedEvents[eventId];
      }
    }
  }

  function requireEntry(collection, id, label) {
    const entry = collection[id];
    if (!entry) throw new Error(`${label} not found: ${id}`);
    return entry;
  }

  return {
    snapshot() {
      return structuredClone(state);
    },

    hasSeen(token) {
      const item = state.seen[String(token).toLowerCase()];
      return Boolean(item && Number.isFinite(item.updatedAt) && item.updatedAt >= now() - seenTtlMs);
    },

    markSeen(token, payload) {
      const key = String(token).toLowerCase();
      return commit((draft) => {
        const existing = draft.seen[key] || {};
        draft.seen[key] = {
          ...existing,
          ...payload,
          token: payload?.token ?? existing.token ?? key,
          updatedAt: now(),
        };
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

    getPonsCursor() {
      return state.cursors.ponsV2 ?? null;
    },

    commitPonsRange({ toBlock, transitions }) {
      if (!Number.isInteger(toBlock) || toBlock < 0) {
        throw new Error("Pons V2 cursor must be a non-negative integer");
      }
      if (state.cursors.ponsV2 != null && toBlock < state.cursors.ponsV2) {
        throw new Error(`Pons V2 cursor cannot move backwards from ${state.cursors.ponsV2} to ${toBlock}`);
      }
      if (!Array.isArray(transitions)) throw new Error("Pons transitions must contain an array");
      return commit((draft) => {
        for (const transition of transitions) {
          const eventId = String(transition?.eventId || "");
          if (!eventId) throw new Error("Pons transition eventId is required");
          if (draft.appliedEvents[eventId]) continue;
          const token = String(transition?.token || "").toLowerCase();
          if (!token || !transition?.nextToken || typeof transition.nextToken !== "object") {
            throw new Error(`Pons transition ${eventId} requires token state`);
          }
          draft.tokens[token] = structuredClone(transition.nextToken);
          const watchlist = new Set(draft.watchlist.map((value) => String(value).toLowerCase()));
          if (transition.nextToken.watchlist) watchlist.add(token);
          else watchlist.delete(token);
          draft.watchlist = [...watchlist];

          for (const notification of transition.notifications || []) {
            if (!notification?.id) throw new Error(`Pons transition ${eventId} notification id is required`);
            if (!draft.outbox[notification.id]) {
              draft.outbox[notification.id] = {
                ...structuredClone(notification),
                eventId,
                status: "pending",
                attempts: 0,
                nextAttemptAt: now(),
                createdAt: now(),
                deliveredAt: null,
                lastError: null,
              };
            }
          }
          for (const check of transition.checks || []) {
            if (!check?.id) throw new Error(`Pons transition ${eventId} check id is required`);
            if (!draft.pendingChecks[check.id]) {
              draft.pendingChecks[check.id] = {
                ...structuredClone(check),
                eventId,
                status: "pending",
                attempts: 0,
                nextAttemptAt: check.dueAt ?? now(),
                createdAt: now(),
                completedAt: null,
                lastError: null,
              };
            }
          }
          draft.appliedEvents[eventId] = {
            appliedAt: now(),
            blockNumber: transition.blockNumber ?? null,
          };
        }
        draft.cursors.ponsV2 = toBlock;
        pruneAppliedEvents(draft);
        return draft.cursors.ponsV2;
      });
    },

    listDueOutbox(at = now(), limit = 20) {
      return Object.values(state.outbox)
        .filter((entry) => entry.status === "pending" && entry.nextAttemptAt <= at)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)
        .slice(0, limit)
        .map((entry) => structuredClone(entry));
    },

    markOutboxDelivered(id, deliveredAt = now()) {
      return commit((draft) => {
        const entry = requireEntry(draft.outbox, id, "outbox entry");
        entry.status = "delivered";
        entry.deliveredAt = deliveredAt;
        entry.lastError = null;
        return entry;
      });
    },

    rescheduleOutbox(id, retry) {
      return commit((draft) => {
        const entry = requireEntry(draft.outbox, id, "outbox entry");
        entry.status = retry.status || "pending";
        entry.attempts = retry.attempts;
        entry.nextAttemptAt = retry.nextAttemptAt;
        entry.lastError = retry.lastError;
        return entry;
      });
    },

    listDueChecks(at = now(), limit = 20) {
      return Object.values(state.pendingChecks)
        .filter((entry) => entry.status === "pending" && entry.nextAttemptAt <= at)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)
        .slice(0, limit)
        .map((entry) => structuredClone(entry));
    },

    completeCheck(id, completedAt = now()) {
      return commit((draft) => {
        const entry = requireEntry(draft.pendingChecks, id, "pending check");
        entry.status = "completed";
        entry.completedAt = completedAt;
        entry.lastError = null;
        return entry;
      });
    },

    rescheduleCheck(id, retry) {
      return commit((draft) => {
        const entry = requireEntry(draft.pendingChecks, id, "pending check");
        entry.status = retry.status || "pending";
        entry.attempts = retry.attempts;
        entry.nextAttemptAt = retry.nextAttemptAt;
        entry.lastError = retry.lastError;
        return entry;
      });
    },

    applyCheckResult(id, { token, nextToken, completedAt = now() }) {
      const key = String(token || "").toLowerCase();
      if (!key || !nextToken || typeof nextToken !== "object") {
        throw new Error(`pending check ${id} requires token state`);
      }
      return commit((draft) => {
        const entry = requireEntry(draft.pendingChecks, id, "pending check");
        draft.tokens[key] = structuredClone(nextToken);
        const watchlist = new Set(draft.watchlist.map((value) => String(value).toLowerCase()));
        if (nextToken.watchlist) watchlist.add(key);
        else watchlist.delete(key);
        draft.watchlist = [...watchlist];
        entry.status = "completed";
        entry.completedAt = completedAt;
        entry.lastError = null;
        return entry;
      });
    },

    commitTokenUpdate({ token, nextToken, notification = null, check = null }) {
      const key = String(token || "").toLowerCase();
      if (!key || !nextToken || typeof nextToken !== "object") {
        throw new Error("token update requires token state");
      }
      return commit((draft) => {
        draft.tokens[key] = structuredClone(nextToken);
        const watchlist = new Set(draft.watchlist.map((value) => String(value).toLowerCase()));
        if (nextToken.watchlist) watchlist.add(key);
        else watchlist.delete(key);
        draft.watchlist = [...watchlist];
        if (notification?.id && !draft.outbox[notification.id]) {
          draft.outbox[notification.id] = {
            ...structuredClone(notification),
            eventId: notification.eventId ?? null,
            status: "pending",
            attempts: 0,
            nextAttemptAt: now(),
            createdAt: now(),
            deliveredAt: null,
            lastError: null,
          };
        }
        if (check?.id && !draft.pendingChecks[check.id]) {
          draft.pendingChecks[check.id] = {
            ...structuredClone(check),
            eventId: check.eventId ?? null,
            status: "pending",
            attempts: 0,
            nextAttemptAt: check.dueAt ?? now(),
            createdAt: now(),
            completedAt: null,
            lastError: null,
          };
        }
        return draft.tokens[key];
      });
    },
  };
}

let defaultStore;

export function getDefaultStore() {
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
export const getPonsCursor = (...args) => getDefaultStore().getPonsCursor(...args);
export const commitPonsRange = (...args) => getDefaultStore().commitPonsRange(...args);

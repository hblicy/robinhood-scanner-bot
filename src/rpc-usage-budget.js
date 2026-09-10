function utcMonth(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("RPC budget clock is invalid");
  return date.toISOString().slice(0, 7);
}

function stageFor(total, limit) {
  const ratio = total / limit;
  if (ratio >= 1) return "exhausted";
  if (ratio >= 0.95) return "critical";
  if (ratio >= 0.8) return "throttled";
  return "normal";
}

function emptyState(month) {
  return { schemaVersion: 1, month, total: 0, methods: {} };
}

function normalizeInitial(initial, month) {
  if (initial == null || initial.month !== month) return emptyState(month);
  if (!Number.isInteger(initial.total) || initial.total < 0) {
    throw new Error("RPC usage total must be a non-negative integer");
  }
  if (!initial.methods || typeof initial.methods !== "object" || Array.isArray(initial.methods)) {
    throw new Error("RPC usage methods must be an object");
  }
  const methods = {};
  for (const [method, count] of Object.entries(initial.methods)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`RPC usage count for ${method} must be a non-negative integer`);
    }
    methods[method] = count;
  }
  return { schemaVersion: 1, month, total: initial.total, methods };
}

function cloneState(state) {
  return { ...state, methods: { ...state.methods } };
}

export function createRpcUsageBudget({ limit, initial = null, persist = null, now = Date.now } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("RPC monthly limit must be a positive integer");
  }
  if (persist != null && typeof persist !== "function") {
    throw new Error("RPC usage persist must be a function");
  }
  let state = normalizeInitial(initial, utcMonth(now()));
  let dirty = false;

  return Object.freeze({
    record(method) {
      if (typeof method !== "string" || method.trim() === "") {
        throw new Error("RPC method must be a non-empty string");
      }
      state.total += 1;
      state.methods[method] = (state.methods[method] ?? 0) + 1;
      dirty = true;
      return stageFor(state.total, limit);
    },
    assertAllowed(role) {
      if (stageFor(state.total, limit) === "exhausted" && role !== "discovery-public") {
        const error = new Error("rpc-budget-exhausted");
        error.code = "rpc-budget-exhausted";
        throw error;
      }
    },
    flush() {
      if (!dirty) return false;
      persist?.(cloneState(state));
      dirty = false;
      return true;
    },
    snapshot() {
      const snapshot = cloneState(state);
      snapshot.limit = limit;
      snapshot.stage = stageFor(state.total, limit);
      snapshot.methods = Object.freeze(snapshot.methods);
      return Object.freeze(snapshot);
    },
  });
}

import { isRateLimitError } from "./chain.js";

export const ANALYSIS_RPC_COOLDOWN_MS = 15 * 60_000;

export class AnalysisRpcCooldownError extends Error {
  constructor() {
    super("analysis RPC is cooling down after rate limiting");
    this.name = "AnalysisRpcCooldownError";
    this.code = "ANALYSIS_RPC_COOLDOWN";
  }
}

export function bindAnalysisCircuit({ circuit, analyze, onOpen } = {}) {
  if (!circuit || typeof circuit.run !== "function") {
    throw new Error("analysis RPC circuit is required");
  }
  if (typeof analyze !== "function") throw new Error("analysis function is required");
  return async (candidate) => {
    const outcome = await circuit.run(() => analyze(candidate), { onOpen });
    if (outcome.status === "cooldown") throw new AnalysisRpcCooldownError();
    return outcome.value;
  };
}

export function createAnalysisRpcCircuit({
  now = Date.now,
  cooldownMs = ANALYSIS_RPC_COOLDOWN_MS,
  isRateLimit = isRateLimitError,
} = {}) {
  if (typeof now !== "function") throw new Error("analysis RPC circuit requires a clock");
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    throw new Error("analysis RPC cooldown must be positive");
  }
  let open = false;
  let openUntil = 0;
  let probing = false;
  let notified = false;

  function enter() {
    if (!open) return true;
    if (now() < openUntil || probing) return false;
    probing = true;
    return true;
  }

  function succeed() {
    open = false;
    openUntil = 0;
    probing = false;
    notified = false;
  }

  function fail(error) {
    probing = false;
    if (!isRateLimit(error)) {
      if (open && now() >= openUntil) succeed();
      return { rateLimited: false, notify: false };
    }
    open = true;
    openUntil = now() + cooldownMs;
    const notify = !notified;
    notified = true;
    return { rateLimited: true, notify };
  }

  return Object.freeze({
    async run(work, { onOpen } = {}) {
      if (typeof work !== "function") throw new Error("analysis RPC circuit work is required");
      if (!enter()) return { status: "cooldown" };
      try {
        const value = await work();
        succeed();
        return { status: "ok", value };
      } catch (error) {
        const transition = fail(error);
        if (transition.notify && typeof onOpen === "function") await onOpen(error);
        throw error;
      }
    },
    snapshot() {
      return Object.freeze({ open, openUntil, probing, notified });
    },
  });
}

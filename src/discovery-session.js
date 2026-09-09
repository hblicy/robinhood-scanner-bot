import { safeErrorMessage } from "./safety.js";

export function createDiscoverySessionRunner({
  primary,
  fallback = null,
  shouldFallback,
  cooldownMs,
  now = Date.now,
  log = console.warn,
}) {
  if (!primary) throw new Error("primary discovery provider is required");
  if (typeof shouldFallback !== "function") throw new Error("shouldFallback must be a function");
  if (!Number.isInteger(cooldownMs) || cooldownMs <= 0) {
    throw new Error("cooldownMs must be a positive integer");
  }
  let openUntil = 0;
  let probeInFlight = false;
  let openingError = null;

  async function onFallback(work, primaryError = openingError) {
    if (!fallback) throw primaryError;
    try {
      return await work(fallback);
    } catch (fallbackError) {
      throw new AggregateError(
        [primaryError, fallbackError].filter(Boolean),
        "discovery session failed on primary and fallback"
      );
    }
  }

  async function run(work) {
    if (typeof work !== "function") throw new Error("discovery work must be a function");
    const current = now();
    if (fallback && current < openUntil) return onFallback(work);
    if (fallback && probeInFlight) return onFallback(work);

    const probing = Boolean(fallback && openUntil > 0);
    if (probing) probeInFlight = true;
    try {
      const result = await work(primary);
      if (probing) {
        openUntil = 0;
        openingError = null;
        log("发现 RPC 已恢复，后续扫描切回主节点");
      }
      return result;
    } catch (error) {
      if (!fallback || !shouldFallback(error)) throw error;
      const firstOpen = openUntil === 0;
      openingError = error;
      openUntil = now() + cooldownMs;
      if (firstOpen) log(`发现 RPC 进入熔断：${safeErrorMessage(error)}`);
      return onFallback(work, error);
    } finally {
      if (probing) probeInFlight = false;
    }
  }

  return { run };
}

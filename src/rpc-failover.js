import { safeErrorMessage } from "./safety.js";

export function createFailoverProvider({
  primary,
  fallback,
  shouldFallback,
  cooldownMs,
  now = Date.now,
  log = console.warn,
}) {
  if (!primary || !fallback) throw new Error("primary and fallback providers are required");
  if (typeof shouldFallback !== "function") throw new Error("shouldFallback must be a function");
  if (!Number.isInteger(cooldownMs) || cooldownMs <= 0) {
    throw new Error("cooldownMs must be a positive integer");
  }

  let circuitOpen = false;
  let openUntil = 0;
  let probeInFlight = false;

  const runFallback = async (method, args, primaryError = null) => {
    try {
      return await fallback[method](...args);
    } catch (fallbackError) {
      if (!primaryError) throw fallbackError;
      throw new AggregateError(
        [primaryError, fallbackError],
        `discovery RPC ${String(method)} failed on primary and fallback`
      );
    }
  };

  const open = (error, renewCooldown) => {
    const changed = !circuitOpen;
    circuitOpen = true;
    if (changed || renewCooldown) openUntil = now() + cooldownMs;
    if (changed) {
      log(`发现 RPC 进入熔断，临时使用分析备用节点：${safeErrorMessage(error)}`);
    }
  };

  const invoke = async (method, args) => {
    const current = now();
    if (circuitOpen && current < openUntil) return runFallback(method, args);
    if (circuitOpen && probeInFlight) return runFallback(method, args);

    const probing = circuitOpen;
    if (probing) probeInFlight = true;
    try {
      const result = await primary[method](...args);
      if (probing) {
        circuitOpen = false;
        openUntil = 0;
        log("发现 RPC 已恢复，切回官方节点");
      }
      return result;
    } catch (error) {
      if (!shouldFallback(error)) throw error;
      open(error, probing);
      return runFallback(method, args, error);
    } finally {
      if (probing) probeInFlight = false;
    }
  };

  return new Proxy(primary, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => invoke(property, args);
    },
  });
}

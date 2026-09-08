export const RPC_CU = Object.freeze({
  getBlockNumber: 10,
  getBlock: 20,
  getCode: 20,
  getLogs: 60,
  getTransaction: 17,
  getTransactionReceipt: 20,
  call: 26,
});

export const DEFAULT_RPC_CUPS = 350;

export function createRpcScheduler({
  cuPerSecond = DEFAULT_RPC_CUPS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isFinite(cuPerSecond) || cuPerSecond <= 0) {
    throw new Error("cuPerSecond must be positive");
  }
  let nextStartAt = 0;
  return async (cost, operation) => {
    if (!Number.isFinite(cost) || cost <= 0) throw new Error("RPC cost must be positive");
    if (typeof operation !== "function") throw new Error("RPC operation must be a function");
    const current = now();
    const reservedAt = Math.max(current, nextStartAt);
    nextStartAt = reservedAt + Math.ceil((cost * 1000) / cuPerSecond);
    const delay = Math.max(0, reservedAt - current);
    if (delay > 0) await sleep(delay);
    return operation();
  };
}

export function createBudgetedProvider(provider, schedule) {
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const cost = RPC_CU[property];
      if (!cost) return value.bind(target);
      return (...args) => schedule(cost, () => value.apply(target, args));
    },
  });
}

import { createAssetCatalog, serializeAssetCatalog } from "./catalog.js";

export function createAssetCatalogCache({ readJson, atomicWriteJson }) {
  if (typeof readJson !== "function") throw new Error("readJson must be a function");
  if (typeof atomicWriteJson !== "function") {
    throw new Error("atomicWriteJson must be a function");
  }

  const stats = { runtimeHits: 0, shippedHits: 0, refreshSuccesses: 0, refreshFailures: 0 };
  return Object.freeze({
    load({ shippedPath, runtimePath }) {
      let runtimeError = null;
      try {
        const runtime = readJson(runtimePath);
        if (runtime != null) {
          const catalog = createAssetCatalog(runtime);
          stats.runtimeHits += 1;
          return catalog;
        }
      } catch (error) {
        runtimeError = error;
      }
      try {
        const shipped = readJson(shippedPath);
        if (shipped == null) throw new Error("asset catalog snapshot not found");
        const catalog = createAssetCatalog(shipped);
        stats.shippedHits += 1;
        return catalog;
      } catch (error) {
        if (runtimeError) {
          throw new AggregateError(
            [runtimeError, error],
            "runtime and shipped asset catalog snapshots are invalid"
          );
        }
        throw error;
      }
    },

    async refresh({ current, runtimePath, load }) {
      try {
        const next = createAssetCatalog(await load());
        await atomicWriteJson(runtimePath, serializeAssetCatalog(next));
        stats.refreshSuccesses += 1;
        return { catalog: next, status: "fresh", error: null };
      } catch (error) {
        stats.refreshFailures += 1;
        return { catalog: current, status: "stale", error };
      }
    },
    snapshot() {
      return Object.freeze({ ...stats });
    },
  });
}

export function createAssetRefreshScheduler({
  current,
  enabled,
  intervalMs,
  refresh,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  onError = () => {},
}) {
  if (!current) throw new Error("asset refresh scheduler requires a current catalog");
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("asset refresh interval must be a positive integer");
  }
  if (typeof refresh !== "function") throw new Error("asset refresh must be a function");
  let catalog = current;
  let timer = null;
  const run = async () => {
    try {
      const result = await refresh(catalog);
      catalog = result?.catalog ?? result ?? catalog;
      if (result?.error) onError(result.error);
      return result;
    } catch (error) {
      onError(error);
      return { catalog, status: "stale", error };
    }
  };
  return Object.freeze({
    async start() {
      if (!enabled || timer != null) return false;
      await run();
      timer = setIntervalImpl(run, intervalMs);
      timer?.unref?.();
      return true;
    },
    stop() {
      if (timer == null) return false;
      clearIntervalImpl(timer);
      timer = null;
      return true;
    },
    currentCatalog() {
      return catalog;
    },
  });
}

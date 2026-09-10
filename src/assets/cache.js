import { createAssetCatalog, serializeAssetCatalog } from "./catalog.js";

export function createAssetCatalogCache({ readJson, atomicWriteJson }) {
  if (typeof readJson !== "function") throw new Error("readJson must be a function");
  if (typeof atomicWriteJson !== "function") {
    throw new Error("atomicWriteJson must be a function");
  }

  return Object.freeze({
    load({ shippedPath, runtimePath }) {
      const document = readJson(runtimePath) ?? readJson(shippedPath);
      if (document == null) throw new Error("asset catalog snapshot not found");
      return createAssetCatalog(document);
    },

    async refresh({ current, runtimePath, load }) {
      try {
        const next = createAssetCatalog(await load());
        await atomicWriteJson(runtimePath, serializeAssetCatalog(next));
        return { catalog: next, status: "fresh", error: null };
      } catch (error) {
        return { catalog: current, status: "stale", error };
      }
    },
  });
}

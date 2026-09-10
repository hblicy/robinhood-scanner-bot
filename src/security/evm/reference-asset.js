import { getAddress } from "ethers";

const DEFAULT_CACHE = new Map();

function uniqueRestrictions(values) {
  return [...new Set((values ?? [])
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim()))];
}

function unavailable(asset) {
  return Object.freeze({
    status: "unknown",
    restrictions: Object.freeze(uniqueRestrictions([
      ...(asset.restrictions ?? []),
      "reference-check-unavailable",
    ])),
    capabilities: Object.freeze({ policy: null, pause: null, multiplier: null }),
  });
}

export async function inspectReferenceAsset(asset, {
  cache = DEFAULT_CACHE,
  readBytecodeHash,
  readPolicies,
} = {}) {
  if (!asset || typeof asset !== "object") throw new Error("reference asset is required");
  if (typeof readBytecodeHash !== "function" || typeof readPolicies !== "function") {
    return unavailable(asset);
  }
  let chain;
  let address;
  try {
    chain = String(asset.chain).toLowerCase();
    if (!chain) throw new Error("missing chain");
    address = getAddress(asset.address).toLowerCase();
    const latestKey = `${chain}:${address}:latest`;
    const cachedKey = cache.get(latestKey);
    if (typeof cachedKey === "string" && cache.has(cachedKey)) return cache.get(cachedKey);

    const bytecodeHash = String(await readBytecodeHash({ ...asset, chain, address }));
    if (!/^0x[0-9a-fA-F]+$/.test(bytecodeHash)) throw new Error("invalid bytecode hash");
    const key = `${chain}:${address}:${bytecodeHash.toLowerCase()}`;
    if (cache.has(key)) {
      cache.set(latestKey, key);
      return cache.get(key);
    }
    const policy = await readPolicies({ ...asset, chain, address, bytecodeHash });
    const capabilities = policy?.capabilities ?? {};
    const result = Object.freeze({
      status: "known",
      restrictions: Object.freeze(uniqueRestrictions([
        ...(asset.restrictions ?? []),
        ...(policy?.restrictions ?? []),
      ])),
      capabilities: Object.freeze({
        policy: capabilities.policy === true,
        pause: capabilities.pause === true,
        multiplier: capabilities.multiplier === true,
      }),
      bytecodeHash: bytecodeHash.toLowerCase(),
    });
    cache.set(key, result);
    cache.set(latestKey, key);
    return result;
  } catch {
    return unavailable(asset);
  }
}

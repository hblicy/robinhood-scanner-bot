import { Contract, getAddress, id } from "ethers";
import { B20_READ_ABI } from "../../abis.js";

const DEFAULT_CACHE = new Map();
const B20_TRANSFER_POLICY_SCOPES = Object.freeze([
  id("TRANSFER_SENDER_POLICY"),
  id("TRANSFER_RECEIVER_POLICY"),
  id("TRANSFER_EXECUTOR_POLICY"),
]);

export async function readB20ReferencePolicies(asset, {
  provider,
  contractFactory = (address, abi, runner) => new Contract(address, abi, runner),
} = {}) {
  const contract = contractFactory(getAddress(asset.address), B20_READ_ABI, provider);
  const [multiplier, paused, ...policyIds] = await Promise.all([
    contract.multiplier(),
    contract.isPaused(0),
    ...B20_TRANSFER_POLICY_SCOPES.map((scope) => contract.policyId(scope)),
  ]);
  return { multiplier, paused, policyIds };
}

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
  readB20,
} = {}) {
  if (!asset || typeof asset !== "object") throw new Error("reference asset is required");
  if (typeof readBytecodeHash !== "function") {
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
    const isB20 = chain === "base" && typeof readB20 === "function";
    if (!isB20 && typeof readPolicies !== "function") return unavailable(asset);
    const policy = isB20
      ? await readB20({ ...asset, chain, address, bytecodeHash })
      : await readPolicies({ ...asset, chain, address, bytecodeHash });
    if (isB20) {
      const multiplier = BigInt(policy?.multiplier);
      if (multiplier <= 0n || typeof policy?.paused !== "boolean" || !Array.isArray(policy?.policyIds)) {
        throw new Error("invalid B20 policy response");
      }
      const policyIds = policy.policyIds.map((value) => {
        const id = BigInt(value);
        if (id < 0n || id > 0xffffffffffffffffn) throw new Error("invalid B20 policy id");
        return id.toString();
      });
      const result = Object.freeze({
        status: "complete",
        standard: "B20",
        multiplier: multiplier.toString(),
        paused: policy.paused,
        policyIds: Object.freeze(policyIds),
        restrictions: Object.freeze(uniqueRestrictions([
          ...(asset.restrictions ?? []),
          ...(policyIds.some((id) => id !== "0") ? ["transfer-policy"] : []),
          ...(policy.paused ? ["reference-asset-restricted"] : []),
        ])),
        capabilities: Object.freeze({ policy: true, pause: true, multiplier: true }),
        bytecodeHash: bytecodeHash.toLowerCase(),
      });
      cache.set(key, result);
      cache.set(latestKey, key);
      return result;
    }
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

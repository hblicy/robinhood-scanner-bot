import { getAddress } from "ethers";
import { createLaunchpadSecurityEntry } from "./index.js";

const DEFAULT_COOLDOWN_MS = 20_000;

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

export function createO1SecurityEntry({
  chain,
  venue,
  factory,
  hook,
  poolManager,
  assetCatalog,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now,
}) {
  if (!assetCatalog || typeof assetCatalog.lookup !== "function") {
    throw new Error(`${chain}|${venue} trusted asset catalog is required`);
  }
  const expected = {
    factory: getAddress(factory),
    hook: getAddress(hook),
    poolManager: getAddress(poolManager),
  };

  return createLaunchpadSecurityEntry({
    chain,
    venue,
    isPoolResolved: (candidate) => candidate.metadata?.poolResolved === true,
    excludedAddresses: Object.values(expected),
    quoteRecipientAddresses: [expected.poolManager, expected.hook],
    async bind(candidate) {
      const quote = assetCatalog.lookup(candidate.quoteToken);
      if (!quote || quote.kind !== "stock") return { ok: false, reason: "asset-unverified" };
      const metadata = candidate.metadata ?? {};
      const identityMatches = sameAddress(candidate.pool, expected.poolManager)
        && sameAddress(metadata.factory, expected.factory)
        && sameAddress(metadata.hook, expected.hook)
        && sameAddress(metadata.poolManager, expected.poolManager)
        && /^0x[0-9a-fA-F]{64}$/.test(String(candidate.poolId ?? ""));
      if (!identityMatches) return { ok: false, reason: "pool-binding-mismatch" };

      const launchedAt = candidate.createdAt ?? candidate.pairCreatedAt;
      if (Number.isFinite(launchedAt)) {
        const elapsed = now() - launchedAt;
        if (elapsed >= 0 && elapsed < cooldownMs) {
          return { ok: false, reason: "launch-cooldown" };
        }
      }
      return {
        ok: true,
        pool: expected.poolManager,
        excludedAddresses: [expected.factory, expected.hook],
        quoteRecipientAddresses: [expected.poolManager, expected.hook],
      };
    },
  });
}

import { getAddress } from "ethers";
import { sellabilityResult } from "../../sellability.js";
import { createLaunchpadSecurityEntry } from "./index.js";

function decorate(result, metadata) {
  return {
    ...result,
    taxModel: metadata.taxModel,
    configuredTaxBps: metadata.configuredTaxBps,
    buyTaxBps: metadata.buyTaxBps ?? metadata.configuredTaxBps,
    sellTaxBps: metadata.sellTaxBps ?? metadata.configuredTaxBps,
    vault: metadata.vault ?? null,
    poolResolved: metadata.poolResolved === true,
  };
}

export function createFlapSecurityEntry(profileVenue, {
  assetCatalog,
  maxTaxBps = 500,
  meaningfulThreshold,
} = {}) {
  if (!assetCatalog || typeof assetCatalog.lookup !== "function") {
    throw new Error(`${profileVenue.id} trusted asset catalog is required`);
  }
  if (!Number.isInteger(maxTaxBps) || maxTaxBps < 0 || maxTaxBps > 10_000) {
    throw new Error(`${profileVenue.id} max tax is invalid`);
  }
  const portal = getAddress(profileVenue.contracts.portal);
  const excludedAddresses = Object.values(profileVenue.contracts).map(getAddress);
  const observed = createLaunchpadSecurityEntry({
    chain: "bsc",
    venue: profileVenue.id,
    meaningfulThreshold,
    excludedAddresses,
    isPoolResolved: (candidate) => candidate.metadata?.poolResolved === true,
    async bind(candidate) {
      let pool;
      try {
        pool = getAddress(candidate.pool);
      } catch {
        return { ok: false, reason: "pool-not-resolved" };
      }
      if (pool === portal || excludedAddresses.includes(pool)) {
        return { ok: false, reason: "pool-binding-mismatch" };
      }
      return { ok: true, pool, excludedAddresses };
    },
  });

  return Object.freeze({
    chain: "bsc",
    venue: profileVenue.id,
    async inspect(candidate, dependencies = {}) {
      const metadata = candidate.metadata ?? {};
      if (metadata.poolResolved !== true) {
        return decorate(sellabilityResult("unknown", "pool-not-resolved"), metadata);
      }
      const quote = assetCatalog.lookup(candidate.quoteToken);
      if (!quote || quote.kind !== "stock") {
        return decorate(sellabilityResult("unknown", "asset-unverified"), metadata);
      }
      if (!Number.isInteger(metadata.configuredTaxBps) || !metadata.taxModel) {
        return decorate(sellabilityResult("unknown", "tax-config-unavailable"), metadata);
      }
      if (metadata.configuredTaxBps > maxTaxBps) {
        return decorate(sellabilityResult("blocked", "excessive-tax"), metadata);
      }
      return decorate(await observed.inspect(candidate, dependencies), metadata);
    },
  });
}

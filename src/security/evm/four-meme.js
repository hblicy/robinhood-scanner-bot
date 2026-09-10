import { getAddress } from "ethers";
import { createLaunchpadSecurityEntry } from "./index.js";

export function createFourMemeSecurityEntry(profileVenue, options = {}) {
  const manager = getAddress(profileVenue.contracts.manager);
  const excludedAddresses = Object.values(profileVenue.contracts).map(getAddress);
  return createLaunchpadSecurityEntry({
    chain: "bsc",
    venue: profileVenue.id,
    meaningfulThreshold: options.meaningfulThreshold,
    excludedAddresses,
    isPoolResolved: (candidate) => candidate.metadata?.poolResolved === true,
    async bind(candidate) {
      let pool;
      try {
        pool = getAddress(candidate.pool);
      } catch {
        return { ok: false, reason: "pool-not-resolved" };
      }
      if (pool === manager) return { ok: false, reason: "pool-not-resolved" };
      return { ok: true, pool, excludedAddresses };
    },
  });
}

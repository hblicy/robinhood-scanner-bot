import { inspectSellability, sellabilityResult } from "../../sellability.js";
import { observeSellReceipts } from "./observed-sells.js";

function entryKey(chain, venue) {
  return `${String(chain).toLowerCase()}|${String(venue).toLowerCase()}`;
}

export function createEvmSecurityRegistry(entries) {
  if (!Array.isArray(entries)) throw new Error("security registry entries must be an array");
  const byVenue = new Map();
  for (const entry of entries) {
    if (!entry?.chain || !entry?.venue || typeof entry.inspect !== "function") {
      throw new Error("invalid EVM security registry entry");
    }
    const key = entryKey(entry.chain, entry.venue);
    if (byVenue.has(key)) throw new Error(`duplicate EVM security adapter ${key}`);
    byVenue.set(key, entry);
  }
  return Object.freeze({
    inspect(candidate, dependencies = {}) {
      const adapter = byVenue.get(entryKey(candidate?.chain, candidate?.venue));
      if (!adapter) return sellabilityResult("unknown", "unsupported-venue");
      return adapter.inspect(candidate, dependencies);
    },
  });
}

export function createObservedSellSecurityEntry({
  chain,
  venue,
  bind,
  meaningfulThreshold = 1n,
  excludedAddresses = [],
  quoteRecipientAddresses = [],
}) {
  if (typeof bind !== "function") throw new Error(`${chain}|${venue} security binding is required`);
  return Object.freeze({
    chain,
    venue,
    async inspect(candidate, dependencies = {}) {
      const binding = await bind(candidate, dependencies);
      if (!binding?.ok) {
        const reason = binding?.reason || "evidence-unavailable";
        return sellabilityResult(
          reason === "pool-binding-mismatch" ? "blocked" : "unknown",
          reason,
          { details: binding?.details }
        );
      }
      if (typeof dependencies.getObservedSellReceipts !== "function") {
        return sellabilityResult("unknown", "evidence-unavailable", {
          details: ["observed sell receipt reader unavailable"],
        });
      }
      const receipts = await dependencies.getObservedSellReceipts(candidate, binding);
      const observed = observeSellReceipts({
        receipts,
        token: candidate.token,
        quote: candidate.quoteToken,
        pool: binding.pool || candidate.pool,
        vaults: binding.vaults,
        excludedAddresses: [...excludedAddresses, ...(binding.excludedAddresses ?? [])],
        quoteRecipientAddresses: [
          ...quoteRecipientAddresses,
          ...(binding.quoteRecipientAddresses ?? []),
        ],
        meaningfulThreshold: binding.meaningfulThreshold ?? meaningfulThreshold,
      });
      const evidence = {
        evidenceMode: "observed-sells",
        bindingVerified: true,
        meaningfulSellers: observed.meaningfulSellers,
        quoteOutflowReceipts: observed.quoteOutflowReceipts,
        details: [`checked ${observed.receiptSamples} successful or candidate receipts`],
      };
      if (observed.meaningfulSellers < 3 || observed.quoteOutflowReceipts < 3) {
        return sellabilityResult("unknown", "insufficient-meaningful-sells", evidence);
      }
      return sellabilityResult("confirmed", null, evidence);
    },
  });
}

export function createV2SecurityEntry({
  chain,
  venue,
  factoryAddress,
  wrappedNative,
  excludedAddresses = [],
}) {
  return Object.freeze({
    chain,
    venue,
    async inspect(candidate, dependencies = {}) {
      const inspect = dependencies.inspectV2Sellability ?? inspectSellability;
      const result = await inspect({
        ...candidate,
        quote: candidate.quoteToken,
        blockNumber: candidate.blockOrSlot ?? candidate.blockNumber ?? null,
      }, {
        ...dependencies,
        expectedVenue: venue,
        factoryAddress,
        wrappedNative,
        excludedAddresses,
      });
      if (result?.reason === "pool-binding-mismatch") {
        return sellabilityResult("blocked", "pool-binding-mismatch", result);
      }
      return result;
    },
  });
}

export function createLaunchpadSecurityEntry({
  isPoolResolved,
  ...options
}) {
  if (typeof isPoolResolved !== "function") {
    throw new Error(`${options.chain}|${options.venue} pool resolution check is required`);
  }
  const observedEntry = createObservedSellSecurityEntry(options);
  return Object.freeze({
    chain: options.chain,
    venue: options.venue,
    inspect(candidate, dependencies = {}) {
      if (!isPoolResolved(candidate)) {
        return sellabilityResult("unknown", "pool-not-resolved");
      }
      return observedEntry.inspect(candidate, dependencies);
    },
  });
}

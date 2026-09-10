import { Contract, getAddress } from "ethers";
import { STONKS_EXCHANGE_ABI, V3_FACTORY_STATE_ABI } from "../../abis.js";
import { createLaunchpadSecurityEntry } from "./index.js";

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

export async function readStonksLaunchState(candidate, {
  provider,
  launcher,
  launcherImplementation,
  uniswapV3Factory,
}) {
  const launcherContract = new Contract(launcher, STONKS_EXCHANGE_ABI, provider);
  const [state, implementationSlot] = await Promise.all([
    launcherContract.tokenInfo(candidate.token),
    provider.getStorage(launcher, EIP1967_IMPLEMENTATION_SLOT, candidate.analysisBlock),
  ]);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(implementationSlot))) {
    throw new Error(`invalid EIP-1967 implementation slot for ${launcher}`);
  }
  const implementation = getAddress(`0x${implementationSlot.slice(-40)}`);
  if (!sameAddress(implementation, launcherImplementation)) {
    return { implementation };
  }
  const factory = new Contract(uniswapV3Factory, V3_FACTORY_STATE_ABI, provider);
  const factoryPool = await factory.getPool(state.token, state.quote, state.fee);
  return {
    token: state.token,
    creator: state.creator,
    pool: state.pool,
    quote: state.quote,
    tokenId: state.tokenId.toString(),
    fee: Number(state.fee),
    createdAt: Number(state.createdAt),
    implementation,
    factoryPool,
  };
}

export function createStonksExchangeSecurityEntry(venue, {
  assetCatalog,
  readLaunchState,
} = {}) {
  if (!assetCatalog || typeof assetCatalog.lookup !== "function") {
    throw new Error(`${venue.id} trusted asset catalog is required`);
  }
  const expected = Object.fromEntries(Object.entries(venue.contracts)
    .map(([key, value]) => [key, getAddress(value)]));
  const stateReader = readLaunchState ?? ((candidate, dependencies) => readStonksLaunchState(candidate, {
    provider: dependencies.provider,
    launcher: expected.launcher,
    launcherImplementation: expected.launcherImplementation,
    uniswapV3Factory: expected.uniswapV3Factory,
  }));

  return createLaunchpadSecurityEntry({
    chain: "base",
    venue: venue.id,
    isPoolResolved: (candidate) => candidate.metadata?.poolResolved === true,
    excludedAddresses: Object.values(expected),
    async bind(candidate, dependencies) {
      const quote = assetCatalog.lookup(candidate.quoteToken);
      if (!quote || quote.kind !== "stock") return { ok: false, reason: "asset-unverified" };
      const metadata = candidate.metadata ?? {};
      const staticIdentityMatches = sameAddress(metadata.launcher, expected.launcher)
        && sameAddress(metadata.feeLocker, expected.feeLocker)
        && sameAddress(metadata.quoteRegistry, expected.quoteRegistry)
        && sameAddress(metadata.uniswapV3Factory, expected.uniswapV3Factory)
        && sameAddress(metadata.positionManager, expected.positionManager);
      if (!staticIdentityMatches) return { ok: false, reason: "pool-binding-mismatch" };

      const state = await stateReader(candidate, dependencies);
      const stateMatches = sameAddress(state.token, candidate.token)
        && sameAddress(state.creator, candidate.creator)
        && sameAddress(state.pool, candidate.pool)
        && sameAddress(state.quote, candidate.quoteToken)
        && String(state.tokenId) === String(metadata.tokenId)
        && Number(state.fee) === Number(metadata.fee)
        && sameAddress(state.implementation, expected.launcherImplementation)
        && sameAddress(state.factoryPool, candidate.pool);
      if (!stateMatches) return { ok: false, reason: "pool-binding-mismatch" };
      const decimals = Number(candidate.decimals);
      const meaningfulThreshold = Number.isInteger(decimals) && decimals >= 0
        ? 10n ** BigInt(decimals)
        : 1n;
      return {
        ok: true,
        pool: getAddress(candidate.pool),
        excludedAddresses: Object.values(expected),
        quoteRecipientAddresses: [getAddress(candidate.pool)],
        meaningfulThreshold,
      };
    },
  });
}

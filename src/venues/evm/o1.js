import { Interface, getAddress } from "ethers";
import { O1_LAUNCH_FACTORY_ABI } from "../../abis.js";
import { withLegacyPairAliases } from "../../assets/pair.js";

const iface = new Interface(O1_LAUNCH_FACTORY_ABI);

export function createO1Adapter({
  id = "o1-v4-robinhood",
  factory,
  hook,
  poolManager,
  classifyPair,
  version = 1,
}) {
  if (typeof classifyPair !== "function") throw new Error(`${id} pair classifier is required`);
  const factoryAddress = getAddress(factory);
  const hookAddress = getAddress(hook);
  const poolManagerAddress = getAddress(poolManager);

  return Object.freeze({
    id,
    sourceKind: "launchpad",
    version,
    addresses: Object.freeze([factoryAddress]),
    topics: Object.freeze([iface.getEvent("Launched").topicHash]),
    parse(log) {
      if (getAddress(log.address) !== factoryAddress) {
        throw new Error(`O1 factory mismatch: ${log.address}`);
      }
      const args = iface.parseLog(log).args;
      const picked = withLegacyPairAliases(classifyPair(args.token, args.quoteToken));
      if (!picked) return null;
      return {
        ...picked,
        pool: poolManagerAddress,
        poolId: String(args.poolId).toLowerCase(),
        creator: getAddress(args.originalCreator),
        lifecyclePhase: "new_launch",
        metadata: {
          factory: factoryAddress,
          hook: hookAddress,
          poolManager: poolManagerAddress,
          poolResolved: true,
          launchSupply: args.launchSupply.toString(),
          tickSpacing: Number(args.tickSpacing),
        },
      };
    },
  });
}

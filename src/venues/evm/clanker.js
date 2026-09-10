import { Interface, getAddress } from "ethers";
import { CLANKER_V4_ABI } from "../../abis.js";
import { createLegacyPairClassifier, withLegacyPairAliases } from "../../assets/pair.js";

const clankerInterface = new Interface(CLANKER_V4_ABI);

export function createClankerAdapter({
  id,
  address,
  poolManagerAddress,
  quoteAddresses = [],
  classifyPair,
  version = 1,
}) {
  const factory = getAddress(address);
  const poolManager = getAddress(poolManagerAddress);
  const classify = classifyPair ?? createLegacyPairClassifier({
    referenceAssets: quoteAddresses,
    normalizeAddress: getAddress,
  });
  return Object.freeze({
    id,
    sourceKind: "launchpad",
    version,
    addresses: Object.freeze([factory]),
    topics: Object.freeze([clankerInterface.getEvent("TokenCreated").topicHash]),
    parse(log) {
      const args = clankerInterface.parseLog(log).args;
      const picked = withLegacyPairAliases(classify(args.tokenAddress, args.pairedToken));
      if (!picked) return null;
      return {
        ...picked,
        pool: poolManager,
        poolId: String(args.poolId).toLowerCase(),
        creator: getAddress(args.tokenAdmin),
        lifecyclePhase: "new_launch",
        metadata: {
          msgSender: getAddress(args.msgSender),
          tokenName: args.tokenName,
          tokenSymbol: args.tokenSymbol,
          startingTick: Number(args.startingTick),
          poolHook: getAddress(args.poolHook),
          locker: getAddress(args.locker),
          mevModule: getAddress(args.mevModule),
        },
      };
    },
  });
}

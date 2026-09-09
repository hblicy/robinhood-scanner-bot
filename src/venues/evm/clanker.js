import { Interface, getAddress } from "ethers";
import { CLANKER_V4_ABI } from "../../abis.js";

const clankerInterface = new Interface(CLANKER_V4_ABI);

export function createClankerAdapter({
  id,
  address,
  poolManagerAddress,
  quoteAddresses,
  version = 1,
}) {
  const factory = getAddress(address);
  const poolManager = getAddress(poolManagerAddress);
  const quotes = new Set(quoteAddresses.map((value) => getAddress(value).toLowerCase()));
  return Object.freeze({
    id,
    sourceKind: "launchpad",
    version,
    addresses: Object.freeze([factory]),
    topics: Object.freeze([clankerInterface.getEvent("TokenCreated").topicHash]),
    parse(log) {
      const args = clankerInterface.parseLog(log).args;
      const quoteToken = getAddress(args.pairedToken);
      if (!quotes.has(quoteToken.toLowerCase())) return null;
      return {
        token: getAddress(args.tokenAddress),
        quoteToken,
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

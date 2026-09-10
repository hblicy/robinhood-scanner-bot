import { Interface, getAddress } from "ethers";
import { STONKS_EXCHANGE_ABI } from "../../abis.js";
import { withLegacyPairAliases } from "../../assets/pair.js";

const iface = new Interface(STONKS_EXCHANGE_ABI);

export function createStonksExchangeAdapter({
  id = "stonks-exchange-base",
  launcher,
  launcherImplementation,
  feeLocker,
  quoteRegistry,
  uniswapV3Factory,
  positionManager,
  classifyPair,
  version = 1,
}) {
  if (typeof classifyPair !== "function") throw new Error(`${id} pair classifier is required`);
  const expected = {
    launcher: getAddress(launcher),
    launcherImplementation: getAddress(launcherImplementation),
    feeLocker: getAddress(feeLocker),
    quoteRegistry: getAddress(quoteRegistry),
    uniswapV3Factory: getAddress(uniswapV3Factory),
    positionManager: getAddress(positionManager),
  };
  return Object.freeze({
    id,
    sourceKind: "launchpad",
    version,
    addresses: Object.freeze([expected.launcher]),
    topics: Object.freeze([iface.getEvent("TokenLaunched").topicHash]),
    parse(log) {
      if (getAddress(log.address) !== expected.launcher) {
        throw new Error(`Stonks Exchange launcher mismatch: ${log.address}`);
      }
      const args = iface.parseLog(log).args;
      if (getAddress(args.feeLocker) !== expected.feeLocker) {
        throw new Error(`Stonks Exchange fee locker mismatch: ${args.feeLocker}`);
      }
      const picked = withLegacyPairAliases(classifyPair(args.token, args.quote));
      if (!picked || picked.referenceAssetKind !== "stock") return null;
      return {
        ...picked,
        pool: getAddress(args.pool),
        creator: getAddress(args.creator),
        lifecyclePhase: "new_launch",
        metadata: {
          ...expected,
          poolResolved: true,
          tokenId: args.tokenId.toString(),
          fee: Number(args.fee),
          launchTick: Number(args.launchTick),
          totalSupply: args.totalSupply.toString(),
        },
      };
    },
  });
}

import { Interface, getAddress } from "ethers";
import { PANCAKE_INFINITY_CL_ABI } from "../../abis.js";
import { createUniswapV2Adapter, createUniswapV3Adapter } from "./uniswap.js";
import { createLegacyPairClassifier, withLegacyPairAliases } from "../../assets/pair.js";

const infinityInterface = new Interface(PANCAKE_INFINITY_CL_ABI);

export function createPancakeV2Adapter(options) {
  return createUniswapV2Adapter(options);
}

export function createPancakeV3Adapter(options) {
  return createUniswapV3Adapter(options);
}

export function createPancakeInfinityAdapter({
  id,
  address,
  quoteAddresses = [],
  classifyPair,
  version = 1,
}) {
  const poolManager = getAddress(address);
  const classify = classifyPair ?? createLegacyPairClassifier({
    referenceAssets: quoteAddresses,
    normalizeAddress: getAddress,
  });
  return Object.freeze({
    id,
    sourceKind: "dex",
    version,
    addresses: Object.freeze([poolManager]),
    topics: Object.freeze([infinityInterface.getEvent("Initialize").topicHash]),
    parse(log) {
      const args = infinityInterface.parseLog(log).args;
      const picked = withLegacyPairAliases(classify(args.currency0, args.currency1));
      if (!picked) return null;
      return {
        ...picked,
        pool: poolManager,
        poolId: String(args.id).toLowerCase(),
        creator: null,
        lifecyclePhase: "new_pool",
        metadata: {
          hooks: getAddress(args.hooks),
          fee: Number(args.fee),
          parameters: String(args.parameters).toLowerCase(),
          sqrtPriceX96: args.sqrtPriceX96.toString(),
          tick: Number(args.tick),
        },
      };
    },
  });
}

import { Interface, getAddress } from "ethers";
import { V2_FACTORY_ABI, V3_FACTORY_ABI, V4_PM_ABI } from "../../abis.js";
import { createLegacyPairClassifier, withLegacyPairAliases } from "../../assets/pair.js";

const v2Interface = new Interface(V2_FACTORY_ABI);
const v3Interface = new Interface(V3_FACTORY_ABI);
const v4Interface = new Interface(V4_PM_ABI);

function baseAdapter({ id, address, quoteAddresses = [], classifyPair, iface, eventName, version, parse }) {
  const adapterAddress = getAddress(address);
  const classify = classifyPair ?? createLegacyPairClassifier({
    referenceAssets: quoteAddresses,
    normalizeAddress: getAddress,
  });
  return Object.freeze({
    id,
    sourceKind: "dex",
    version,
    addresses: Object.freeze([adapterAddress]),
    topics: Object.freeze([iface.getEvent(eventName).topicHash]),
    parse(log) {
      const decoded = iface.parseLog(log);
      return parse(decoded.args, classify, adapterAddress);
    },
  });
}

export function createUniswapV2Adapter({ id, address, quoteAddresses, classifyPair, version = 1 }) {
  return baseAdapter({
    id,
    address,
    quoteAddresses,
    classifyPair,
    iface: v2Interface,
    eventName: "PairCreated",
    version,
    parse(args, classify) {
      const picked = withLegacyPairAliases(classify(args.token0, args.token1));
      if (!picked) return null;
      return {
        ...picked,
        pool: getAddress(args.pair),
        poolId: null,
        creator: null,
        lifecyclePhase: "new_pool",
        metadata: {},
      };
    },
  });
}

export function createUniswapV3Adapter({ id, address, quoteAddresses, classifyPair, version = 1 }) {
  return baseAdapter({
    id,
    address,
    quoteAddresses,
    classifyPair,
    iface: v3Interface,
    eventName: "PoolCreated",
    version,
    parse(args, classify) {
      const picked = withLegacyPairAliases(classify(args.token0, args.token1));
      if (!picked) return null;
      return {
        ...picked,
        pool: getAddress(args.pool),
        poolId: null,
        creator: null,
        lifecyclePhase: "new_pool",
        metadata: {
          fee: Number(args.fee),
          tickSpacing: Number(args.tickSpacing),
        },
      };
    },
  });
}

export function createUniswapV4Adapter({ id, address, quoteAddresses, classifyPair, version = 1 }) {
  return baseAdapter({
    id,
    address,
    quoteAddresses,
    classifyPair,
    iface: v4Interface,
    eventName: "Initialize",
    version,
    parse(args, classify, poolManager) {
      const picked = withLegacyPairAliases(classify(args.currency0, args.currency1));
      if (!picked) return null;
      return {
        ...picked,
        pool: poolManager,
        poolId: String(args.id).toLowerCase(),
        creator: null,
        lifecyclePhase: "new_pool",
        metadata: {
          fee: Number(args.fee),
          tickSpacing: Number(args.tickSpacing),
          hooks: getAddress(args.hooks),
          sqrtPriceX96: args.sqrtPriceX96.toString(),
          tick: Number(args.tick),
        },
      };
    },
  });
}

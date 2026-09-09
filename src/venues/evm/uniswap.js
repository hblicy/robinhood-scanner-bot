import { Interface, getAddress } from "ethers";
import { V2_FACTORY_ABI, V3_FACTORY_ABI, V4_PM_ABI } from "../../abis.js";

const v2Interface = new Interface(V2_FACTORY_ABI);
const v3Interface = new Interface(V3_FACTORY_ABI);
const v4Interface = new Interface(V4_PM_ABI);

function quoteSet(addresses) {
  return new Set(addresses.map((address) => getAddress(address).toLowerCase()));
}

function pickToken(token0, token1, quotes) {
  const a = getAddress(token0);
  const b = getAddress(token1);
  const aQuote = quotes.has(a.toLowerCase());
  const bQuote = quotes.has(b.toLowerCase());
  if (aQuote && !bQuote) return { token: b, quoteToken: a };
  if (bQuote && !aQuote) return { token: a, quoteToken: b };
  return null;
}

function baseAdapter({ id, address, quoteAddresses, iface, eventName, version, parse }) {
  const adapterAddress = getAddress(address);
  const quotes = quoteSet(quoteAddresses);
  return Object.freeze({
    id,
    sourceKind: "dex",
    version,
    addresses: Object.freeze([adapterAddress]),
    topics: Object.freeze([iface.getEvent(eventName).topicHash]),
    parse(log) {
      const decoded = iface.parseLog(log);
      return parse(decoded.args, quotes, adapterAddress);
    },
  });
}

export function createUniswapV2Adapter({ id, address, quoteAddresses, version = 1 }) {
  return baseAdapter({
    id,
    address,
    quoteAddresses,
    iface: v2Interface,
    eventName: "PairCreated",
    version,
    parse(args, quotes) {
      const picked = pickToken(args.token0, args.token1, quotes);
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

export function createUniswapV3Adapter({ id, address, quoteAddresses, version = 1 }) {
  return baseAdapter({
    id,
    address,
    quoteAddresses,
    iface: v3Interface,
    eventName: "PoolCreated",
    version,
    parse(args, quotes) {
      const picked = pickToken(args.token0, args.token1, quotes);
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

export function createUniswapV4Adapter({ id, address, quoteAddresses, version = 1 }) {
  return baseAdapter({
    id,
    address,
    quoteAddresses,
    iface: v4Interface,
    eventName: "Initialize",
    version,
    parse(args, quotes, poolManager) {
      const picked = pickToken(args.currency0, args.currency1, quotes);
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

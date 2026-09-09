import { Interface, getAddress } from "ethers";
import { PANCAKE_INFINITY_CL_ABI } from "../../abis.js";
import { createUniswapV2Adapter, createUniswapV3Adapter } from "./uniswap.js";

const infinityInterface = new Interface(PANCAKE_INFINITY_CL_ABI);

export function createPancakeV2Adapter(options) {
  return createUniswapV2Adapter(options);
}

export function createPancakeV3Adapter(options) {
  return createUniswapV3Adapter(options);
}

export function createPancakeInfinityAdapter({ id, address, quoteAddresses, version = 1 }) {
  const poolManager = getAddress(address);
  const quotes = new Set(quoteAddresses.map((value) => getAddress(value).toLowerCase()));
  return Object.freeze({
    id,
    sourceKind: "dex",
    version,
    addresses: Object.freeze([poolManager]),
    topics: Object.freeze([infinityInterface.getEvent("Initialize").topicHash]),
    parse(log) {
      const args = infinityInterface.parseLog(log).args;
      const currency0 = getAddress(args.currency0);
      const currency1 = getAddress(args.currency1);
      const zeroIsQuote = quotes.has(currency0.toLowerCase());
      const oneIsQuote = quotes.has(currency1.toLowerCase());
      if (zeroIsQuote === oneIsQuote) return null;
      return {
        token: zeroIsQuote ? currency1 : currency0,
        quoteToken: zeroIsQuote ? currency0 : currency1,
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

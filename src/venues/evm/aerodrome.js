import { Interface, getAddress } from "ethers";
import {
  AERODROME_CLASSIC_FACTORY_ABI,
  AERODROME_SLIPSTREAM_FACTORY_ABI,
} from "../../abis.js";
import { createLegacyPairClassifier, withLegacyPairAliases } from "../../assets/pair.js";

const classicInterface = new Interface(AERODROME_CLASSIC_FACTORY_ABI);
const slipstreamInterface = new Interface(AERODROME_SLIPSTREAM_FACTORY_ABI);

function adapter({ id, address, quoteAddresses = [], classifyPair, iface, parse, version }) {
  const factory = getAddress(address);
  const classify = classifyPair ?? createLegacyPairClassifier({
    referenceAssets: quoteAddresses,
    normalizeAddress: getAddress,
  });
  return Object.freeze({
    id,
    sourceKind: "dex",
    version,
    addresses: Object.freeze([factory]),
    topics: Object.freeze([iface.getEvent("PoolCreated").topicHash]),
    parse(log) {
      const args = iface.parseLog(log).args;
      const picked = withLegacyPairAliases(classify(args.token0, args.token1));
      if (!picked) return null;
      return parse(args, picked);
    },
  });
}

export function createAerodromeClassicAdapter({
  id,
  address,
  quoteAddresses,
  classifyPair,
  version = 1,
}) {
  return adapter({
    id,
    address,
    quoteAddresses,
    classifyPair,
    iface: classicInterface,
    version,
    parse(args, picked) {
      return {
        ...picked,
        pool: getAddress(args.pool),
        poolId: null,
        creator: null,
        lifecyclePhase: "new_pool",
        metadata: {
          stable: Boolean(args.stable),
          poolIndex: args[4].toString(),
        },
      };
    },
  });
}

export function createAerodromeSlipstreamAdapter({
  id,
  address,
  quoteAddresses,
  classifyPair,
  version = 1,
}) {
  return adapter({
    id,
    address,
    quoteAddresses,
    classifyPair,
    iface: slipstreamInterface,
    version,
    parse(args, picked) {
      return {
        ...picked,
        pool: getAddress(args.pool),
        poolId: null,
        creator: null,
        lifecyclePhase: "new_pool",
        metadata: { tickSpacing: Number(args.tickSpacing) },
      };
    },
  });
}

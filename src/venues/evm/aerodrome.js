import { Interface, getAddress } from "ethers";
import {
  AERODROME_CLASSIC_FACTORY_ABI,
  AERODROME_SLIPSTREAM_FACTORY_ABI,
} from "../../abis.js";

const classicInterface = new Interface(AERODROME_CLASSIC_FACTORY_ABI);
const slipstreamInterface = new Interface(AERODROME_SLIPSTREAM_FACTORY_ABI);

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

function adapter({ id, address, quoteAddresses, iface, parse, version }) {
  const factory = getAddress(address);
  const quotes = quoteSet(quoteAddresses);
  return Object.freeze({
    id,
    sourceKind: "dex",
    version,
    addresses: Object.freeze([factory]),
    topics: Object.freeze([iface.getEvent("PoolCreated").topicHash]),
    parse(log) {
      const args = iface.parseLog(log).args;
      const picked = pickToken(args.token0, args.token1, quotes);
      if (!picked) return null;
      return parse(args, picked);
    },
  });
}

export function createAerodromeClassicAdapter({
  id,
  address,
  quoteAddresses,
  version = 1,
}) {
  return adapter({
    id,
    address,
    quoteAddresses,
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
  version = 1,
}) {
  return adapter({
    id,
    address,
    quoteAddresses,
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

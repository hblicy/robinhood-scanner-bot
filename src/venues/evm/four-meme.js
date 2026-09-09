import { Contract, Interface, ZeroAddress, getAddress } from "ethers";
import {
  FOUR_MEME_HELPER_ABI,
  FOUR_MEME_V2_ABI,
  V2_FACTORY_ABI,
  V3_FACTORY_ABI,
} from "../../abis.js";

const fourMemeInterface = new Interface(FOUR_MEME_V2_ABI);
const v2Interface = new Interface(V2_FACTORY_ABI);
const v3Interface = new Interface(V3_FACTORY_ABI);
const DEFAULT_HELPER = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";
const DEFAULT_PANCAKE_FACTORIES = new Set([
  "0xca143ce32fe78f1f7019d7d551a6402fc5350c73",
  "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
]);

function sameAddress(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

async function readTokenInfo({ provider, token, blockTag, helperAddress }) {
  const helper = new Contract(helperAddress, FOUR_MEME_HELPER_ABI, provider);
  const value = await helper.getTokenInfo(token, { blockTag });
  return { version: Number(value.version), tokenManager: value.tokenManager, quote: value.quote };
}

async function findMigrationPool({ provider, transactionHash, token, quoteToken }) {
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (!receipt || Number(receipt.status) !== 1) return null;
  const pools = [];
  for (const log of receipt.logs ?? []) {
    if (!DEFAULT_PANCAKE_FACTORIES.has(String(log.address).toLowerCase())) continue;
    let parsed;
    if (sameAddress(log.topics?.[0], v2Interface.getEvent("PairCreated").topicHash)) {
      parsed = v2Interface.parseLog(log);
      if ([parsed.args.token0, parsed.args.token1].some((value) => sameAddress(value, token))
        && [parsed.args.token0, parsed.args.token1].some((value) => sameAddress(value, quoteToken))) {
        pools.push(getAddress(parsed.args.pair));
      }
    } else if (sameAddress(log.topics?.[0], v3Interface.getEvent("PoolCreated").topicHash)) {
      parsed = v3Interface.parseLog(log);
      if ([parsed.args.token0, parsed.args.token1].some((value) => sameAddress(value, token))
        && [parsed.args.token0, parsed.args.token1].some((value) => sameAddress(value, quoteToken))) {
        pools.push(getAddress(parsed.args.pool));
      }
    }
  }
  const unique = [...new Set(pools.map((value) => value.toLowerCase()))];
  if (unique.length > 1) throw new Error(`multiple migration pools found for ${token}`);
  return pools[0] ?? null;
}

export function createFourMemeAdapter({
  id,
  address,
  wrappedNative,
  helperAddress = DEFAULT_HELPER,
  resolveTokenInfo = readTokenInfo,
  resolveMigrationPool = findMigrationPool,
  version = 1,
}) {
  const manager = getAddress(address);
  const helper = getAddress(helperAddress);
  const wrapped = getAddress(wrappedNative);
  return Object.freeze({
    id,
    sourceKind: "launchpad",
    version,
    addresses: Object.freeze([manager]),
    topics: Object.freeze([
      fourMemeInterface.getEvent("TokenCreate").topicHash,
      fourMemeInterface.getEvent("LiquidityAdded").topicHash,
    ]),
    async parse(log, { provider } = {}) {
      const parsed = fourMemeInterface.parseLog(log);
      if (parsed.name === "TokenCreate") {
        const token = getAddress(parsed.args.token);
        const info = await resolveTokenInfo({
          provider,
          token,
          blockTag: Number(log.blockNumber),
          helperAddress: helper,
        });
        if (!sameAddress(info.tokenManager, manager)) {
          throw new Error(`Four.meme token manager mismatch for ${token}`);
        }
        const quote = getAddress(info.quote);
        const quoteToken = sameAddress(quote, ZeroAddress) ? wrapped : quote;
        return {
          token,
          quoteToken,
          pool: manager,
          poolId: null,
          creator: getAddress(parsed.args.creator),
          lifecyclePhase: "new_launch",
          metadata: {
            requestId: parsed.args.requestId.toString(),
            name: parsed.args.name,
            symbol: parsed.args.symbol,
            launchTime: Number(parsed.args.launchTime),
            poolResolved: false,
          },
        };
      }

      const token = getAddress(parsed.args.token1);
      const rawQuote = getAddress(parsed.args.token2);
      const quoteToken = sameAddress(rawQuote, ZeroAddress) ? wrapped : rawQuote;
      const pool = await resolveMigrationPool({
        provider,
        transactionHash: log.transactionHash,
        token,
        quoteToken,
      });
      return {
        token,
        quoteToken,
        pool: pool ?? manager,
        poolId: null,
        creator: null,
        lifecyclePhase: "graduated",
        metadata: {
          poolResolved: Boolean(pool),
          tokenAmount: parsed.args.token1Amount.toString(),
          quoteAmount: parsed.args.token2Amount.toString(),
        },
      };
    },
  });
}

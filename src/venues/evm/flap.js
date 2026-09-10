import { Contract, Interface, ZeroAddress, getAddress } from "ethers";
import { FLAP_PORTAL_ABI, FLAP_PORTAL_STATE_ABI, POOL_TOKEN_ABI } from "../../abis.js";
import { withLegacyPairAliases } from "../../assets/pair.js";

const iface = new Interface(FLAP_PORTAL_ABI);

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function taxModel(tokenVersion, configuredTaxBps) {
  if (configuredTaxBps === 0) return "standard";
  if (Number.isInteger(configuredTaxBps) && [4, 5, 6].includes(tokenVersion)) {
    return `tax-v${tokenVersion - 3}`;
  }
  return null;
}

async function readReceipt(transactionHash, provider) {
  return provider.getTransactionReceipt(transactionHash);
}

async function readPoolTokens(pool, provider) {
  const contract = new Contract(pool, POOL_TOKEN_ABI, provider);
  const [token0, token1] = await Promise.all([contract.token0(), contract.token1()]);
  return { token0, token1 };
}

async function readTokenContext(token, provider, blockTag, portal) {
  const contract = new Contract(portal, FLAP_PORTAL_STATE_ABI, provider);
  const state = await contract.getTokenV8Safe(token, { blockTag });
  const buyTaxBps = Number(state.buyTaxRate);
  const sellTaxBps = Number(state.sellTaxRate);
  const configuredTaxBps = Math.max(buyTaxBps, sellTaxBps);
  return {
    tokenVersion: Number(state.tokenVersion),
    buyTaxBps,
    sellTaxBps,
    configuredTaxBps,
    quoteToken: getAddress(state.quoteTokenAddress),
    pool: getAddress(state.pool),
  };
}

function parseCreationContext(receipt, portal, token, wrappedNative) {
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error(`Flap creation receipt unavailable for ${token}`);
  }
  let quoteToken = wrappedNative;
  let tokenVersion = null;
  let configuredTaxBps = 0;
  for (const log of receipt.logs ?? []) {
    if (!sameAddress(log.address, portal)) continue;
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed || !sameAddress(parsed.args.token, token)) continue;
    if (parsed.name === "TokenQuoteSet") quoteToken = getAddress(parsed.args.quoteToken);
    if (parsed.name === "TokenVersionSet") tokenVersion = Number(parsed.args.version);
    if (parsed.name === "FlapTokenTaxSet") configuredTaxBps = Number(parsed.args.tax);
  }
  return Object.freeze({
    quoteToken,
    tokenVersion,
    configuredTaxBps,
    buyTaxBps: configuredTaxBps,
    sellTaxBps: configuredTaxBps,
    taxModel: taxModel(tokenVersion, configuredTaxBps),
  });
}

export function createFlapAdapter({
  id = "flap-v5-bsc",
  portal,
  wrappedNative,
  classifyPair,
  getTransactionReceipt = readReceipt,
  resolvePoolTokens = readPoolTokens,
  resolveTokenContext = null,
  version = 1,
}) {
  if (typeof classifyPair !== "function") throw new Error(`${id} pair classifier is required`);
  const portalAddress = getAddress(portal);
  const wrapped = getAddress(wrappedNative);
  const contexts = new Map();

  return Object.freeze({
    id,
    sourceKind: "launchpad",
    version,
    addresses: Object.freeze([portalAddress]),
    topics: Object.freeze([
      iface.getEvent("TokenCreated").topicHash,
      iface.getEvent("LaunchedToDEX").topicHash,
    ]),
    async parse(log, { provider } = {}) {
      if (!sameAddress(log.address, portalAddress)) {
        throw new Error(`Flap Portal mismatch: ${log.address}`);
      }
      const parsed = iface.parseLog(log);
      if (parsed.name === "TokenCreated") {
        const token = getAddress(parsed.args.token);
        const receipt = await getTransactionReceipt(log.transactionHash, provider);
        const context = parseCreationContext(receipt, portalAddress, token, wrapped);
        contexts.set(token.toLowerCase(), context);
        const picked = withLegacyPairAliases(classifyPair(token, context.quoteToken));
        if (!picked || !sameAddress(picked.targetToken, token)) return null;
        return {
          ...picked,
          pool: portalAddress,
          poolId: null,
          creator: getAddress(parsed.args.creator),
          lifecyclePhase: "new_launch",
          metadata: {
            poolResolved: false,
            launchTimestamp: Number(parsed.args.ts),
            nonce: parsed.args.nonce.toString(),
            name: parsed.args.name,
            symbol: parsed.args.symbol,
            metadataUri: parsed.args.meta,
            tokenVersion: context.tokenVersion,
            taxModel: context.taxModel,
            configuredTaxBps: context.configuredTaxBps,
            buyTaxBps: context.buyTaxBps,
            sellTaxBps: context.sellTaxBps,
          },
        };
      }

      const token = getAddress(parsed.args.token);
      const pool = getAddress(parsed.args.pool);
      const pair = await resolvePoolTokens(pool, provider);
      const token0 = getAddress(pair.token0);
      const token1 = getAddress(pair.token1);
      if (![token0, token1].some((value) => sameAddress(value, token))) {
        throw new Error(`Flap migration pool ${pool} does not contain ${token}`);
      }
      const picked = withLegacyPairAliases(classifyPair(token0, token1));
      if (!picked || !sameAddress(picked.targetToken, token)) return null;
      const cached = contexts.get(token.toLowerCase()) ?? null;
      const loadContext = resolveTokenContext ?? ((value, activeProvider, blockTag) =>
        readTokenContext(value, activeProvider, blockTag, portalAddress));
      const loaded = cached ?? await loadContext(token, provider, Number(log.blockNumber));
      if (loaded?.pool && !sameAddress(loaded.pool, ZeroAddress) && !sameAddress(loaded.pool, pool)) {
        throw new Error(`Flap Portal pool mismatch in tx ${log.transactionHash}: ${loaded.pool} != ${pool}`);
      }
      const stateQuote = sameAddress(loaded?.quoteToken, ZeroAddress) ? wrapped : loaded?.quoteToken;
      if (stateQuote && ![token0, token1].some((value) => sameAddress(value, stateQuote))) {
        throw new Error(`Flap Portal quote mismatch in tx ${log.transactionHash}: ${stateQuote}`);
      }
      const buyTaxBps = Number.isInteger(loaded?.buyTaxBps)
        ? loaded.buyTaxBps
        : loaded?.configuredTaxBps;
      const sellTaxBps = Number.isInteger(loaded?.sellTaxBps)
        ? loaded.sellTaxBps
        : loaded?.configuredTaxBps;
      const configuredTaxBps = Number.isInteger(loaded?.configuredTaxBps)
        ? loaded.configuredTaxBps
        : Number.isInteger(buyTaxBps) && Number.isInteger(sellTaxBps)
          ? Math.max(buyTaxBps, sellTaxBps)
          : null;
      const tokenVersion = Number.isInteger(loaded?.tokenVersion) ? loaded.tokenVersion : null;
      return {
        ...picked,
        pool,
        poolId: null,
        creator: null,
        lifecyclePhase: "graduated",
        metadata: {
          poolResolved: true,
          tokenVersion,
          taxModel: loaded?.taxModel ?? taxModel(tokenVersion, configuredTaxBps),
          configuredTaxBps,
          buyTaxBps,
          sellTaxBps,
          migratedTokenAmount: parsed.args.amount.toString(),
          migratedQuoteAmount: parsed.args.eth.toString(),
        },
      };
    },
  });
}

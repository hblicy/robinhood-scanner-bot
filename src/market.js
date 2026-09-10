import { getAddress } from "ethers";
import { ADDR, CHAIN, SETTINGS, isQuote } from "./config.js";
import { safeErrorMessage } from "./safety.js";

const UA = {
  accept: "application/json",
  "user-agent": "robinhood-scanner-bot/1.0",
};
const DEXPAPRIKA_BASE = "https://api.dexpaprika.com";
const V4_GECKO_VENUES = new Set([
  "uniswap-v4",
  "uniswap-v4-robinhood",
  "uniswap-pools-trade",
]);
const GECKO_VENUE_ALIASES = new Map([
  ["uniswap-v2-robinhood", "uniswap-v2"],
]);

function normalizeGeckoVenue(value) {
  const venue = String(value || "unknown");
  return GECKO_VENUE_ALIASES.get(venue.toLowerCase()) || venue;
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function relAddr(id) {
  if (!id) return null;
  const parts = String(id).split("_");
  const raw = parts[1] || parts[0];
  return isEthAddress(raw) ? raw : null;
}

function isEthAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

function hasNonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

function hasNonNegativeInteger(value) {
  if (!hasNonNegativeNumber(value)) return false;
  return Number.isInteger(Number(value));
}

function hasCompleteGeckoScoreFacts(attributes) {
  const tx = attributes?.transactions?.m5;
  return (
    (hasNonNegativeNumber(attributes?.market_cap_usd) || hasNonNegativeNumber(attributes?.fdv_usd))
    && hasNonNegativeNumber(attributes?.reserve_in_usd)
    && hasNonNegativeNumber(attributes?.volume_usd?.m5)
    && hasNonNegativeNumber(attributes?.volume_usd?.h1)
    && hasNonNegativeInteger(tx?.buys)
    && hasNonNegativeInteger(tx?.sells)
  );
}

export async function geckoNewPools(
  pages = 1,
  {
    fetchImpl = fetch,
    now = Date.now,
    maxAgeMinutes = SETTINGS.maxAgeMinutes,
    timeoutMs = 12000,
    classifyPair = null,
  } = {}
) {
  const events = [];
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${CHAIN.geckoNetwork}/new_pools?page=${page}`;
    let json;
    try {
      json = await getJson(url, { fetchImpl, timeoutMs });
    } catch (cause) {
      throw new Error(`Gecko page ${page} failed: ${safeErrorMessage(cause)}`, { cause });
    }
    if (!Array.isArray(json?.data)) throw new Error(`Gecko page ${page} data must be an array`);
    for (const [rowIndex, row] of json.data.entries()) {
      const a = row.attributes || {};
      const rel = row.relationships || {};
      const tokenRaw = relAddr(rel.base_token?.data?.id);
      const quoteRaw = relAddr(rel.quote_token?.data?.id);
      if (!tokenRaw) throw new Error(`Gecko base_token invalid on page ${page} row ${rowIndex}`);
      if (!quoteRaw) throw new Error(`Gecko quote_token invalid on page ${page} row ${rowIndex}`);
      const classified = classifyPair
        ? classifyPair(tokenRaw, quoteRaw, { leftSide: "base", rightSide: "quote" })
        : null;
      if (classifyPair && classified?.candidateKind !== "meme") continue;
      const picked = classified ?? resolvePair(tokenRaw, quoteRaw);
      if (!picked) continue;
      const token = getAddress(picked.targetToken ?? picked.token);
      const quote = getAddress(picked.referenceAsset ?? picked.quote);
      const venue = normalizeGeckoVenue(rel.dex?.data?.id);
      const poolAddress = isEthAddress(a.address) ? getAddress(a.address) : null;
      const validPoolId = /^0x[0-9a-fA-F]{64}$/.test(String(a.address || ""));
      const supportedV4Venue = V4_GECKO_VENUES.has(String(venue).toLowerCase());
      if (!poolAddress && validPoolId && !supportedV4Venue) continue;
      const poolId = supportedV4Venue && validPoolId
        ? String(a.address).toLowerCase()
        : null;
      if (!poolAddress && !poolId) {
        throw new Error(`Gecko pool address invalid on page ${page} row ${rowIndex}`);
      }
      const createdAt = Date.parse(a.pool_created_at);
      if (!Number.isFinite(createdAt)) {
        throw new Error(`Gecko pool_created_at invalid on page ${page} row ${rowIndex}`);
      }
      const ageMin = (now() - createdAt) / 60000;
      if (ageMin > maxAgeMinutes) continue;
      const tx = a.transactions?.m5 || a.transactions?.h1 || {};
      events.push({
        source: "gecko",
        venue,
        pool: poolAddress,
        poolId,
        token,
        quote,
        quoteToken: quote,
        targetToken: token,
        referenceAsset: quote,
        targetSide: picked.targetSide ?? "base",
        pairDirection: picked.pairDirection ?? "base/quote",
        targetAssetKind: picked.targetAssetKind ?? "meme",
        referenceAssetKind: picked.referenceAssetKind ?? "unknown",
        referenceAssetIssuer: picked.referenceAssetIssuer ?? null,
        assetSource: picked.assetSource ?? null,
        assetVerifiedAt: picked.assetVerifiedAt ?? null,
        referenceRestrictions: [...(picked.referenceRestrictions ?? [])],
        createdAt,
        market: {
          scoreKnown: hasCompleteGeckoScoreFacts(a),
          name: a.name || "",
          priceUsd: num(a.base_token_price_usd),
          fdvUsd: num(a.fdv_usd),
          mcapUsd: num(a.market_cap_usd) || num(a.fdv_usd),
          liquidityUsd: num(a.reserve_in_usd),
          volume5m: num(a.volume_usd?.m5),
          volume1h: num(a.volume_usd?.h1),
          volume24h: num(a.volume_usd?.h24),
          buys5m: tx.buys || 0,
          sells5m: tx.sells || 0,
          buys1h: a.transactions?.h1?.buys || 0,
          sells1h: a.transactions?.h1?.sells || 0,
          priceChange5m: num(a.price_change_percentage?.m5),
        },
      });
    }
  }
  return events;
}

function sameAddress(a, b) {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

export function selectDexPair(pairs, { token, pool = null, quote = null, chain = "robinhood" } = {}) {
  const sameIdentity = String(chain).toLowerCase() === "solana"
    ? (left, right) => Boolean(left && right) && String(left) === String(right)
    : sameAddress;
  const matchingToken = (Array.isArray(pairs) ? pairs : []).filter((p) =>
    String(p.chainId).toLowerCase() === String(chain).toLowerCase()
      && (sameIdentity(p.baseToken?.address, token) || sameIdentity(p.quoteToken?.address, token))
  );
  if (pool || quote) {
    if (!pool || !quote) return null;
    return (
      matchingToken.find(
        (p) => sameIdentity(p.pairAddress, pool) && (
          (sameIdentity(p.baseToken?.address, token) && sameIdentity(p.quoteToken?.address, quote))
          || (sameIdentity(p.quoteToken?.address, token) && sameIdentity(p.baseToken?.address, quote))
        )
      ) || null
    );
  }
  return matchingToken.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
}

export async function dexScreener(token, binding = {}, { profile = CHAIN, fetchImpl = fetch } = {}) {
  const url = `https://api.dexscreener.com/tokens/v1/${profile.dexScreenerSlug || profile.geckoNetwork}/${token}`;
  const json = await getJson(url, { fetchImpl });
  const pairs = Array.isArray(json) ? json : json?.pairs || [];
  const p = selectDexPair(pairs, { token, chain: profile.dexScreenerSlug || profile.geckoNetwork, ...binding });
  if (!p) return null;
  const targetIsBase = sameAddress(p.baseToken?.address, token)
    || String(profile.family).toLowerCase() === "solana" && p.baseToken?.address === token;
  const target = targetIsBase ? p.baseToken : p.quoteToken;
  const reference = targetIsBase ? p.quoteToken : p.baseToken;
  const socials = p.info?.socials || [];
  const websites = p.info?.websites || [];
  return {
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    symbol: target?.symbol,
    name: target?.name,
    quoteSymbol: reference?.symbol,
    baseAddress: target?.address || null,
    quoteAddress: reference?.address || null,
    marketBound: Boolean(binding.pool && binding.quote),
    priceUsd: num(p.priceUsd),
    mcapUsd: num(p.marketCap) || num(p.fdv),
    fdvUsd: num(p.fdv),
    liquidityUsd: num(p.liquidity?.usd),
    volume5m: num(p.volume?.m5),
    volume1h: num(p.volume?.h1),
    volume24h: num(p.volume?.h24),
    buys5m: p.txns?.m5?.buys || 0,
    sells5m: p.txns?.m5?.sells || 0,
    buys1h: p.txns?.h1?.buys || 0,
    sells1h: p.txns?.h1?.sells || 0,
    pairCreatedAt: p.pairCreatedAt || null,
    twitter: socials.find((s) => s.type === "twitter")?.url || null,
    telegram: socials.find((s) => s.type === "telegram")?.url || null,
    websites: websites.map((w) => w.url).filter(Boolean),
    socials,
  };
}

export async function blockscoutHolders(token, limit = 20) {
  const url = `${CHAIN.explorer}/api?module=token&action=getTokenHolders&contractaddress=${token}&page=1&offset=${limit}`;
  const json = await getJson(url);
  if (json?.status !== "1" && json?.message !== "OK") {
    throw new Error(`Blockscout holders unavailable for ${token}`);
  }
  return (json.result || []).map((h) => ({
    address: getAddress(h.address),
    value: BigInt(h.value),
  }));
}

export async function blockscoutToken(token) {
  const url = `${CHAIN.explorer}/api?module=token&action=getToken&contractaddress=${token}`;
  const json = await getJson(url);
  const r = json?.result;
  if (!r) throw new Error(`Blockscout token unavailable for ${token}`);
  return {
    name: r.name,
    symbol: r.symbol,
    decimals: Number(r.decimals || 18),
    totalSupply: r.totalSupply ? BigInt(r.totalSupply) : 0n,
    holders: r.holders ? Number(r.holders) : null,
  };
}

export async function blockscoutCreator(token) {
  const url = `${CHAIN.explorer}/api?module=contract&action=getcontractcreation&contractaddresses=${token}`;
  const json = await getJson(url);
  const row = Array.isArray(json?.result) ? json.result[0] : json?.result;
  if (!row?.contractCreator) return null;
  return {
    creator: getAddress(row.contractCreator),
    txHash: row.txHash || null,
  };
}

export async function deployerHistory(creator, cap = 50) {
  if (!creator) return { created: null, recent: [], known: false };
  const url = `${CHAIN.explorer}/api?module=account&action=txlist&address=${creator}&page=1&offset=200&sort=desc`;
  const json = await getJson(url);
  const txs = json?.result;
  if (!Array.isArray(txs)) throw new Error(`Blockscout deployer history unavailable for ${creator}`);
  return summarizeDeployerHistory(txs, cap, 200);
}

export function summarizeDeployerHistory(txs, cap = 50, pageSize = 200) {
  const created = txs.filter((t) => t.contractAddress && t.contractAddress !== "0x" && t.contractAddress !== "");
  return {
    created: created.length,
    recent: created.slice(0, cap).map((t) => t.contractAddress),
    known: txs.length < pageSize,
  };
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePaprikaPool(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || !Array.isArray(raw.tokens) || raw.tokens.length < 2) {
    throw new Error("DexPaprika pool schema is missing id or tokens");
  }
  const tokens = raw.tokens.map((token) => {
    if (!token?.id || !isEthAddress(token.id)) throw new Error("DexPaprika pool schema contains an invalid token");
    return {
      address: getAddress(token.id),
      symbol: token.symbol || "",
      name: token.name || "",
      decimals: optionalNumber(token.decimals),
    };
  });
  return {
    source: raw.source || "dexpaprika",
    poolId: String(raw.id).toLowerCase(),
    dexId: raw.dex_id || null,
    dexName: raw.dex_name || null,
    chain: raw.chain || CHAIN.geckoNetwork,
    tokens,
    createdAt: raw.created_at ? Date.parse(raw.created_at) : null,
    liquidityUsd: optionalNumber(raw.liquidity_usd),
    volume24hUsd: optionalNumber(raw.volume_usd_24h ?? raw.volume_usd),
    priceUsd: optionalNumber(raw.price_usd),
    lastUpdatedAt: raw.last_updated ? Date.parse(raw.last_updated) : null,
    raw,
  };
}

async function paprikaJson(path, label, options) {
  try {
    return await getJson(`${DEXPAPRIKA_BASE}${path}`, options);
  } catch (cause) {
    throw new Error(`${label} failed: ${safeErrorMessage(cause)}`, { cause });
  }
}

export async function getDexPaprikaTopPools({
  fetchImpl = fetch,
  timeoutMs = 12000,
  limit = 10,
} = {}) {
  const json = await paprikaJson(
    `/networks/${CHAIN.geckoNetwork}/pools?limit=${limit}&order_by=volume_usd&sort=desc`,
    "DexPaprika top pools",
    { fetchImpl, timeoutMs }
  );
  if (!Array.isArray(json?.pools)) throw new Error("DexPaprika top pools schema must contain pools");
  return json.pools.map(normalizePaprikaPool);
}

export async function searchDexPaprikaPools(token, {
  fetchImpl = fetch,
  timeoutMs = 12000,
  limit = 10,
} = {}) {
  const address = getAddress(token);
  const json = await paprikaJson(
    `/networks/${CHAIN.geckoNetwork}/tokens/${address}/pools?limit=${limit}&order_by=volume_usd&sort=desc`,
    `DexPaprika token pools ${address}`,
    { fetchImpl, timeoutMs }
  );
  if (!Array.isArray(json?.pools)) throw new Error("DexPaprika token pools schema must contain pools");
  return json.pools.map(normalizePaprikaPool);
}

export async function getDexPaprikaPool(poolId, {
  fetchImpl = fetch,
  timeoutMs = 12000,
} = {}) {
  const id = String(poolId || "");
  const json = await paprikaJson(
    `/networks/${CHAIN.geckoNetwork}/pools/${encodeURIComponent(id)}`,
    `DexPaprika pool ${id}`,
    { fetchImpl, timeoutMs }
  );
  return normalizePaprikaPool(json);
}

export async function getDexPaprikaTransactions(poolId, {
  fetchImpl = fetch,
  timeoutMs = 12000,
  limit = 20,
} = {}) {
  const id = String(poolId || "");
  const json = await paprikaJson(
    `/networks/${CHAIN.geckoNetwork}/pools/${encodeURIComponent(id)}/transactions?limit=${limit}`,
    `DexPaprika pool transactions ${id}`,
    { fetchImpl, timeoutMs }
  );
  if (!Array.isArray(json?.transactions)) {
    throw new Error("DexPaprika transactions schema must contain transactions");
  }
  return json.transactions.map((transaction) => ({
    id: transaction.id || transaction.hash || null,
    poolId: id.toLowerCase(),
    direction: ["buy", "sell"].includes(String(transaction.type || "").toLowerCase())
      ? String(transaction.type).toLowerCase()
      : "unknown",
    blockTimestamp: optionalNumber(transaction.block_timestamp),
    raw: transaction,
  }));
}

function addressMatches(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

export function normalizeMarketEvidence({ expected, pools = [], transactions = [], errors = [] }) {
  const expectedPool = String(expected?.poolId || "").toLowerCase();
  const normalizedPools = [];
  for (const pool of pools) {
    try {
      normalizedPools.push(pool.poolId && pool.tokens ? pool : normalizePaprikaPool(pool));
    } catch (error) {
      errors = [...errors, { source: pool?.source || "market", message: safeErrorMessage(error) }];
    }
  }
  const bound = normalizedPools.filter((pool) =>
    pool.poolId === expectedPool &&
    pool.tokens.some((token) => addressMatches(token.address, expected.token)) &&
    pool.tokens.some((token) => addressMatches(token.address, expected.pairToken))
  );
  if (!bound.length) {
    return {
      token: expected.token,
      pairToken: expected.pairToken,
      poolId: expectedPool,
      marketReady: errors.length ? "unknown" : false,
      liquidityUsd: null,
      conflict: false,
      errors,
      sources: normalizedPools,
    };
  }
  const liquidities = bound.map((pool) => pool.liquidityUsd).filter((value) => Number.isFinite(value));
  const minLiquidity = liquidities.length ? Math.min(...liquidities) : null;
  const maxLiquidity = liquidities.length ? Math.max(...liquidities) : null;
  const conflict = liquidities.length > 1 && minLiquidity > 0 && maxLiquidity >= minLiquidity * 2;
  const matchingTransactions = transactions.filter((transaction) =>
    !transaction.poolId || String(transaction.poolId).toLowerCase() === expectedPool
  );
  const directions = new Set(matchingTransactions.map((transaction) => transaction.direction));
  const hasBidirectional = directions.has("buy") && directions.has("sell");
  const hasLiquidity = Number.isFinite(minLiquidity) && minLiquidity > 0;
  return {
    token: expected.token,
    pairToken: expected.pairToken,
    poolId: expectedPool,
    marketReady: hasLiquidity && hasBidirectional ? true : errors.length ? "unknown" : false,
    liquidityUsd: minLiquidity,
    conflict,
    errors,
    sources: bound,
    transactionCount: matchingTransactions.length,
    bidirectional: hasBidirectional,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asAddr(raw) {
  if (!raw) return ADDR.NATIVE;
  if (raw.toLowerCase() === ADDR.NATIVE.toLowerCase()) return ADDR.NATIVE;
  if (raw.toLowerCase() === ADDR.ZERO.toLowerCase()) return ADDR.NATIVE;
  return getAddress(raw);
}

function resolvePair(tokenRaw, quoteRaw) {
  const a = asAddr(tokenRaw);
  const b = asAddr(quoteRaw);
  if (isQuote(a) && !isQuote(b)) return { token: b, quote: a };
  if (isQuote(b) && !isQuote(a)) return { token: a, quote: b };
  return null;
}

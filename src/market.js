import { getAddress } from "ethers";
import { ADDR, CHAIN, SETTINGS, isQuote } from "./config.js";

const UA = {
  accept: "application/json",
  "user-agent": "robinhood-scanner-bot/1.0",
};

async function getJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
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

export async function geckoNewPools(pages = 1) {
  const events = [];
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${CHAIN.geckoNetwork}/new_pools?page=${page}`;
    const json = await getJson(url).catch(() => null);
    if (!json?.data) break;
    for (const row of json.data) {
      const a = row.attributes || {};
      const rel = row.relationships || {};
      const tokenRaw = relAddr(rel.base_token?.data?.id);
      const quoteRaw = relAddr(rel.quote_token?.data?.id);
      if (!tokenRaw) continue;
      const picked = resolvePair(tokenRaw, quoteRaw);
      if (!picked) continue;
      const { token, quote } = picked;
      const createdAt = a.pool_created_at ? Date.parse(a.pool_created_at) : Date.now();
      const ageMin = (Date.now() - createdAt) / 60000;
      if (ageMin > SETTINGS.maxAgeMinutes * 3) continue;
      const tx = a.transactions?.m5 || a.transactions?.h1 || {};
      events.push({
        source: "gecko",
        venue: rel.dex?.data?.id || "unknown",
        pool: isEthAddress(a.address) ? getAddress(a.address) : null,
        token: getAddress(token),
        quote,
        createdAt,
        market: {
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

export function selectDexPair(pairs, { token, pool = null, quote = null } = {}) {
  const matchingToken = (Array.isArray(pairs) ? pairs : []).filter(
    (p) =>
      String(p.chainId).toLowerCase() === "robinhood" &&
      sameAddress(p.baseToken?.address, token)
  );
  if (pool || quote) {
    if (!pool || !quote) return null;
    return (
      matchingToken.find(
        (p) => sameAddress(p.pairAddress, pool) && sameAddress(p.quoteToken?.address, quote)
      ) || null
    );
  }
  return matchingToken.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
}

export async function dexScreener(token, binding = {}) {
  const url = `https://api.dexscreener.com/tokens/v1/${CHAIN.geckoNetwork}/${token}`;
  const json = await getJson(url);
  const pairs = Array.isArray(json) ? json : json?.pairs || [];
  const p = selectDexPair(pairs, { token, ...binding });
  if (!p) return null;
  const socials = p.info?.socials || [];
  const websites = p.info?.websites || [];
  return {
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    symbol: p.baseToken?.symbol,
    name: p.baseToken?.name,
    quoteSymbol: p.quoteToken?.symbol,
    baseAddress: p.baseToken?.address || null,
    quoteAddress: p.quoteToken?.address || null,
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

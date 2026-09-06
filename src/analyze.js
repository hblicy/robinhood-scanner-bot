import { Contract, Interface, ZeroAddress, formatEther, getAddress, parseEther } from "ethers";
import { ADDR, NARRATIVE_WORDS, SETTINGS, isQuote } from "./config.js";
import { ERC20_ABI, V2_ROUTER_ABI } from "./abis.js";
import {
  bytecodeFlags,
  getProvider,
  isContractCallRevert,
  readOwner,
  readTokenMeta,
  readV2Pool,
  withRetry,
} from "./chain.js";
import {
  blockscoutCreator,
  blockscoutHolders,
  blockscoutToken,
  deployerHistory,
  dexScreener,
} from "./market.js";
import { safeErrorMessage } from "./safety.js";

const erc20Iface = new Interface(ERC20_ABI);
const SIM_FROM = "0x1000000000000000000000000000000000000001";
const BUY_ETH = parseEther("0.001");

function pct(part, whole) {
  if (!whole || whole === 0n) return 0;
  return Number((part * 10000n) / whole) / 100;
}

function hasNarrative(symbol, name) {
  const s = `${symbol || ""} ${name || ""}`.toLowerCase();
  return NARRATIVE_WORDS.filter((w) => s.includes(w));
}

async function settled(promise) {
  try {
    return { ok: true, value: await promise, error: null, cause: null };
  } catch (error) {
    return { ok: false, value: null, error: safeErrorMessage(error), cause: error };
  }
}

export class RetryableAnalysisError extends Error {
  constructor(source, token, cause = null) {
    const detail = cause ? `: ${safeErrorMessage(cause)}` : ": not indexed yet";
    super(`${source} unavailable for ${token}${detail}`, cause ? { cause } : undefined);
    this.name = "RetryableAnalysisError";
    this.code = "RETRYABLE_ANALYSIS";
    this.source = source;
    this.token = token;
  }
}

function requireCore(source, result, token) {
  if (!result.ok) throw new RetryableAnalysisError(source, token, result.cause || new Error(result.error));
  if (result.value == null) throw new RetryableAnalysisError(source, token);
  return result.value;
}

const DEFAULT_ANALYZE_DEPENDENCIES = {
  now: Date.now,
  readTokenMeta,
  readOwner,
  bytecodeFlags,
  dexScreener,
  blockscoutToken,
  blockscoutHolders,
  blockscoutCreator,
  readV2Pool,
  readCreatorBalance: (token, creator) =>
    new Contract(token, ERC20_ABI, getProvider()).balanceOf(creator),
  deployerHistory,
  honeypotCheck,
};

export function scoreFromFacts(f) {
  const checks = [];
  const red = [];
  let score = 0;

  const age = Number.isFinite(f.ageMinutes) ? f.ageMinutes : null;
  if (age === null) {
    checks.push({ key: "age", ok: false, pts: 0, detail: "年龄未知" });
  } else if (age <= SETTINGS.maxAgeMinutes) {
    score += 15;
    checks.push({ key: "age", ok: true, pts: 15, detail: `${age.toFixed(1)} 分钟` });
  } else if (age <= SETTINGS.maxAgeMinutes * 2) {
    score += 5;
    checks.push({ key: "age", ok: false, pts: 5, detail: `${age.toFixed(1)} 分钟（偏老）` });
  } else {
    checks.push({ key: "age", ok: false, pts: 0, detail: `${age.toFixed(1)} 分钟（太老）` });
    red.push("年龄超过窗口，机会很小");
  }

  if (f.hasTwitter || f.hasTelegram) {
    score += 10;
    checks.push({
      key: "social",
      ok: true,
      pts: 10,
      detail: [f.hasTwitter ? "Twitter" : null, f.hasTelegram ? "TG" : null].filter(Boolean).join(" + "),
    });
  } else {
    checks.push({ key: "social", ok: false, pts: 0, detail: "无社交链接" });
    if (SETTINGS.requireSocial) red.push("无 Twitter/TG");
  }

  if ((f.narrativeHits || []).length) {
    score += 5;
    checks.push({ key: "narrative", ok: true, pts: 5, detail: f.narrativeHits.join(", ") });
  } else {
    checks.push({ key: "narrative", ok: false, pts: 0, detail: "名称无热门叙事词" });
  }

  const buys = f.buys5m || 0;
  const sells = f.sells5m || 0;
  const vol = f.volume5m || f.volume1h || 0;
  if (vol > 0 && buys >= sells && buys > 0) {
    score += 15;
    checks.push({ key: "flow", ok: true, pts: 15, detail: `买 ${buys} / 卖 ${sells} · $${fmt(vol)}` });
  } else if (vol > 0) {
    score += 5;
    checks.push({ key: "flow", ok: false, pts: 5, detail: `买 ${buys} / 卖 ${sells} · $${fmt(vol)}（卖压偏多）` });
  } else {
    checks.push({ key: "flow", ok: false, pts: 0, detail: "几乎无成交" });
  }

  const mcap = f.mcapUsd || 0;
  if (mcap > 0 && mcap <= 80_000) {
    score += 8;
    checks.push({ key: "mcap", ok: true, pts: 8, detail: `$${fmt(mcap)} 早期低市值` });
  } else if (mcap > 0 && mcap <= SETTINGS.maxMcapUsd) {
    score += 4;
    checks.push({ key: "mcap", ok: true, pts: 4, detail: `$${fmt(mcap)}` });
  } else if (mcap > SETTINGS.maxMcapUsd) {
    checks.push({ key: "mcap", ok: false, pts: 0, detail: `$${fmt(mcap)} 已偏高` });
    red.push("市值已过筛选上限");
  } else {
    checks.push({ key: "mcap", ok: false, pts: 0, detail: "市值未知" });
  }

  const liq = f.liquidityUsd || 0;
  const ratio = mcap > 0 ? liq / mcap : 0;
  if (liq >= SETTINGS.minLiquidityUsd && ratio >= 0.2) {
    score += 10;
    checks.push({ key: "liq", ok: true, pts: 10, detail: `$${fmt(liq)}  (liq/mc ${(ratio * 100).toFixed(0)}%)` });
  } else if (liq >= SETTINGS.minLiquidityUsd) {
    score += 5;
    checks.push({ key: "liq", ok: false, pts: 5, detail: `$${fmt(liq)}  (liq/mc ${(ratio * 100).toFixed(0)}%，偏薄)` });
  } else {
    checks.push({ key: "liq", ok: false, pts: 0, detail: `$${fmt(liq)} 流动性不足` });
    red.push("流动性过低");
  }

  const top10 = f.top10Pct ?? null;
  if (top10 !== null && top10 <= 30) {
    score += 15;
    checks.push({ key: "holders", ok: true, pts: 15, detail: `前10 ${top10.toFixed(1)}% · ${f.holderCount ?? "?"} 人` });
  } else if (top10 !== null && top10 <= SETTINGS.maxTop10Pct) {
    score += 8;
    checks.push({ key: "holders", ok: false, pts: 8, detail: `前10 ${top10.toFixed(1)}% · ${f.holderCount ?? "?"} 人` });
  } else if (top10 !== null) {
    checks.push({ key: "holders", ok: false, pts: 0, detail: `前10 ${top10.toFixed(1)}% 过度集中` });
    red.push("持仓过度集中");
  } else {
    checks.push({ key: "holders", ok: false, pts: 0, detail: "持仓分布未知" });
  }

  if (!f.creatorKnown || !Number.isFinite(f.creatorPct)) {
    checks.push({ key: "creator", ok: false, pts: 0, detail: "创建者或持仓未知" });
  } else if (f.creatorPct <= 5) {
    score += 10;
    checks.push({ key: "creator", ok: true, pts: 10, detail: `创建者持仓 ${f.creatorPct.toFixed(1)}%` });
  } else if (f.creatorPct <= 15) {
    score += 4;
    checks.push({ key: "creator", ok: false, pts: 4, detail: `创建者持仓 ${f.creatorPct.toFixed(1)}%` });
  } else {
    checks.push({ key: "creator", ok: false, pts: 0, detail: `创建者持仓 ${f.creatorPct?.toFixed(1)}%` });
    red.push("创建者持仓过高");
  }

  if (f.honeypot === true) {
    checks.push({ key: "honeypot", ok: false, pts: 0, detail: f.honeypotReason || "无法卖出" });
    red.push("蜜罐 / 无法卖出");
  } else if (f.honeypot === false) {
    score += 10;
    checks.push({
      key: "honeypot",
      ok: true,
      pts: 10,
      detail: `买税 ${f.buyTaxBps ?? 0}bps / 卖税 ${f.sellTaxBps ?? 0}bps`,
    });
  } else {
    checks.push({ key: "honeypot", ok: false, pts: 0, detail: "模拟未完成，勿当通过" });
  }

  const tax = Math.max(f.buyTaxBps || 0, f.sellTaxBps || 0);
  if (tax > SETTINGS.maxTaxBps) red.push(`税率 ${tax}bps 过高`);

  if (f.lpUnknown) {
    checks.push({ key: "lp", ok: false, pts: 0, detail: "未验证 V2 LP 销毁比例" });
  } else if (f.lpBurnedPct >= 90) {
    score += 10;
    checks.push({ key: "lp", ok: true, pts: 10, detail: `LP 已烧 ${f.lpBurnedPct.toFixed(0)}%` });
  } else if (f.lpBurnedPct > 0) {
    score += 3;
    checks.push({ key: "lp", ok: false, pts: 3, detail: `LP 仅烧 ${f.lpBurnedPct.toFixed(0)}%，可撤池` });
    red.push("流动性随时可撤");
  } else {
    checks.push({ key: "lp", ok: false, pts: 0, detail: "LP 未锁未烧" });
    red.push("流动性随时可撤");
  }

  if (!f.privilegesKnown) {
    checks.push({ key: "mint", ok: false, pts: 0, detail: "增发/权限状态未知" });
  } else if (f.mintable && f.owner && f.owner !== ZeroAddress) {
    checks.push({ key: "mint", ok: false, pts: 0, detail: "可铸造且 owner 未放弃" });
    red.push("可增发");
  } else {
    score += 5;
    checks.push({
      key: "mint",
      ok: true,
      pts: 5,
      detail: f.mintable ? `可铸造但 owner=${short(f.owner)}` : "未见 mint / owner 已弃",
    });
  }

  const prev = f.deployerTokens;
  if (!f.deployerHistoryKnown || !Number.isFinite(prev)) {
    checks.push({ key: "deployer", ok: false, pts: 0, detail: "创建者历史未知" });
  } else if (prev <= 2) {
    score += 7;
    checks.push({ key: "deployer", ok: true, pts: 7, detail: `历史发币 ${prev}` });
  } else if (prev <= SETTINGS.maxDeployerTokens) {
    score += 2;
    checks.push({ key: "deployer", ok: false, pts: 2, detail: `历史发币 ${prev}` });
  } else {
    checks.push({ key: "deployer", ok: false, pts: 0, detail: `历史发币 ${prev}，像串子` });
    red.push("创建者大量发垃圾币");
  }

  score = Math.max(0, Math.min(100, score) - red.length * 12);
  checks.push({
    key: "market",
    ok: f.marketBound === true,
    pts: 0,
    detail: f.marketBound === true ? "市场数据与事件池一致" : "市场数据未绑定事件池",
  });

  const hardFail = red.some((r) => /蜜罐|无法卖出|税率/.test(r));
  let verdict = "watch";
  if (hardFail) verdict = "skip";
  else if (
    score >= 75 &&
    red.length === 0 &&
    f.honeypot === false &&
    f.marketBound === true &&
    f.securityComplete === true
  ) verdict = "green";
  else if (score >= SETTINGS.minScore) verdict = "review";
  else verdict = "skip";

  return { score, checks, red, verdict };
}

export async function analyze(event, overrides = {}) {
  const dependencies = { ...DEFAULT_ANALYZE_DEPENDENCIES, ...overrides };
  const token = getAddress(event.token);
  const [metaResult, ownerResult, flagsResult, dexResult, bsTokenResult, holdersResult, creatorResult] = await Promise.all([
    settled(dependencies.readTokenMeta(token)),
    settled(dependencies.readOwner(token)),
    settled(dependencies.bytecodeFlags(token)),
    settled(dependencies.dexScreener(token, event.pool ? { pool: event.pool, quote: event.quote } : {})),
    settled(dependencies.blockscoutToken(token)),
    settled(dependencies.blockscoutHolders(token, 25)),
    settled(dependencies.blockscoutCreator(token)),
  ]);

  const meta = requireCore("token metadata", metaResult, token);
  const owner = ownerResult.value;
  const flags = requireCore("bytecode", flagsResult, token);
  const dex = requireCore("DexScreener pool", dexResult, token);
  const bsToken = bsTokenResult.value;
  const holders = holdersResult.value || [];
  const creatorInfo = creatorResult.value;

  const createdAt = event.createdAt || dex?.pairCreatedAt || null;
  const ageMinutes = createdAt ? Math.max(0, (dependencies.now() - createdAt) / 60000) : null;

  let lpBurnedPct = null;
  let poolInfo = null;
  let poolResult = { ok: true, value: null, error: null };
  if (event.venue === "uniswap-v2" && event.pool) {
    poolResult = await settled(dependencies.readV2Pool(event.pool));
    poolInfo = poolResult.value;
    lpBurnedPct = poolInfo?.burnedPct ?? null;
  }

  const supply = meta.totalSupply || bsToken?.totalSupply || 0n;
  const skipHolders = new Set(
    [ADDR.DEAD, ADDR.ZERO, ADDR.V4_POOL_MANAGER, event.pool, ADDR.V2_ROUTER, ADDR.V3_ROUTER]
      .filter(Boolean)
      .map((a) => a.toLowerCase())
  );
  let top10 = 0n;
  let counted = 0;
  for (const h of holders) {
    if (skipHolders.has(h.address.toLowerCase())) continue;
    if (isQuote(h.address)) continue;
    if (counted < 10) top10 += h.value;
    counted += 1;
  }
  const top10Pct = supply > 0n && holders.length ? pct(top10, supply) : null;

  const creator = creatorInfo?.creator || null;
  const creatorBalanceResult = creator
    ? await settled(dependencies.readCreatorBalance(token, creator))
    : { ok: true, value: null, error: null };
  const creatorKnown = creatorResult.ok && Boolean(creator) && creatorBalanceResult.ok && supply > 0n;
  const creatorPct = creatorKnown ? pct(creatorBalanceResult.value, supply) : null;
  const historyResult = creator
    ? await settled(dependencies.deployerHistory(creator))
    : { ok: true, value: null, error: null };
  const history = historyResult.value;

  const hpResult = await settled(dependencies.honeypotCheck({
    token,
    quote: event.quote,
    venue: event.venue,
    pool: event.pool,
    holders,
  }));
  const hp = hpResult.value || {
    honeypot: null,
    complete: false,
    reason: hpResult.error,
    buyTaxBps: null,
    sellTaxBps: null,
  };

  const mkt = event.market || {};
  const holdersKnown = holdersResult.ok && supply > 0n && holders.length > 0;
  // Selector scanning is diagnostic only; it cannot prove proxy or non-standard privilege absence.
  const privilegesKnown = false;
  const deployerHistoryKnown = Boolean(historyResult.ok && history?.known);
  const marketBound = dex?.marketBound === true;
  const securityComplete = Boolean(
    marketBound &&
      holdersKnown &&
      creatorKnown &&
      privilegesKnown &&
      deployerHistoryKnown &&
      lpBurnedPct !== null &&
      hp.complete === true &&
      hp.honeypot === false
  );
  const facts = {
    ageMinutes,
    hasTwitter: Boolean(dex?.twitter),
    hasTelegram: Boolean(dex?.telegram),
    narrativeHits: hasNarrative(meta.symbol || dex?.symbol, meta.name || dex?.name),
    buys5m: dex?.buys5m || mkt.buys5m || 0,
    sells5m: dex?.sells5m || mkt.sells5m || 0,
    volume5m: dex?.volume5m || mkt.volume5m || 0,
    volume1h: dex?.volume1h || mkt.volume1h || 0,
    mcapUsd: dex?.mcapUsd || mkt.mcapUsd || mkt.fdvUsd || 0,
    liquidityUsd: dex?.liquidityUsd || mkt.liquidityUsd || 0,
    top10Pct,
    holderCount: bsToken?.holders ?? holders.length,
    holdersKnown,
    creatorKnown,
    creatorPct,
    honeypot: hp.honeypot,
    honeypotReason: hp.reason,
    buyTaxBps: hp.buyTaxBps,
    sellTaxBps: hp.sellTaxBps,
    lpBurnedPct,
    lpUnknown: event.venue !== "uniswap-v2" || lpBurnedPct === null,
    mintable: Boolean(flags.mintable),
    owner,
    privilegesKnown,
    deployerTokens: history?.created ?? null,
    deployerHistoryKnown,
    marketBound,
    securityComplete,
  };

  const scored = scoreFromFacts(facts);

  return {
    ...event,
    token,
    meta: {
      name: meta.name || dex?.name || "",
      symbol: meta.symbol || dex?.symbol || "???",
      decimals: meta.decimals,
      totalSupply: supply.toString(),
    },
    owner,
    creator,
    flags,
    dex,
    facts,
    lp: poolInfo,
    honeypot: hp,
    marketBound,
    securityComplete,
    errorSources: [
      ["token metadata", metaResult],
      ["owner", ownerResult],
      ["bytecode", flagsResult],
      ["DexScreener pool", dexResult],
      ["Blockscout token", bsTokenResult],
      ["Blockscout holders", holdersResult],
      ["Blockscout creator", creatorResult],
      ["creator balance", creatorBalanceResult],
      ["deployer history", historyResult],
      ["V2 pool", poolResult],
      ["honeypot", hpResult],
    ].filter(([, result]) => !result.ok).map(([source, result]) => ({ source, error: result.error })),
    ...scored,
    links: {
      dex: dex?.url || `https://dexscreener.com/robinhood/${token}`,
      explorer: `https://robinhoodchain.blockscout.com/token/${token}`,
      gmgn: `https://gmgn.ai/robinhood/token/${token}`,
    },
  };
}

export async function honeypotCheck(
  { token, quote, venue, pool, holders = [] },
  dependencies = {}
) {
  const inspectBytecode = dependencies.bytecodeFlags || bytecodeFlags;
  const quoteRoundTrip = dependencies.quoteRoundTrip || simulateV2Quotes;
  const transferFromPool = dependencies.simulateTransferFromPool || simulateTransferFromPool;
  const transfer = dependencies.simulateTransfer || simulateTransfer;
  const flags = await inspectBytecode(token);
  const result = {
    honeypot: null,
    complete: false,
    reason: "",
    buyOk: null,
    sellOk: null,
    buyTaxBps: null,
    sellTaxBps: null,
    flags,
  };

  if (!flags.hasCode) {
    result.honeypot = true;
    result.reason = "无合约代码";
    return result;
  }

  const quoteAddr = isQuote(quote) && quote !== ADDR.NATIVE && quote !== ADDR.ZERO ? quote : ADDR.WETH;

  if (venue === "uniswap-v2") {
    const sim = await quoteRoundTrip(token, quoteAddr);
    result.buyOk = sim.buyOk ?? null;
    result.sellOk = sim.sellOk ?? null;
    result.reason = sim.reason || "";
    if (sim.buyOk === false) {
      result.honeypot = true;
      result.reason = sim.reason || "无法报价买入";
      return result;
    }
    if (sim.sellOk === false) {
      result.honeypot = true;
      result.reason = sim.reason || "无法报价卖出（蜜罐）";
      return result;
    }
  }

  if (pool) {
    const fromPool = await transferFromPool(token, pool);
    if (fromPool === false) {
      result.honeypot = true;
      result.reason = "从池子转出失败";
      return result;
    }
    result.buyOk = result.buyOk ?? fromPool;
  }

  const seller = holders.find(
    (h) =>
      h.value > 0n &&
      h.address.toLowerCase() !== String(pool || "").toLowerCase() &&
      h.address.toLowerCase() !== ADDR.DEAD.toLowerCase() &&
      h.address.toLowerCase() !== ADDR.ZERO.toLowerCase() &&
      h.address.toLowerCase() !== ADDR.V2_ROUTER.toLowerCase()
  );
  if (seller && pool) {
    const amt = seller.value / 100n || 1n;
    const sellXfer = await transfer(token, seller.address, pool, amt);
    if (sellXfer.ok === false) {
      result.honeypot = true;
      result.sellOk = false;
      result.reason = `持仓钱包转回池子失败: ${sellXfer.error}`;
      return result;
    }
    result.sellOk = true;
  }

  if (flags.blacklist || flags.pausable) {
    result.reason = "合约含黑名单/暂停函数，需人工看";
  } else if (result.buyOk && result.sellOk) {
    result.reason = "报价/直接转账通过，但缺少完整 Router 买入-授权-卖出模拟";
  } else if (!result.reason) {
    result.reason = "未完成完整 Router 买入-授权-卖出模拟";
  }
  return result;
}

async function simulateV2Quotes(token, quote) {
  const provider = getProvider();
  const router = new Contract(ADDR.V2_ROUTER, V2_ROUTER_ABI, provider);
  const pathBuy = [quote, token];
  const pathSell = [token, quote];
  const out = {
    buyOk: null,
    sellOk: null,
    reason: "",
  };

  let expectedBuy = 0n;
  try {
    const amounts = await router.getAmountsOut(BUY_ETH, pathBuy);
    expectedBuy = amounts[1];
    if (expectedBuy === 0n) {
      out.buyOk = false;
      out.reason = "买入报价为 0";
      return out;
    }
    out.buyOk = true;
  } catch (err) {
    if (!isContractCallRevert(err)) throw err;
    out.buyOk = false;
    out.reason = `无法报价买入: ${safeErrorMessage(err)}`;
    return out;
  }

  try {
    const back = await router.getAmountsOut(expectedBuy, pathSell);
    const ethBack = back[1];
    if (ethBack === 0n) {
      out.sellOk = false;
      out.reason = "卖出报价为 0";
      return out;
    }
    out.sellOk = true;
  } catch (err) {
    if (!isContractCallRevert(err)) throw err;
    out.sellOk = false;
    out.reason = `无法报价卖出: ${safeErrorMessage(err)}`;
  }

  return out;
}

async function simulateTransfer(token, from, to, amount) {
  const data = erc20Iface.encodeFunctionData("transfer", [to, amount]);
  return rawCall({ from, to: token, data });
}

async function simulateTransferFromPool(token, pool) {
  const provider = getProvider();
  const erc = new Contract(token, ERC20_ABI, provider);
  const bal = await erc.balanceOf(pool);
  if (bal === 0n) return null;
  const amt = bal / 1000n || 1n;
  const data = erc20Iface.encodeFunctionData("transfer", [SIM_FROM, amt]);
  const call = await rawCall({ from: pool, to: token, data });
  return call.ok;
}

export async function rawCall(
  tx,
  state = undefined,
  { provider = getProvider(), retry = (fn) => withRetry(fn, 2) } = {}
) {
  const payload = [
    {
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value || "0x0",
    },
    "latest",
  ];
  if (state) payload.push(state);
  try {
    await retry(() => provider.send("eth_call", payload));
    return { ok: true };
  } catch (err) {
    const msg = safeErrorMessage(err?.error || err);
    if (state && /state override|extra param|3 params/i.test(msg)) {
      try {
        await retry(() => provider.send("eth_call", payload.slice(0, 2)));
        return { ok: true };
      } catch (err2) {
        if (!isContractCallRevert(err2)) throw err2;
        return { ok: false, error: safeErrorMessage(err2) };
      }
    }
    if (!isContractCallRevert(err)) throw err;
    return { ok: false, error: msg };
  }
}

function short(addr) {
  if (!addr) return "-";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmt(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

export { formatEther, getAddress };

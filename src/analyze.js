import path from "node:path";
import { Contract, ZeroAddress, formatEther, getAddress, parseEther } from "ethers";
import { ADDR, DATA_DIR, NARRATIVE_WORDS, SETTINGS, isQuote } from "./config.js";
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
import {
  inspectSellability,
  normalizeSellabilityEvidence,
  sellabilityResult,
  SELLABILITY,
  validateV2PoolBinding,
} from "./sellability.js";
import { loadWalletLabels, normalizeWalletSignals } from "./wallet-labels.js";
import { scoreCandidate } from "./core/score.js";

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

function normalizeHoneypotSellability(result, sellability, legacyHoneypot = result?.honeypot) {
  let normalizedSellability = normalizeSellabilityEvidence(sellability, legacyHoneypot);
  if (
    normalizedSellability.status !== SELLABILITY.CONFIRMED &&
    (normalizedSellability.reason == null || normalizedSellability.reason === "")
  ) {
    normalizedSellability = { ...normalizedSellability, reason: "evidence-unavailable" };
  }
  const reason = normalizedSellability.status === SELLABILITY.CONFIRMED
    ? (result?.reason || normalizedSellability.reason)
    : normalizedSellability.reason;
  const normalized = { ...result, reason, sellability: normalizedSellability };
  if (normalizedSellability.status === SELLABILITY.CONFIRMED) {
    return { ...normalized, honeypot: false, complete: true, sellOk: true };
  }
  if (normalizedSellability.status === SELLABILITY.BLOCKED) {
    return { ...normalized, honeypot: true, complete: true, sellOk: false };
  }
  return { ...normalized, honeypot: null, complete: false, sellOk: null };
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
  minScore: SETTINGS.minScore,
  scoreThresholds: SETTINGS,
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
  walletCatalog: loadWalletLabels(path.join(DATA_DIR, "wallet-labels.json")),
};

export function scoreFromFacts(f, thresholds = SETTINGS) {
  const scored = scoreCandidate(f, thresholds);
  const checks = Object.values(scored.categories)
    .flatMap((category) => category.checks)
    .map(({ points, ...check }) => ({ ...check, pts: points }));
  const knownChecks = new Set(checks.map((check) => check.key));
  const unknownChecks = {
    age: "年龄未知",
    social: "社交信息未知",
    narrative: "叙事信息未知",
    flow: "成交数据未知",
    mcap: "市值未知",
    liq: "流动性未知",
    holders: "持仓分布未知",
    creator: "创建者或持仓未知",
    lp: "LP 状态未知",
    mint: "增发/权限状态未知",
    deployer: "创建者历史未知",
    smart_money: "标签信号未知",
  };
  for (const [key, detail] of Object.entries(unknownChecks)) {
    if (!knownChecks.has(key)) checks.push({ key, ok: false, pts: 0, detail });
  }
  if (f.honeypot === true) {
    checks.push({ key: "honeypot", ok: false, pts: 0, detail: f.honeypotReason || "无法卖出" });
  } else if (f.honeypot === false) {
    const taxesKnown = Number.isFinite(f.buyTaxBps) && Number.isFinite(f.sellTaxBps);
    checks.push({
      key: "honeypot",
      ok: true,
      pts: 0,
      detail: taxesKnown
        ? `买税 ${f.buyTaxBps}bps / 卖税 ${f.sellTaxBps}bps`
        : "已确认卖出证据，税率未知",
    });
  } else {
    checks.push({ key: "honeypot", ok: false, pts: 0, detail: "模拟未完成，勿当通过" });
  }
  checks.push({
    key: "market",
    ok: f.marketBound === true,
    pts: 0,
    detail: f.marketBound === true ? "市场数据与事件池一致" : "市场数据未绑定事件池",
  });

  const red = scored.redFlags;
  const hardFail = red.some((reason) => /蜜罐|无法卖出|税率/.test(reason));
  let verdict = "skip";
  if (!hardFail && scored.score >= 75 && red.length === 0 && f.honeypot === false
      && f.marketBound === true && f.securityComplete === true) {
    verdict = "green";
  } else if (!hardFail && scored.score >= (thresholds.minScore ?? SETTINGS.minScore)) {
    verdict = "review";
  }
  return { ...scored, checks, red, verdict };
}

export async function analyze(event, overrides = {}) {
  const dependencies = { ...DEFAULT_ANALYZE_DEPENDENCIES, ...overrides };
  const scoreThresholds = { ...dependencies.scoreThresholds, minScore: dependencies.minScore };
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

  const mkt = event.market || {};
  const holdersKnown = holdersResult.ok && supply > 0n && holders.length > 0;
  // Selector scanning is diagnostic only; it cannot prove proxy or non-standard privilege absence.
  const privilegesKnown = false;
  const deployerHistoryKnown = Boolean(historyResult.ok && history?.known);
  const marketBound = dex?.marketBound === true;
  const buildFacts = (hp, sellability) => ({
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
    sellabilityStatus: sellability.status,
    sellabilityReason: sellability.reason,
    sellabilityBuyerSamples: sellability.buyerSamples,
    sellabilityLadderSamples: sellability.ladderSamples,
    sellabilityMeaningfulSellers: sellability.meaningfulSellers,
    walletSignalsStatus: sellability.walletSignals.status,
    walletSignalCount: sellability.walletSignals.count,
    lpBurnedPct,
    lpUnknown: event.venue !== "uniswap-v2" || lpBurnedPct === null,
    mintable: Boolean(flags.mintable),
    owner,
    privilegesKnown,
    deployerTokens: history?.created ?? null,
    deployerHistoryKnown,
    marketBound,
    securityComplete: Boolean(
      marketBound &&
        holdersKnown &&
        creatorKnown &&
        privilegesKnown &&
        deployerHistoryKnown &&
        lpBurnedPct !== null &&
        hp.complete === true &&
        hp.honeypot === false
    ),
  });
  const prefilterSellability = sellabilityResult(SELLABILITY.UNKNOWN, "prefilter-score", {
    walletSignals: { status: "unconfigured", count: 0, matches: [] },
  });
  const prefilterHp = normalizeHoneypotSellability({
    honeypot: null,
    complete: false,
    reason: "prefilter-score",
    buyTaxBps: null,
    sellTaxBps: null,
  }, prefilterSellability);
  const preliminary = scoreFromFacts(buildFacts(prefilterHp, prefilterSellability), scoreThresholds);
  const inspectDeeply = preliminary.score >= Math.max(0, Number(dependencies.minScore) - 10);
  const hpResult = inspectDeeply
    ? await settled(dependencies.honeypotCheck({
      token,
      quote: event.quote,
      venue: event.venue,
      pool: event.pool,
      holders,
      blockNumber: event.blockNumber ?? null,
      pairCreatedAt: dex?.pairCreatedAt ?? event.createdAt ?? null,
      decimals: meta.decimals,
      walletCatalog: dependencies.walletCatalog,
    }))
    : { ok: true, value: prefilterHp, error: null, cause: null };
  const hpRaw = hpResult.value || {
    honeypot: null,
    complete: false,
    reason: hpResult.error,
    buyTaxBps: null,
    sellTaxBps: null,
  };
  const rawSellability = hpRaw.sellability || sellabilityResult(
    SELLABILITY.UNKNOWN,
    hpRaw.reason || "evidence-unavailable"
  );
  const hp = normalizeHoneypotSellability(hpRaw, rawSellability);
  const sellability = hp.sellability;
  const walletSignals = normalizeWalletSignals(sellability.walletSignals);

  const facts = buildFacts(hp, sellability);
  const securityComplete = facts.securityComplete;

  const scored = scoreFromFacts(facts, scoreThresholds);

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
    sellability,
    walletSignals,
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
  {
    token,
    quote,
    venue,
    pool,
    holders = [],
    blockNumber = null,
    pairCreatedAt = null,
    decimals,
    walletCatalog,
  },
  dependencies = {}
) {
  const walletSignals = normalizeWalletSignals({
    status: walletCatalog?.status,
    count: 0,
    matches: [],
  });
  let poolAddress;
  try {
    poolAddress = getAddress(pool);
  } catch {
    poolAddress = null;
  }
  if (venue !== "uniswap-v2" || !poolAddress || poolAddress === ZeroAddress) {
    const sellability = sellabilityResult(SELLABILITY.UNKNOWN, "unsupported-venue", { walletSignals });
    return normalizeHoneypotSellability({
      honeypot: null,
      complete: false,
      reason: "unsupported-venue",
      buyOk: null,
      sellOk: null,
      buyTaxBps: null,
      sellTaxBps: null,
      flags: null,
      sellability,
    }, sellability);
  }

  const provider = dependencies.provider || getProvider();
  const readBlockNumber = dependencies.getBlockNumber || (() => provider.getBlockNumber());
  const inspectBytecode = dependencies.bytecodeFlags || bytecodeFlags;
  const quoteRoundTrip = dependencies.quoteRoundTrip || simulateV2Quotes;
  const inspect = dependencies.inspectSellability || inspectSellability;
  const validateBinding = dependencies.validateV2PoolBinding || validateV2PoolBinding;
  const analysisBlock = await readBlockNumber();
  if (!Number.isInteger(analysisBlock) || analysisBlock < 0) throw new Error("analysis block unavailable");
  const quoteValue = String(quote || "").toLowerCase();
  const quoteAddr = isQuote(quote) && quoteValue !== ADDR.NATIVE.toLowerCase() && quoteValue !== ADDR.ZERO.toLowerCase()
    ? quote
    : ADDR.WETH;
  const inspectionContext = {
    token,
    quote: quoteAddr,
    venue,
    pool: poolAddress,
    blockNumber,
    pairCreatedAt,
    decimals,
    analysisBlock,
  };
  const bindingEvidence = await validateBinding(inspectionContext, {
    provider,
    retry: dependencies.retry,
  });
  if (!bindingEvidence?.ok || !bindingEvidence.binding) {
    const sellability = sellabilityResult(
      SELLABILITY.UNKNOWN,
      bindingEvidence?.reason || "evidence-unavailable",
      { details: bindingEvidence?.details, walletSignals }
    );
    return normalizeHoneypotSellability({
      honeypot: null,
      complete: false,
      reason: sellability.reason,
      buyOk: null,
      sellOk: null,
      buyTaxBps: null,
      sellTaxBps: null,
      flags: null,
      sellability,
    }, sellability);
  }

  let sellability = sellabilityResult(SELLABILITY.UNKNOWN, "evidence-unavailable", { walletSignals });
  const result = {
    honeypot: null,
    complete: false,
    reason: "",
    buyOk: null,
    sellOk: null,
    buyTaxBps: null,
    sellTaxBps: null,
    flags: null,
    sellability,
  };

  const readOptions = { provider, blockTag: analysisBlock };
  const flags = await inspectBytecode(token, readOptions);
  result.flags = flags;

  const blocked = (reason, detail) => {
    result.reason = reason;
    return normalizeHoneypotSellability(result, sellabilityResult(SELLABILITY.BLOCKED, reason, {
      details: detail ? [detail] : [],
      walletSignals,
    }));
  };

  if (!flags.hasCode) {
    return blocked("no-contract-code", "无合约代码：无法验证卖出能力");
  }

  const sim = await quoteRoundTrip(token, quoteAddr, readOptions);
  result.buyOk = sim.buyOk ?? null;
  result.sellOk = sim.sellOk ?? null;
  result.reason = sim.reason || "";
  if (sim.buyOk === false) {
    return blocked("buy-quote-unavailable", sim.reason || "无法报价买入");
  }
  if (sim.sellOk === false) {
    return blocked("sell-quote-zero", sim.reason || "无法报价卖出（蜜罐）");
  }

  const inspectedSellability = await inspect(inspectionContext, {
    provider,
    retry: dependencies.retry,
    poolBinding: bindingEvidence.binding,
    walletCatalog,
  });
  sellability = normalizeSellabilityEvidence(inspectedSellability, false);
  result.sellability = sellability;
  result.reason = sellability.reason || result.reason;
  if (sellability.status !== SELLABILITY.CONFIRMED) {
    return normalizeHoneypotSellability(result, sellability);
  }

  result.honeypot = false;
  result.reason = result.reason || sellability.reason || "已确认真实卖出证据";
  return normalizeHoneypotSellability(result, sellability);
}

async function simulateV2Quotes(token, quote, { provider = getProvider(), blockTag } = {}) {
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
    const amounts = await router.getAmountsOut(BUY_ETH, pathBuy, { blockTag });
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
    const back = await router.getAmountsOut(expectedBuy, pathSell, { blockTag });
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

export { formatEther, getAddress };

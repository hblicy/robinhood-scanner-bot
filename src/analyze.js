import { Contract, Interface, ZeroAddress, formatEther, getAddress, parseEther } from "ethers";
import { ADDR, NARRATIVE_WORDS, SETTINGS, isQuote } from "./config.js";
import { ERC20_ABI, V2_ROUTER_ABI } from "./abis.js";
import {
  bytecodeFlags,
  getProvider,
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

export function scoreFromFacts(f) {
  const checks = [];
  const red = [];
  let score = 0;

  const age = f.ageMinutes ?? 999;
  if (age <= SETTINGS.maxAgeMinutes) {
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

  if (f.creatorDumping) {
    checks.push({ key: "creator", ok: false, pts: 0, detail: `创建者仍持 ${f.creatorPct?.toFixed(1) ?? "?"}% 且在卖` });
    red.push("创建者持续抛售");
  } else if ((f.creatorPct || 0) <= 5) {
    score += 10;
    checks.push({ key: "creator", ok: true, pts: 10, detail: `创建者持仓 ${f.creatorPct?.toFixed(1) ?? 0}%` });
  } else if ((f.creatorPct || 0) <= 15) {
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
    checks.push({ key: "lp", ok: false, pts: 0, detail: "非 Uniswap V2，未检测 LP 锁" });
  } else if (f.lpBurnedPct >= 90 || f.lpLocked) {
    score += 10;
    checks.push({ key: "lp", ok: true, pts: 10, detail: f.lpLocked ? "LP 锁定" : `LP 已烧 ${f.lpBurnedPct.toFixed(0)}%` });
  } else if (f.lpBurnedPct > 0) {
    score += 3;
    checks.push({ key: "lp", ok: false, pts: 3, detail: `LP 仅烧 ${f.lpBurnedPct.toFixed(0)}%，可撤池` });
    red.push("流动性随时可撤");
  } else {
    checks.push({ key: "lp", ok: false, pts: 0, detail: "LP 未锁未烧" });
    red.push("流动性随时可撤");
  }

  if (f.mintable && f.owner && f.owner !== ZeroAddress) {
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

  const prev = f.deployerTokens ?? 0;
  if (prev <= 2) {
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
  const hardFail = red.some((r) => /蜜罐|无法卖出|税率/.test(r));
  let verdict = "watch";
  if (hardFail) verdict = "skip";
  else if (score >= 75 && red.length === 0 && f.honeypot === false) verdict = "green";
  else if (score >= SETTINGS.minScore) verdict = "review";
  else verdict = "skip";

  return { score, checks, red, verdict };
}

export async function analyze(event) {
  const token = getAddress(event.token);
  const [meta, owner, flags, dex, bsToken, holders, creatorInfo] = await Promise.all([
    readTokenMeta(token).catch(() => ({ name: "", symbol: "???", decimals: 18, totalSupply: 0n })),
    readOwner(token).catch(() => null),
    bytecodeFlags(token).catch(() => ({})),
    dexScreener(token).catch(() => null),
    blockscoutToken(token).catch(() => null),
    blockscoutHolders(token, 25).catch(() => []),
    blockscoutCreator(token).catch(() => null),
  ]);

  const createdAt = event.createdAt || dex?.pairCreatedAt || Date.now();
  const ageMinutes = Math.max(0, (Date.now() - createdAt) / 60000);

  let lpBurnedPct = 0;
  let lpLocked = false;
  let poolInfo = null;
  if (event.venue === "uniswap-v2" && event.pool) {
    poolInfo = await readV2Pool(event.pool).catch(() => null);
    lpBurnedPct = poolInfo?.burnedPct || 0;
    lpLocked = lpBurnedPct >= 90;
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
  const creatorBal = creator ? holders.find((h) => h.address.toLowerCase() === creator.toLowerCase()) : null;
  const creatorPct = creator && supply > 0n ? pct(creatorBal?.value || 0n, supply) : 0;
  const history = creator ? await deployerHistory(creator).catch(() => ({ created: 0 })) : { created: 0 };

  const hp = await honeypotCheck({
    token,
    quote: event.quote,
    venue: event.venue,
    pool: event.pool,
    holders,
  }).catch((err) => ({ honeypot: null, reason: err.message }));

  const mkt = event.market || {};
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
    creatorDumping: creatorPct > 8 && (dex?.sells5m || 0) > (dex?.buys5m || 0) * 1.5,
    creatorPct,
    honeypot: hp.honeypot,
    honeypotReason: hp.reason,
    buyTaxBps: hp.buyTaxBps,
    sellTaxBps: hp.sellTaxBps,
    lpBurnedPct,
    lpLocked,
    lpUnknown: event.venue !== "uniswap-v2",
    mintable: Boolean(flags.mintable),
    owner,
    deployerTokens: history.created,
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
    ...scored,
    links: {
      dex: dex?.url || `https://dexscreener.com/robinhood/${token}`,
      explorer: `https://robinhoodchain.blockscout.com/token/${token}`,
      gmgn: `https://gmgn.ai/robinhood/token/${token}`,
    },
  };
}

export async function honeypotCheck({ token, quote, venue, pool, holders = [] }) {
  const flags = await bytecodeFlags(token);
  const result = {
    honeypot: null,
    reason: "",
    buyOk: null,
    sellOk: null,
    buyTaxBps: 0,
    sellTaxBps: 0,
    flags,
  };

  if (!flags.hasCode) {
    result.honeypot = true;
    result.reason = "无合约代码";
    return result;
  }

  const quoteAddr = isQuote(quote) && quote !== ADDR.NATIVE && quote !== ADDR.ZERO ? quote : ADDR.WETH;

  if (venue === "uniswap-v2") {
    const sim = await simulateV2Quotes(token, quoteAddr);
    Object.assign(result, sim);
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
    const fromPool = await simulateTransferFromPool(token, pool);
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
    const sellXfer = await simulateTransfer(token, seller.address, pool, amt);
    if (sellXfer.ok === false) {
      result.honeypot = true;
      result.sellOk = false;
      result.reason = `持仓钱包转回池子失败: ${sellXfer.error}`;
      return result;
    }
    result.sellOk = true;
  }

  if (result.buyOk && result.sellOk) {
    result.honeypot = false;
    result.reason = result.reason || "买卖路径可报价，持仓可转出";
    return result;
  }

  if (venue === "uniswap-v2" && result.buyOk && result.sellOk !== false) {
    result.honeypot = false;
    result.reason = "V2 买卖均可报价（未拿到持仓做转账复核）";
    return result;
  }

  if (flags.blacklist || flags.pausable) {
    result.reason = "合约含黑名单/暂停函数，需人工看";
  } else if (!result.reason) {
    result.reason = "未完成完整买卖模拟";
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
    buyTaxBps: 0,
    sellTaxBps: 0,
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
    out.buyOk = false;
    out.reason = `无法报价买入: ${err.shortMessage || err.message}`;
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
    const lost = BUY_ETH > ethBack ? BUY_ETH - ethBack : 0n;
    out.sellTaxBps = Math.min(10_000, Number((lost * 10000n) / BUY_ETH));
  } catch (err) {
    out.sellOk = false;
    out.reason = `无法报价卖出: ${err.shortMessage || err.message}`;
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
  const bal = await erc.balanceOf(pool).catch(() => 0n);
  if (bal === 0n) return null;
  const amt = bal / 1000n || 1n;
  const data = erc20Iface.encodeFunctionData("transfer", [SIM_FROM, amt]);
  const call = await rawCall({ from: pool, to: token, data });
  return call.ok;
}

async function rawCall(tx, state = undefined) {
  const provider = getProvider();
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
    await withRetry(() => provider.send("eth_call", payload), 2);
    return { ok: true };
  } catch (err) {
    const msg = err?.error?.message || err.shortMessage || err.message || String(err);
    if (state && /state override|extra param|3 params/i.test(msg)) {
      try {
        await provider.send("eth_call", payload.slice(0, 2));
        return { ok: true };
      } catch (err2) {
        return { ok: false, error: err2.shortMessage || err2.message };
      }
    }
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

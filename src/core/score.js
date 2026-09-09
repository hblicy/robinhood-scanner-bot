export const SCORE_MAXIMA = Object.freeze({
  age: 15,
  liquidity: 15,
  marketCap: 10,
  flow: 15,
  social: 10,
  ownership: 15,
  lpAndPermissions: 12,
  smartWallets: 8,
});

function formatNumber(value) {
  if (!Number.isFinite(value)) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(0);
}

function createCategories() {
  return Object.fromEntries(Object.entries(SCORE_MAXIMA).map(([key, max]) => [
    key,
    { points: 0, max, checks: [] },
  ]));
}

function distinctWalletCount(facts) {
  if (facts.walletSignalsStatus !== "known") return 0;
  if (Array.isArray(facts.walletSignalMatches)) {
    const identities = new Set();
    for (const match of facts.walletSignalMatches) {
      const raw = typeof match === "string" ? match : match?.address;
      if (typeof raw !== "string" || !raw.trim()) continue;
      const identity = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : raw;
      identities.add(identity);
    }
    return identities.size;
  }
  return Number.isInteger(facts.walletSignalCount) ? Math.max(0, facts.walletSignalCount) : 0;
}

export function scoreCandidate(facts = {}, thresholds = {}) {
  const categories = createCategories();
  const redFlags = [];
  const add = (category, check) => {
    const bucket = categories[category];
    const points = Math.max(0, Math.min(bucket.max - bucket.points, Number(check.points) || 0));
    bucket.points += points;
    bucket.checks.push({ ...check, points });
  };

  if (Number.isFinite(facts.ageMinutes)) {
    const maxAge = Number(thresholds.maxAgeMinutes);
    if (facts.ageMinutes <= maxAge) {
      add("age", { key: "age", ok: true, points: 15, detail: `${facts.ageMinutes.toFixed(1)} 分钟` });
    } else if (facts.ageMinutes <= maxAge * 2) {
      add("age", { key: "age", ok: false, points: 5, detail: `${facts.ageMinutes.toFixed(1)} 分钟（偏老）` });
    } else {
      add("age", { key: "age", ok: false, points: 0, detail: `${facts.ageMinutes.toFixed(1)} 分钟（太老）` });
      redFlags.push("年龄超过窗口，机会很小");
    }
  }

  const socialKnown = typeof facts.hasTwitter === "boolean" || typeof facts.hasTelegram === "boolean";
  if (socialKnown) {
    const hasSocial = facts.hasTwitter === true || facts.hasTelegram === true;
    add("social", {
      key: "social",
      ok: hasSocial,
      points: hasSocial ? 6 : 0,
      detail: hasSocial
        ? [facts.hasTwitter ? "Twitter" : null, facts.hasTelegram ? "TG" : null].filter(Boolean).join(" + ")
        : "无社交链接",
    });
    if (!hasSocial && thresholds.requireSocial) redFlags.push("无 Twitter/TG");
  }
  if (Array.isArray(facts.narrativeHits)) {
    const hits = facts.narrativeHits.filter(Boolean);
    add("social", {
      key: "narrative",
      ok: hits.length > 0,
      points: hits.length > 0 ? 4 : 0,
      detail: hits.length > 0 ? hits.join(", ") : "名称无热门叙事词",
    });
  }

  const flowKnown = Number.isFinite(facts.volume5m) || Number.isFinite(facts.volume1h)
    || Number.isFinite(facts.buys5m) || Number.isFinite(facts.sells5m);
  if (flowKnown) {
    const buys = Number.isFinite(facts.buys5m) ? facts.buys5m : 0;
    const sells = Number.isFinite(facts.sells5m) ? facts.sells5m : 0;
    const volume = Number.isFinite(facts.volume5m) && facts.volume5m > 0
      ? facts.volume5m
      : Number.isFinite(facts.volume1h) ? facts.volume1h : 0;
    if (volume > 0 && buys >= sells && buys > 0) {
      add("flow", { key: "flow", ok: true, points: 15, detail: `买 ${buys} / 卖 ${sells} · $${formatNumber(volume)}` });
    } else if (volume > 0) {
      add("flow", { key: "flow", ok: false, points: 5, detail: `买 ${buys} / 卖 ${sells} · $${formatNumber(volume)}（卖压偏多）` });
    } else {
      add("flow", { key: "flow", ok: false, points: 0, detail: "几乎无成交" });
    }
  }

  if (Number.isFinite(facts.mcapUsd)) {
    if (facts.mcapUsd > 0 && facts.mcapUsd <= 80_000) {
      add("marketCap", { key: "mcap", ok: true, points: 10, detail: `$${formatNumber(facts.mcapUsd)} 早期低市值` });
    } else if (facts.mcapUsd > 0 && facts.mcapUsd <= thresholds.maxMcapUsd) {
      add("marketCap", { key: "mcap", ok: true, points: 5, detail: `$${formatNumber(facts.mcapUsd)}` });
    } else {
      add("marketCap", { key: "mcap", ok: false, points: 0, detail: `$${formatNumber(facts.mcapUsd)} 已偏高` });
      if (facts.mcapUsd > thresholds.maxMcapUsd) redFlags.push("市值已过筛选上限");
    }
  }

  if (Number.isFinite(facts.liquidityUsd)) {
    const ratio = Number.isFinite(facts.mcapUsd) && facts.mcapUsd > 0
      ? facts.liquidityUsd / facts.mcapUsd
      : null;
    if (facts.liquidityUsd >= thresholds.minLiquidityUsd && ratio !== null && ratio >= 0.2) {
      add("liquidity", { key: "liq", ok: true, points: 15, detail: `$${formatNumber(facts.liquidityUsd)}  (liq/mc ${(ratio * 100).toFixed(0)}%)` });
    } else if (facts.liquidityUsd >= thresholds.minLiquidityUsd) {
      add("liquidity", { key: "liq", ok: false, points: 7, detail: `$${formatNumber(facts.liquidityUsd)}  (比例未知或偏薄)` });
    } else {
      add("liquidity", { key: "liq", ok: false, points: 0, detail: `$${formatNumber(facts.liquidityUsd)} 流动性不足` });
      redFlags.push("流动性过低");
    }
  }

  if (Number.isFinite(facts.top10Pct)) {
    if (facts.top10Pct <= 30) {
      add("ownership", { key: "holders", ok: true, points: 10, detail: `前10 ${facts.top10Pct.toFixed(1)}% · ${facts.holderCount ?? "?"} 人` });
    } else if (facts.top10Pct <= thresholds.maxTop10Pct) {
      add("ownership", { key: "holders", ok: false, points: 5, detail: `前10 ${facts.top10Pct.toFixed(1)}% · ${facts.holderCount ?? "?"} 人` });
    } else {
      add("ownership", { key: "holders", ok: false, points: 0, detail: `前10 ${facts.top10Pct.toFixed(1)}% 过度集中` });
      redFlags.push("持仓过度集中");
    }
  }
  if (facts.creatorKnown === true && Number.isFinite(facts.creatorPct)) {
    if (facts.creatorPct <= 5) {
      add("ownership", { key: "creator", ok: true, points: 3, detail: `创建者持仓 ${facts.creatorPct.toFixed(1)}%` });
    } else if (facts.creatorPct <= 15) {
      add("ownership", { key: "creator", ok: false, points: 1, detail: `创建者持仓 ${facts.creatorPct.toFixed(1)}%` });
    } else {
      add("ownership", { key: "creator", ok: false, points: 0, detail: `创建者持仓 ${facts.creatorPct.toFixed(1)}%` });
      redFlags.push("创建者持仓过高");
    }
  }
  if (facts.deployerHistoryKnown === true && Number.isFinite(facts.deployerTokens)) {
    if (facts.deployerTokens <= 2) {
      add("ownership", { key: "deployer", ok: true, points: 2, detail: `历史发币 ${facts.deployerTokens}` });
    } else if (facts.deployerTokens <= thresholds.maxDeployerTokens) {
      add("ownership", { key: "deployer", ok: false, points: 1, detail: `历史发币 ${facts.deployerTokens}` });
    } else {
      add("ownership", { key: "deployer", ok: false, points: 0, detail: `历史发币 ${facts.deployerTokens}，像串子` });
      redFlags.push("创建者大量发垃圾币");
    }
  }

  if (facts.lpUnknown === true) {
    add("lpAndPermissions", { key: "lp", ok: false, points: 0, detail: "未验证 V2 LP 销毁比例" });
  } else if (Number.isFinite(facts.lpBurnedPct)) {
    if (facts.lpBurnedPct >= 90) {
      add("lpAndPermissions", { key: "lp", ok: true, points: 10, detail: `LP 已烧 ${facts.lpBurnedPct.toFixed(0)}%` });
    } else if (facts.lpBurnedPct > 0) {
      add("lpAndPermissions", { key: "lp", ok: false, points: 3, detail: `LP 仅烧 ${facts.lpBurnedPct.toFixed(0)}%，可撤池` });
      redFlags.push("流动性随时可撤");
    } else {
      add("lpAndPermissions", { key: "lp", ok: false, points: 0, detail: "LP 未锁未烧" });
      redFlags.push("流动性随时可撤");
    }
  }
  if (facts.privilegesKnown === true) {
    if (facts.mintable && facts.owner && !/^0x0{40}$/i.test(facts.owner)) {
      add("lpAndPermissions", { key: "mint", ok: false, points: 0, detail: "可铸造且 owner 未放弃" });
      redFlags.push("可增发");
    } else {
      add("lpAndPermissions", { key: "mint", ok: true, points: 2, detail: "未见 mint / owner 已弃" });
    }
  }

  if (facts.honeypot === true) {
    redFlags.push("蜜罐 / 无法卖出");
  }
  const tax = Math.max(
    Number.isFinite(facts.buyTaxBps) ? facts.buyTaxBps : 0,
    Number.isFinite(facts.sellTaxBps) ? facts.sellTaxBps : 0
  );
  if (tax > thresholds.maxTaxBps) redFlags.push(`税率 ${tax}bps 过高`);

  const walletCount = distinctWalletCount(facts);
  const walletPoints = walletCount >= 2 ? 8 : walletCount === 1 ? 5 : 0;
  if (facts.walletSignalsStatus === "known" || facts.walletSignalsStatus === "unconfigured") {
    add("smartWallets", {
      key: "smart_money",
      ok: walletPoints > 0,
      points: walletPoints,
      detail: facts.walletSignalsStatus !== "known"
        ? "标签未配置"
        : walletCount > 0 ? `命中 ${walletCount} 个已标记买家` : "未命中",
    });
  }

  const score = Object.values(categories).reduce((sum, category) => sum + category.points, 0);
  return { score, categories, redFlags };
}

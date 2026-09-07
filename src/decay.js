const TWO_HOURS_MS = 2 * 3_600_000;
const SAFE_TOP_POOL_CATEGORIES = new Set(["infrastructure", "stock", "pons"]);

export function buildDecayWindows(poolRegisteredAt) {
  if (!Number.isFinite(poolRegisteredAt)) throw new Error("poolRegisteredAt must be finite");
  return Array.from({ length: 12 }, (_, index) => ({
    index,
    label: `${index * 2}h-${(index + 1) * 2}h`,
    startAt: poolRegisteredAt + index * TWO_HOURS_MS,
    endAt: poolRegisteredAt + (index + 1) * TWO_HOURS_MS,
  }));
}

function pct(numerator, denominator) {
  if (denominator <= 0n) return null;
  return Number((numerator * 10_000n) / denominator) / 100;
}

export function summarizeDecayWindow(input, { excludedAddresses = [] } = {}) {
  const holders = Array.isArray(input.holders) ? input.holders : [];
  const totalSupply = BigInt(input.totalSupply ?? 0);
  const excluded = new Set(excludedAddresses.map((address) => String(address).toLowerCase()));
  const sorted = [...holders].sort((left, right) => {
    const a = BigInt(left.balance);
    const b = BigInt(right.balance);
    return a === b ? 0 : a > b ? -1 : 1;
  });
  const rawTop = sorted.slice(0, 10).reduce((sum, holder) => sum + BigInt(holder.balance), 0n);
  const adjustedTop = sorted
    .filter((holder) => !excluded.has(String(holder.address).toLowerCase()))
    .slice(0, 10)
    .reduce((sum, holder) => sum + BigInt(holder.balance), 0n);
  return {
    label: input.label,
    startAt: input.startAt,
    endAt: input.endAt,
    complete: Number.isFinite(input.now) && Number.isFinite(input.endAt) && input.now >= input.endAt,
    source: input.source || "unknown",
    volumeUsd: Number.isFinite(input.volumeUsd) ? input.volumeUsd : null,
    holderNet: Number.isFinite(input.holderNet) ? input.holderNet : null,
    netBuyUsd: Number.isFinite(input.netBuyUsd) ? input.netBuyUsd : null,
    rawTop10Pct: pct(rawTop, totalSupply),
    adjustedTop10Pct: pct(adjustedTop, totalSupply),
    creatorBalanceChangePct: Number.isFinite(input.creatorBalanceChangePct)
      ? input.creatorBalanceChangePct
      : null,
    creatorSellEvidence: input.creatorSellEvidence === true,
    shadowCoin: input.shadowCoin === true,
  };
}

function completeMetrics(window) {
  return window?.complete === true &&
    Number.isFinite(window.volumeUsd) &&
    Number.isFinite(window.adjustedTop10Pct);
}

export function evaluateDecay({ baseline, previous, current }) {
  if (!completeMetrics(baseline) || !completeMetrics(previous) || !completeMetrics(current) ||
      !Number.isFinite(current.holderNet) || !Number.isFinite(current.netBuyUsd)) {
    return { decision: "pending", killed: false, greenAllowed: false, reason: null, risks: ["incomplete-or-unknown"] };
  }
  if (current.shadowCoin === true) {
    return { decision: "killed", killed: true, greenAllowed: false, reason: "shadow-coin", risks: ["shadow-coin"] };
  }
  if (current.volumeUsd <= previous.volumeUsd * 0.5 && current.holderNet <= 0 && current.netBuyUsd < 0) {
    return {
      decision: "killed",
      killed: true,
      greenAllowed: false,
      reason: "two-hour-decay-collapse",
      risks: ["two-hour-decay-collapse"],
    };
  }
  if (current.label === "22h-24h" && current.volumeUsd < baseline.volumeUsd * 0.2) {
    return {
      decision: "killed",
      killed: true,
      greenAllowed: false,
      reason: "day-one-volume-dead",
      risks: ["day-one-volume-dead"],
    };
  }
  const risks = [];
  if (current.holderNet > 0 && current.adjustedTop10Pct > previous.adjustedTop10Pct) {
    risks.push("holders-up-concentration-up");
  }
  if (Number.isFinite(current.creatorBalanceChangePct) && current.creatorBalanceChangePct < 0) {
    risks.push(current.creatorSellEvidence ? "creator-selling" : "creator-balance-change-unverified");
  }
  return {
    decision: risks.length ? "risk" : "passed",
    killed: false,
    greenAllowed: risks.length === 0,
    reason: null,
    risks,
  };
}

export function evaluateHeat(input, settings) {
  const stale = !Number.isFinite(input.fetchedAt) || !Number.isFinite(input.now) ||
    input.now - input.fetchedAt > settings.ttlMs;
  const dataKnown = Number.isFinite(input.launches24h) && Array.isArray(input.topPools) && input.topPools.length > 0;
  const infrastructureOnly = dataKnown && input.topPools.every((pool) =>
    SAFE_TOP_POOL_CATEGORIES.has(pool.category)
  );
  const high = dataKnown && input.launches24h >= settings.highHeatLaunches24h;
  const decision = !dataKnown || stale || infrastructureOnly ? "不打" : "打";
  return {
    decision,
    level: high ? "high" : "normal",
    admissionCap: decision === "不打" || high ? settings.highHeatCap : settings.normalCap,
    launches24h: Number.isFinite(input.launches24h) ? input.launches24h : null,
    ponsPopularPct: Number.isFinite(input.ponsPopularPct) ? input.ponsPopularPct : null,
    stale,
    calculatedAt: input.now,
  };
}

import { SCORE_MAXIMA, scoreCandidate } from "./core/score.js";

const ROUTE_STAT_KEYS = Object.freeze([
  "pons_official_checks",
  "deferred_pons_checks",
  "skipped_unsupported_venue",
  "skipped_score_upper_bound",
  "paid_deep_checks",
  "analysis_rpc_cooldown_skips",
]);

const UNREAD_CATEGORY_MAXIMUM =
  SCORE_MAXIMA.social
  + SCORE_MAXIMA.ownership
  + SCORE_MAXIMA.lpAndPermissions
  + SCORE_MAXIMA.smartWallets;

export function createCandidateRouteStats() {
  return Object.fromEntries(ROUTE_STAT_KEYS.map((key) => [key, 0]));
}

export function incrementCandidateRouteStat(stats, key) {
  if (!stats || !Object.hasOwn(stats, key)) {
    throw new Error(`unknown candidate route stat: ${key}`);
  }
  stats[key] += 1;
  return stats[key];
}

export function formatCandidateRouteStats(stats) {
  return [
    `pons=${stats.pons_official_checks}`,
    `deferred=${stats.deferred_pons_checks}`,
    `unsupported=${stats.skipped_unsupported_venue}`,
    `score=${stats.skipped_score_upper_bound}`,
    `deep=${stats.paid_deep_checks}`,
    `cooldown=${stats.analysis_rpc_cooldown_skips}`,
  ].join(" ");
}

export function supportsRobinhoodSellability(candidate) {
  return candidate?.venue === "uniswap-v2";
}

export function scoreCandidateUpperBound(candidate, thresholds = {}) {
  const market = candidate?.market;
  if (candidate?.source !== "gecko" || market?.scoreKnown !== true) return null;
  const observedAt = Number(candidate.observedAt);
  const createdAt = Number(candidate.createdAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(createdAt)) return null;
  const facts = {
    ageMinutes: Math.max(0, (observedAt - createdAt) / 60_000),
    mcapUsd: market.mcapUsd,
    liquidityUsd: market.liquidityUsd,
    volume5m: market.volume5m,
    volume1h: market.volume1h,
    buys5m: market.buys5m,
    sells5m: market.sells5m,
  };
  if (Object.values(facts).some((value) => !Number.isFinite(value))) return null;
  if (Object.values(facts).some((value) => value < 0)) return null;
  if (!Number.isInteger(facts.buys5m) || !Number.isInteger(facts.sells5m)) return null;
  return scoreCandidate(facts, thresholds).score + UNREAD_CATEGORY_MAXIMUM;
}

export function routeCandidate(candidate, {
  thresholds = {},
  supportsSellability,
} = {}) {
  if (typeof supportsSellability !== "function") {
    throw new Error("candidate gate requires sellability capability lookup");
  }
  if (!supportsSellability(candidate)) {
    return { action: "skip", reason: "unsupported-sellability-venue" };
  }
  const deepInspectionFloor = Math.max(0, Number(thresholds.minScore ?? 0) - 10);
  const upperBound = scoreCandidateUpperBound(candidate, thresholds);
  if (upperBound !== null && upperBound < deepInspectionFloor) {
    return {
      action: "skip",
      reason: "prefilter-score-upper-bound",
      upperBound,
      deepInspectionFloor,
    };
  }
  return { action: "analyze", upperBound, deepInspectionFloor };
}

import { normalizeSellabilityEvidence } from "./sellability.js";
import { candidateKey } from "./core/candidate.js";
import { decideCandidateAlert } from "./core/alert-policy.js";

export { candidateKey } from "./core/candidate.js";

function normalizeSellabilityReason(reason) {
  if (reason == null || reason === "") return "none";
  if (typeof reason !== "string") return "evidence-unavailable";
  return reason.length <= 64 && /^[a-z0-9-]+$/.test(reason) ? reason : "evidence-unavailable";
}

export async function handleCandidate(event, options, dependencies) {
  const ageReference = Number.isFinite(event.observedAt) ? event.observedAt : dependencies.now();
  const ageMinutes = event.createdAt
    ? Math.max(0, (ageReference - event.createdAt) / 60_000)
    : null;
  const key = candidateKey(event);
  if (ageMinutes !== null && ageMinutes > dependencies.maxAgeMinutes) {
    if (options.persistSeen !== false) {
      dependencies.markSeen(key, { token: event.token, skipped: "too-old", ageMinutes });
    }
    return null;
  }

  dependencies.log(`analyzing ${event.token} via ${event.source}/${event.venue}`);
  const report = await dependencies.analyze(event);
  const sellability = normalizeSellabilityEvidence(report.sellability, report.honeypot?.honeypot);
  const normalizedReport = { ...report, sellability };
  const sellabilityStatus = sellability.status;
  const sellabilityReason = normalizeSellabilityReason(
    sellability.reason || (sellabilityStatus === "confirmed" ? null : "evidence-unavailable")
  );
  const alertDecision = decideCandidateAlert({
    mode: dependencies.mode ?? "live",
    sellability: sellabilityStatus,
    score: report.score,
    minScore: dependencies.minScore,
  });
  normalizedReport.watchlistAdmission = alertDecision?.watchlistAdmission === true;
  normalizedReport.alertType = alertDecision?.type ?? null;
  if (alertDecision) await dependencies.alertReport(normalizedReport);
  else {
    const errorSources = [...new Set((report.errorSources || []).map(({ source }) => source))];
    const suffix = errorSources.length ? ` data-errors=${errorSources.join(",")}` : "";
    dependencies.log(
      `quiet skip ${report.meta.symbol} ${report.score}/100 ${report.verdict}${suffix} sellability=${sellabilityStatus}:${sellabilityReason}`
    );
  }
  if (typeof dependencies.onAnalyzed === "function") {
    await dependencies.onAnalyzed(normalizedReport, event);
  }
  if (options.persistSeen !== false) {
    dependencies.markSeen(key, {
      token: report.token,
      pool: report.pool,
      poolId: report.poolId || null,
      symbol: report.meta.symbol,
      score: report.score,
      verdict: report.verdict,
      venue: report.venue,
    });
  }
  return normalizedReport;
}

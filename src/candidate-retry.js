import { candidateKey } from "./runtime.js";
import { normalizeSellabilityEvidence } from "./sellability.js";

export const CANDIDATE_RETRY_OFFSETS_MS = Object.freeze([120_000, 300_000, 600_000]);

export function shouldScheduleCandidateRecheck(event, report) {
  const sellability = normalizeSellabilityEvidence(
    report?.sellability,
    report?.honeypot?.honeypot
  );
  return Boolean(event?.token && (event?.pool || event?.poolId))
    && sellability.status === "unknown"
    && !["prefilter-score", "unsupported-venue"].includes(sellability.reason);
}

export function createCandidateRecheck(event, firstAnalyzedAt) {
  if (!Number.isFinite(firstAnalyzedAt)) {
    throw new Error("candidate recheck requires firstAnalyzedAt");
  }
  const dueAt = firstAnalyzedAt + CANDIDATE_RETRY_OFFSETS_MS[0];
  return {
    id: `candidate-recheck:${candidateKey(event)}`,
    type: "candidate_recheck",
    event: structuredClone(event),
    firstAnalyzedAt,
    dueAt,
    nextAttemptAt: dueAt,
    retryOffsetsMs: [...CANDIDATE_RETRY_OFFSETS_MS],
    maxAttempts: CANDIDATE_RETRY_OFFSETS_MS.length,
  };
}

export function decideCandidateRecheck(check, report, at, maxAgeMinutes) {
  if (!shouldScheduleCandidateRecheck(check?.event, report)) return { complete: true };

  const origin = Number.isFinite(check.event.createdAt)
    ? check.event.createdAt
    : check.firstAnalyzedAt;
  if (!Number.isFinite(at) || at - origin > maxAgeMinutes * 60_000) {
    return { complete: true };
  }

  const completedAttempt = Number(check.attempts || 0) + 1;
  const nextOffset = CANDIDATE_RETRY_OFFSETS_MS[completedAttempt];
  if (nextOffset == null) return { complete: true };
  return {
    complete: false,
    retryAt: check.firstAnalyzedAt + nextOffset,
    lastError: report.sellability?.reason || "evidence-unavailable",
  };
}

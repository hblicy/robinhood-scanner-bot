import { candidateKey } from "./runtime.js";
import { isDiscoveryFallbackError } from "./chain.js";
import { safeErrorMessage } from "./safety.js";

export const CANDIDATE_RECOVERY_OFFSETS_MS = Object.freeze([120_000, 300_000, 600_000]);

export class RetryableCandidateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RetryableCandidateError";
    this.code = "RETRYABLE_CANDIDATE";
  }
}

export function candidateRecoveryId(event) {
  return `candidate-recovery:${candidateKey(event)}`;
}

export function createCandidateRecovery(event, failedAt, error) {
  if (!Number.isFinite(failedAt)) throw new Error("candidate recovery requires failedAt");
  const dueAt = failedAt + CANDIDATE_RECOVERY_OFFSETS_MS[0];
  return {
    id: candidateRecoveryId(event),
    type: "candidate_recovery",
    event: structuredClone(event),
    firstAnalyzedAt: failedAt,
    dueAt,
    nextAttemptAt: dueAt,
    retryOffsetsMs: [...CANDIDATE_RECOVERY_OFFSETS_MS],
    maxAttempts: CANDIDATE_RECOVERY_OFFSETS_MS.length,
    lastError: safeErrorMessage(error),
  };
}

export function isRetryableCandidateFailure(error) {
  return error?.code === "RETRYABLE_CANDIDATE"
    || error?.code === "RETRYABLE_ANALYSIS"
    || isDiscoveryFallbackError(error);
}

export function activeCandidateRecoveryKeys(snapshot) {
  return new Set(Object.values(snapshot?.pendingChecks || {})
    .filter((check) => check?.type === "candidate_recovery" && check.status !== "completed")
    .map((check) => candidateKey(check.event)));
}

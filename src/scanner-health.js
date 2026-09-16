function counts(entries, field) {
  return Object.values(entries || {}).reduce((result, entry) => {
    const key = String(entry?.[field] || "unknown");
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

function formatCounts(values, separator = "=") {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${separator}${value}`)
    .join(",");
}

export function formatPendingReconciliation(summary) {
  return `pending-reconcile scanned=${summary.scanned} expired=${summary.expired}`
    + ` canonicalCreated=${summary.canonicalCreated}`
    + ` reasons=${formatCounts(summary.reasons, ":") || "none"}`;
}

export function formatWorkerActivity(name, result) {
  const fields = Object.entries(result)
    .filter(([key, value]) => key !== "nextBucketCursor" && Number(value) > 0)
    .map(([key, value]) => `${key}=${value}`);
  return fields.length ? `${name} ${fields.join(" ")}` : null;
}

export function formatScannerHealth(snapshot, at = Date.now()) {
  const pending = Object.values(snapshot?.pendingChecks || {})
    .filter((entry) => entry?.status === "pending");
  const created = pending.map((entry) => Number(entry.createdAt)).filter(Number.isFinite);
  const oldestPendingAgeMs = created.length ? Math.max(0, at - Math.min(...created)) : 0;
  return [
    "scanner-health",
    `onchain=${snapshot?.cursors?.onchain ?? "null"}`,
    `pons=${snapshot?.cursors?.ponsV2 ?? "null"}`,
    `pendingStatus=${formatCounts(counts(snapshot?.pendingChecks, "status")) || "none"}`,
    `pendingTypes=${formatCounts(counts(pending, "type")) || "none"}`,
    `oldestPendingAgeMs=${oldestPendingAgeMs}`,
    `outbox=${formatCounts(counts(snapshot?.outbox, "status")) || "none"}`,
  ].join(" ");
}

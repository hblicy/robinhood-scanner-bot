export const PENDING_CHECK_BUCKET_COUNT = 3;

const REALTIME_TYPES = new Set(["candidate_recovery", "candidate_recheck"]);
const PONS_TYPES = new Set([
  "pons_inspection",
  "curve_flow",
  "holders",
  "deployer_24h",
  "line_a",
  "market",
  "line_c",
]);

export function pendingCheckBucket(type) {
  if (REALTIME_TYPES.has(type)) return 0;
  if (PONS_TYPES.has(type)) return 1;
  return 2;
}

export function selectDueChecks(entries, { at, limit, startBucket = 0 }) {
  if (!Number.isFinite(at) || !Number.isInteger(limit) || limit < 0) {
    throw new Error("pending-check selection requires finite at and non-negative integer limit");
  }
  const buckets = Array.from({ length: PENDING_CHECK_BUCKET_COUNT }, () => []);
  for (const entry of entries) {
    if (entry?.status !== "pending" || !Number.isFinite(entry.nextAttemptAt) || entry.nextAttemptAt > at) continue;
    buckets[pendingCheckBucket(entry.type)].push(entry);
  }
  for (const bucket of buckets) {
    bucket.sort((left, right) =>
      left.nextAttemptAt - right.nextAttemptAt
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id));
  }

  const selected = [];
  let cursor = ((startBucket % PENDING_CHECK_BUCKET_COUNT) + PENDING_CHECK_BUCKET_COUNT)
    % PENDING_CHECK_BUCKET_COUNT;
  while (selected.length < limit) {
    let picked = false;
    for (let offset = 0; offset < PENDING_CHECK_BUCKET_COUNT && selected.length < limit; offset += 1) {
      const bucket = buckets[(cursor + offset) % PENDING_CHECK_BUCKET_COUNT];
      if (!bucket.length) continue;
      selected.push(bucket.shift());
      picked = true;
    }
    if (!picked) break;
    cursor = (cursor + 1) % PENDING_CHECK_BUCKET_COUNT;
  }
  return selected;
}

export function candidateKey(event) {
  return [event?.venue || "unknown", event?.poolId || event?.pool || "no-pool", event?.token || "no-token"]
    .map((value) => String(value).toLowerCase())
    .join("|");
}

export async function handleCandidate(event, options, dependencies) {
  const ageMinutes = event.createdAt
    ? Math.max(0, (dependencies.now() - event.createdAt) / 60_000)
    : null;
  const key = candidateKey(event);
  if (ageMinutes !== null && ageMinutes > dependencies.maxAgeMinutes * 2) {
    if (options.persistSeen !== false) {
      dependencies.markSeen(key, { token: event.token, skipped: "too-old", ageMinutes });
    }
    return null;
  }

  dependencies.log(`analyzing ${event.token} via ${event.source}/${event.venue}`);
  const report = await dependencies.analyze(event);
  const shouldAlert =
    report.verdict === "green" ||
    report.verdict === "review" ||
    report.honeypot?.honeypot === true ||
    report.score >= dependencies.minScore;
  if (shouldAlert) await dependencies.alertReport(report);
  else dependencies.log(`quiet skip ${report.meta.symbol} ${report.score}/100 ${report.verdict}`);
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
  return report;
}

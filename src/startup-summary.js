function projectedMonthlyTotal(usage, now) {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const elapsed = Math.max(1, date.getTime() - start);
  return Math.ceil(usage.total * (end - start) / elapsed);
}

export function printStartupSummary(config, { log = console.log } = {}) {
  const catalog = config.assetCatalog;
  const usage = config.rpcUsageBudget?.snapshot?.();
  const venues = config.venueRegistry?.list?.() ?? [];
  log(`${config.profile.name} assets=${catalog?.assets?.length ?? 0} assetSnapshot=${catalog?.source?.verifiedAt ?? "none"}`);
  log(`venues ${venues.map(({ id, identityStatus, securityCapability }) =>
    `${id}:${identityStatus}/${securityCapability}`).join(" ") || "none"}`);
  if (usage) log(`rpc-budget ${usage.total}/${usage.limit} stage=${usage.stage}`);
  else log("rpc-budget not-metered");
}

export function formatHourlyUsage(config, now = Date.now()) {
  const usage = config.rpcUsageBudget?.snapshot?.();
  if (!usage) return `${config.profile.key} rpc-usage not-metered`;
  const methods = Object.entries(usage.methods)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([method, count]) => `${method}=${count}`)
    .join(" ");
  const cache = config.assetCatalogCache?.snapshot?.() ?? {};
  const cacheHits = Number(cache.runtimeHits ?? 0) + Number(cache.shippedHits ?? 0);
  return `${config.profile.key} rpc-usage ${usage.total}/${usage.limit} stage=${usage.stage} ${methods || "methods=none"} cacheHits=${cacheHits} projected=${projectedMonthlyTotal(usage, now)}`;
}

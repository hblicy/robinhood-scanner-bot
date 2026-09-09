export function normalizeRpcEndpoint(value) {
  const parsed = new URL(value);
  parsed.hash = "";
  if ((parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")) {
    parsed.port = "";
  }
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.href;
}

export function createRoleProviders({
  discoveryUrl,
  analysisUrl,
  discoveryCups,
  analysisCups,
  createProvider,
}) {
  if (typeof createProvider !== "function") throw new Error("createProvider must be a function");
  const discoveryKey = normalizeRpcEndpoint(discoveryUrl);
  const analysisKey = normalizeRpcEndpoint(analysisUrl);
  if (discoveryKey === analysisKey) {
    const shared = createProvider(analysisUrl, Math.min(discoveryCups, analysisCups));
    return {
      analysis: shared,
      discoveryPrimary: shared,
      discoveryFallback: null,
      sameEndpoint: true,
    };
  }
  const discoveryPrimary = createProvider(discoveryUrl, discoveryCups);
  const analysis = createProvider(analysisUrl, analysisCups);
  return {
    analysis,
    discoveryPrimary,
    discoveryFallback: analysis,
    sameEndpoint: false,
  };
}

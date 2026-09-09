import { Connection } from "@solana/web3.js";
import { createDiscoverySessionRunner } from "../discovery-session.js";
import { isDiscoveryFallbackError } from "../chain.js";
import { createRpcScheduler } from "../rpc-budget.js";
import { createRoleProviders } from "../rpc-endpoints.js";

const READ_COST = Object.freeze({
  getSlot: 1,
  getSignaturesForAddress: 1,
  getTransaction: 2,
  getAccountInfo: 1,
  getMultipleAccountsInfo: 1,
  getParsedAccountInfo: 1,
  getTokenSupply: 1,
  getTokenAccountBalance: 1,
  getParsedTokenAccountsByOwner: 2,
  onLogs: 1,
  removeOnLogsListener: 1,
});

export function createReadonlySolanaConnection(connection, cups) {
  const schedule = createRpcScheduler({ cuPerSecond: cups });
  const readonly = {};
  for (const [method, cost] of Object.entries(READ_COST)) {
    if (typeof connection[method] !== "function") continue;
    readonly[method] = (...args) => schedule(cost, () => connection[method](...args));
  }
  return Object.freeze(readonly);
}

export function createSolanaRpcContext(config, dependencies = {}) {
  const createConnection = dependencies.createConnection ?? ((url, wsEndpoint = "") => new Connection(url, {
    commitment: "confirmed",
    ...(wsEndpoint ? { wsEndpoint } : {}),
  }));
  const buildHttp = (url, cups) => createReadonlySolanaConnection(createConnection(url), cups);
  const providers = createRoleProviders({
    discoveryUrl: config.rpc.discoveryUrl,
    analysisUrl: config.rpc.analysisUrl,
    discoveryCups: config.rpc.discoveryCups,
    analysisCups: config.rpc.analysisCups,
    createProvider: buildHttp,
  });
  const wsConnection = config.rpc.wsUrl
    ? createReadonlySolanaConnection(
      createConnection(config.rpc.discoveryUrl, config.rpc.wsUrl),
      config.rpc.discoveryCups
    )
    : null;
  return Object.freeze({
    analysisConnection: providers.analysis,
    discoveryPrimary: providers.discoveryPrimary,
    discoveryFallback: providers.discoveryFallback,
    wsConnection,
    discoverySessions: createDiscoverySessionRunner({
      primary: providers.discoveryPrimary,
      fallback: providers.discoveryFallback,
      shouldFallback: dependencies.shouldFallback ?? isDiscoveryFallbackError,
      cooldownMs: config.rpc.cooldownMs,
      log: dependencies.log ?? console.warn,
    }),
  });
}

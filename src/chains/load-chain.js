import path from "node:path";
import { EVM_PROFILES } from "./evm-profiles.js";
import { SOLANA_PROFILE } from "./solana-profile.js";

const PREFIXES = Object.freeze({
  ethereum: "ETHEREUM",
  base: "BASE",
  bsc: "BSC",
  robinhood: "ROBINHOOD",
});
const ALERT_MODES = new Set(["recovery", "shadow", "live"]);
const MONTHLY_RPC_LIMITS = Object.freeze({
  ethereum: 4_500_000,
  base: 3_000_000,
  bsc: 5_500_000,
  robinhood: 5_000_000,
});

function firstValue(env, names, fallback = "") {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

function integer(name, value, { min, max = Number.MAX_SAFE_INTEGER }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function finiteNumber(name, value, { min = 0, max = Number.MAX_VALUE, exclusiveMin = false } = {}) {
  const parsed = Number(value);
  const below = exclusiveMin ? parsed <= min : parsed < min;
  if (!Number.isFinite(parsed) || below || parsed > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}`);
  }
  return parsed;
}

function booleanValue(name, value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  throw new Error(`${name} must be true or false`);
}

function rpcUrl(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  return value;
}

function wsUrl(name, value) {
  if (value === undefined || value === "") return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid WS(S) URL`);
  }
  if (!new Set(["ws:", "wss:"]).has(parsed.protocol)) {
    throw new Error(`${name} must be a valid WS(S) URL`);
  }
  return value;
}

function loadSolanaConfig(envSource) {
  const prefix = "SOLANA";
  const discoveryUrl = rpcUrl(
    "SOLANA_DISCOVERY_RPC_URL",
    firstValue(envSource, ["SOLANA_DISCOVERY_RPC_URL"], SOLANA_PROFILE.publicRpc)
  );
  const analysisUrl = rpcUrl(
    "SOLANA_ANALYSIS_RPC_URL",
    firstValue(envSource, ["SOLANA_ANALYSIS_RPC_URL"], discoveryUrl)
  );
  const alertMode = String(firstValue(envSource, ["SOLANA_ALERT_MODE", "ALERT_MODE"], "shadow")).toLowerCase();
  if (!ALERT_MODES.has(alertMode)) {
    throw new Error("SOLANA_ALERT_MODE must be recovery, shadow, or live");
  }
  return Object.freeze({
    family: "solana",
    profile: SOLANA_PROFILE,
    rpc: Object.freeze({
      discoveryUrl,
      analysisUrl,
      wsUrl: wsUrl("SOLANA_WS_RPC_URL", envSource.SOLANA_WS_RPC_URL),
      discoveryCups: integer(
        "SOLANA_DISCOVERY_RPC_CUPS",
        firstValue(envSource, ["SOLANA_DISCOVERY_RPC_CUPS", "DISCOVERY_RPC_CUPS"], 40),
        { min: 1 }
      ),
      analysisCups: integer(
        "SOLANA_ANALYSIS_RPC_CUPS",
        firstValue(envSource, ["SOLANA_ANALYSIS_RPC_CUPS", "ANALYSIS_RPC_CUPS"], 80),
        { min: 1 }
      ),
      concurrency: integer(
        "SOLANA_RPC_CONCURRENCY",
        firstValue(envSource, ["SOLANA_RPC_CONCURRENCY"], 4),
        { min: 1, max: 32 }
      ),
      cooldownMs: integer(
        "SOLANA_DISCOVERY_RPC_COOLDOWN_MS",
        firstValue(envSource, ["SOLANA_DISCOVERY_RPC_COOLDOWN_MS", "DISCOVERY_RPC_COOLDOWN_MS"], 60_000),
        { min: 1 }
      ),
    }),
    settings: Object.freeze({
      maxAgeMinutes: finiteNumber("MAX_AGE_MINUTES", firstValue(envSource, ["MAX_AGE_MINUTES"], 30), {
        min: 0,
        exclusiveMin: true,
      }),
      minLiquidityUsd: finiteNumber("MIN_LIQUIDITY_USD", firstValue(envSource, ["MIN_LIQUIDITY_USD"], 1_500)),
      maxMcapUsd: finiteNumber("MAX_MCAP_USD", firstValue(envSource, ["MAX_MCAP_USD"], 1_500_000), {
        min: 0,
        exclusiveMin: true,
      }),
      maxTop10Pct: finiteNumber("MAX_TOP10_PCT", firstValue(envSource, ["MAX_TOP10_PCT"], 55), {
        min: 0,
        max: 100,
      }),
      maxTaxBps: finiteNumber("MAX_TAX_BPS", firstValue(envSource, ["MAX_TAX_BPS"], 500), {
        min: 0,
        max: 10_000,
      }),
      maxDeployerTokens: integer("MAX_DEPLOYER_TOKENS", firstValue(envSource, ["MAX_DEPLOYER_TOKENS"], 8), {
        min: 0,
      }),
      requireSocial: booleanValue("REQUIRE_SOCIAL", envSource.REQUIRE_SOCIAL, false),
      pollMs: integer("SOLANA_POLL_MS", firstValue(envSource, ["SOLANA_POLL_MS", "POLL_MS"], 5_000), {
        min: 250,
      }),
      minScore: integer("SOLANA_MIN_SCORE", firstValue(envSource, ["SOLANA_MIN_SCORE", "MIN_SCORE"], 70), {
        min: 0,
        max: 100,
      }),
      confirmationBlocks: 1,
      alertMode,
      meaningfulSellerCount: integer(
        "SOLANA_MEANINGFUL_SELLER_COUNT",
        firstValue(envSource, ["SOLANA_MEANINGFUL_SELLER_COUNT"], 3),
        { min: 1, max: 20 }
      ),
      assetRefreshMs: integer(
        "ASSET_REFRESH_MS",
        firstValue(envSource, ["ASSET_REFRESH_MS"], 21_600_000),
        { min: 60_000 }
      ),
    }),
    telegram: Object.freeze({
      token: firstValue(envSource, ["TELEGRAM_BOT_TOKEN"], ""),
      chatId: firstValue(envSource, [`${prefix}_TELEGRAM_CHAT_ID`, "TELEGRAM_CHAT_ID"], ""),
    }),
    dataDir: path.resolve("data", "solana"),
  });
}

export function loadChainConfig(chainKey, envSource = process.env) {
  if (chainKey === "solana") return loadSolanaConfig(envSource);
  const profile = EVM_PROFILES[chainKey];
  if (!profile) throw new Error(`unsupported EVM chain ${chainKey}`);
  const prefix = PREFIXES[chainKey];
  const discoveryName = `${prefix}_DISCOVERY_RPC_URL`;
  const analysisName = `${prefix}_ANALYSIS_RPC_URL`;
  const legacyDiscoveryNames = chainKey === "robinhood" ? ["DISCOVERY_RPC_URL"] : [];
  const discoveryUrl = rpcUrl(
    discoveryName,
    firstValue(envSource, [discoveryName, ...legacyDiscoveryNames], profile.publicRpc)
  );
  const legacyAnalysisNames = chainKey === "robinhood" ? ["ANALYSIS_RPC_URL", "RPC_URL"] : [];
  const analysisUrl = rpcUrl(
    analysisName,
    firstValue(envSource, [analysisName, ...legacyAnalysisNames], discoveryUrl)
  );
  const minScoreName = `${prefix}_MIN_SCORE`;
  const confirmationsName = `${prefix}_CONFIRMATION_BLOCKS`;
  const alertModeName = `${prefix}_ALERT_MODE`;
  const alertMode = String(firstValue(
    envSource,
    [alertModeName, "ALERT_MODE"],
    chainKey === "robinhood" ? "live" : "shadow"
  )).toLowerCase();
  if (!ALERT_MODES.has(alertMode)) {
    throw new Error(`${alertModeName} must be recovery, shadow, or live`);
  }

  return Object.freeze({
    family: "evm",
    profile,
    rpc: Object.freeze({
      discoveryUrl,
      analysisUrl,
      discoveryCups: integer(
        `${prefix}_DISCOVERY_RPC_CUPS`,
        firstValue(envSource, [`${prefix}_DISCOVERY_RPC_CUPS`, "DISCOVERY_RPC_CUPS"], 150),
        { min: 1 }
      ),
      analysisCups: integer(
        `${prefix}_ANALYSIS_RPC_CUPS`,
        firstValue(envSource, [`${prefix}_ANALYSIS_RPC_CUPS`, "ANALYSIS_RPC_CUPS"], 250),
        { min: 1 }
      ),
      cooldownMs: integer(
        `${prefix}_DISCOVERY_RPC_COOLDOWN_MS`,
        firstValue(envSource, [`${prefix}_DISCOVERY_RPC_COOLDOWN_MS`, "DISCOVERY_RPC_COOLDOWN_MS"], 60_000),
        { min: 1 }
      ),
      monthlyLimit: integer(
        `${prefix}_MONTHLY_RPC_LIMIT`,
        firstValue(envSource, [`${prefix}_MONTHLY_RPC_LIMIT`], MONTHLY_RPC_LIMITS[chainKey]),
        { min: 1 }
      ),
    }),
    settings: Object.freeze({
      maxAgeMinutes: finiteNumber(
        "MAX_AGE_MINUTES",
        firstValue(envSource, ["MAX_AGE_MINUTES"], 30),
        { min: 0, exclusiveMin: true }
      ),
      minLiquidityUsd: finiteNumber(
        "MIN_LIQUIDITY_USD",
        firstValue(envSource, ["MIN_LIQUIDITY_USD"], 1_500)
      ),
      maxMcapUsd: finiteNumber(
        "MAX_MCAP_USD",
        firstValue(envSource, ["MAX_MCAP_USD"], 1_500_000),
        { min: 0, exclusiveMin: true }
      ),
      maxTop10Pct: finiteNumber(
        "MAX_TOP10_PCT",
        firstValue(envSource, ["MAX_TOP10_PCT"], 55),
        { min: 0, max: 100 }
      ),
      maxTaxBps: finiteNumber(
        "MAX_TAX_BPS",
        firstValue(envSource, ["MAX_TAX_BPS"], 500),
        { min: 0, max: 10_000 }
      ),
      maxDeployerTokens: integer(
        "MAX_DEPLOYER_TOKENS",
        firstValue(envSource, ["MAX_DEPLOYER_TOKENS"], 8),
        { min: 0 }
      ),
      requireSocial: booleanValue("REQUIRE_SOCIAL", envSource.REQUIRE_SOCIAL, false),
      pollMs: integer("POLL_MS", firstValue(envSource, ["POLL_MS"], 2_500), { min: 1 }),
      minScore: integer(
        minScoreName,
        firstValue(envSource, [minScoreName, "MIN_SCORE"], 55),
        { min: 0, max: 100 }
      ),
      confirmationBlocks: integer(
        confirmationsName,
        firstValue(envSource, [confirmationsName, "CONFIRMATION_BLOCKS"], profile.confirmations),
        { min: 0 }
      ),
      alertMode,
      assetRefreshMs: integer(
        "ASSET_REFRESH_MS",
        firstValue(envSource, ["ASSET_REFRESH_MS"], 21_600_000),
        { min: 60_000 }
      ),
    }),
    telegram: Object.freeze({
      token: firstValue(envSource, ["TELEGRAM_BOT_TOKEN"], ""),
      chatId: firstValue(envSource, [`${prefix}_TELEGRAM_CHAT_ID`, "TELEGRAM_CHAT_ID"], ""),
    }),
    dataDir: path.resolve("data", chainKey),
  });
}

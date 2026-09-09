import path from "node:path";
import { EVM_PROFILES } from "./evm-profiles.js";

const PREFIXES = Object.freeze({
  ethereum: "ETHEREUM",
  base: "BASE",
  bsc: "BSC",
  robinhood: "ROBINHOOD",
});
const ALERT_MODES = new Set(["recovery", "shadow", "live"]);

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

export function loadChainConfig(chainKey, envSource = process.env) {
  const profile = EVM_PROFILES[chainKey];
  if (!profile) throw new Error(`unsupported EVM chain ${chainKey}`);
  const prefix = PREFIXES[chainKey];
  const discoveryName = `${prefix}_DISCOVERY_RPC_URL`;
  const analysisName = `${prefix}_ANALYSIS_RPC_URL`;
  const discoveryUrl = rpcUrl(
    discoveryName,
    firstValue(envSource, [discoveryName], profile.publicRpc)
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
    }),
    settings: Object.freeze({
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
    }),
    telegram: Object.freeze({
      token: firstValue(envSource, ["TELEGRAM_BOT_TOKEN"], ""),
      chatId: firstValue(envSource, [`${prefix}_TELEGRAM_CHAT_ID`, "TELEGRAM_CHAT_ID"], ""),
    }),
    dataDir: path.resolve("data", chainKey),
  });
}

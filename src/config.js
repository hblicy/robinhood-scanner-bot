import { getAddress, ZeroAddress } from "ethers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./env.js";
import {
  validateNonNegativeInteger,
  validatePositiveInteger,
  validatePositiveNumber,
  validateRange,
} from "./safety.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fileEnv = readEnvFile(path.join(root, ".env"));
const ALLOWED_ENV = new Set([
  "RPC_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "QUOTE_TOKENS",
  "MAX_AGE_MINUTES",
  "MIN_LIQUIDITY_USD",
  "MAX_MCAP_USD",
  "MIN_SCORE",
  "MAX_TOP10_PCT",
  "MAX_TAX_BPS",
  "MAX_DEPLOYER_TOKENS",
  "LINE_A_MAX_AGE_MINUTES",
  "LINE_A_IGNORE_SECONDS",
  "MIN_FLOW_TRADES",
  "MIN_FLOW_UNIQUE_TRADERS",
  "MAX_SINGLE_TRADER_PCT",
  "MAX_DEPLOYER_LAUNCHES_24H",
  "HIGH_HEAT_LAUNCHES_24H",
  "WATCHLIST_CAP_NORMAL",
  "WATCHLIST_CAP_HIGH_HEAT",
  "CURVE_DEAD_GRACE_MS",
  "PONS_CONFIRMATIONS",
  "PONS_RECONCILE_INTERVAL_MS",
  "OUTBOX_POLL_MS",
  "DEXPAPRIKA_SCAN",
  "REQUIRE_SOCIAL",
  "POLL_MS",
  "GECKO_POLL_MS",
  "ONCHAIN_SCAN",
  "GECKO_SCAN",
  "CONFIRMATION_BLOCKS",
  "MAX_QUEUE_SIZE",
  "MAX_SEEN_ENTRIES",
  "SEEN_TTL_MS",
]);

function env(name, fallback = "") {
  if (!ALLOWED_ENV.has(name)) throw new Error(`unsupported scanner setting ${name}`);
  const v = process.env[name] ?? fileEnv[name];
  return v === undefined || v === "" ? fallback : v;
}

function envNum(name, fallback) {
  const v = env(name, "");
  if (v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be numeric`);
  return n;
}

function envBool(name, fallback = false) {
  const v = env(name, "").toLowerCase();
  if (v === "") return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${name} must be true or false`);
}

export const ROOT = root;
export const DATA_DIR = path.join(root, "data");

export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  rpc: env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  explorer: "https://robinhoodchain.blockscout.com",
  dexScreener: "https://dexscreener.com/robinhood",
  geckoNetwork: "robinhood",
  nativeSymbol: "ETH",
};

export const ADDR = {
  WETH: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  USDG: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  NATIVE: getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"),
  ZERO: ZeroAddress,
  DEAD: getAddress("0x000000000000000000000000000000000000dEaD"),
  MULTICALL3: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
  V2_FACTORY: getAddress("0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f"),
  V2_ROUTER: getAddress("0x89e5DB8B5aA49aA85AC63f691524311AEB649eba"),
  V3_FACTORY: getAddress("0x1f7d7550B1b028f7571E69A784071F0205FD2EfA"),
  V3_ROUTER: getAddress("0xCaf681a66D020601342297493863E78C959E5cb2"),
  V3_QUOTER: getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"),
  V3_NPM: getAddress("0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3"),
  V4_POOL_MANAGER: getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
  V4_QUOTER: getAddress("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94"),
  V4_POSM: getAddress("0x58daec3116aae6D93017bAAea7749052E8a04fA7"),
  UNIVERSAL_ROUTER: getAddress("0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77"),
  NVDA: getAddress("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"),
  PONS_FACTORY: getAddress("0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"),
  PONS_ROUTER: getAddress("0xe33E9E479dF8802cb0866d5d05258bEc4cF62948"),
  PONS_HOOK: getAddress("0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"),
  PONS_LOCKER: getAddress("0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952"),
  PONS_EXECUTOR: getAddress("0xC7819B64A1dAECD7eC19856d026cb14EfBd89046"),
  PONS_V1_FACTORY: getAddress("0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB"),
};

const QUOTE_INPUTS = new Set(
  env("QUOTE_TOKENS", "WETH,ETH,USDG")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
if (QUOTE_INPUTS.size === 0) throw new Error("QUOTE_TOKENS must not be empty");

const BUILTIN_QUOTES = {
  WETH: [ADDR.WETH],
  ETH: [ADDR.NATIVE, ADDR.ZERO],
  USDG: [ADDR.USDG],
};

const resolvedQuotes = [];
for (const input of QUOTE_INPUTS) {
  const builtin = BUILTIN_QUOTES[input.toUpperCase()];
  if (builtin) {
    resolvedQuotes.push(...builtin);
    continue;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) {
    throw new Error(`QUOTE_TOKENS contains an unknown symbol: ${input}`);
  }
  resolvedQuotes.push(getAddress(input));
}

export const QUOTE_ADDRESSES = new Set(resolvedQuotes.map((address) => address.toLowerCase()));

export const QUOTE_LABELS = new Map([
  [ADDR.WETH.toLowerCase(), "WETH"],
  [ADDR.NATIVE.toLowerCase(), "ETH"],
  [ADDR.ZERO.toLowerCase(), "ETH"],
  [ADDR.USDG.toLowerCase(), "USDG"],
  [ADDR.NVDA.toLowerCase(), "NVDA"],
]);

const onchainScan = envBool("ONCHAIN_SCAN", true);
const geckoScan = envBool("GECKO_SCAN", true);
if (!onchainScan && !geckoScan) {
  throw new Error("at least one of ONCHAIN_SCAN or GECKO_SCAN must be true");
}

export const SETTINGS = {
  telegramToken: env("TELEGRAM_BOT_TOKEN"),
  telegramChat: env("TELEGRAM_CHAT_ID"),
  maxAgeMinutes: validatePositiveNumber("MAX_AGE_MINUTES", envNum("MAX_AGE_MINUTES", 30)),
  minLiquidityUsd: validateRange("MIN_LIQUIDITY_USD", envNum("MIN_LIQUIDITY_USD", 1500), 0, Number.MAX_VALUE),
  maxMcapUsd: validatePositiveNumber("MAX_MCAP_USD", envNum("MAX_MCAP_USD", 1_500_000)),
  minScore: validateRange("MIN_SCORE", envNum("MIN_SCORE", 55), 0, 100),
  maxTop10Pct: validateRange("MAX_TOP10_PCT", envNum("MAX_TOP10_PCT", 55), 0, 100),
  maxTaxBps: validateRange("MAX_TAX_BPS", envNum("MAX_TAX_BPS", 500), 0, 10_000),
  maxDeployerTokens: validateNonNegativeInteger("MAX_DEPLOYER_TOKENS", envNum("MAX_DEPLOYER_TOKENS", 8)),
  lineAMaxAgeMinutes: validatePositiveNumber("LINE_A_MAX_AGE_MINUTES", envNum("LINE_A_MAX_AGE_MINUTES", 20)),
  lineAIgnoreSeconds: validateNonNegativeInteger("LINE_A_IGNORE_SECONDS", envNum("LINE_A_IGNORE_SECONDS", 10)),
  minFlowTrades: validatePositiveInteger("MIN_FLOW_TRADES", envNum("MIN_FLOW_TRADES", 5)),
  minFlowUniqueTraders: validatePositiveInteger(
    "MIN_FLOW_UNIQUE_TRADERS",
    envNum("MIN_FLOW_UNIQUE_TRADERS", 3)
  ),
  maxSingleTraderPct: validateRange("MAX_SINGLE_TRADER_PCT", envNum("MAX_SINGLE_TRADER_PCT", 80), 0, 100),
  maxDeployerLaunches24h: validateNonNegativeInteger(
    "MAX_DEPLOYER_LAUNCHES_24H",
    envNum("MAX_DEPLOYER_LAUNCHES_24H", 20)
  ),
  highHeatLaunches24h: validateNonNegativeInteger(
    "HIGH_HEAT_LAUNCHES_24H",
    envNum("HIGH_HEAT_LAUNCHES_24H", 20_000)
  ),
  watchlistCapNormal: validatePositiveInteger("WATCHLIST_CAP_NORMAL", envNum("WATCHLIST_CAP_NORMAL", 3)),
  watchlistCapHighHeat: validatePositiveInteger(
    "WATCHLIST_CAP_HIGH_HEAT",
    envNum("WATCHLIST_CAP_HIGH_HEAT", 1)
  ),
  curveDeadGraceMs: validatePositiveInteger("CURVE_DEAD_GRACE_MS", envNum("CURVE_DEAD_GRACE_MS", 14_400_000)),
  requireSocial: envBool("REQUIRE_SOCIAL", false),
  pollMs: validatePositiveInteger("POLL_MS", envNum("POLL_MS", 2500)),
  geckoPollMs: validatePositiveInteger("GECKO_POLL_MS", envNum("GECKO_POLL_MS", 15000)),
  onchainScan,
  geckoScan,
  confirmationBlocks: validateNonNegativeInteger("CONFIRMATION_BLOCKS", envNum("CONFIRMATION_BLOCKS", 2)),
  ponsConfirmations: validateNonNegativeInteger("PONS_CONFIRMATIONS", envNum("PONS_CONFIRMATIONS", 2)),
  ponsReconcileIntervalMs: validatePositiveInteger(
    "PONS_RECONCILE_INTERVAL_MS",
    envNum("PONS_RECONCILE_INTERVAL_MS", 60_000)
  ),
  outboxPollMs: validatePositiveInteger("OUTBOX_POLL_MS", envNum("OUTBOX_POLL_MS", 5_000)),
  dexPaprikaScan: envBool("DEXPAPRIKA_SCAN", true),
  maxQueueSize: validatePositiveInteger("MAX_QUEUE_SIZE", envNum("MAX_QUEUE_SIZE", 500)),
  maxSeenEntries: validatePositiveInteger("MAX_SEEN_ENTRIES", envNum("MAX_SEEN_ENTRIES", 10_000)),
  seenTtlMs: validatePositiveInteger("SEEN_TTL_MS", envNum("SEEN_TTL_MS", 86_400_000)),
};

export const NARRATIVE_WORDS = [
  "robinhood",
  "hood",
  "gme",
  "gamestop",
  "vlad",
  "cash",
  "cat",
  "dog",
  "pepe",
  "wojak",
  "ape",
  "stock",
  "wallstreet",
  "wsb",
  "moon",
  "trump",
  "elon",
  "hoodrat",
];

export function isQuote(address) {
  if (!address) return false;
  return QUOTE_ADDRESSES.has(String(address).toLowerCase());
}

export function explorerToken(address) {
  return `${CHAIN.explorer}/token/${address}`;
}

export function explorerAddress(address) {
  return `${CHAIN.explorer}/address/${address}`;
}

export function dexScreenerToken(address) {
  return `${CHAIN.dexScreener}/${address}`;
}

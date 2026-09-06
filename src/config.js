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
};

const QUOTE_SET = new Set(
  env("QUOTE_TOKENS", "WETH,ETH,USDG")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);
const UNKNOWN_QUOTES = [...QUOTE_SET].filter((name) => !["WETH", "ETH", "USDG"].includes(name));
if (QUOTE_SET.size === 0 || UNKNOWN_QUOTES.length > 0) {
  throw new Error("QUOTE_TOKENS must contain only WETH, ETH or USDG");
}

export const QUOTE_ADDRESSES = new Set(
  [
    QUOTE_SET.has("WETH") ? ADDR.WETH.toLowerCase() : null,
    QUOTE_SET.has("USDG") ? ADDR.USDG.toLowerCase() : null,
    QUOTE_SET.has("ETH") ? ADDR.NATIVE.toLowerCase() : null,
    QUOTE_SET.has("ETH") ? ADDR.ZERO.toLowerCase() : null,
  ].filter(Boolean)
);

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
  requireSocial: envBool("REQUIRE_SOCIAL", false),
  pollMs: validatePositiveInteger("POLL_MS", envNum("POLL_MS", 2500)),
  geckoPollMs: validatePositiveInteger("GECKO_POLL_MS", envNum("GECKO_POLL_MS", 15000)),
  onchainScan,
  geckoScan,
  confirmationBlocks: validateNonNegativeInteger("CONFIRMATION_BLOCKS", envNum("CONFIRMATION_BLOCKS", 2)),
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

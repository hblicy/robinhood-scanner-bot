import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChainRpcContext } from "./chain.js";
import { loadChainConfig } from "./chains/load-chain.js";
import { getStoreFor } from "./store.js";
import { instanceLockPort } from "./instance-lock.js";
import { createAerodromeClassicAdapter, createAerodromeSlipstreamAdapter } from "./venues/evm/aerodrome.js";
import { createClankerAdapter } from "./venues/evm/clanker.js";
import { createFourMemeAdapter } from "./venues/evm/four-meme.js";
import { createPancakeInfinityAdapter, createPancakeV2Adapter, createPancakeV3Adapter } from "./venues/evm/pancakeswap.js";
import { createPonsAdapter } from "./venues/evm/pons.js";
import { createUniswapV2Adapter, createUniswapV3Adapter, createUniswapV4Adapter } from "./venues/evm/uniswap.js";
import { createEvmSecurityRegistry, createV2SecurityEntry } from "./security/evm/index.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_STATE_FILES = Object.freeze([
  "state.json",
  "seen.json",
  "positions.json",
  "trades.json",
]);

function migrateLegacyRobinhoodState(projectRoot, dataDir) {
  if (LEGACY_STATE_FILES.some((name) => fs.existsSync(path.join(dataDir, name)))) return false;
  const legacyDir = path.join(projectRoot, "data");
  const available = LEGACY_STATE_FILES.filter((name) => fs.existsSync(path.join(legacyDir, name)));
  if (!available.length) return false;

  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of available) {
    const destination = path.join(dataDir, name);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.copyFileSync(path.join(legacyDir, name), temporary, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary, destination);
  }
  return true;
}

function rpcOptions(config) {
  return {
    chain: {
      ...config.profile,
      discoveryRpc: config.rpc.discoveryUrl,
      analysisRpc: config.rpc.analysisUrl,
    },
    settings: {
      discoveryRpcCups: config.rpc.discoveryCups,
      analysisRpcCups: config.rpc.analysisCups,
      discoveryRpcCooldownMs: config.rpc.cooldownMs,
    },
  };
}

function defaultCommands() {
  return {
    async watch(context) {
      const { runCommand } = await import("./scanner.js");
      return runCommand("watch", null, context);
    },
    async scan(context) {
      const { runCommand } = await import("./scanner.js");
      return runCommand("scan", null, context);
    },
    async check(token, context) {
      const { runCommand } = await import("./scanner.js");
      return runCommand("check", token, context);
    },
  };
}

function quoteAddresses(profile) {
  return profile.quotes.map(({ address }) => address);
}

function instantiateVenue(profile, venue) {
  const common = { id: venue.id, quoteAddresses: quoteAddresses(profile), version: venue.version };
  if (venue.id.startsWith("uniswap-v2-")) {
    return createUniswapV2Adapter({ ...common, address: venue.contracts.factory });
  }
  if (venue.id.startsWith("uniswap-v3-")) {
    return createUniswapV3Adapter({ ...common, address: venue.contracts.factory });
  }
  if (venue.id.startsWith("uniswap-v4-")) {
    return createUniswapV4Adapter({ ...common, address: venue.contracts.poolManager });
  }
  if (venue.id === "aerodrome-classic-base") {
    return createAerodromeClassicAdapter({ ...common, address: venue.contracts.factory });
  }
  if (venue.id.startsWith("aerodrome-slipstream-")) {
    return createAerodromeSlipstreamAdapter({ ...common, address: venue.contracts.factory });
  }
  if (venue.id === "clanker-v4-base") {
    return createClankerAdapter({
      ...common,
      address: venue.contracts.factory,
      poolManagerAddress: venue.contracts.poolManager,
    });
  }
  if (venue.id === "pancakeswap-v2-bsc") {
    return createPancakeV2Adapter({ ...common, address: venue.contracts.factory });
  }
  if (venue.id === "pancakeswap-v3-bsc") {
    return createPancakeV3Adapter({ ...common, address: venue.contracts.factory });
  }
  if (venue.id === "pancakeswap-infinity-cl-bsc") {
    return createPancakeInfinityAdapter({ ...common, address: venue.contracts.poolManager });
  }
  if (venue.id === "four-meme-v2-bsc") {
    return createFourMemeAdapter({
      id: venue.id,
      address: venue.contracts.manager,
      helperAddress: venue.contracts.helper,
      wrappedNative: profile.wrappedNative,
      version: venue.version,
    });
  }
  throw new Error(`no discovery adapter for ${profile.key}|${venue.id}`);
}

function securityRegistry(profile) {
  const entries = profile.venues
    .filter(({ id }) => id.startsWith("uniswap-v2-") || id === "pancakeswap-v2-bsc")
    .map((venue) => createV2SecurityEntry({
      chain: profile.key,
      venue: venue.id,
      factoryAddress: venue.contracts.factory,
      wrappedNative: profile.wrappedNative,
      excludedAddresses: Object.values(venue.contracts),
    }));
  return createEvmSecurityRegistry(entries);
}

async function assertRpcChain(rpcContext, expectedChainId) {
  const rawChainId = await rpcContext.analysisProvider.send("eth_chainId", []);
  let actualChainId;
  try {
    actualChainId = Number(BigInt(rawChainId));
  } catch (cause) {
    throw new Error(`analysis RPC returned an invalid chain ID: ${String(rawChainId)}`, { cause });
  }
  if (actualChainId !== expectedChainId) {
    throw new Error(`RPC chain mismatch: expected ${expectedChainId}, actual ${actualChainId}`);
  }
}

export function createApp({ chainKey, env = process.env, dependencies = {} }) {
  const loaded = loadChainConfig(chainKey, env);
  const projectRoot = path.resolve(dependencies.projectRoot ?? PROJECT_ROOT);
  const dataDir = path.join(projectRoot, "data", chainKey);
  if (chainKey === "robinhood") migrateLegacyRobinhoodState(projectRoot, dataDir);

  const createRpcContext = dependencies.createRpcContext ?? createChainRpcContext;
  const rpcContext = createRpcContext(rpcOptions(loaded));
  const store = getStoreFor(dataDir, dependencies.storeSettings);
  const venues = loaded.profile.venues.map((venue) => instantiateVenue(loaded.profile, venue));
  if (chainKey === "robinhood") venues.push(createPonsAdapter());
  const commands = dependencies.commands ?? defaultCommands();
  const verifyChain = dependencies.assertChain ?? assertRpcChain;
  const config = Object.freeze({
    ...loaded,
    dataDir,
    notificationsEnabled: loaded.settings.alertMode === "live",
    rpcContext,
    store,
    telegramTitle: loaded.profile.name,
    telegram: loaded.telegram,
    lockPort: instanceLockPort(dataDir),
    venues: Object.freeze(venues),
    venueIds: Object.freeze(venues.map((venue) => venue.id)),
    securityRegistry: securityRegistry(loaded.profile),
  });
  const context = Object.freeze({ config });
  let chainVerification;
  const ensureChain = () => {
    chainVerification ??= Promise.resolve().then(() => verifyChain(rpcContext, loaded.profile.id));
    return chainVerification;
  };

  return Object.freeze({
    config,
    watch: async () => {
      await ensureChain();
      return commands.watch(context);
    },
    scan: async () => {
      await ensureChain();
      return commands.scan(context);
    },
    check: async (token) => {
      await ensureChain();
      return commands.check(token, context);
    },
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract } from "ethers";
import { createChainRpcContext } from "./chain.js";
import { bytecodeFlags, readOwner, readTokenMeta, readV2Pool } from "./chain.js";
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
import { analyze, honeypotCheck } from "./analyze.js";
import { ERC20_ABI } from "./abis.js";
import { dexScreener } from "./market.js";
import { formatAlert, sendTelegramWith } from "./notify.js";
import { loadWalletLabels } from "./wallet-labels.js";
import { PublicKey } from "@solana/web3.js";
import { createSolanaRpcContext } from "./solana/rpc.js";
import { createPumpAdapters } from "./venues/solana/pump.js";
import { createRaydiumAdapters } from "./venues/solana/raydium.js";
import { createSolanaSecurityRegistry } from "./security/solana/index.js";
import { inspectMintControls } from "./security/solana/mint.js";
import { analyzeSolanaCandidate } from "./solana/analyze.js";

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
      if (context.config.profile.key !== "robinhood") {
        const { watchEvm } = await import("./evm/runner.js");
        return watchEvm(context.config);
      }
      const { runCommand } = await import("./scanner.js");
      return runCommand("watch", null, context);
    },
    async scan(context) {
      if (context.config.profile.key !== "robinhood") {
        const { runEvmRangeOnce } = await import("./evm/runner.js");
        return runEvmRangeOnce(context.config, { persist: false });
      }
      const { runCommand } = await import("./scanner.js");
      return runCommand("scan", null, context);
    },
    async check(token, context) {
      if (context.config.profile.key !== "robinhood") {
        return context.config.services.check(token);
      }
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

function createServices({ loaded, rpcContext, registry, projectRoot, dependencies }) {
  if (dependencies.services) return dependencies.services;
  const provider = rpcContext.analysisProvider;
  const profile = loaded.profile;
  const walletCatalog = loadWalletLabels(path.join(projectRoot, "data", "wallets", "evm.json"));
  const unavailable = (source) => async () => {
    throw new Error(`${source} adapter unavailable for ${profile.key}`);
  };
  const analyzeCandidate = (event) => analyze(event, {
    minScore: loaded.settings.minScore,
    scoreThresholds: { ...loaded.settings, maxAgeMinutes: loaded.settings.maxAgeMinutes ?? 30 },
    profile,
    readTokenMeta: (token) => readTokenMeta(token, { provider }),
    readOwner: (token) => readOwner(token, { provider }),
    bytecodeFlags: (token) => bytecodeFlags(token, { provider }),
    dexScreener: (token, binding) => dexScreener(token, binding, { profile }),
    blockscoutToken: unavailable("explorer token"),
    blockscoutHolders: unavailable("explorer holders"),
    blockscoutCreator: unavailable("explorer creator"),
    readV2Pool: (pool) => readV2Pool(pool, { provider }),
    readCreatorBalance: (token, creator) => new Contract(token, ERC20_ABI, provider).balanceOf(creator),
    deployerHistory: unavailable("deployer history"),
    honeypotCheck: (input) => honeypotCheck(input, {
      provider,
      securityRegistry: registry,
    }),
    walletCatalog,
  });
  const alertReport = async (report) => {
    const text = formatAlert({ ...report, chain: profile.key, chainName: profile.name });
    console.log(`[${profile.key}] ${report.verdict} ${report.meta.symbol} ${report.score}/100`);
    return sendTelegramWith(text, {
      settings: {
        telegramToken: loaded.telegram.token,
        telegramChat: loaded.telegram.chatId,
      },
    });
  };
  return Object.freeze({
    analyze: analyzeCandidate,
    alertReport,
    async check(token) {
      const [meta, owner, flags] = await Promise.all([
        readTokenMeta(token, { provider }),
        readOwner(token, { provider }),
        bytecodeFlags(token, { provider }),
      ]);
      const report = { chain: profile.key, token, meta, owner, flags };
      console.log(JSON.stringify(report, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
      return report;
    },
  });
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

async function assertSolanaPrograms(rpcContext, programs) {
  for (const program of programs) {
    const account = await rpcContext.analysisConnection.getAccountInfo(new PublicKey(program.programId), "finalized");
    if (!account?.executable) throw new Error(`Solana program is not executable: ${program.id}`);
  }
}

function defaultSolanaCommands() {
  return {
    async watch(context) {
      const { watchSolana } = await import("./solana/runner.js");
      return watchSolana(context.config);
    },
    async scan(context) {
      const { runSolanaOnce } = await import("./solana/runner.js");
      return runSolanaOnce(context.config, { persist: false });
    },
    async check(token, context) {
      return context.config.services.check(token);
    },
  };
}

function createSolanaApplication(loaded, { dependencies, projectRoot }) {
  const dataDir = path.join(projectRoot, "data", "solana");
  const rpcContext = (dependencies.createSolanaRpcContext ?? createSolanaRpcContext)(loaded, dependencies.rpcDependencies);
  const store = getStoreFor(dataDir, dependencies.storeSettings);
  const venues = [...createPumpAdapters(loaded.profile), ...createRaydiumAdapters(loaded.profile)];
  const registry = createSolanaSecurityRegistry(loaded.profile);
  const walletCatalog = loadWalletLabels(path.join(projectRoot, "data", "wallets", "solana.json"));
  const services = dependencies.services ?? Object.freeze({
    analyze: (event) => analyzeSolanaCandidate(event, {
      config: loaded,
      connection: rpcContext.analysisConnection,
      securityRegistry: registry,
      walletCatalog,
    }),
    async alertReport(report) {
      const text = formatAlert({ ...report, chain: "solana", chainName: loaded.profile.name });
      console.log(`[solana] ${report.verdict} ${report.meta.symbol} ${report.score}/100`);
      return sendTelegramWith(text, { settings: { telegramToken: loaded.telegram.token, telegramChat: loaded.telegram.chatId } });
    },
    async check(token) {
      const result = await inspectMintControls(token, { connection: rpcContext.analysisConnection });
      console.log(JSON.stringify({ chain: "solana", token, mint: result }, null, 2));
      return result;
    },
  });
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
    securityRegistry: registry,
    services,
  });
  const context = Object.freeze({ config });
  const commands = dependencies.commands ?? defaultSolanaCommands();
  const verifyPrograms = dependencies.assertSolanaPrograms ?? assertSolanaPrograms;
  let verification;
  const ensurePrograms = () => {
    verification ??= Promise.resolve().then(() => verifyPrograms(rpcContext, loaded.profile.programs));
    return verification;
  };
  return Object.freeze({
    config,
    watch: async () => { await ensurePrograms(); return commands.watch(context); },
    scan: async () => { await ensurePrograms(); return commands.scan(context); },
    check: async (token) => { await ensurePrograms(); return commands.check(token, context); },
  });
}

export function createApp({ chainKey, env = process.env, dependencies = {} }) {
  const loaded = loadChainConfig(chainKey, env);
  const projectRoot = path.resolve(dependencies.projectRoot ?? PROJECT_ROOT);
  if (loaded.family === "solana") return createSolanaApplication(loaded, { dependencies, projectRoot });
  const dataDir = path.join(projectRoot, "data", chainKey);
  if (chainKey === "robinhood") migrateLegacyRobinhoodState(projectRoot, dataDir);

  const createRpcContext = dependencies.createRpcContext ?? createChainRpcContext;
  const rpcContext = createRpcContext(rpcOptions(loaded));
  const store = getStoreFor(dataDir, dependencies.storeSettings);
  const venues = loaded.profile.venues.map((venue) => instantiateVenue(loaded.profile, venue));
  if (chainKey === "robinhood") venues.push(createPonsAdapter());
  const registry = securityRegistry(loaded.profile);
  const services = createServices({ loaded, rpcContext, registry, projectRoot, dependencies });
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
    securityRegistry: registry,
    services,
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

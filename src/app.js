import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, getAddress } from "ethers";
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
import { createAnalysisRpcCircuit } from "./analysis-rpc-circuit.js";
import { createVenueRegistry } from "./venues/registry.js";
import { verifyVenueDeployments } from "./venues/verify.js";
import { createRpcUsageBudget } from "./rpc-usage-budget.js";
import { createAssetCatalogCache, createAssetRefreshScheduler } from "./assets/cache.js";
import { createPairClassifier } from "./assets/pair.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_STATE_FILES = Object.freeze([
  "state.json",
  "seen.json",
  "positions.json",
  "trades.json",
]);
const DISABLED_VENUES = Object.freeze({
  ethereum: Object.freeze([]),
  base: Object.freeze([
    ["o1-base", "missing-verified-factory"],
    ["stonks-exchange-base", "missing-verified-factory"],
    ["basestonk-base", "missing-verified-factory"],
  ]),
  bsc: Object.freeze([["flap-bsc", "missing-verified-factory"]]),
  robinhood: Object.freeze([["long-robinhood", "missing-verified-factory"]]),
  solana: Object.freeze([["stonk-fun-solana", "missing-verified-program"]]),
});

function createConfiguredVenueRegistry(profile, security) {
  const configured = (profile.venues ?? profile.programs ?? []).map((venue) => ({
    chain: profile.key,
    family: profile.family,
    id: venue.id,
    identityStatus: "verified",
    securityCapability: profile.family === "solana"
      ? "supported"
      : security.supports({ chain: profile.key, venue: venue.id })
        ? "supported"
        : "discovery-only",
    verifiedContracts: profile.family === "evm" ? Object.values(venue.contracts) : [],
    disabledReason: null,
  }));
  const disabled = (DISABLED_VENUES[profile.key] ?? []).map(([id, disabledReason]) => ({
    chain: profile.key,
    family: profile.family,
    id,
    identityStatus: "disabled-unverified",
    securityCapability: "unsupported",
    verifiedContracts: [],
    disabledReason,
  }));
  return createVenueRegistry([...configured, ...disabled]);
}

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

function rpcOptions(config, usageBudget = null) {
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
    usageBudget,
  };
}

function readRpcUsage(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`cannot read RPC usage state ${file}`, { cause });
  }
}

function writeRpcUsage(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function createAssetRuntime(loaded, dataDir, dependencies) {
  const shippedPath = path.join(
    path.resolve(dependencies.assetConfigRoot ?? PROJECT_ROOT),
    "config",
    "assets",
    `${loaded.profile.key}.json`
  );
  const runtimePath = path.join(dataDir, "asset-catalog.json");
  const cache = createAssetCatalogCache({
    readJson: dependencies.readAssetJson ?? readJsonIfPresent,
    atomicWriteJson: dependencies.writeAssetJson ?? writeRpcUsage,
  });
  const initial = dependencies.assetCatalog ?? cache.load({ shippedPath, runtimePath });
  const refreshLoader = dependencies.refreshAssetCatalog;
  const scheduler = createAssetRefreshScheduler({
    current: initial,
    enabled: initial.source.runtimeRefresh === true,
    intervalMs: loaded.settings.assetRefreshMs,
    refresh: (current) => cache.refresh({
      current,
      runtimePath,
      load: async () => {
        if (typeof refreshLoader !== "function") {
          throw new Error(`asset-registry-unavailable: no refresh adapter for ${loaded.profile.key}`);
        }
        return refreshLoader({ chain: loaded.profile.key, current });
      },
    }),
    onError: dependencies.logError ?? console.error,
  });
  const catalog = Object.freeze({
    get schemaVersion() { return scheduler.currentCatalog().schemaVersion; },
    get chain() { return scheduler.currentCatalog().chain; },
    get family() { return scheduler.currentCatalog().family; },
    get source() { return scheduler.currentCatalog().source; },
    get assets() { return scheduler.currentCatalog().assets; },
    has: (address) => scheduler.currentCatalog().has(address),
    lookup: (address) => scheduler.currentCatalog().lookup(address),
  });
  const normalizeAddress = loaded.family === "evm"
    ? getAddress
    : (value) => new PublicKey(value).toBase58();
  const classifyPair = createPairClassifier({
    catalog,
    nativeQuotes: loaded.profile.quotes.map(({ address }) => address),
    normalizeAddress,
  });
  return { catalog, cache, scheduler, classifyPair };
}

function createChainUsageBudget(loaded, dataDir, dependencies) {
  const file = path.join(dataDir, "rpc-usage.json");
  return createRpcUsageBudget({
    limit: loaded.rpc.monthlyLimit,
    initial: dependencies.rpcUsageInitial ?? readRpcUsage(file),
    persist: dependencies.persistRpcUsage ?? ((state) => writeRpcUsage(file, state)),
    now: dependencies.now ?? Date.now,
  });
}

function startUsageFlush(budget, { intervalMs = 60_000, logError = console.error } = {}) {
  const flush = () => budget.flush();
  const timer = setInterval(() => {
    try {
      flush();
    } catch (error) {
      logError(`RPC usage flush failed: ${error.message}`);
    }
  }, intervalMs);
  timer.unref?.();
  const onExit = () => flush();
  process.once("exit", onExit);
  return () => {
    clearInterval(timer);
    process.removeListener("exit", onExit);
    flush();
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

function instantiateVenue(profile, venue, classifyPair) {
  const common = {
    id: venue.id,
    quoteAddresses: quoteAddresses(profile),
    classifyPair,
    version: venue.version,
  };
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
      classifyPair,
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
  const sendText = (text) => sendTelegramWith(text, {
    settings: {
      telegramToken: loaded.telegram.token,
      telegramChat: loaded.telegram.chatId,
    },
  });
  const alertReport = async (report) => {
    const text = formatAlert({ ...report, chain: profile.key, chainName: profile.name });
    console.log(`[${profile.key}] ${report.verdict} ${report.meta.symbol} ${report.score}/100`);
    return sendText(text);
  };
  return Object.freeze({
    analyze: analyzeCandidate,
    alertReport,
    sendText,
    async notifyAnalysisRpcLimited() {
      try {
        return await sendText(
          `⚠️ ${profile.name} 分析 RPC 被限流或额度耗尽，深检暂时暂停；官方发现仍在运行。`
        );
      } catch (error) {
        console.error(`[${profile.key}] analysis RPC alert failed`);
        return false;
      }
    },
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

function createSolanaApplication(loaded, { dependencies, projectRoot, readOnly }) {
  const dataDir = path.join(projectRoot, "data", "solana");
  const assets = createAssetRuntime(loaded, dataDir, dependencies);
  const rpcContext = (dependencies.createSolanaRpcContext ?? createSolanaRpcContext)(loaded, dependencies.rpcDependencies);
  const store = getStoreFor(dataDir, dependencies.storeSettings, { readOnly });
  const venues = [
    ...createPumpAdapters(loaded.profile, { classifyPair: assets.classifyPair }),
    ...createRaydiumAdapters(loaded.profile, { classifyPair: assets.classifyPair }),
  ];
  const registry = createSolanaSecurityRegistry(loaded.profile);
  const venueRegistry = createConfiguredVenueRegistry(loaded.profile, registry);
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
    venueRegistry,
    assetCatalog: assets.catalog,
    assetCatalogCache: assets.cache,
    assetRefreshScheduler: assets.scheduler,
    classifyPair: assets.classifyPair,
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
    watch: async () => {
      await assets.scheduler.start();
      try {
        await ensurePrograms();
        return await commands.watch(context);
      } finally {
        assets.scheduler.stop();
      }
    },
    scan: async () => { await ensurePrograms(); return commands.scan(context); },
    check: async (token) => { await ensurePrograms(); return commands.check(token, context); },
  });
}

export function createApp({ chainKey, command = "watch", env = process.env, dependencies = {} }) {
  const loaded = loadChainConfig(chainKey, env);
  const projectRoot = path.resolve(dependencies.projectRoot ?? PROJECT_ROOT);
  const readOnly = command !== "watch";
  if (loaded.family === "solana") return createSolanaApplication(loaded, { dependencies, projectRoot, readOnly });
  const dataDir = path.join(projectRoot, "data", chainKey);
  if (!readOnly && chainKey === "robinhood") migrateLegacyRobinhoodState(projectRoot, dataDir);

  const assets = createAssetRuntime(loaded, dataDir, dependencies);
  const createRpcContext = dependencies.createRpcContext ?? createChainRpcContext;
  const rpcUsageBudget = createChainUsageBudget(loaded, dataDir, dependencies);
  const rpcContext = createRpcContext(rpcOptions(loaded, rpcUsageBudget));
  const store = getStoreFor(dataDir, dependencies.storeSettings, { readOnly });
  const venues = loaded.profile.venues.map((venue) =>
    instantiateVenue(loaded.profile, venue, assets.classifyPair));
  if (chainKey === "robinhood") venues.push(createPonsAdapter());
  const registry = securityRegistry(loaded.profile);
  const venueRegistry = createConfiguredVenueRegistry(loaded.profile, registry);
  const services = createServices({ loaded, rpcContext, registry, projectRoot, dependencies });
  const commands = dependencies.commands ?? defaultCommands();
  const verifyChain = dependencies.assertChain ?? assertRpcChain;
  const verifyVenues = dependencies.verifyVenueDeployments ?? ((entries) =>
    rpcContext.discoverySessions.run((provider) => verifyVenueDeployments(entries, {
      getCode: (address) => provider.getCode(address),
    })));
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
    venueRegistry,
    analysisRpcCircuit: createAnalysisRpcCircuit(),
    rpcUsageBudget,
    assetCatalog: assets.catalog,
    assetCatalogCache: assets.cache,
    assetRefreshScheduler: assets.scheduler,
    classifyPair: assets.classifyPair,
    services,
  });
  const context = Object.freeze({ config });
  let chainVerification;
  const ensureChain = () => {
    chainVerification ??= Promise.resolve()
      .then(() => verifyChain(rpcContext, loaded.profile.id))
      .then(() => verifyVenues(venueRegistry.list()));
    return chainVerification;
  };

  return Object.freeze({
    config,
    watch: async () => {
      await assets.scheduler.start();
      const stopUsageFlush = startUsageFlush(rpcUsageBudget, {
        intervalMs: dependencies.rpcUsageFlushMs ?? 60_000,
        logError: dependencies.logError ?? console.error,
      });
      try {
        await ensureChain();
        return await commands.watch(context);
      } finally {
        stopUsageFlush();
        assets.scheduler.stop();
      }
    },
    scan: async () => {
      try {
        await ensureChain();
        return await commands.scan(context);
      } finally {
        rpcUsageBudget.flush();
      }
    },
    check: async (token) => {
      try {
        await ensureChain();
        return await commands.check(token, context);
      } finally {
        rpcUsageBudget.flush();
      }
    },
  });
}

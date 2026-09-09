import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChainRpcContext } from "./chain.js";
import { loadChainConfig } from "./chains/load-chain.js";
import { getStoreFor } from "./store.js";
import { createPonsAdapter } from "./venues/evm/pons.js";

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
  const venues = [...loaded.profile.venues];
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
    venues: Object.freeze(venues),
    venueIds: Object.freeze(venues.map((venue) => venue.id)),
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

import {
  AbiCoder,
  Contract,
  Interface,
  ZeroAddress,
  getAddress,
  keccak256,
} from "ethers";
import { PONS_FACTORY_ABI } from "./abis.js";
import { getLogsChunked } from "./chain.js";
import { ADDR, CHAIN } from "./config.js";
import { safeErrorMessage } from "./safety.js";

const factoryInterface = new Interface(PONS_FACTORY_ABI);
const PHASES = new Map([
  [0, "not_graduated"],
  [1, "swept"],
  [2, "pool_created"],
  [3, "rescued"],
]);
const EVENT_KIND = new Map([
  ["TokenLaunched", "token_launched"],
  ["LaunchSwept", "launch_swept"],
  ["PoolGraduated", "pool_graduated"],
  ["GraduationTokensPermanentlyLocked", "tokens_locked"],
]);
const FACTORY_TOPICS = [...EVENT_KIND.keys()].map(
  (name) => factoryInterface.getEvent(name).topicHash
);

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function asAddress(value, field) {
  try {
    return getAddress(value);
  } catch (cause) {
    throw new Error(`Pons ${field} is not an address`, { cause });
  }
}

function asDecimal(value) {
  return BigInt(value ?? 0).toString();
}

function phaseName(value) {
  const phase = Number(value);
  if (!PHASES.has(phase)) throw new Error(`unknown Pons phase ${phase}`);
  return PHASES.get(phase);
}

function normalizedIndex(log) {
  const value = log?.index ?? log?.logIndex;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Pons factory log is missing a valid log index");
  }
  return index;
}

export function parsePonsFactoryLog(log) {
  let parsed;
  try {
    parsed = factoryInterface.parseLog(log);
  } catch (cause) {
    throw new Error(
      `Pons factory log parse failed at block ${log?.blockNumber ?? "unknown"} tx ${log?.transactionHash || "unknown"}`,
      { cause }
    );
  }
  const kind = EVENT_KIND.get(parsed.name);
  if (!kind) throw new Error(`unsupported Pons factory event ${parsed.name}`);
  const logIndex = normalizedIndex(log);
  const transactionHash = String(log.transactionHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new Error("Pons factory log is missing a valid transaction hash");
  }
  const base = {
    kind,
    eventId: `${CHAIN.id}:${transactionHash}:${logIndex}`,
    blockNumber: Number(log.blockNumber),
    transactionIndex: Number(log.transactionIndex ?? 0),
    logIndex,
    transactionHash,
    token: asAddress(parsed.args.token, "token"),
    args: {},
  };
  if (!Number.isInteger(base.blockNumber) || base.blockNumber < 0) {
    throw new Error("Pons factory log is missing a valid block number");
  }

  if (parsed.name === "TokenLaunched") {
    base.args = {
      curve: asAddress(parsed.args.curve, "curve"),
      deployer: asAddress(parsed.args.deployer, "deployer"),
      pairToken: asAddress(parsed.args.pairToken, "pairToken"),
      launchConfigId: asDecimal(parsed.args.launchConfigId),
      graduationThreshold: asDecimal(parsed.args.graduationThreshold),
    };
  } else if (parsed.name === "LaunchSwept") {
    base.args = {
      quoteOut: asDecimal(parsed.args.quoteOut),
      tokenOut: asDecimal(parsed.args.tokenOut),
    };
  } else if (parsed.name === "PoolGraduated") {
    base.args = {
      positionId: asDecimal(parsed.args.positionId),
      tokenAmount: asDecimal(parsed.args.tokenAmount),
      pairTokenAmount: asDecimal(parsed.args.pairTokenAmount),
    };
  } else {
    base.args = { amount: asDecimal(parsed.args.amount) };
  }
  return base;
}

export async function scanPonsRange(
  provider,
  fromBlock,
  toBlock,
  { getLogs = getLogsChunked } = {}
) {
  const logs = await getLogs({
    address: ADDR.PONS_FACTORY,
    topics: [FACTORY_TOPICS],
    fromBlock,
    toBlock,
    provider,
  });
  return logs
    .map(parsePonsFactoryLog)
    .sort((left, right) =>
      left.blockNumber - right.blockNumber ||
      left.transactionIndex - right.transactionIndex ||
      left.logIndex - right.logIndex
    );
}

async function defaultReadFactoryLinks(provider, addresses) {
  const factory = new Contract(addresses.PONS_FACTORY, PONS_FACTORY_ABI, provider);
  const [memeHook, locker, graduationExecutor] = await Promise.all([
    factory.memeHook(),
    factory.locker(),
    factory.graduationExecutor(),
  ]);
  return { memeHook, locker, graduationExecutor };
}

export async function verifyPonsDeployment(
  provider,
  addresses = ADDR,
  { readFactoryLinks = defaultReadFactoryLinks } = {}
) {
  const codeTargets = [
    "PONS_FACTORY",
    "PONS_ROUTER",
    "PONS_HOOK",
    "PONS_LOCKER",
    "PONS_EXECUTOR",
  ];
  for (const name of codeTargets) {
    let code;
    try {
      code = await provider.getCode(addresses[name]);
    } catch (cause) {
      throw new Error(`cannot read bytecode for ${name}: ${safeErrorMessage(cause)}`, { cause });
    }
    if (!code || code === "0x") throw new Error(`${name} has no bytecode at ${addresses[name]}`);
  }

  let links;
  try {
    links = await readFactoryLinks(provider, addresses);
  } catch (cause) {
    throw new Error(`cannot read Pons factory deployment links: ${safeErrorMessage(cause)}`, { cause });
  }
  const expected = {
    memeHook: addresses.PONS_HOOK,
    locker: addresses.PONS_LOCKER,
    graduationExecutor: addresses.PONS_EXECUTOR,
  };
  for (const [field, expectedAddress] of Object.entries(expected)) {
    const actual = links?.[field];
    if (!sameAddress(actual, expectedAddress)) {
      throw new Error(`Pons factory ${field} expected ${expectedAddress}, actual ${actual || "missing"}`);
    }
  }
  return { ok: true, addresses: structuredClone(expected) };
}

function normalizeLaunchRecord(raw) {
  return {
    token: asAddress(raw.token ?? raw[0], "token"),
    curve: asAddress(raw.curve ?? raw[1], "curve"),
    deployer: asAddress(raw.deployer ?? raw[2], "deployer"),
    creatorFeeRecipient: asAddress(raw.creatorFeeRecipient ?? raw[3], "creatorFeeRecipient"),
    pairToken: asAddress(raw.pairToken ?? raw[4], "pairToken"),
    graduationThreshold: asDecimal(raw.graduationThreshold ?? raw[5]),
    poolFee: Number(raw.poolFee ?? raw[6]),
    tickSpacing: Number(raw.tickSpacing ?? raw[7]),
    creatorTaxBps: Number(raw.creatorTaxBps ?? raw[8]),
    buybackEnabled: Boolean(raw.buybackEnabled ?? raw[9]),
    phase: Number(raw.phase ?? raw[10]),
    sweptQuote: asDecimal(raw.sweptQuote ?? raw[11]),
    sweptTokens: asDecimal(raw.sweptTokens ?? raw[12]),
    sweptAt: Number(raw.sweptAt ?? raw[13]),
    exists: Boolean(raw.exists ?? raw[14]),
  };
}

export async function readPonsLaunch(
  provider,
  token,
  { contractFactory = (address, abi, runner) => new Contract(address, abi, runner) } = {}
) {
  const queryToken = asAddress(token, "query token");
  try {
    const factory = contractFactory(ADDR.PONS_FACTORY, PONS_FACTORY_ABI, provider);
    return normalizeLaunchRecord(await factory.getLaunchedToken(queryToken));
  } catch (cause) {
    throw new Error(`Pons launch read failed for ${queryToken}: ${safeErrorMessage(cause)}`, { cause });
  }
}

export function classifyPonsRecord(queryToken, record, launchedEvent = null) {
  const query = asAddress(queryToken, "query token");
  if (!record || record.exists !== true) {
    return { identity: "not_pons", protocolPhase: "not_applicable" };
  }
  if (!sameAddress(record.token, query)) {
    throw new Error(`Pons token identity mismatch: queried ${query}, got ${record.token}`);
  }
  if (sameAddress(record.curve, ZeroAddress)) throw new Error("Pons launch curve is zero");
  if (sameAddress(record.deployer, ZeroAddress)) throw new Error("Pons launch deployer is zero");
  if (launchedEvent) {
    for (const field of ["curve", "deployer", "pairToken"]) {
      if (!sameAddress(record[field], launchedEvent[field])) {
        throw new Error(`Pons TokenLaunched ${field} mismatch: event ${launchedEvent[field]}, record ${record[field]}`);
      }
    }
  }
  return { identity: "pons-v2", protocolPhase: phaseName(record.phase) };
}

export function computePonsPoolId(record, hook = ADDR.PONS_HOOK) {
  const token = asAddress(record.token, "token");
  let pairToken = asAddress(record.pairToken, "pairToken");
  if (sameAddress(pairToken, ADDR.NATIVE)) pairToken = ZeroAddress;
  const currencies = [token, pairToken].sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase())
  );
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [currencies[0], currencies[1], Number(record.poolFee), Number(record.tickSpacing), asAddress(hook, "hook")]
  );
  return keccak256(encoded);
}

export async function reconcilePonsToken(
  provider,
  token,
  { readLaunch = readPonsLaunch } = {}
) {
  const record = await readLaunch(provider, token);
  return { ...classifyPonsRecord(token, record), record };
}


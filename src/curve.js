import { Interface, ZeroAddress, getAddress, zeroPadValue } from "ethers";
import { PONS_CURVE_ABI, PONS_FACTORY_ABI } from "./abis.js";
import { attachBlockTimes, findFirstBlockAtOrAfter, getLogsChunked } from "./chain.js";
import { ADDR, SETTINGS } from "./config.js";
import { safeErrorMessage } from "./safety.js";

const curveInterface = new Interface(PONS_CURVE_ABI);
const factoryInterface = new Interface(PONS_FACTORY_ABI);
const CURVE_TOPICS = [
  curveInterface.getEvent("CurveBuy").topicHash,
  curveInterface.getEvent("CurveSell").topicHash,
];

function logIndex(log) {
  const index = Number(log.index ?? log.logIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error("curve log is missing a valid log index");
  return index;
}

function parseCurveLog(log) {
  let parsed;
  try {
    parsed = curveInterface.parseLog(log);
  } catch (cause) {
    throw new Error(
      `curve log parse failed at block ${log.blockNumber ?? "unknown"} tx ${log.transactionHash || "unknown"}`,
      { cause }
    );
  }
  const direction = parsed.name === "CurveBuy" ? "buy" : "sell";
  const actor = direction === "buy" ? parsed.args.buyer : parsed.args.seller;
  return {
    direction,
    actor: getAddress(actor),
    recipient: getAddress(parsed.args.recipient),
    quoteAmount: BigInt(direction === "buy" ? parsed.args.quoteIn : parsed.args.quoteOut).toString(),
    tokenAmount: BigInt(direction === "buy" ? parsed.args.tokensOut : parsed.args.tokensIn).toString(),
    fee: BigInt(parsed.args.fee).toString(),
    tax: BigInt(parsed.args.tax).toString(),
    blockNumber: Number(log.blockNumber),
    transactionIndex: Number(log.transactionIndex ?? 0),
    logIndex: logIndex(log),
    transactionHash: String(log.transactionHash).toLowerCase(),
  };
}

export async function loadCurveTrades(
  provider,
  curve,
  fromBlock,
  toBlock,
  { getLogs = getLogsChunked, attachTimes = attachBlockTimes } = {}
) {
  const address = getAddress(curve);
  let logs;
  try {
    logs = await getLogs({
      address,
      topics: [CURVE_TOPICS],
      fromBlock,
      toBlock,
      provider,
    });
  } catch (cause) {
    throw new Error(`cannot read curve logs for ${address}: ${safeErrorMessage(cause)}`, { cause });
  }
  const parsed = logs.map(parseCurveLog).sort((left, right) =>
    left.blockNumber - right.blockNumber ||
    left.transactionIndex - right.transactionIndex ||
    left.logIndex - right.logIndex
  );
  return attachTimes(parsed, provider);
}

function addressSet(values) {
  return new Set((values || []).map((value) => String(value).toLowerCase()));
}

function usableTrader(value, routers) {
  if (!value) return null;
  let address;
  try {
    address = getAddress(value);
  } catch {
    return null;
  }
  if (address === ZeroAddress || routers.has(address.toLowerCase())) return null;
  return address;
}

export async function hydrateTraderAddresses(
  provider,
  trades,
  { knownRouters = [ADDR.PONS_ROUTER] } = {}
) {
  const routers = addressSet(knownRouters);
  const transactions = new Map();
  await Promise.all([...new Set(trades.map((item) => item.transactionHash))].map(async (hash) => {
    try {
      const transaction = await provider.getTransaction(hash);
      if (!transaction?.from) throw new Error("transaction is unavailable");
      transactions.set(hash, transaction);
    } catch (cause) {
      throw new Error(`cannot read transaction ${hash}: ${safeErrorMessage(cause)}`, { cause });
    }
  }));

  return trades.map((item) => {
    const transaction = transactions.get(item.transactionHash);
    const from = getAddress(transaction.from);
    if (!routers.has(from.toLowerCase())) {
      return { ...item, trader: from, traderEvidence: "tx.from" };
    }
    const actor = usableTrader(item.actor, routers);
    if (actor) return { ...item, trader: actor, traderEvidence: "event.actor via known router" };
    const recipient = usableTrader(item.recipient, routers);
    return {
      ...item,
      trader: recipient,
      traderEvidence: recipient ? "event.recipient via known router" : "unknown via known router",
    };
  });
}

export function summarizeCurveFlow(
  trades,
  {
    limit = 30,
    minTrades = SETTINGS.minFlowTrades,
    minUniqueTraders = SETTINGS.minFlowUniqueTraders,
    maxSingleTraderPct = SETTINGS.maxSingleTraderPct,
    excludedAddresses = [
      ADDR.ZERO,
      ADDR.DEAD,
      ADDR.PONS_ROUTER,
      ADDR.PONS_FACTORY,
      ADDR.PONS_HOOK,
      ADDR.PONS_LOCKER,
      ADDR.PONS_EXECUTOR,
    ],
  } = {}
) {
  const recent = [...(trades || [])]
    .sort((left, right) =>
      left.blockNumber - right.blockNumber ||
      left.transactionIndex - right.transactionIndex ||
      left.logIndex - right.logIndex
    )
    .slice(-limit);
  const excluded = addressSet(excludedAddresses);
  const normalized = recent.filter((item) =>
    item.trader && !excluded.has(String(item.trader).toLowerCase())
  );
  const counts = new Map();
  const directions = new Map();
  for (const item of normalized) {
    const trader = String(item.trader).toLowerCase();
    counts.set(trader, (counts.get(trader) || 0) + 1);
    const seenDirections = directions.get(trader) || new Set();
    seenDirections.add(item.direction);
    directions.set(trader, seenDirections);
  }
  const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] || null;
  const maxTraderPct = dominant && normalized.length
    ? (dominant[1] / normalized.length) * 100
    : 0;
  const buyCount = recent.filter((item) => item.direction === "buy").length;
  const sellCount = recent.filter((item) => item.direction === "sell").length;
  const uniqueTraders = counts.size;
  const sampleStatus = recent.length >= minTrades && uniqueTraders >= minUniqueTraders
    ? "sufficient"
    : "insufficient";
  const dominantDirections = dominant ? directions.get(dominant[0]) : new Set();
  return {
    sampleStatus,
    tradeCount: recent.length,
    normalizedTradeCount: normalized.length,
    uniqueTraders,
    buyCount,
    sellCount,
    bidirectional: buyCount > 0 && sellCount > 0,
    maxTraderPct,
    dominantTrader: dominant?.[0] ?? null,
    washPattern: sampleStatus === "sufficient" && maxTraderPct > maxSingleTraderPct &&
      dominantDirections.has("buy") && dominantDirections.has("sell"),
    sellability: sellCount > 0 ? "observed" : "unknown",
    lastTradeAt: recent.reduce((latest, item) =>
      Number.isFinite(item.createdAt) ? Math.max(latest ?? item.createdAt, item.createdAt) : latest,
    null),
    trades: recent,
  };
}

export async function countDeployerLaunches24h(
  provider,
  deployer,
  now,
  { findStartBlock = findFirstBlockAtOrAfter, getLogs = getLogsChunked } = {}
) {
  const address = getAddress(deployer);
  const head = await provider.getBlockNumber();
  const fromBlock = await findStartBlock(now - 86_400_000, head, provider);
  let logs;
  try {
    logs = await getLogs({
      address: ADDR.PONS_FACTORY,
      topics: [
        factoryInterface.getEvent("TokenLaunched").topicHash,
        null,
        null,
        zeroPadValue(address, 32),
      ],
      fromBlock,
      toBlock: head,
      provider,
    });
  } catch (cause) {
    throw new Error(`cannot count Pons launches for ${address}: ${safeErrorMessage(cause)}`, { cause });
  }
  return logs.length;
}


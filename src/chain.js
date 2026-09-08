import { Contract, Interface, JsonRpcProvider, id, getAddress, ZeroAddress } from "ethers";
import { ADDR, CHAIN, SETTINGS, isQuote } from "./config.js";
import { ERC20_ABI, PAIR_V2_ABI, V2_FACTORY_ABI, V3_FACTORY_ABI, V4_PM_ABI } from "./abis.js";
import { createBudgetedProvider, createRpcScheduler } from "./rpc-budget.js";
import { createFailoverProvider } from "./rpc-failover.js";

let analysisProvider;
let discoveryProvider;

function createBudgetedJsonRpcProvider(url, cuPerSecond) {
  const provider = new JsonRpcProvider(url, CHAIN.id, { staticNetwork: true });
  return createBudgetedProvider(provider, createRpcScheduler({ cuPerSecond }));
}

export function getAnalysisProvider() {
  if (!analysisProvider) {
    analysisProvider = createBudgetedJsonRpcProvider(CHAIN.analysisRpc, SETTINGS.analysisRpcCups);
  }
  return analysisProvider;
}

export function getDiscoveryProvider() {
  if (!discoveryProvider) {
    const official = createBudgetedJsonRpcProvider(CHAIN.discoveryRpc, SETTINGS.discoveryRpcCups);
    discoveryProvider = createFailoverProvider({
      primary: official,
      fallback: getAnalysisProvider(),
      shouldFallback: isDiscoveryFallbackError,
      cooldownMs: SETTINGS.discoveryRpcCooldownMs,
      log: console.warn,
    });
  }
  return discoveryProvider;
}

export function getProvider() {
  return getAnalysisProvider();
}

export async function withRetry(fn, tries = 3, sleepImpl = sleep) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < tries - 1) {
        const delay = isRateLimitError(err) ? 1000 * (2 ** i) : 400 * (i + 1);
        await sleepImpl(delay);
      }
    }
  }
  throw last;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function toHex(n) {
  return "0x" + BigInt(n).toString(16);
}

function errorDetails(error) {
  const values = [];
  const pending = [error];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    if (typeof current === "object") visited.add(current);
    values.push(current);
    if (typeof current === "object") {
      pending.push(current.cause, current.error, current.info?.error);
      if (Array.isArray(current.errors)) pending.push(...current.errors);
    }
  }
  return values;
}

export function isRateLimitError(error) {
  return errorDetails(error).some((value) => {
    const status = Number(typeof value === "object" ? value.status || value.statusCode : NaN);
    const rawCode = typeof value === "object" ? value.code : undefined;
    const numericCode = Number(rawCode);
    const code = String(rawCode ?? "");
    const message = typeof value === "string"
      ? value
      : `${value.shortMessage || ""} ${value.message || ""}`;
    return status === 429 || numericCode === 429 || /rate[_\s-]?limit(?:ed)?|too many requests|compute units?|throughput/i.test(`${code} ${message}`);
  });
}

export function isDiscoveryFallbackError(error) {
  const details = errorDetails(error);
  const statuses = details.flatMap((value) => {
    if (typeof value !== "object") return [];
    return [
      value.status,
      value.statusCode,
      value.response?.status,
      value.response?.statusCode,
      value.info?.responseStatus,
    ].map((status) => Number.parseInt(String(status), 10)).filter(Number.isInteger);
  });
  if (statuses.some((status) => [408, 429, 500, 502, 503, 504].includes(status))) return true;
  if (statuses.length > 0) return false;

  const codes = details.map((value) =>
    typeof value === "object" ? String(value.code || "").toUpperCase() : ""
  );
  if (codes.some((code) => [
    "CALL_EXCEPTION",
    "INVALID_ARGUMENT",
    "UNSUPPORTED_OPERATION",
    "BAD_DATA",
    "-32601",
  ].includes(code))) return false;
  if (codes.some((code) => ["NETWORK_ERROR", "TIMEOUT"].includes(code))) return true;
  if (isRateLimitError(error)) return true;
  if (codes.includes("SERVER_ERROR")) return true;

  return details.some((value) => {
    const message = typeof value === "string"
      ? value
      : `${value.shortMessage || ""} ${value.message || ""}`;
    return /\b(?:timed?\s*out|connection|socket|econnreset|econnrefused|enotfound|eai_again|service unavailable|bad gateway|gateway timeout)\b/i.test(message);
  });
}

export function isContractCallRevert(error) {
  const details = errorDetails(error);
  if (details.some((value) => {
    const status = Number(typeof value === "object" ? value.status || value.statusCode : NaN);
    const code = typeof value === "object" ? String(value.code || "").toUpperCase() : "";
    return [401, 403, 408, 429, 500, 502, 503, 504].includes(status) ||
      ["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT"].includes(code);
  })) return false;
  return details.some((value) => {
    const code = typeof value === "object" ? String(value.code || "").toUpperCase() : "";
    const message = typeof value === "string"
      ? value
      : `${value.shortMessage || ""} ${value.message || ""}`;
    return code === "CALL_EXCEPTION" || /execution reverted|call exception|revert(?:ed)?\b/i.test(message);
  });
}

export function isLogRangeLimitError(error) {
  const details = errorDetails(error);
  if (details.some((value) => {
    const status = Number(typeof value === "object" ? value.status || value.statusCode : NaN);
    const code = typeof value === "object" ? String(value.code || "").toUpperCase() : "";
    return [401, 403, 429].includes(status) || ["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT"].includes(code);
  })) return false;
  return details.some((value) => {
    const message = typeof value === "string"
      ? value
      : `${value.shortMessage || ""} ${value.message || ""}`;
    return /range too large|block range|too many (?:logs|results)|query returned more than|response size|result set too large|exceed(?:s|ed)? (?:the )?(?:maximum|max).*range/i.test(message);
  });
}

export async function getBlockNumber(provider = getAnalysisProvider()) {
  return withRetry(() => provider.getBlockNumber());
}

export async function findFirstBlockAtOrAfter(
  targetMs,
  head,
  provider = getProvider(),
  retry = (fn) => withRetry(fn)
) {
  if (!Number.isFinite(targetMs)) throw new Error("target timestamp must be finite");
  if (!Number.isInteger(head) || head < 0) throw new Error("head must be a non-negative integer");

  let low = 0;
  let high = head;
  let first = head;
  while (low <= high) {
    const blockNumber = Math.floor((low + high) / 2);
    const block = await retry(() => provider.getBlock(blockNumber));
    const timestamp = Number(block?.timestamp);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`cannot read timestamp for block ${blockNumber}`);
    }
    if (timestamp * 1000 >= targetMs) {
      first = blockNumber;
      high = blockNumber - 1;
    } else {
      low = blockNumber + 1;
    }
  }
  return first;
}

const v2Iface = new Interface(V2_FACTORY_ABI);
const v3Iface = new Interface(V3_FACTORY_ABI);
const v4Iface = new Interface(V4_PM_ABI);

const TOPICS = {
  pairCreated: id("PairCreated(address,address,address,uint256)"),
  poolCreated: id("PoolCreated(address,address,uint24,int24,address)"),
  initialize: v4Iface.getEvent("Initialize").topicHash,
};

function pickToken(token0, token1) {
  const a = getAddress(token0);
  const b = getAddress(token1);
  if (isQuote(a) && !isQuote(b)) return { token: b, quote: a };
  if (isQuote(b) && !isQuote(a)) return { token: a, quote: b };
  return null;
}

function baseEvent({ source, venue, pool, poolId, token, quote, fee, blockNumber, txHash, createdAt }) {
  return {
    source,
    venue,
    pool: pool ? getAddress(pool) : null,
    poolId: poolId ? String(poolId).toLowerCase() : null,
    token: getAddress(token),
    quote: quote ? getAddress(quote) : ADDR.WETH,
    fee: fee ?? null,
    blockNumber: blockNumber ?? null,
    txHash: txHash ?? null,
    createdAt: createdAt ?? null,
  };
}

export function parseV4PoolLog(log) {
  const parsed = v4Iface.parseLog(log);
  const picked = pickToken(parsed.args.currency0, parsed.args.currency1);
  if (!picked) return null;
  return baseEvent({
    source: "onchain",
    venue: "uniswap-v4",
    pool: null,
    poolId: parsed.args.id,
    token: picked.token,
    quote: picked.quote === ADDR.ZERO ? ADDR.NATIVE : picked.quote,
    fee: Number(parsed.args.fee),
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash,
  });
}

export async function getLogsChunked({
  address,
  topics,
  fromBlock,
  toBlock,
  chunk = 10,
  maxLogs = Infinity,
  provider = getProvider(),
  retry = (fn) => withRetry(fn),
}) {
  if (maxLogs !== Infinity && (!Number.isInteger(maxLogs) || maxLogs < 0)) {
    throw new Error("maxLogs must be a non-negative integer or Infinity");
  }
  const out = [];
  const append = (logs) => {
    if (logs.length > maxLogs - out.length) {
      throw new Error(`log budget exceeded: max ${maxLogs}`);
    }
    out.push(...logs);
  };
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const logs = await retry(() =>
        provider.getLogs({
          address,
          topics,
          fromBlock: start,
          toBlock: end,
        })
      );
      append(logs);
    } catch (err) {
      if (end - start + 1 > 1 && isLogRangeLimitError(err)) {
        const mid = Math.floor((start + end) / 2);
        const nextChunk = Math.max(1, Math.floor((end - start + 1) / 2));
        const remaining = maxLogs - out.length;
        const left = await getLogsChunked({ address, topics, fromBlock: start, toBlock: mid, chunk: nextChunk, maxLogs: remaining, provider, retry });
        append(left);
        const right = await getLogsChunked({ address, topics, fromBlock: mid + 1, toBlock: end, chunk: nextChunk, maxLogs: maxLogs - out.length, provider, retry });
        append(right);
      } else {
        throw err;
      }
    }
    start = end + 1;
  }
  return out;
}

function parseFactoryLog(log, venue, parser) {
  try {
    return parser(log);
  } catch (cause) {
    throw new Error(
      `${venue} log parse failed at block ${log.blockNumber ?? "unknown"} tx ${log.transactionHash || "unknown"}`,
      { cause }
    );
  }
}

export async function scanOnchain(
  fromBlock,
  toBlock,
  {
    provider = getAnalysisProvider(),
    getLogs = getLogsChunked,
    attachTimes = attachBlockTimes,
  } = {}
) {
  const events = [];
  const common = { fromBlock, toBlock, provider };

  const [v2logs, v3logs, v4logs] = await Promise.all([
    getLogs({
      ...common,
      address: ADDR.V2_FACTORY,
      topics: [TOPICS.pairCreated],
    }),
    getLogs({
      ...common,
      address: ADDR.V3_FACTORY,
      topics: [TOPICS.poolCreated],
    }),
    getLogs({
      ...common,
      address: ADDR.V4_POOL_MANAGER,
      topics: [TOPICS.initialize],
    }),
  ]);

  for (const log of v2logs) {
    const event = parseFactoryLog(log, "uniswap-v2", () => {
      const parsed = v2Iface.parseLog(log);
      const picked = pickToken(parsed.args.token0, parsed.args.token1);
      if (!picked) return null;
      return baseEvent({
        source: "onchain",
        venue: "uniswap-v2",
        pool: parsed.args.pair,
        token: picked.token,
        quote: picked.quote,
        blockNumber: Number(log.blockNumber),
        txHash: log.transactionHash,
      });
    });
    if (event) events.push(event);
  }

  for (const log of v3logs) {
    const event = parseFactoryLog(log, "uniswap-v3", () => {
      const parsed = v3Iface.parseLog(log);
      const picked = pickToken(parsed.args.token0, parsed.args.token1);
      if (!picked) return null;
      return baseEvent({
        source: "onchain",
        venue: "uniswap-v3",
        pool: parsed.args.pool,
        token: picked.token,
        quote: picked.quote,
        fee: Number(parsed.args.fee),
        blockNumber: Number(log.blockNumber),
        txHash: log.transactionHash,
      });
    });
    if (event) events.push(event);
  }

  for (const log of v4logs) {
    const event = parseFactoryLog(log, "uniswap-v4", () => parseV4PoolLog(log));
    if (event) events.push(event);
  }

  return attachTimes(events, provider);
}

export async function attachBlockTimes(
  events,
  provider = getProvider(),
  retry = (fn) => withRetry(fn)
) {
  const blockNumbers = [...new Set(events.map((event) => event.blockNumber).filter(Number.isInteger))];
  const blocks = new Map();
  await Promise.all(
    blockNumbers.map(async (blockNumber) => {
      const block = await retry(() => provider.getBlock(blockNumber));
      const timestamp = Number(block?.timestamp);
      if (!Number.isFinite(timestamp)) throw new Error(`cannot read timestamp for block ${blockNumber}`);
      blocks.set(blockNumber, timestamp * 1000);
    })
  );
  return events.map((event) => ({
    ...event,
    createdAt: Number.isInteger(event.blockNumber) ? blocks.get(event.blockNumber) ?? null : event.createdAt ?? null,
  }));
}

export async function readTokenMeta(token) {
  const c = new Contract(token, ERC20_ABI, getProvider());
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    c.name(),
    c.symbol(),
    c.decimals(),
    c.totalSupply(),
  ]);
  return { name, symbol, decimals: Number(decimals), totalSupply };
}

export async function readOwnerFromContract(c) {
  try {
    return getAddress(await c.owner());
  } catch (error) {
    if (!isContractCallRevert(error)) throw error;
    try {
      return getAddress(await c.getOwner());
    } catch (fallbackError) {
      if (!isContractCallRevert(fallbackError)) throw fallbackError;
      return null;
    }
  }
}

export async function readOwner(token) {
  return readOwnerFromContract(new Contract(token, ERC20_ABI, getProvider()));
}

export async function readV2PoolFromContract(c) {
  const [token0, token1, reserves, lpSupply, deadLp, zeroLp] = await Promise.all([
    c.token0(),
    c.token1(),
    c.getReserves(),
    c.totalSupply(),
    c.balanceOf(ADDR.DEAD),
    c.balanceOf(ZeroAddress),
  ]);
  const burned = deadLp + zeroLp;
  const burnedPct = lpSupply === 0n ? 0 : Number((burned * 10000n) / lpSupply) / 100;
  return {
    token0: getAddress(token0),
    token1: getAddress(token1),
    reserve0: reserves[0],
    reserve1: reserves[1],
    lpSupply,
    burnedLp: burned,
    burnedPct,
  };
}

export async function readV2Pool(pool) {
  return readV2PoolFromContract(new Contract(pool, PAIR_V2_ABI, getProvider()));
}

export async function bytecodeFlags(token, { provider = getProvider(), blockTag = null } = {}) {
  const code = await withRetry(() => blockTag == null ? provider.getCode(token) : provider.getCode(token, blockTag));
  const hex = (code || "0x").toLowerCase();
  const has = (sel) => hex.includes(sel.toLowerCase().replace(/^0x/, ""));
  return {
    hasCode: hex.length > 4,
    mintable: has("40c10f19") || has("a0712d68"),
    blacklist: has("f9f92be4") || has("16279055") || has("27e235e3"),
    pausable: has("8456cb59") || has("5c975abb"),
    maxTx: has("d95901d1") || has("8dbdbe6d"),
    tradingEnable: has("8a8c523c") || has("c9567bf9"),
  };
}

export async function creatorOf(token) {
  const provider = getProvider();
  const current = await provider.getBlockNumber();
  const step = 80_000;
  let end = current;
  while (end > 0) {
    const start = Math.max(0, end - step + 1);
    const logs = await provider
      .getLogs({
        fromBlock: start,
        toBlock: end,
        address: token,
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x0000000000000000000000000000000000000000000000000000000000000000"],
      })
      .catch(() => []);
    if (logs.length) {
      const first = logs[0];
      const tx = await provider.getTransaction(first.transactionHash);
      return {
        creator: tx?.from ? getAddress(tx.from) : null,
        txHash: first.transactionHash,
        blockNumber: Number(first.blockNumber),
      };
    }
    if (start === 0) break;
    end = start - 1;
  }
  return { creator: null, txHash: null, blockNumber: null };
}

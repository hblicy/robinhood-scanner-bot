import { Contract, Interface, JsonRpcProvider, id, getAddress, ZeroAddress } from "ethers";
import { ADDR, CHAIN, isQuote } from "./config.js";
import { ERC20_ABI, PAIR_V2_ABI, V2_FACTORY_ABI, V3_FACTORY_ABI, V4_PM_ABI } from "./abis.js";

let httpProvider;

export function getProvider() {
  if (!httpProvider) {
    httpProvider = new JsonRpcProvider(CHAIN.rpc, CHAIN.id, { staticNetwork: true });
  }
  return httpProvider;
}

export async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(400 * (i + 1));
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

export async function getBlockNumber() {
  return withRetry(() => getProvider().getBlockNumber());
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
  chunk = 400,
  provider = getProvider(),
}) {
  const out = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const logs = await withRetry(() =>
        provider.getLogs({
          address,
          topics,
          fromBlock: start,
          toBlock: end,
        })
      );
      out.push(...logs);
    } catch (err) {
      if (chunk > 40) {
        const mid = Math.floor((start + end) / 2);
        const left = await getLogsChunked({ address, topics, fromBlock: start, toBlock: mid, chunk: Math.floor(chunk / 2), provider });
        const right = await getLogsChunked({ address, topics, fromBlock: mid + 1, toBlock: end, chunk: Math.floor(chunk / 2), provider });
        out.push(...left, ...right);
      } else {
        throw err;
      }
    }
    start = end + 1;
  }
  return out;
}

export async function scanOnchain(fromBlock, toBlock) {
  const events = [];

  const [v2logs, v3logs, v4logs] = await Promise.all([
    getLogsChunked({
      address: ADDR.V2_FACTORY,
      topics: [TOPICS.pairCreated],
      fromBlock,
      toBlock,
    }),
    getLogsChunked({
      address: ADDR.V3_FACTORY,
      topics: [TOPICS.poolCreated],
      fromBlock,
      toBlock,
    }),
    getLogsChunked({
      address: ADDR.V4_POOL_MANAGER,
      topics: [TOPICS.initialize],
      fromBlock,
      toBlock,
    }),
  ]);

  for (const log of v2logs) {
    try {
      const parsed = v2Iface.parseLog(log);
      const picked = pickToken(parsed.args.token0, parsed.args.token1);
      if (!picked) continue;
      events.push(
        baseEvent({
          source: "onchain",
          venue: "uniswap-v2",
          pool: parsed.args.pair,
          token: picked.token,
          quote: picked.quote,
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash,
        })
      );
    } catch {
      /* ignore undecodable */
    }
  }

  for (const log of v3logs) {
    try {
      const parsed = v3Iface.parseLog(log);
      const picked = pickToken(parsed.args.token0, parsed.args.token1);
      if (!picked) continue;
      events.push(
        baseEvent({
          source: "onchain",
          venue: "uniswap-v3",
          pool: parsed.args.pool,
          token: picked.token,
          quote: picked.quote,
          fee: Number(parsed.args.fee),
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash,
        })
      );
    } catch {
      /* ignore */
    }
  }

  for (const log of v4logs) {
    try {
      const event = parseV4PoolLog(log);
      if (event) events.push(event);
    } catch {
      /* ignore */
    }
  }

  return attachBlockTimes(events);
}

export async function attachBlockTimes(events, provider = getProvider()) {
  const blockNumbers = [...new Set(events.map((event) => event.blockNumber).filter(Number.isInteger))];
  const blocks = new Map();
  await Promise.all(
    blockNumbers.map(async (blockNumber) => {
      const block = await provider.getBlock(blockNumber).catch(() => null);
      blocks.set(blockNumber, block?.timestamp ? Number(block.timestamp) * 1000 : null);
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
    c.name().catch(() => ""),
    c.symbol().catch(() => ""),
    c.decimals().catch(() => 18),
    c.totalSupply().catch(() => 0n),
  ]);
  return { name, symbol, decimals: Number(decimals), totalSupply };
}

export async function readOwner(token) {
  const c = new Contract(token, ERC20_ABI, getProvider());
  try {
    return getAddress(await c.owner());
  } catch {
    try {
      return getAddress(await c.getOwner());
    } catch {
      return null;
    }
  }
}

export async function readV2Pool(pool) {
  const c = new Contract(pool, PAIR_V2_ABI, getProvider());
  const [token0, token1, reserves, lpSupply, deadLp, zeroLp] = await Promise.all([
    c.token0(),
    c.token1(),
    c.getReserves(),
    c.totalSupply(),
    c.balanceOf(ADDR.DEAD).catch(() => 0n),
    c.balanceOf(ZeroAddress).catch(() => 0n),
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

export async function bytecodeFlags(token) {
  const code = await withRetry(() => getProvider().getCode(token));
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

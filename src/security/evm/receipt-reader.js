import { getAddress, zeroPadValue } from "ethers";
import { getLogsChunked, withRetry } from "../../chain.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEFAULT_LOOKBACK_BLOCKS = 250;
const DEFAULT_MAX_LOGS = 500;
const DEFAULT_MAX_RECEIPTS = 30;

function newestFirst(left, right) {
  return Number(right.blockNumber) - Number(left.blockNumber)
    || Number(right.index ?? right.logIndex ?? -1) - Number(left.index ?? left.logIndex ?? -1);
}

export async function readObservedSellReceipts(candidate, binding, {
  provider,
  getLogs,
  getTransactionReceipt,
  lookbackBlocks = DEFAULT_LOOKBACK_BLOCKS,
  maxLogs = DEFAULT_MAX_LOGS,
  maxReceipts = DEFAULT_MAX_RECEIPTS,
} = {}) {
  const head = Number(candidate?.analysisBlock);
  if (!Number.isInteger(head) || head < 0) throw new Error("analysis block unavailable");
  if (!Number.isInteger(lookbackBlocks) || lookbackBlocks <= 0) throw new Error("lookbackBlocks must be positive");
  if (!Number.isInteger(maxLogs) || maxLogs <= 0) throw new Error("maxLogs must be positive");
  if (!Number.isInteger(maxReceipts) || maxReceipts <= 0) throw new Error("maxReceipts must be positive");

  const token = getAddress(candidate.token);
  const liquidityAddresses = [...new Set([binding?.pool, ...(binding?.vaults ?? [])]
    .filter(Boolean)
    .map((address) => getAddress(address)))];
  if (!liquidityAddresses.length) throw new Error("bound liquidity address unavailable");

  const candidateBlock = Number(candidate.blockNumber ?? candidate.blockOrSlot);
  const lookbackStart = Math.max(0, head - lookbackBlocks + 1);
  const fromBlock = Number.isInteger(candidateBlock) && candidateBlock >= 0
    ? Math.max(lookbackStart, candidateBlock)
    : lookbackStart;
  if (fromBlock > head) throw new Error(`candidate block ${fromBlock} is after analysis block ${head}`);

  const readLogs = getLogs ?? ((request) => getLogsChunked({ ...request, provider }));
  const readReceipt = getTransactionReceipt
    ?? ((transactionHash) => withRetry(() => provider.getTransactionReceipt(transactionHash)));
  const logs = await readLogs({
    address: token,
    topics: [TRANSFER_TOPIC, null, liquidityAddresses.map((address) => zeroPadValue(address, 32))],
    fromBlock,
    toBlock: head,
    chunk: lookbackBlocks,
    maxLogs,
  });
  if (!Array.isArray(logs) || logs.length > maxLogs) throw new Error(`log budget exceeded: max ${maxLogs}`);

  const hashes = [];
  const seen = new Set();
  for (const log of [...logs].sort(newestFirst)) {
    const hash = String(log?.transactionHash ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash) || seen.has(hash)) continue;
    seen.add(hash);
    hashes.push(hash);
    if (hashes.length === maxReceipts) break;
  }

  const receipts = [];
  for (const hash of hashes) {
    const receipt = await readReceipt(hash);
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}

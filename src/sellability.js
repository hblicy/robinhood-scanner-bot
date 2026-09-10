import { getAddress, Interface } from "ethers";
import { ERC20_ABI, PAIR_V2_ABI, V2_FACTORY_ABI } from "./abis.js";
import {
  getProvider,
  getLogsChunked,
  findFirstBlockAtOrAfter,
  isContractCallRevert,
  isRateLimitError,
  withRetry,
} from "./chain.js";
import { ADDR } from "./config.js";
import { safeErrorMessage } from "./safety.js";
import { normalizeWalletSignals } from "./wallet-labels.js";

export const SELLABILITY = Object.freeze({
  CONFIRMED: "confirmed",
  UNKNOWN: "unknown",
  BLOCKED: "blocked",
});

const transferInterface = new Interface(ERC20_ABI);
const transferEvent = transferInterface.getEvent("Transfer");
const pairInterface = new Interface(PAIR_V2_ABI);
const swapEvent = pairInterface.getEvent("Swap");
const factoryInterface = new Interface(V2_FACTORY_ABI);
const MAX_BUYERS = 5;
const MAX_LADDER_WALLETS = 3;
const MAX_RECEIPTS = 30;
const MAX_CODE_LOOKUPS = 50;
const MAX_TRANSFER_LOGS = 10_000;
const MAX_TRANSFER_LOOKBACK_BLOCKS = 500;
const TRANSFER_CHUNK_BLOCKS = 10;

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function excludedAddress(address, pool, extra = []) {
  return [pool, ADDR.V2_ROUTER, ADDR.V3_ROUTER, ADDR.V4_POOL_MANAGER, ADDR.ZERO, ADDR.DEAD, ...extra]
    .some((value) => sameAddress(address, value));
}

function isLowAddress(address) {
  try {
    const value = BigInt(address);
    return value > 0n && value <= 0xffffn;
  } catch {
    return true;
  }
}

function sortLogs(logs) {
  return [...logs].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.index ?? a.logIndex ?? 0) - Number(b.index ?? b.logIndex ?? 0));
}

function sortReceiptLogs(logs) {
  return [...logs].sort((a, b) => Number(a.index ?? a.logIndex ?? -1) - Number(b.index ?? b.logIndex ?? -1));
}

function parseTransfer(log) {
  const parsed = transferInterface.parseLog(log);
  return { from: parsed.args.from, to: parsed.args.to, value: BigInt(parsed.args.value) };
}

export function recentTransferRanges(
  start,
  head,
  maxBlocks = MAX_TRANSFER_LOOKBACK_BLOCKS,
  chunk = TRANSFER_CHUNK_BLOCKS
) {
  const floor = Math.max(start, head - maxBlocks + 1);
  const ranges = [];
  for (let end = head; end >= floor;) {
    const fromBlock = Math.max(floor, end - chunk + 1);
    ranges.push({ fromBlock, toBlock: end });
    end = fromBlock - 1;
  }
  return ranges;
}

function unavailable(error, evidence = {}) {
  return sellabilityResult(SELLABILITY.UNKNOWN, "evidence-unavailable", {
    ...evidence,
    details: [`V2 sellability evidence unavailable: ${safeErrorMessage(error)}`],
  });
}

function encodeBalanceOf(address) {
  return transferInterface.encodeFunctionData("balanceOf", [address]);
}

async function readBalance(provider, token, address, head, retry) {
  const data = await retry(() => provider.call({ to: token, data: encodeBalanceOf(address), blockTag: head }));
  return BigInt(transferInterface.decodeFunctionResult("balanceOf", data)[0]);
}

function normalizedQuote(quote, dependencies = {}) {
  const nativeAddresses = dependencies.nativeAddresses ?? [ADDR.ZERO, ADDR.NATIVE];
  const wrappedNative = dependencies.wrappedNative ?? ADDR.WETH;
  return nativeAddresses.some((value) => sameAddress(quote, value)) ? wrappedNative : quote;
}

function decodeAddressResult(iface, functionName, data, address) {
  try {
    return getAddress(iface.decodeFunctionResult(functionName, data)[0]);
  } catch (cause) {
    throw new Error(`failed to decode ${functionName} address result from ${address}`, { cause });
  }
}

async function readAddressFunction(provider, to, iface, functionName, args, head, retry) {
  const data = iface.encodeFunctionData(functionName, args);
  const result = await retry(() => provider.call({ to, data, blockTag: head }));
  return decodeAddressResult(iface, functionName, result, to);
}

async function bindV2Pool(context, provider, head, retry, dependencies = {}) {
  let token;
  let quote;
  let pool;
  try {
    token = getAddress(context.token);
    quote = getAddress(normalizedQuote(context.quote, dependencies));
    pool = getAddress(context.pool);
  } catch {
    return null;
  }

  const factoryPair = await readAddressFunction(
    provider,
    dependencies.factoryAddress ?? ADDR.V2_FACTORY,
    factoryInterface,
    "getPair",
    [token, quote],
    head,
    retry
  );
  if (!sameAddress(factoryPair, pool)) return null;

  const [token0, token1] = await Promise.all([
    readAddressFunction(provider, pool, pairInterface, "token0", [], head, retry),
    readAddressFunction(provider, pool, pairInterface, "token1", [], head, retry),
  ]);
  const tokenIsToken0 = sameAddress(token0, token) && sameAddress(token1, quote);
  const tokenIsToken1 = sameAddress(token1, token) && sameAddress(token0, quote);
  if (!tokenIsToken0 && !tokenIsToken1) return null;

  return { token, quote, pool, tokenIsToken0, analysisBlock: head };
}

function matchesBindingContext(context, binding, head, dependencies = {}) {
  if (!Number.isInteger(binding?.analysisBlock) || binding.analysisBlock < 0 || binding.analysisBlock !== head) {
    return false;
  }
  if (typeof binding.tokenIsToken0 !== "boolean") return false;
  try {
    return sameAddress(getAddress(binding.token), getAddress(context?.token)) &&
      sameAddress(getAddress(binding.quote), getAddress(normalizedQuote(context?.quote, dependencies))) &&
      sameAddress(getAddress(binding.pool), getAddress(context?.pool));
  } catch {
    return false;
  }
}

export async function validateV2PoolBinding(context, dependencies = {}) {
  const expectedVenue = dependencies.expectedVenue ?? "uniswap-v2";
  if (context?.venue !== expectedVenue || !context?.pool) {
    return { ok: false, reason: "unsupported-venue", binding: null, details: [] };
  }

  const provider = dependencies.provider ?? getProvider();
  const retry = dependencies.retry ?? ((fn) => withRetry(fn));
  try {
    const head = Number.isInteger(context.analysisBlock) && context.analysisBlock >= 0
      ? context.analysisBlock
      : await retry(() => provider.getBlockNumber());
    if (!Number.isInteger(head) || head < 0) throw new Error("analysis block unavailable");
    const binding = await bindV2Pool(context, provider, head, retry, dependencies);
    if (!binding) return { ok: false, reason: "pool-binding-mismatch", binding: null, details: [] };
    return { ok: true, reason: null, binding, details: [] };
  } catch (error) {
    if (isRateLimitError(error)) throw error;
    return {
      ok: false,
      reason: "evidence-unavailable",
      binding: null,
      details: [`V2 pool binding unavailable: ${safeErrorMessage(error)}`],
    };
  }
}

function hasMeaningfulSellSegment(receipt, binding, meaningfulThreshold) {
  let sellerTokenIn = 0n;
  let segmentQuoteNetOutflow = 0n;
  let totalQuoteNetOutflow = 0n;
  let qualifyingSwap = false;

  for (const receiptLog of sortReceiptLogs(receipt.logs ?? [])) {
    const isTransfer = receiptLog.topics?.[0]?.toLowerCase() === transferEvent.topicHash.toLowerCase();
    if (isTransfer && sameAddress(receiptLog.address, binding.token)) {
      const tokenTransfer = parseTransfer(receiptLog);
      if (sameAddress(tokenTransfer.from, receipt.from) && sameAddress(tokenTransfer.to, binding.pool)) {
        sellerTokenIn += tokenTransfer.value;
      }
    }
    if (isTransfer && sameAddress(receiptLog.address, binding.quote)) {
      const quoteTransfer = parseTransfer(receiptLog);
      if (!sameAddress(quoteTransfer.from, binding.pool) || !sameAddress(quoteTransfer.to, binding.pool)) {
        if (sameAddress(quoteTransfer.from, binding.pool)) {
          segmentQuoteNetOutflow += quoteTransfer.value;
          totalQuoteNetOutflow += quoteTransfer.value;
        }
        if (sameAddress(quoteTransfer.to, binding.pool)) {
          segmentQuoteNetOutflow -= quoteTransfer.value;
          totalQuoteNetOutflow -= quoteTransfer.value;
        }
      }
    }

    if (!sameAddress(receiptLog.address, binding.pool) ||
      receiptLog.topics?.[0]?.toLowerCase() !== swapEvent.topicHash.toLowerCase()) continue;
    const swap = pairInterface.parseLog(receiptLog);
    const swapTokenIn = BigInt(binding.tokenIsToken0 ? swap.args.amount0In : swap.args.amount1In);
    const quoteOut = BigInt(binding.tokenIsToken0 ? swap.args.amount1Out : swap.args.amount0Out);
    if (sellerTokenIn >= meaningfulThreshold &&
      swapTokenIn >= meaningfulThreshold &&
      quoteOut > 0n &&
      sellerTokenIn >= swapTokenIn &&
      segmentQuoteNetOutflow > 0n) {
      qualifyingSwap = true;
    }
    sellerTokenIn = 0n;
    segmentQuoteNetOutflow = 0n;
  }
  return qualifyingSwap && totalQuoteNetOutflow > 0n;
}

export function decodeTransferCall(data) {
  if (data === "" || data === "0x" || data == null) return null;
  return Boolean(transferInterface.decodeFunctionResult("transfer", data)[0]);
}

export async function resolveStartBlock(
  context,
  head,
  findBlock = findFirstBlockAtOrAfter,
  provider = getProvider(),
  retry = (fn) => withRetry(fn)
) {
  if (Number.isInteger(context?.blockNumber) && context.blockNumber >= 0) return context.blockNumber;
  if (Number.isFinite(context?.pairCreatedAt)) return findBlock(context.pairCreatedAt, head, provider, retry);
  return null;
}

export function sellabilityResult(status, reason, evidence = {}) {
  const {
    buyerSamples = 0,
    ladderSamples = 0,
    meaningfulSellers = 0,
    details = [],
    walletSignals,
  } = evidence;

  const result = {
    status,
    reason,
    buyerSamples,
    ladderSamples,
    meaningfulSellers,
    details: Array.isArray(details) ? [...details] : [],
    walletSignals: normalizeWalletSignals(walletSignals),
  };
  if (evidence.evidenceMode === "observed-sells") {
    result.evidenceMode = "observed-sells";
    result.bindingVerified = evidence.bindingVerified === true;
    result.quoteOutflowReceipts = Number.isInteger(evidence.quoteOutflowReceipts)
      && evidence.quoteOutflowReceipts >= 0
      ? evidence.quoteOutflowReceipts
      : 0;
  }
  for (const field of ["buyTaxBps", "sellTaxBps"]) {
    if (Number.isFinite(evidence[field]) && evidence[field] >= 0 && evidence[field] <= 10_000) {
      result[field] = evidence[field];
    }
  }
  if (typeof evidence.taxModel === "string" && evidence.taxModel !== "") {
    result.taxModel = evidence.taxModel;
  }
  return result;
}

export function normalizeSellabilityEvidence(sellability, legacyHoneypot = null) {
  const evidence = sellability && typeof sellability === "object" ? sellability : {};
  const countFields = ["buyerSamples", "ladderSamples", "meaningfulSellers"];
  const validCounts = countFields.every((field) => Number.isInteger(evidence[field]) && evidence[field] >= 0);
  const normalized = sellabilityResult(SELLABILITY.UNKNOWN, evidence.reason ?? null, {
    buyerSamples: Number.isInteger(evidence.buyerSamples) && evidence.buyerSamples >= 0
      ? evidence.buyerSamples
      : 0,
    ladderSamples: Number.isInteger(evidence.ladderSamples) && evidence.ladderSamples >= 0
      ? evidence.ladderSamples
      : 0,
    meaningfulSellers: Number.isInteger(evidence.meaningfulSellers) && evidence.meaningfulSellers >= 0
      ? evidence.meaningfulSellers
      : 0,
    details: evidence.details,
    walletSignals: evidence.walletSignals,
    evidenceMode: evidence.evidenceMode,
    bindingVerified: evidence.bindingVerified,
    quoteOutflowReceipts: evidence.quoteOutflowReceipts,
    buyTaxBps: evidence.buyTaxBps,
    sellTaxBps: evidence.sellTaxBps,
    taxModel: evidence.taxModel,
  });

  const observedEvidenceComplete = normalized.evidenceMode === "observed-sells"
    && normalized.bindingVerified === true
    && normalized.meaningfulSellers >= 3
    && normalized.quoteOutflowReceipts >= 3;
  const v2EvidenceComplete = normalized.evidenceMode == null
    && validCounts
    && normalized.buyerSamples > 0
    && normalized.ladderSamples > 0
    && normalized.meaningfulSellers >= 3;

  if (evidence.status === SELLABILITY.BLOCKED) {
    normalized.status = SELLABILITY.BLOCKED;
  } else if (
    evidence.status === SELLABILITY.CONFIRMED &&
    (observedEvidenceComplete || v2EvidenceComplete) &&
    legacyHoneypot === false
  ) {
    normalized.status = SELLABILITY.CONFIRMED;
  }

  return normalized;
}

export function evaluateLedgerBalance({ ledgerBalance, reportedBalance, oneToken }) {
  const missing = ledgerBalance - reportedBalance;
  if (ledgerBalance >= oneToken && missing > 0n && missing * 100n > ledgerBalance) {
    return {
      blocked: true,
      reason: "hidden-balance-mutation",
    };
  }

  return {
    blocked: false,
    reason: null,
  };
}

export function evaluateTransferLadder(results) {
  const successfulPercents = [];
  const failedPercents = [];
  let sawUnknown = false;

  for (const step of results) {
    if (step?.ok === true) {
      successfulPercents.push(step.percent);
      continue;
    }
    if (step?.ok === false) {
      failedPercents.push(step.percent);
      continue;
    }
    if (step?.ok == null) {
      sawUnknown = true;
    }
  }

  if (failedPercents.length > 0) {
    const hasStrictlySmallerSuccess = failedPercents.some((failedPercent) =>
      successfulPercents.some((successPercent) => successPercent < failedPercent)
    );

    return {
      blocked: true,
      reason: hasStrictlySmallerSuccess ? "sell-size-limited" : "sell-transfer-blocked",
    };
  }

  return {
    blocked: false,
    reason: sawUnknown ? "evidence-unavailable" : null,
  };
}

function countMeaningfulSellers(sellers) {
  if (!(sellers instanceof Set)) {
    return { valid: false, count: 0 };
  }

  const meaningful = new Set();
  for (const seller of sellers) {
    if (typeof seller !== "string") continue;
    const normalized = seller.trim();
    if (!normalized) continue;
    meaningful.add(normalized);
  }

  return { valid: true, count: meaningful.size };
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function finalizeSellability({ buyerSamples, ladderSamples, sellers, details = [], walletSignals }) {
  const sellerEvidence = countMeaningfulSellers(sellers);
  const meaningfulSellers = sellerEvidence.count;

  if (!isPositiveInteger(buyerSamples) || !isPositiveInteger(ladderSamples) || !sellerEvidence.valid) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "evidence-unavailable", {
      buyerSamples,
      ladderSamples,
      meaningfulSellers,
      details,
      walletSignals,
    });
  }

  if (meaningfulSellers < 3) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "insufficient-meaningful-sells", {
      buyerSamples,
      ladderSamples,
      meaningfulSellers,
      details,
      walletSignals,
    });
  }

  return sellabilityResult(SELLABILITY.CONFIRMED, null, {
    buyerSamples,
    ladderSamples,
    meaningfulSellers,
    details,
    walletSignals,
  });
}

export async function inspectSellability(context, dependencies = {}) {
  const walletCatalog = dependencies.walletCatalog?.status === "known"
    && dependencies.walletCatalog.labels instanceof Map
    ? dependencies.walletCatalog
    : { status: "unconfigured", labels: new Map() };
  let walletSignals = normalizeWalletSignals({
    status: walletCatalog.status,
    count: 0,
    matches: [],
  });
  const result = (status, reason, evidence = {}) => sellabilityResult(status, reason, {
    ...evidence,
    walletSignals: evidence.walletSignals ?? walletSignals,
  });
  const unavailableResult = (error, evidence = {}) => unavailable(error, {
    ...evidence,
    walletSignals: evidence.walletSignals ?? walletSignals,
  });

  const expectedVenue = dependencies.expectedVenue ?? "uniswap-v2";
  const excludedAddresses = dependencies.excludedAddresses ?? [];
  if (context?.venue !== expectedVenue || !context?.pool) {
    return result(SELLABILITY.UNKNOWN, "unsupported-venue");
  }

  const provider = dependencies.provider ?? getProvider();
  const retry = dependencies.retry ?? ((fn) => withRetry(fn));
  const getLogs = dependencies.getLogs ?? getLogsChunked;
  const findBlock = dependencies.findFirstBlockAtOrAfter ?? findFirstBlockAtOrAfter;
  let buyerSamples = 0;
  let ladderSamples = 0;

  try {
    const head = Number.isInteger(context.analysisBlock) && context.analysisBlock >= 0
      ? context.analysisBlock
      : await retry(() => provider.getBlockNumber());
    if (!Number.isInteger(head) || head < 0) throw new Error("analysis block unavailable");
    const bindingEvidence = matchesBindingContext(context, dependencies.poolBinding, head, dependencies)
      ? { ok: true, binding: dependencies.poolBinding }
      : await validateV2PoolBinding(
        { ...context, analysisBlock: head },
        { ...dependencies, provider, retry }
      );
    if (!bindingEvidence.ok) {
      return result(SELLABILITY.UNKNOWN, bindingEvidence.reason || "evidence-unavailable", {
        details: bindingEvidence.details,
      });
    }
    const binding = bindingEvidence.binding;
    const start = await resolveStartBlock(context, head, findBlock, provider, retry);
    if (start == null) return unavailableResult("pool creation block unavailable");
    if (!Number.isInteger(start) || start < 0 || start > head) {
      return unavailableResult(`pool creation block ${start} is after analysis block ${head}`);
    }

    const rawLogs = [];
    const rawBuyers = new Set();
    const rawSellers = new Set();
    let scanStart = head;
    for (const range of recentTransferRanges(start, head)) {
      const remaining = MAX_TRANSFER_LOGS - rawLogs.length;
      const rangeLogs = await getLogs({
        address: context.token,
        topics: [transferEvent.topicHash],
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        maxLogs: remaining,
        provider,
        retry,
      });
      if (!Array.isArray(rangeLogs) || rangeLogs.length > remaining) {
        throw new Error(`log budget exceeded: max ${remaining}`);
      }
      rawLogs.push(...rangeLogs);
      scanStart = range.fromBlock;
      for (const log of rangeLogs) {
        const transfer = parseTransfer(log);
        if (sameAddress(transfer.from, binding.pool)) rawBuyers.add(transfer.to.toLowerCase());
        if (sameAddress(transfer.to, binding.pool)) rawSellers.add(transfer.from.toLowerCase());
      }
      if (rawBuyers.size >= MAX_BUYERS && rawSellers.size >= 3) break;
    }
    const logs = sortLogs(rawLogs).map((log) => ({ log, transfer: parseTransfer(log) }));
    const buys = logs.filter(({ transfer }) => sameAddress(transfer.from, context.pool));
    const buyers = [];
    const buyerCandidates = new Set();
    const codeCache = new Map();
    let codeLookups = 0;
    const isEoa = async (address) => {
      if (isLowAddress(address)) return false;
      const key = address.toLowerCase();
      if (codeCache.has(key)) return codeCache.get(key);
      if (codeLookups >= MAX_CODE_LOOKUPS) throw new Error("EOA code lookup budget exhausted");
      codeLookups++;
      const code = await retry(() => provider.getCode(address, head));
      const eoa = typeof code === "string" && code.toLowerCase() === "0x";
      codeCache.set(key, eoa);
      return eoa;
    };
    const orderedCandidates = [];
    for (const { transfer } of [...buys].reverse()) {
      const key = transfer.to.toLowerCase();
      if (buyerCandidates.has(key) || excludedAddress(transfer.to, context.pool, excludedAddresses)) continue;
      buyerCandidates.add(key);
      orderedCandidates.push(transfer.to);
    }
    orderedCandidates.sort((a, b) =>
      Number(walletCatalog.labels.has(b.toLowerCase())) - Number(walletCatalog.labels.has(a.toLowerCase()))
    );
    for (const candidate of orderedCandidates) {
      if (!(await isEoa(candidate))) continue;
      buyers.push(candidate);
      if (buyers.length === MAX_BUYERS) break;
    }
    buyerSamples = buyers.length;

    const decimals = Number(context.decimals);
    if (!Number.isInteger(decimals) || decimals < 0) throw new Error("token decimals unavailable");
    const oneToken = 10n ** BigInt(decimals);
    const balances = new Map();
    for (const wallet of buyers) {
      let intervalNet = 0n;
      for (const { transfer } of logs) {
        if (sameAddress(transfer.to, wallet)) intervalNet += transfer.value;
        if (sameAddress(transfer.from, wallet)) intervalNet -= transfer.value;
      }
      const openingBalance = scanStart === 0 ? 0n : await readBalance(provider, binding.token, wallet, scanStart - 1, retry);
      const expectedBalance = openingBalance + intervalNet;
      const reportedBalance = await readBalance(provider, context.token, wallet, head, retry);
      balances.set(wallet.toLowerCase(), reportedBalance);
      if (evaluateLedgerBalance({ ledgerBalance: expectedBalance, reportedBalance, oneToken }).blocked) {
        return result(SELLABILITY.BLOCKED, "hidden-balance-mutation", {
          buyerSamples,
          ladderSamples,
          details: [`wallet=${wallet} expectedBalance=${expectedBalance} reported=${reportedBalance}`],
        });
      }
    }

    const matches = buyers
      .filter((wallet) => (balances.get(wallet.toLowerCase()) ?? 0n) >= oneToken)
      .map((wallet) => walletCatalog.labels.get(wallet.toLowerCase()))
      .filter(Boolean);
    walletSignals = normalizeWalletSignals({
      status: walletCatalog.status,
      count: matches.length,
      matches: matches.slice(0, 3),
    });

    const ladderWallets = buyers.filter((wallet) => (balances.get(wallet.toLowerCase()) ?? 0n) >= oneToken).slice(0, MAX_LADDER_WALLETS);
    for (const wallet of ladderWallets) {
      ladderSamples++;
      const balance = balances.get(wallet.toLowerCase());
      const steps = [];
      for (const percent of [1, 10, 50, 100]) {
        try {
          const amount = (balance * BigInt(percent)) / 100n || 1n;
          const data = await retry(() => provider.call({
            from: wallet,
            to: context.token,
            data: transferInterface.encodeFunctionData("transfer", [context.pool, amount]),
            blockTag: head,
          }));
          steps.push({ percent, ok: decodeTransferCall(data) });
        } catch (error) {
          if (!isContractCallRevert(error)) throw error;
          steps.push({ percent, ok: false });
        }
      }
      const ladder = evaluateTransferLadder(steps);
      if (ladder.blocked) return result(SELLABILITY.BLOCKED, ladder.reason, { buyerSamples, ladderSamples });
      if (ladder.reason === "evidence-unavailable") return unavailableResult("transfer simulation returned empty data", { buyerSamples, ladderSamples });
    }

    const poolBalance = await readBalance(provider, context.token, context.pool, head, retry);
    const meaningfulThreshold = poolBalance / 10000n > oneToken ? poolBalance / 10000n : oneToken;
    const sellers = new Set();
    const receiptCandidates = new Map();
    const receiptCache = new Map();
    const readReceipt = (hash) => {
      if (!receiptCache.has(hash)) {
        receiptCache.set(hash, retry(() => provider.getTransactionReceipt(hash)));
      }
      return receiptCache.get(hash);
    };
    for (const { log, transfer } of [...logs].reverse()) {
      if (!sameAddress(transfer.to, binding.pool) || transfer.value < meaningfulThreshold) continue;
      const hash = log.transactionHash;
      if (!hash) continue;
      const sources = receiptCandidates.get(hash) ?? new Set();
      sources.add(transfer.from.toLowerCase());
      receiptCandidates.set(hash, sources);
    }
    let receiptReads = 0;
    for (const [hash, sources] of receiptCandidates) {
      let hasEligibleSource = false;
      for (const source of sources) {
        if (sellers.has(source) || excludedAddress(source, binding.pool, excludedAddresses)) continue;
        if (await isEoa(source)) {
          hasEligibleSource = true;
          break;
        }
      }
      if (!hasEligibleSource) continue;
      if (receiptReads >= MAX_RECEIPTS) break;
      receiptReads++;
      const receipt = await readReceipt(hash);
      if (Number(receipt?.status) !== 1 || typeof receipt?.from !== "string") continue;
      const seller = receipt.from.toLowerCase();
      if (!sources.has(seller) || sellers.has(seller)
        || excludedAddress(receipt.from, binding.pool, excludedAddresses)
        || !(await isEoa(receipt.from))) continue;
      if (hasMeaningfulSellSegment(receipt, binding, meaningfulThreshold)) sellers.add(seller);
      if (sellers.size >= 3 || receiptReads === MAX_RECEIPTS) break;
    }
    return finalizeSellability({ buyerSamples, ladderSamples, sellers, walletSignals });
  } catch (error) {
    if (isRateLimitError(error)) throw error;
    return unavailableResult(error, { buyerSamples, ladderSamples });
  }
}

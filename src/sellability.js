import { Interface } from "ethers";
import { ERC20_ABI } from "./abis.js";
import { getProvider, getLogsChunked, findFirstBlockAtOrAfter, isContractCallRevert, withRetry } from "./chain.js";
import { ADDR } from "./config.js";
import { safeErrorMessage } from "./safety.js";

export const SELLABILITY = Object.freeze({
  CONFIRMED: "confirmed",
  UNKNOWN: "unknown",
  BLOCKED: "blocked",
});

const transferInterface = new Interface(ERC20_ABI);
const transferEvent = transferInterface.getEvent("Transfer");
const MAX_BUYERS = 5;
const MAX_LADDER_WALLETS = 3;
const MAX_RECEIPTS = 30;

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function excludedAddress(address, pool) {
  return [pool, ADDR.V2_ROUTER, ADDR.V3_ROUTER, ADDR.V4_POOL_MANAGER, ADDR.ZERO, ADDR.DEAD]
    .some((value) => sameAddress(address, value));
}

function sortLogs(logs) {
  return [...logs].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.index ?? a.logIndex ?? 0) - Number(b.index ?? b.logIndex ?? 0));
}

function parseTransfer(log) {
  const parsed = transferInterface.parseLog(log);
  return { from: parsed.args.from, to: parsed.args.to, value: BigInt(parsed.args.value) };
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

function normalizedQuote(quote) {
  return sameAddress(quote, ADDR.ZERO) || sameAddress(quote, ADDR.NATIVE) ? ADDR.WETH : quote;
}

export function decodeTransferCall(data) {
  if (data === "" || data === "0x" || data == null) return null;
  return Boolean(transferInterface.decodeFunctionResult("transfer", data)[0]);
}

export async function resolveStartBlock(context, head, findBlock = findFirstBlockAtOrAfter) {
  if (Number.isInteger(context?.blockNumber) && context.blockNumber >= 0) return context.blockNumber;
  if (Number.isFinite(context?.pairCreatedAt)) return findBlock(context.pairCreatedAt, head);
  return null;
}

export function sellabilityResult(status, reason, evidence = {}) {
  const {
    buyerSamples = 0,
    ladderSamples = 0,
    meaningfulSellers = 0,
    details = [],
  } = evidence;

  return {
    status,
    reason,
    buyerSamples,
    ladderSamples,
    meaningfulSellers,
    details: Array.isArray(details) ? [...details] : [],
  };
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

export function finalizeSellability({ buyerSamples, ladderSamples, sellers, details = [] }) {
  const sellerEvidence = countMeaningfulSellers(sellers);
  const meaningfulSellers = sellerEvidence.count;

  if (!isPositiveInteger(buyerSamples) || !isPositiveInteger(ladderSamples) || !sellerEvidence.valid) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "evidence-unavailable", {
      buyerSamples,
      ladderSamples,
      meaningfulSellers,
      details,
    });
  }

  if (meaningfulSellers < 3) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "insufficient-meaningful-sells", {
      buyerSamples,
      ladderSamples,
      meaningfulSellers,
      details,
    });
  }

  return sellabilityResult(SELLABILITY.CONFIRMED, null, {
    buyerSamples,
    ladderSamples,
    meaningfulSellers,
    details,
  });
}

export async function inspectSellability(context, dependencies = {}) {
  if (context?.venue !== "uniswap-v2" || !context?.pool) {
    return sellabilityResult(SELLABILITY.UNKNOWN, "unsupported-venue");
  }

  const provider = dependencies.provider ?? getProvider();
  const retry = dependencies.retry ?? ((fn) => withRetry(fn));
  const getLogs = dependencies.getLogs ?? getLogsChunked;
  const findBlock = dependencies.findFirstBlockAtOrAfter ?? findFirstBlockAtOrAfter;
  let buyerSamples = 0;
  let ladderSamples = 0;

  try {
    const head = await retry(() => provider.getBlockNumber());
    const start = await resolveStartBlock(context, head, findBlock);
    if (start == null) return unavailable("pool creation block unavailable");

    const rawLogs = await getLogs({
      address: context.token,
      topics: [transferEvent.topicHash],
      fromBlock: start,
      toBlock: head,
      provider,
      retry,
    });
    const logs = sortLogs(rawLogs).map((log) => ({ log, transfer: parseTransfer(log) }));
    const buys = logs.filter(({ transfer }) => sameAddress(transfer.from, context.pool));
    const buyers = [];
    for (const { transfer } of [...buys].reverse()) {
      if (buyers.some((wallet) => sameAddress(wallet, transfer.to)) || excludedAddress(transfer.to, context.pool)) continue;
      if (await retry(() => provider.getCode(transfer.to)) !== "0x") continue;
      buyers.push(transfer.to);
      if (buyers.length === MAX_BUYERS) break;
    }
    buyerSamples = buyers.length;

    const decimals = Number(context.decimals);
    if (!Number.isInteger(decimals) || decimals < 0) throw new Error("token decimals unavailable");
    const oneToken = 10n ** BigInt(decimals);
    const balances = new Map();
    for (const wallet of buyers) {
      let ledgerBalance = 0n;
      for (const { transfer } of logs) {
        if (sameAddress(transfer.to, wallet)) ledgerBalance += transfer.value;
        if (sameAddress(transfer.from, wallet)) ledgerBalance -= transfer.value;
      }
      const reportedBalance = await readBalance(provider, context.token, wallet, head, retry);
      balances.set(wallet.toLowerCase(), reportedBalance);
      if (evaluateLedgerBalance({ ledgerBalance, reportedBalance, oneToken }).blocked) {
        return sellabilityResult(SELLABILITY.BLOCKED, "hidden-balance-mutation", {
          buyerSamples,
          ladderSamples,
          details: [`wallet=${wallet} ledger=${ledgerBalance} reported=${reportedBalance}`],
        });
      }
    }

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
      if (ladder.blocked) return sellabilityResult(SELLABILITY.BLOCKED, ladder.reason, { buyerSamples, ladderSamples });
      if (ladder.reason === "evidence-unavailable") return unavailable("transfer simulation returned empty data", { buyerSamples, ladderSamples });
    }

    const poolBalance = await readBalance(provider, context.token, context.pool, head, retry);
    const meaningfulThreshold = poolBalance / 10000n > oneToken ? poolBalance / 10000n : oneToken;
    const sellers = new Set();
    const receiptHashes = new Set();
    let receiptReads = 0;
    for (const { log, transfer } of [...logs].reverse()) {
      if (!sameAddress(transfer.to, context.pool) || transfer.value < meaningfulThreshold || excludedAddress(transfer.from, context.pool)) continue;
      if (await retry(() => provider.getCode(transfer.from)) !== "0x") continue;
      const hash = log.transactionHash;
      if (!hash || receiptHashes.has(hash)) continue;
      receiptHashes.add(hash);
      receiptReads++;
      const receipt = await retry(() => provider.getTransactionReceipt(hash));
      if (Number(receipt?.status) !== 1) {
        if (receiptReads === MAX_RECEIPTS) break;
        continue;
      }
      const paidQuote = (receipt.logs ?? []).some((receiptLog) => {
        if (!sameAddress(receiptLog.address, normalizedQuote(context.quote))) return false;
        if (receiptLog.topics?.[0]?.toLowerCase() !== transferEvent.topicHash.toLowerCase()) return false;
        const quoteTransfer = parseTransfer(receiptLog);
        return sameAddress(quoteTransfer.from, context.pool) && quoteTransfer.value > 0n;
      });
      if (paidQuote) sellers.add(transfer.from.toLowerCase());
      if (sellers.size >= 3 || receiptReads === MAX_RECEIPTS) break;
    }
    return finalizeSellability({ buyerSamples, ladderSamples, sellers });
  } catch (error) {
    return unavailable(error, { buyerSamples, ladderSamples });
  }
}

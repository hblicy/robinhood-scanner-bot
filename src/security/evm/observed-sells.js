import { Interface, getAddress } from "ethers";
import { ERC20_ABI, V4_PM_ABI } from "../../abis.js";

const transferInterface = new Interface(ERC20_ABI);
const transferTopic = transferInterface.getEvent("Transfer").topicHash.toLowerCase();
const v4Interface = new Interface(V4_PM_ABI);
const v4SwapTopic = v4Interface.getEvent("Swap").topicHash.toLowerCase();

function sameAddress(left, right) {
  return typeof left === "string" && typeof right === "string"
    && left.toLowerCase() === right.toLowerCase();
}

function addressSet(values) {
  return new Set(values.filter(Boolean).map((value) => getAddress(value).toLowerCase()));
}

function parseTransfer(log, transactionHash) {
  try {
    const parsed = transferInterface.parseLog(log);
    return {
      from: getAddress(parsed.args.from),
      to: getAddress(parsed.args.to),
      value: BigInt(parsed.args.value),
    };
  } catch (cause) {
    throw new Error(`invalid Transfer log in receipt ${transactionHash || "unknown"}`, { cause });
  }
}

export function observeSellReceipts({
  receipts,
  token,
  quote,
  pool,
  poolId = null,
  vaults = [],
  excludedAddresses = [],
  quoteRecipientAddresses = [],
  meaningfulThreshold,
}) {
  if (!Array.isArray(receipts)) throw new Error("observed sell receipts must be an array");
  if (typeof meaningfulThreshold !== "bigint" || meaningfulThreshold <= 0n) {
    throw new Error("meaningful sell threshold must be a positive bigint");
  }

  const tokenAddress = getAddress(token);
  const quoteAddress = getAddress(quote);
  const poolAddress = getAddress(pool);
  const boundLiquidity = addressSet([poolAddress, ...vaults]);
  const excluded = addressSet([poolAddress, ...vaults, ...excludedAddresses]);
  const sellers = new Set();
  let quoteOutflowReceipts = 0;

  for (const receipt of receipts) {
    if (Number(receipt?.status) !== 1 || typeof receipt?.from !== "string") continue;
    const seller = getAddress(receipt.from).toLowerCase();
    if (excluded.has(seller)) continue;
    const quoteRecipients = addressSet([seller, ...quoteRecipientAddresses]);

    let tokenIn = 0n;
    let quoteOut = 0n;
    let swapTokenIn = 0n;
    let swapQuoteOut = 0n;
    for (const log of receipt.logs ?? []) {
      if (poolId != null && sameAddress(log.address, poolAddress)
        && String(log.topics?.[0]).toLowerCase() === v4SwapTopic
        && String(log.topics?.[1]).toLowerCase() === poolId.toLowerCase()) {
        try {
          const { args } = v4Interface.parseLog(log);
          const tokenIsCurrency0 = tokenAddress.toLowerCase() < quoteAddress.toLowerCase();
          swapTokenIn -= tokenIsCurrency0 ? args.amount0 : args.amount1;
          swapQuoteOut += tokenIsCurrency0 ? args.amount1 : args.amount0;
        } catch (cause) {
          throw new Error(`invalid V4 Swap log in receipt ${receipt.transactionHash || "unknown"}`, { cause });
        }
        continue;
      }
      if (String(log?.topics?.[0]).toLowerCase() !== transferTopic) continue;
      if (!sameAddress(log.address, tokenAddress) && !sameAddress(log.address, quoteAddress)) continue;
      const transfer = parseTransfer(log, receipt.transactionHash);
      if (sameAddress(log.address, tokenAddress)
        && sameAddress(transfer.from, seller)
        && boundLiquidity.has(transfer.to.toLowerCase())) {
        tokenIn += transfer.value;
      }
      if (sameAddress(log.address, quoteAddress)
        && boundLiquidity.has(transfer.from.toLowerCase())
        && quoteRecipients.has(transfer.to.toLowerCase())) {
        quoteOut += transfer.value;
      }
      if (sameAddress(log.address, quoteAddress)
        && quoteRecipients.has(transfer.from.toLowerCase())
        && boundLiquidity.has(transfer.to.toLowerCase())) {
        quoteOut -= transfer.value;
      }
    }
    const swapBound = poolId == null || (swapTokenIn >= meaningfulThreshold && swapQuoteOut > 0n);
    if (swapBound && tokenIn >= meaningfulThreshold && quoteOut > 0n) {
      sellers.add(seller);
      quoteOutflowReceipts++;
    }
  }

  return {
    sellers,
    meaningfulSellers: sellers.size,
    quoteOutflowReceipts,
    receiptSamples: receipts.length,
  };
}

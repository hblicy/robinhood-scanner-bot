export const SELLABILITY = Object.freeze({
  CONFIRMED: "confirmed",
  UNKNOWN: "unknown",
  BLOCKED: "blocked",
});

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

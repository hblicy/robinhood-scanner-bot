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
  const ladder = [...results].sort((left, right) => {
    const leftPercent = typeof left?.percent === "number" ? left.percent : 0;
    const rightPercent = typeof right?.percent === "number" ? right.percent : 0;
    return leftPercent - rightPercent;
  });
  let sawUnknown = false;
  let sawPassingSmallerStep = false;

  for (const step of ladder) {
    if (step?.ok === false) {
      return {
        blocked: true,
        reason: sawPassingSmallerStep ? "sell-size-limited" : "sell-transfer-blocked",
      };
    }
    if (step?.ok == null) {
      sawUnknown = true;
    } else if (step.ok === true) {
      sawPassingSmallerStep = true;
    }
  }

  return {
    blocked: false,
    reason: sawUnknown ? "evidence-unavailable" : null,
  };
}

function countMeaningfulSellers(sellers) {
  if (Array.isArray(sellers)) {
    return new Set(sellers.filter((seller) => seller != null)).size;
  }
  if (sellers instanceof Set) {
    return sellers.size;
  }
  if (typeof sellers === "number" && Number.isFinite(sellers)) {
    return sellers;
  }
  return 0;
}

export function finalizeSellability({ buyerSamples, ladderSamples, sellers, details = [] }) {
  const meaningfulSellers = countMeaningfulSellers(sellers);

  if (buyerSamples === 0 || ladderSamples === 0) {
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

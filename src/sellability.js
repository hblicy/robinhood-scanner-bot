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

function ladderValue(entry) {
  if (entry && typeof entry === "object") {
    const values = Object.values(entry);
    if (values.length > 0) return values[0];
  }
  return null;
}

export function evaluateTransferLadder(results) {
  let sawUnknown = false;

  for (let index = 0; index < results.length; index += 1) {
    const value = ladderValue(results[index]);
    if (value === false) {
      return {
        blocked: true,
        reason: index === 0 ? "sell-transfer-blocked" : "sell-size-limited",
      };
    }
    if (value == null) {
      sawUnknown = true;
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

import { ADDR } from "./config.js";
import { classifyPonsRecord, computePonsPoolId } from "./pons.js";

const PHASE_RANK = {
  not_graduated: 0,
  swept: 1,
  pool_created: 2,
};
const FORBIDDEN_NAME = /official|airdrop|teneo|robinhood|hood/i;

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function initialMonitorState(protocolPhase) {
  if (protocolPhase === "rescued") return "killed";
  if (protocolPhase === "pool_created") return "decay";
  return "observed";
}

export function createPonsTokenState(event, record, now) {
  const identity = classifyPonsRecord(event.token, record, event.kind === "token_launched" ? event.args : null);
  if (identity.identity !== "pons-v2") throw new Error(`cannot create Pons state for ${identity.identity}`);
  const rescued = identity.protocolPhase === "rescued";
  return {
    token: record.token,
    pad: "pons-v2",
    protocolPhase: identity.protocolPhase,
    monitorState: initialMonitorState(identity.protocolPhase),
    marketReady: identity.protocolPhase === "pool_created" ? false : "unknown",
    pairToken: record.pairToken,
    curve: record.curve,
    deployer: record.deployer,
    factory: ADDR.PONS_FACTORY,
    hook: ADDR.PONS_HOOK,
    birthBlock: event.blockNumber ?? null,
    birthAt: event.createdAt ?? (Number.isFinite(event.blockTimestamp) ? event.blockTimestamp * 1000 : now),
    poolId: identity.protocolPhase === "pool_created" ? computePonsPoolId(record) : null,
    positionId: null,
    poolRegisteredAt: null,
    watchlist: false,
    killReason: rescued ? "graduation-rescued-no-pool" : null,
    riskDataStatus: "unknown",
    admissionHeatDecision: null,
    lineA: null,
    lineB: null,
    lineC: null,
    facts: {
      poolFee: record.poolFee,
      tickSpacing: record.tickSpacing,
      creatorFeeRecipient: record.creatorFeeRecipient ?? null,
      creatorTaxBps: record.creatorTaxBps ?? null,
      buybackEnabled: record.buybackEnabled ?? null,
      graduationThreshold: record.graduationThreshold ?? null,
      lifecycleEvents: [event.eventId],
    },
    decay: [],
    updatedAt: now,
  };
}

function assertForwardPhase(previous, next, eventKind) {
  if (previous === "rescued") return "rescued";
  if (next === "rescued") {
    if (previous === "swept" || eventKind === "reconcile") return next;
    throw new Error(`Pons phase regression/conflict ${previous} -> ${next}`);
  }
  if (!(previous in PHASE_RANK) || !(next in PHASE_RANK)) {
    throw new Error(`unsupported Pons phase transition ${previous} -> ${next}`);
  }
  if (PHASE_RANK[next] < PHASE_RANK[previous]) {
    throw new Error(`Pons phase regression ${previous} -> ${next}`);
  }
  return next;
}

export function reducePonsEvent(previous, event, record, now) {
  if (!previous) return createPonsTokenState(event, record, now);
  if (!sameAddress(previous.token, event.token)) {
    throw new Error(`Pons event token mismatch: state ${previous.token}, event ${event.token}`);
  }
  if (previous.protocolPhase === "rescued") return structuredClone(previous);
  const classified = classifyPonsRecord(event.token, record);
  if (classified.identity !== "pons-v2") throw new Error("Pons identity disappeared during lifecycle reduction");
  const protocolPhase = assertForwardPhase(previous.protocolPhase, classified.protocolPhase, event.kind);
  const next = structuredClone(previous);
  next.protocolPhase = protocolPhase;
  next.updatedAt = now;
  next.facts = next.facts || {};
  next.facts.lifecycleEvents = [...new Set([...(next.facts.lifecycleEvents || []), event.eventId])];

  if (event.kind === "launch_swept") {
    next.facts.sweptQuote = event.args?.quoteOut ?? record.sweptQuote ?? null;
    next.facts.sweptTokens = event.args?.tokenOut ?? record.sweptTokens ?? null;
    next.facts.sweptAt = record.sweptAt ?? null;
  }
  if (event.kind === "pool_graduated") {
    next.positionId = event.args?.positionId ?? null;
    next.facts.graduatedTokenAmount = event.args?.tokenAmount ?? null;
    next.facts.graduatedPairTokenAmount = event.args?.pairTokenAmount ?? null;
  }
  if (event.kind === "tokens_locked") {
    next.facts.permanentlyLockedAmount = event.args?.amount ?? null;
  }

  if (protocolPhase === "rescued") {
    next.monitorState = "killed";
    next.watchlist = false;
    next.killReason = "graduation-rescued-no-pool";
    next.marketReady = false;
  } else if (protocolPhase === "pool_created") {
    if (next.monitorState !== "killed") next.monitorState = "decay";
    next.poolId = computePonsPoolId(record);
    next.marketReady = false;
  }
  return next;
}

function observed(reason, riskDataStatus = "known") {
  return {
    monitorState: "observed",
    watchlistEligible: false,
    killReason: null,
    reasons: [reason],
    riskDataStatus,
  };
}

function killed(killReason, riskDataStatus = "known") {
  return {
    monitorState: "killed",
    watchlistEligible: false,
    killReason,
    reasons: [killReason],
    riskDataStatus,
  };
}

export function evaluateLineA(input, limits) {
  const riskDataStatus = input.bundleStatus === "known" && input.internalStatus === "known"
    ? "known"
    : "unknown";
  const label = `${input.name || ""} ${input.symbol || ""}`;
  if (FORBIDDEN_NAME.test(label)) return killed("forbidden-name", riskDataStatus);
  if (Number(input.deployerLaunches24h) > limits.maxDeployerLaunches24h) {
    return killed("serial-deployer", riskDataStatus);
  }
  if (input.bundleStatus === "known" && Number(input.bundlePct) > limits.maxBundlePct) {
    return killed("bundle-over-30pct", riskDataStatus);
  }
  if (input.internalStatus === "known" && Number(input.internalPct) > limits.maxInternalPct) {
    return killed("internal-over-30pct", riskDataStatus);
  }
  if (input.sellability === "blocked") return killed("cannot-sell", riskDataStatus);
  if (Number.isFinite(input.holderCount) && input.holderCount <= 3) {
    return killed("holders-at-most-3", riskDataStatus);
  }

  const flow = input.flow || {};
  if (flow.sampleStatus === "sufficient") {
    if (flow.buyCount > 0 && flow.sellCount === 0) return killed("all-buy-no-sell", riskDataStatus);
    if (flow.buyCount === 0 && flow.sellCount > 0) return killed("only-sells", riskDataStatus);
    if (flow.maxTraderPct > limits.maxSingleTraderPct && flow.washPattern === true) {
      return killed("wash-trading", riskDataStatus);
    }
  }

  if (!["pons-v2", "long"].includes(input.identity)) return observed("unsupported identity", riskDataStatus);
  if (!Number.isFinite(input.ageSeconds) || input.ageSeconds < limits.minAgeSeconds) {
    return observed(input.ageSeconds <= limits.ignoreSeconds ? "anti-snipe window" : "too early", riskDataStatus);
  }
  if (input.ageSeconds > limits.maxAgeMinutes * 60) return observed("outside Line A window", riskDataStatus);
  if (flow.sampleStatus !== "sufficient" || flow.tradeCount < limits.minFlowTrades ||
      flow.uniqueTraders < limits.minFlowUniqueTraders) {
    return observed("flow sample insufficient", riskDataStatus);
  }
  if (!(flow.buyCount > 0 && flow.sellCount > 0)) return observed("bidirectional flow unknown", riskDataStatus);
  if (input.holdersIncreasing !== true) return observed("holders not increasing", riskDataStatus);
  if (!input.narrativeReason) return observed("no-narrative", riskDataStatus);

  return {
    monitorState: "watchlisted",
    watchlistEligible: true,
    killReason: null,
    reasons: riskDataStatus === "unknown" ? ["risk data pending verification"] : [],
    riskDataStatus,
  };
}

function recyclable(entry, now, curveDeadGraceMs) {
  return entry.monitorState === "killed" ||
    (entry.monitorState === "curve_dead" && Number.isFinite(entry.curveDeadAt) &&
      now - entry.curveDeadAt > curveDeadGraceMs);
}

export function admitWatchlist(current, candidate, cap, now = Date.now(), curveDeadGraceMs = 14_400_000) {
  const watchlist = structuredClone(Array.isArray(current) ? current : []);
  if (!candidate?.watchlistEligible) return { admitted: false, reason: "ineligible", watchlist };
  if (watchlist.some((entry) => sameAddress(entry.token, candidate.token))) {
    return { admitted: true, reason: "already-present", watchlist };
  }
  while (watchlist.length >= cap) {
    const index = watchlist.findIndex((entry) => recyclable(entry, now, curveDeadGraceMs));
    if (index < 0) return { admitted: false, reason: "watchlist-full", watchlist };
    watchlist.splice(index, 1);
  }
  watchlist.push(structuredClone(candidate));
  return { admitted: true, reason: "admitted", watchlist };
}

export function canGreen(state) {
  if (!state || state.monitorState === "killed" || state.protocolPhase === "rescued") return false;
  if (state.riskDataStatus !== "known" || state.admissionHeatDecision !== "打") return false;
  if (state.lineA?.passed !== true || state.lineB?.passed !== true || state.lineC?.passed !== true) return false;
  if (state.marketReady !== true) return false;
  if (state.pad === "pons-v2") return state.protocolPhase === "pool_created";
  return state.pad === "long";
}

export function applyMarketEvidence(state, evidence, now) {
  const next = structuredClone(state);
  next.facts = next.facts || {};
  const matches = sameAddress(state.token, evidence?.token) &&
    sameAddress(state.pairToken, evidence?.pairToken) &&
    String(state.poolId || "").toLowerCase() === String(evidence?.poolId || "").toLowerCase();
  if (!matches) {
    next.marketReady = false;
    next.facts.market = { ...structuredClone(evidence || {}), conflict: true, bindingMismatch: true };
  } else if (!Number.isFinite(state.poolRegisteredAt)) {
    next.marketReady = false;
    next.facts.market = { ...structuredClone(evidence || {}), registrationMissing: true };
  } else {
    next.marketReady = state.protocolPhase === "pool_created" ? evidence.marketReady : false;
    next.facts.market = structuredClone(evidence);
  }
  next.updatedAt = now;
  return next;
}

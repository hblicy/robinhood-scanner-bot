const LIVE = "live";
const SILENT_MODES = new Set(["recovery", "shadow"]);
const WATCHLIST_TRANSITIONS = new Set(["rescued", "green", "market_ready", "graduated", "swept"]);

function validateMode(mode) {
  if (mode !== LIVE && !SILENT_MODES.has(mode)) throw new Error(`unknown alert mode: ${mode}`);
}

export function decideCandidateAlert({ mode, sellability, score, minScore }) {
  validateMode(mode);
  if (mode !== LIVE) return null;
  if (sellability === "blocked") return { type: "risk", watchlistAdmission: false };
  if (sellability === "confirmed" && Number.isFinite(score) && Number.isFinite(minScore) && score >= minScore) {
    return { type: "candidate", watchlistAdmission: true };
  }
  return null;
}

export function decideLifecycleAlert({ mode, transitionType, watchlisted = false, evidenceConfirmed = false }) {
  validateMode(mode);
  if (mode !== LIVE) return null;
  if (transitionType === "hard_kill") {
    return evidenceConfirmed ? { type: transitionType } : null;
  }
  if (WATCHLIST_TRANSITIONS.has(transitionType) && watchlisted === true) {
    return { type: transitionType };
  }
  return null;
}

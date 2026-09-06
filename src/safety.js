export function sanitizeRpcUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid RPC URL";
    return `${url.protocol}//[redacted]${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "invalid RPC URL";
  }
}

export function safeErrorMessage(error) {
  const message = error?.shortMessage || error?.message || String(error);
  return String(message).replace(/https?:\/\/[^\s"'<>)}\]]+/gi, (url) => sanitizeRpcUrl(url));
}

export function validateBps(name, value) {
  if (!Number.isInteger(value) || value < 0 || value >= 10_000) {
    throw new Error(`${name} must be an integer in [0, 10000)`);
  }
  return value;
}

export function validatePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function minOutFromQuote(quote, slippageBps) {
  validateBps("SLIPPAGE_BPS", slippageBps);
  const amount = BigInt(quote);
  if (amount <= 0n) throw new Error("quote output must be positive");
  const minOut = (amount * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut <= 0n) throw new Error("minimum output must be positive");
  return minOut;
}

export function plannedExitAmount(position, sellPct) {
  const pctBps = Math.trunc(Number(sellPct) * 100);
  if (!Number.isInteger(pctBps) || pctBps <= 0 || pctBps > 10_000) {
    throw new Error("SELL_PCT must be in (0, 100]");
  }
  const initial = BigInt(position.initialTokenAmount);
  const remaining = BigInt(position.remainingTokenAmount);
  if (sellPct >= 100) return remaining;
  const planned = (initial * BigInt(pctBps)) / 10_000n;
  return planned > remaining ? remaining : planned;
}

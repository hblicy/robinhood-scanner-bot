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
  return String(message).replace(/https?:\/\/\S+/gi, "[redacted URL]");
}

export function validatePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function validatePositiveNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

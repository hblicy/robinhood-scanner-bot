function unavailable(message, cause) {
  const error = new Error(`asset-registry-unavailable: ${message}`, { cause });
  error.code = "asset-registry-unavailable";
  return error;
}

export async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response?.ok) {
      throw new Error(`server response ${response?.status ?? "unknown"}`);
    }
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`unexpected content-type ${contentType || "missing"}`);
    }
    return await response.json();
  } catch (error) {
    if (error?.code === "asset-registry-unavailable") throw error;
    throw unavailable(error?.message || "request failed", error);
  } finally {
    clearTimeout(timeout);
  }
}

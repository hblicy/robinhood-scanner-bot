import { safeErrorMessage } from "./safety.js";
import { shouldSendLifecycleNotification } from "./notification-policy.js";

const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 135_000, 300_000];

export function nextRetryAt(now, attempts) {
  const index = Math.min(Math.max(Number(attempts) - 1, 0), RETRY_DELAYS_MS.length - 1);
  return now + RETRY_DELAYS_MS[index];
}

export async function drainOutbox({
  store,
  send,
  now = Date.now,
  limit = 20,
  maxAttempts = 5,
}) {
  const result = { delivered: 0, suppressed: 0, retried: 0, failed: 0 };
  const entries = store.listDueOutbox(now(), limit);
  for (const entry of entries) {
    if (!shouldSendLifecycleNotification(entry)) {
      store.markOutboxSuppressed(entry.id, now());
      result.suppressed += 1;
      continue;
    }
    try {
      await send(entry.text, entry);
      store.markOutboxDelivered(entry.id, now());
      result.delivered += 1;
    } catch (cause) {
      const attempts = Number(entry.attempts || 0) + 1;
      const exhausted = attempts >= maxAttempts;
      store.rescheduleOutbox(entry.id, {
        status: exhausted ? "failed" : "pending",
        attempts,
        nextAttemptAt: nextRetryAt(now(), attempts),
        lastError: safeErrorMessage(cause),
      });
      if (exhausted) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}

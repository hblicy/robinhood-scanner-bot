const ALLOWED_LIFECYCLE_TYPES = new Set([
  "hard_kill",
  "rescued",
  "green",
  "market_ready",
]);

export function shouldSendLifecycleNotification(entry) {
  return ALLOWED_LIFECYCLE_TYPES.has(String(entry?.transitionType || ""));
}

import { decideLifecycleAlert } from "./core/alert-policy.js";

export function shouldSendLifecycleNotification(entry, { mode = "live" } = {}) {
  return decideLifecycleAlert({
    mode,
    transitionType: String(entry?.transitionType || ""),
    watchlisted: entry?.watchlisted === true,
    evidenceConfirmed: entry?.evidenceConfirmed === true,
  }) !== null;
}

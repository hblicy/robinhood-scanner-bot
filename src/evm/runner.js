import { acquireInstanceLock } from "../instance-lock.js";
import { candidateKey } from "../core/candidate.js";
import { handleCandidate } from "../runtime.js";
import {
  findFirstBlockAtOrAfter,
  getBlockNumber,
  getLogsChunked,
  isDiscoveryFallbackError,
  sleep,
  withRetry,
} from "../chain.js";
import { scanEvmRange } from "./discovery.js";
import { safeErrorMessage } from "../safety.js";
import {
  createCandidateRouteStats,
  candidateRouteStatKey,
  formatCandidateRouteStats,
  incrementCandidateRouteStat,
  routeCandidate,
} from "../candidate-gate.js";
import {
  AnalysisRpcCooldownError,
  bindAnalysisCircuit,
} from "../analysis-rpc-circuit.js";
import { formatHourlyUsage } from "../startup-summary.js";
import {
  createCandidateRecheck,
  decideCandidateRecheck,
  shouldScheduleCandidateRecheck,
} from "../candidate-retry.js";

const RECHECK_LIMIT = 20;

async function blockTimes({ provider, blockNumbers }) {
  const values = await Promise.all(blockNumbers.map(async (blockNumber) => {
    const block = await withRetry(() => provider.getBlock(blockNumber));
    const timestamp = Number(block?.timestamp);
    if (!Number.isFinite(timestamp)) throw new Error(`block ${blockNumber} timestamp unavailable`);
    return [blockNumber, timestamp * 1000];
  }));
  return new Map(values);
}

function defaultDependencies(config) {
  return {
    now: Date.now,
    getBlockNumber,
    findFirstBlockAtOrAfter,
    scanRange: ({ provider, fromBlock, toBlock }) => scanEvmRange({
      chain: config.profile,
      provider,
      fromBlock,
      toBlock,
      adapters: config.venues.filter((venue) => Array.isArray(venue.addresses)),
      getLogs: (request) => getLogsChunked(request),
      getBlockTimes: blockTimes,
    }),
    analyze: config.services?.analyze,
    alertReport: config.services?.alertReport,
    analysisRpcCircuit: config.analysisRpcCircuit,
    notifyAnalysisRpcLimited: config.services?.notifyAnalysisRpcLimited,
    log: console.log,
    sleep,
  };
}

function validateDependencies(dependencies) {
  for (const name of ["getBlockNumber", "findFirstBlockAtOrAfter", "scanRange", "analyze", "alertReport", "log"]) {
    if (typeof dependencies[name] !== "function") throw new Error(`EVM runner dependency ${name} is required`);
  }
}

function analysisWithCircuit(dependencies, routeStats) {
  if (!dependencies.analysisRpcCircuit) return dependencies.analyze;
  return bindAnalysisCircuit({
    circuit: dependencies.analysisRpcCircuit,
    analyze: async (value) => {
      incrementCandidateRouteStat(routeStats, "paid_deep_checks");
      return dependencies.analyze(value);
    },
    onOpen: dependencies.notifyAnalysisRpcLimited,
  });
}

async function runDueCandidateRechecks(config, dependencies, mode, routeStats) {
  const result = { completed: 0, retried: 0 };
  if (mode !== "live" || typeof config.store.listDueChecks !== "function") return result;
  const now = dependencies.now();
  const analyzeCandidate = analysisWithCircuit(dependencies, routeStats);
  const checks = config.store.listDueChecks(now, RECHECK_LIMIT)
    .filter(({ type }) => type === "candidate_recheck");
  for (const check of checks) {
    try {
      const event = { ...structuredClone(check.event), observedAt: now };
      const budgetStage = config.rpcUsageBudget?.snapshot?.().stage ?? "normal";
      if (budgetStage === "exhausted"
        || (budgetStage === "critical" && event.referenceAssetKind !== "stock")) {
        config.store.rescheduleCheck(check.id, {
          status: "pending",
          attempts: Number(check.attempts || 0),
          nextAttemptAt: now + 15 * 60_000,
          lastError: `rpc budget ${budgetStage}`,
        });
        result.retried += 1;
        continue;
      }
      const report = await handleCandidate(event, { persistSeen: false }, {
        now: dependencies.now,
        maxAgeMinutes: config.settings.maxAgeMinutes ?? 30,
        minScore: config.settings.minScore,
        mode,
        analyze: analyzeCandidate,
        markSeen: () => {},
        alertReport: dependencies.alertReport,
        log: dependencies.log,
      });
      if (!report) {
        config.store.completeCheck(check.id, now);
        result.completed += 1;
        continue;
      }
      const decision = decideCandidateRecheck(
        check,
        report,
        now,
        config.settings.maxAgeMinutes ?? 30
      );
      if (decision.complete) {
        config.store.completeCheck(check.id, now);
        result.completed += 1;
      } else {
        config.store.rescheduleCheck(check.id, {
          status: "pending",
          attempts: Number(check.attempts || 0) + 1,
          nextAttemptAt: decision.retryAt,
          lastError: safeErrorMessage(decision.lastError || "evidence pending"),
        });
        result.retried += 1;
      }
    } catch (error) {
      if (!(error instanceof AnalysisRpcCooldownError)) {
        throw new Error(`candidate recheck failed for ${check.event?.token || "unknown"}`, { cause: error });
      }
      config.store.rescheduleCheck(check.id, {
        status: "pending",
        attempts: Number(check.attempts || 0),
        nextAttemptAt: now + 60_000,
        lastError: safeErrorMessage(error),
      });
      result.retried += 1;
    }
  }
  return result;
}

export async function runEvmRangeOnce(config, { persist = true } = {}, supplied = {}) {
  const dependencies = { ...defaultDependencies(config), ...supplied };
  validateDependencies(dependencies);
  const store = config.store;
  const savedCursor = store.getOnchainCursor();
  const configuredMode = config.settings.alertMode;
  const mode = persist && savedCursor == null ? "recovery" : configuredMode;
  const routeStats = createCandidateRouteStats();
  const rechecks = persist
    ? await runDueCandidateRechecks(config, dependencies, mode, routeStats)
    : { completed: 0, retried: 0 };

  return config.rpcContext.discoverySessions.run(async (provider) => {
    const latest = await dependencies.getBlockNumber(provider);
    const confirmations = config.settings.confirmationBlocks ?? config.profile.confirmations ?? 0;
    const head = latest - confirmations;
    if (head < 0) return { mode, fromBlock: null, toBlock: head, candidates: 0, reports: [], routeStats, rechecks };
    const maxAgeMinutes = config.settings.maxAgeMinutes ?? 30;
    const fromBlock = savedCursor == null
      ? await dependencies.findFirstBlockAtOrAfter(
        dependencies.now() - maxAgeMinutes * 60_000,
        head,
        provider
      )
      : savedCursor + 1;
    if (fromBlock > head) return { mode, fromBlock, toBlock: head, candidates: 0, reports: [], routeStats, rechecks };

    const candidates = await dependencies.scanRange({ provider, fromBlock, toBlock: head, config });
    const reports = [];
    for (const candidate of candidates) {
      const key = candidateKey(candidate);
      if (persist && store.hasSeen(key)) continue;
      const event = {
        ...candidate,
        source: candidate.source || candidate.sourceKind,
        quote: candidate.quote ?? candidate.quoteToken,
        blockNumber: candidate.blockNumber ?? candidate.blockOrSlot,
        observedAt: dependencies.now(),
      };
      const route = routeCandidate(event, {
        thresholds: { ...config.settings, maxAgeMinutes },
        supportsSellability: (value) => config.securityRegistry.supports(value),
        venueRegistry: config.venueRegistry ?? null,
        rpcUsageBudget: config.rpcUsageBudget ?? null,
      });
      if (route.action !== "analyze") {
        const stat = candidateRouteStatKey(route);
        incrementCandidateRouteStat(routeStats, stat);
        if (persist) store.markSeen(key, { token: event.token, skipped: route.reason });
        continue;
      }
      const analyzeCandidate = analysisWithCircuit({
        ...dependencies,
        notifyAnalysisRpcLimited: mode === "live" ? dependencies.notifyAnalysisRpcLimited : undefined,
      }, routeStats);
      let report;
      try {
        report = await handleCandidate(event, { persistSeen: persist }, {
          now: dependencies.now,
          maxAgeMinutes,
          minScore: config.settings.minScore,
          mode,
          analyze: analyzeCandidate,
          markSeen: (seenKey, payload) => store.markSeen(seenKey, payload),
          alertReport: dependencies.alertReport,
          log: dependencies.log,
          onAnalyzed: async (analyzedReport, analyzedEvent) => {
            if (typeof dependencies.onAnalyzed === "function") {
              await dependencies.onAnalyzed(analyzedReport, analyzedEvent);
            }
            if (persist && mode === "live"
              && shouldScheduleCandidateRecheck(analyzedEvent, analyzedReport)) {
              config.store.scheduleCheck(createCandidateRecheck(analyzedEvent, dependencies.now()));
            }
          },
        });
      } catch (error) {
        if (!(error instanceof AnalysisRpcCooldownError)) throw error;
        incrementCandidateRouteStat(routeStats, "analysis_rpc_cooldown_skips");
        if (persist) store.markSeen(key, { token: event.token, skipped: "analysis-rpc-cooldown" });
        continue;
      }
      if (report) reports.push(report);
    }
    if (persist) store.setOnchainCursor(head);
    return { mode, fromBlock, toBlock: head, candidates: candidates.length, reports, routeStats, rechecks };
  });
}

export async function watchEvm(config, supplied = {}) {
  const dependencies = { ...defaultDependencies(config), ...supplied };
  const release = await (dependencies.acquireLock ?? acquireInstanceLock)(config.dataDir);
  let lastUsageHour = null;
  try {
    while (true) {
      try {
        const result = await runEvmRangeOnce(config, { persist: true }, dependencies);
        dependencies.log(
          `${config.profile.key}: blocks ${result.fromBlock ?? "none"}-${result.toBlock} candidates=${result.candidates} mode=${result.mode} rechecks=${result.rechecks.completed}/${result.rechecks.retried} routes ${formatCandidateRouteStats(result.routeStats)}`
        );
        const usageHour = Math.floor(dependencies.now() / 3_600_000);
        if (config.rpcUsageBudget && usageHour !== lastUsageHour) {
          dependencies.log(formatHourlyUsage(config, dependencies.now()));
          lastUsageHour = usageHour;
        }
      } catch (error) {
        if (!isDiscoveryFallbackError(error)) throw error;
        dependencies.log(`${config.profile.key} discovery retry: ${safeErrorMessage(error)}`);
      }
      await dependencies.sleep(config.settings.pollMs ?? 5_000);
    }
  } finally {
    await release();
  }
}

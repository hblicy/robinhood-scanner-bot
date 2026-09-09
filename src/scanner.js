import { SETTINGS, CHAIN, DATA_DIR, isQuote } from "./config.js";
import { getDefaultStore, getOnchainCursor, hasSeen, markSeen, setOnchainCursor } from "./store.js";
import {
  findFirstBlockAtOrAfter,
  getAnalysisProvider,
  getBlockNumber,
  getDiscoveryProvider,
  isDiscoveryFallbackError,
  scanOnchain,
  sleep,
} from "./chain.js";
import { geckoNewPools, getDexPaprikaTopPools } from "./market.js";
import { analyze } from "./analyze.js";
import { alertReport, formatAlert, formatLifecycleNotification, sendTelegram } from "./notify.js";
import { CandidateQueue, createSerialExecutor } from "./queue.js";
import { candidateKey, handleCandidate } from "./runtime.js";
import { safeErrorMessage } from "./safety.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { createPonsTokenState, reducePonsEvent } from "./lifecycle.js";
import { classifyPonsRecord, readPonsLaunch, scanPonsRange, verifyPonsDeployment } from "./pons.js";
import { drainOutbox, nextRetryAt } from "./outbox.js";
import { formatInspectionReport, inspectToken } from "./check.js";
import { evaluateHeat } from "./decay.js";
import {
  createCandidateRecheck,
  decideCandidateRecheck,
  shouldScheduleCandidateRecheck,
} from "./candidate-retry.js";

const DEFAULT_ANALYSIS_CONCURRENCY = 1;
const candidates = new CandidateQueue({
  maxSize: SETTINGS.maxQueueSize,
  hasSeen,
  keyOf: candidateKey,
});
let draining = false;

function lifecycleChecks(event, state, now) {
  const types = event.kind === "token_launched"
    ? ["curve_flow", "holders", "deployer_24h", "line_a"]
    : event.kind === "pool_graduated"
      ? ["market", "line_c"]
      : [];
  return types.map((type) => ({
    id: `${event.eventId}:${type}`,
    eventId: event.eventId,
    type,
    token: state.token,
    dueAt: now,
  }));
}

async function buildPonsTransitions(events, {
  provider,
  readLaunch,
  now,
  initialTokens = {},
  scheduleChecks = true,
}) {
  const working = structuredClone(initialTokens);
  const transitions = [];
  for (const event of events) {
    const record = await readLaunch(provider, event.token);
    const key = event.token.toLowerCase();
    const previous = working[key] || null;
    const nextToken = previous
      ? reducePonsEvent(previous, event, record, now())
      : createPonsTokenState(event, record, now());
    working[key] = nextToken;
    transitions.push({
      eventId: event.eventId,
      blockNumber: event.blockNumber,
      token: event.token,
      nextToken,
      notifications: [],
      checks: scheduleChecks ? lifecycleChecks(event, nextToken, now()) : [],
    });
  }
  return transitions;
}

export async function previewPonsRange({
  provider,
  fromBlock,
  toBlock,
  now = Date.now,
  scanRange = scanPonsRange,
  readLaunch = readPonsLaunch,
  initialTokens = {},
  scheduleChecks = true,
}) {
  const events = await scanRange(provider, fromBlock, toBlock);
  const transitions = await buildPonsTransitions(events, {
    provider,
    readLaunch,
    now,
    initialTokens,
    scheduleChecks,
  });
  return { events, transitions };
}

export async function watchPonsRange(options) {
  const snapshot = options.store.snapshot();
  const result = await previewPonsRange({ ...options, initialTokens: snapshot.tokens });
  options.store.commitPonsRange({ toBlock: options.toBlock, transitions: result.transitions });
  return result;
}

export async function runPendingChecks({
  store,
  handlers,
  now = Date.now,
  limit = 20,
  maxAttempts = 5,
}) {
  const result = { completed: 0, retried: 0, failed: 0 };
  for (const check of store.listDueChecks(now(), limit)) {
    try {
      const handler = handlers?.[check.type];
      if (typeof handler !== "function") throw new Error(`no pending-check handler for ${check.type}`);
      const update = await handler(check);
      if (update?.retryAt != null) {
        if (!Number.isFinite(update.retryAt)) {
          throw new Error(`pending check ${check.id} returned invalid retryAt`);
        }
        store.rescheduleCheck(check.id, {
          status: "pending",
          attempts: Number(check.attempts || 0) + 1,
          nextAttemptAt: update.retryAt,
          lastError: safeErrorMessage(update.lastError || "evidence pending"),
        });
        result.retried += 1;
        continue;
      }
      if (update?.nextToken && update?.token) {
        store.applyCheckResult(check.id, { ...update, completedAt: now() });
      } else {
        store.completeCheck(check.id, now());
      }
      result.completed += 1;
    } catch (cause) {
      const attempts = Number(check.attempts || 0) + 1;
      const allowedAttempts = Number.isInteger(check.maxAttempts) && check.maxAttempts > 0
        ? check.maxAttempts
        : maxAttempts;
      const exhausted = attempts >= allowedAttempts;
      const anchoredOffset = Array.isArray(check.retryOffsetsMs)
        ? check.retryOffsetsMs[attempts]
        : null;
      const retryAt = Number.isFinite(check.firstAnalyzedAt) && Number.isFinite(anchoredOffset)
        ? check.firstAnalyzedAt + anchoredOffset
        : nextRetryAt(now(), attempts);
      store.rescheduleCheck(check.id, {
        status: exhausted ? "failed" : "pending",
        attempts,
        nextAttemptAt: retryAt,
        lastError: safeErrorMessage(cause),
      });
      if (exhausted) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}

export function createCandidateRetryScheduler({ store, now = Date.now }) {
  if (!store || typeof store.scheduleCheck !== "function") {
    throw new Error("candidate retry scheduler requires a store");
  }
  return async (report, event) => {
    if (!shouldScheduleCandidateRecheck(event, report)) return null;
    return store.scheduleCheck(createCandidateRecheck(event, now()));
  };
}

export function createCandidateRecheckHandler({
  executeCandidate,
  now = Date.now,
  maxAgeMinutes = SETTINGS.maxAgeMinutes,
  minScore = SETTINGS.minScore,
  analyze: analyzeCandidate = analyze,
  alertReport: sendAlert = alertReport,
  log = console.log,
}) {
  if (typeof executeCandidate !== "function") {
    throw new Error("candidate recheck handler requires a shared executor");
  }
  return async (check) => {
    if (!check?.event || typeof check.event !== "object" || !check.event.token) {
      throw new Error(`candidate recheck ${check?.id || "unknown"} requires an event`);
    }
    const at = now();
    const event = { ...structuredClone(check.event), observedAt: at };
    const report = await executeCandidate(() => handleCandidate(
      event,
      { persistSeen: false },
      {
        now,
        maxAgeMinutes,
        minScore,
        analyze: analyzeCandidate,
        markSeen: () => {},
        alertReport: sendAlert,
        log,
      }
    ));
    if (!report) return undefined;
    const decision = decideCandidateRecheck(check, report, at, maxAgeMinutes);
    if (decision.complete) return undefined;
    return { retryAt: decision.retryAt, lastError: decision.lastError };
  };
}

export function createInspectionCheckHandlers({
  provider,
  store,
  now = Date.now,
  inspect = inspectToken,
  timeoutMs = 90_000,
}) {
  const handle = async (check) => {
    const previous = store.snapshot().tokens[String(check.token).toLowerCase()];
    if (!previous) throw new Error(`pending check token state missing for ${check.token}`);
    const report = await inspect(check.token, { provider, now }, { timeoutMs });
    if (report.timedOut) {
      throw new Error(`inspection timeout; unfinished=${(report.unfinishedSources || []).join(",") || "unknown"}`);
    }
    if (report.identity !== "pons-v2") {
      throw new Error(`inspection Factory identity is ${report.identity || "unknown"}`);
    }

    const nextToken = structuredClone(previous);
    nextToken.facts = nextToken.facts || {};
    nextToken.facts.inspection = report;
    nextToken.riskDataStatus = report.riskDataStatus || "unknown";
    nextToken.lineB = {
      passed: report.curve?.status === "sufficient" && report.curve?.bidirectional === true,
      sampleStatus: report.curve?.status || "unknown",
      tradeCount: report.curve?.tradeCount ?? null,
      uniqueTraders: report.curve?.uniqueTraders ?? null,
    };
    if (nextToken.protocolPhase === "pool_created" && [true, false, "unknown"].includes(report.marketReady)) {
      nextToken.marketReady = report.marketReady;
    }
    if (report.monitorState === "killed" && nextToken.protocolPhase !== "rescued") {
      nextToken.monitorState = "killed";
      nextToken.watchlist = false;
      nextToken.killReason = report.reasons?.[0] || "inspection-hard-kill";
    }
    nextToken.updatedAt = now();

    let transitionType = null;
    if (previous.monitorState !== "killed" && nextToken.monitorState === "killed") transitionType = "hard_kill";
    else if (previous.marketReady !== true && nextToken.marketReady === true) transitionType = "market_ready";
    const notification = transitionType ? {
      id: `${check.id}:${transitionType}`,
      eventId: check.eventId,
      transitionType,
      token: check.token,
      reason: report.reasons?.[0] || (transitionType === "market_ready" ? "Hook 与双向市场证据已确认" : "风险硬门槛触发"),
    } : null;
    if (notification) notification.text = formatLifecycleNotification(notification);
    return { token: check.token, nextToken, notification };
  };
  return Object.fromEntries([
    "curve_flow",
    "holders",
    "deployer_24h",
    "line_a",
    "market",
    "line_c",
  ].map((type) => [type, handle]));
}

function heatPoolCategory(pool) {
  if (pool?.category) return pool.category;
  const tokens = Array.isArray(pool?.tokens) ? pool.tokens : [];
  if (tokens.some((token) => String(token.symbol || "").replace(/^\$/, "").toUpperCase() === "PONS")) {
    return "pons";
  }
  const nonQuote = tokens.filter((token) => !isQuote(token.address));
  if (nonQuote.length === 0) return "infrastructure";
  if (nonQuote.every((token) => String(token.symbol || "").toUpperCase() === "NVDA")) return "stock";
  return "memecoin";
}

export async function refreshMarketHeat({
  provider,
  store,
  settings = SETTINGS,
  now = Date.now,
  getBlockNumber: readHead = getBlockNumber,
  findFirstBlockAtOrAfter: findStart = findFirstBlockAtOrAfter,
  scanRange = scanPonsRange,
  getTopPools = getDexPaprikaTopPools,
}) {
  const at = now();
  const [launchesResult, poolsResult] = await Promise.allSettled([
    (async () => {
      const head = await readHead(provider);
      const from = await findStart(at - 86_400_000, head, provider);
      const events = await scanRange(provider, from, head);
      return events.filter((event) => event.kind === "token_launched").length;
    })(),
    getTopPools(),
  ]);
  const errors = [];
  if (launchesResult.status === "rejected") {
    errors.push({ source: "pons_launches_24h", message: safeErrorMessage(launchesResult.reason) });
  }
  if (poolsResult.status === "rejected") {
    errors.push({ source: "dexpaprika_top_pools", message: safeErrorMessage(poolsResult.reason) });
  }
  const pools = poolsResult.status === "fulfilled" ? poolsResult.value : [];
  const topPools = pools.map((pool) => ({ category: heatPoolCategory(pool) }));
  const ponsCount = topPools.filter((pool) => pool.category === "pons").length;
  const heat = evaluateHeat({
    launches24h: launchesResult.status === "fulfilled" ? launchesResult.value : null,
    topPools,
    ponsPopularPct: topPools.length ? (ponsCount / topPools.length) * 100 : null,
    fetchedAt: errors.length ? null : at,
    now: at,
  }, {
    ttlMs: 2 * 3_600_000,
    highHeatLaunches24h: settings.highHeatLaunches24h,
    normalCap: settings.watchlistCapNormal,
    highHeatCap: settings.watchlistCapHighHeat,
  });
  heat.errors = errors;
  store.commitHeat({ heat });
  return heat;
}

export async function reconcilePonsWatchlist({
  provider,
  store,
  readLaunch = readPonsLaunch,
  now = Date.now,
}) {
  const snapshot = store.snapshot();
  let updated = 0;
  for (const address of snapshot.watchlist) {
    const previous = snapshot.tokens[address.toLowerCase()];
    if (!previous) throw new Error(`watchlist token state missing for ${address}`);
    const record = await readLaunch(provider, address);
    const phase = ["not_graduated", "swept", "pool_created", "rescued"][Number(record.phase)];
    if (!phase) throw new Error(`unknown Pons phase ${record.phase}`);
    if (phase === previous.protocolPhase) continue;
    const event = {
      kind: "reconcile",
      eventId: `reconcile:${address.toLowerCase()}:${phase}`,
      token: address,
      args: {},
    };
    const nextToken = reducePonsEvent(previous, event, record, now());
    let notification = null;
    if (phase === "rescued") {
      notification = {
        id: `${event.eventId}:rescued`,
        eventId: event.eventId,
        transitionType: "rescued",
        token: address,
        reason: `Factory getter 阶段为 ${phase}`,
      };
      notification.text = formatLifecycleNotification(notification);
    }
    store.commitTokenUpdate({ token: address, nextToken, notification });
    updated += 1;
  }
  return { updated };
}

export async function classifyAuxiliaryCandidate(event, {
  provider,
  readLaunch = readPonsLaunch,
}) {
  let record;
  try {
    record = await readLaunch(provider, event.token);
  } catch (cause) {
    return { ...event, pad: "unknown", identity: "unknown", error: safeErrorMessage(cause) };
  }
  const classification = classifyPonsRecord(event.token, record);
  if (classification.identity === "pons-v2") {
    return { ...event, pad: "pons-v2", identity: "pons-v2", protocolPhase: classification.protocolPhase };
  }
  return {
    ...event,
    pad: isQuote(event.quote) ? "long" : "uniswap-native",
    identity: "not_pons",
    protocolPhase: "not_applicable",
  };
}

async function drainQueue(queue, concurrency, handle) {
  let handled = 0;
  let failed = 0;
  while (queue.size > 0) {
    const batch = [];
    while (batch.length < concurrency && queue.size > 0) batch.push(queue.take());
    const results = await Promise.all(batch.map(async (event) => {
      try {
        await handle(event);
        return true;
      } catch {
        return false;
      } finally {
        queue.finish(event);
      }
    }));
    handled += results.filter(Boolean).length;
    failed += results.filter((ok) => !ok).length;
  }
  return { handled, failed };
}

function enqueue(event) {
  const accepted = candidates.enqueue(event);
  if (!accepted && candidates.size >= SETTINGS.maxQueueSize) {
    console.warn(`candidate queue full (${SETTINGS.maxQueueSize}); deferred ${candidateKey(event)}`);
  }
  return accepted;
}

async function drain({ persistSeen = true }) {
  if (draining) return { handled: 0, failed: 0 };
  draining = true;
  try {
    return await drainQueue(candidates, DEFAULT_ANALYSIS_CONCURRENCY, async (event) => {
      try {
        await handleCandidate(
          event,
          { persistSeen },
          {
            now: Date.now,
            maxAgeMinutes: SETTINGS.maxAgeMinutes,
            minScore: SETTINGS.minScore,
            analyze,
            markSeen,
            alertReport,
            log: console.log,
          }
        );
      } catch (error) {
        console.error("handle failed", event.token, safeErrorMessage(error));
        throw error;
      }
    });
  } finally {
    draining = false;
  }
}

export async function processEvents(events, queue, runDrain) {
  let accepted = 0;
  let handled = 0;
  let failed = 0;
  const collectDrain = async () => {
    const result = await runDrain();
    handled += result?.handled || 0;
    failed += result?.failed || 0;
  };
  for (const event of events) {
    if (queue.isFull) await collectDrain();
    if (queue.enqueue(event)) accepted += 1;
  }
  await collectDrain();
  return { accepted, handled, failed };
}

export async function processOnchainRange({ from, head }, dependencies) {
  const events = await dependencies.scanOnchain(from, head);
  const result = await dependencies.handleEvents(events);
  const complete = result.failed === 0;
  return { events, ...result, complete };
}

export async function initialOnchainCursor({
  head,
  savedCursor,
  maxAgeMinutes,
  now,
  findFirstBlockAtOrAfter: findBoundary,
}) {
  const cutoff = now() - maxAgeMinutes * 60_000;
  const firstRelevantBlock = await findBoundary(cutoff, head);
  return Math.min(head, Math.max(savedCursor ?? -1, firstRelevantBlock - 1));
}

export async function runWatchIteration(state, dependencies) {
  const { settings } = dependencies;
  const errors = [];
  const observedAt = dependencies.now();
  const runOnchain = async () => {
    if (!settings.onchainScan) return;
    try {
      const runDiscoverySession = dependencies.runDiscoverySession ??
        ((work) => work(dependencies.provider));
      const result = await runDiscoverySession(async (provider) => {
        const latestHead = await dependencies.getBlockNumber(provider);
        const safeHead = latestHead - (settings.confirmationBlocks ?? 0);
        let lastBlock = state.lastBlock;
        if (safeHead >= 0 && lastBlock == null) {
          lastBlock = await initialOnchainCursor({
            head: safeHead,
            savedCursor: dependencies.getOnchainCursor(),
            maxAgeMinutes: settings.maxAgeMinutes,
            now: dependencies.now,
            findFirstBlockAtOrAfter: (target, head) =>
              dependencies.findFirstBlockAtOrAfter(target, head, provider),
          });
        }
        if (safeHead < 0 || safeHead <= lastBlock) {
          return { safeHead, lastBlock, scanned: null };
        }
        const from = lastBlock + 1;
        const scanned = await processOnchainRange(
          { from, head: safeHead },
          {
            scanOnchain: (start, end) => dependencies.scanOnchain(start, end, provider),
            handleEvents: (events) => dependencies.handleEvents(
              events.map((event) => ({ ...event, observedAt: event.observedAt ?? observedAt })),
              "onchain"
            ),
          }
        );
        return { safeHead, lastBlock, from, scanned };
      });
      if (result.scanned?.events.length) {
        dependencies.log(
          `onchain ${result.from}-${result.safeHead}: ${result.scanned.events.length} pools, ${result.scanned.accepted} new`
        );
      }
      if (result.scanned?.complete) {
        dependencies.setOnchainCursor(result.safeHead);
        state.lastBlock = result.safeHead;
      } else if (result.scanned) {
        dependencies.log(
          `onchain ${result.from}-${result.safeHead}: ${result.scanned.failed} failed; cursor not advanced`
        );
      } else if (state.lastBlock == null) {
        state.lastBlock = result.lastBlock;
      }
    } catch (cause) {
      const error = new Error(`onchain watch failed: ${safeErrorMessage(cause)}`, { cause });
      errors.push(error);
      dependencies.log(error.message);
    }
  };

  const runGecko = async () => {
    if (!settings.geckoScan || observedAt - state.lastGecko < settings.geckoPollMs) return;
    state.lastGecko = observedAt;
    try {
      const events = await dependencies.geckoNewPools(1);
      const result = await dependencies.handleEvents(
        events.map((event) => ({ ...event, observedAt: event.observedAt ?? observedAt })),
        "gecko"
      );
      if (result.accepted) {
        dependencies.log(`gecko: ${events.length} pools, ${result.accepted} new`);
      }
      if (result.failed) dependencies.log(`gecko: ${result.failed} candidates failed`);
    } catch (cause) {
      const error = new Error(`gecko watch failed: ${safeErrorMessage(cause)}`, { cause });
      errors.push(error);
      dependencies.log(error.message);
    }
  };
  await Promise.all([runOnchain(), runGecko()]);
  return { state, errors };
}

export async function runPonsWatchIteration(state, dependencies) {
  const runDiscoverySession = dependencies.runDiscoverySession
    ?? ((work) => work(dependencies.provider));
  const iteration = await runDiscoverySession(async (provider) => {
    const safeHead = (await dependencies.getBlockNumber(provider))
      - (dependencies.settings.ponsConfirmations ?? 0);
    if (safeHead < 0) {
      return { complete: true, events: [], transitions: [], lastBlock: state.lastBlock };
    }

    let recovering = false;
    let lastBlock = state.lastBlock;
    if (lastBlock == null) {
      const savedCursor = dependencies.store.getPonsCursor();
      recovering = savedCursor == null;
      const boundary = await dependencies.findFirstBlockAtOrAfter(
        dependencies.now() - dependencies.settings.lineAMaxAgeMinutes * 60_000,
        safeHead,
        provider
      );
      lastBlock = Math.min(safeHead, Math.max(savedCursor ?? -1, boundary - 1));
    }
    if (safeHead <= lastBlock) {
      return { complete: true, events: [], transitions: [], lastBlock };
    }

    const result = await watchPonsRange({
      provider,
      store: dependencies.store,
      fromBlock: lastBlock + 1,
      toBlock: safeHead,
      now: dependencies.now,
      scanRange: dependencies.scanRange,
      readLaunch: dependencies.readLaunch,
      scheduleChecks: !recovering,
    });
    return { ...result, complete: true, lastBlock: safeHead };
  });
  state.lastBlock = iteration.lastBlock;
  delete iteration.lastBlock;
  return iteration;
}

export async function runPonsWatchLoop(state, dependencies) {
  const wait = dependencies.sleep ?? sleep;
  const log = dependencies.log ?? console.log;
  const logError = dependencies.logError ?? console.error;
  while (true) {
    try {
      const result = await runPonsWatchIteration(state, dependencies);
      if (result.events.length) {
        log(`pons ${result.events.length} lifecycle events; cursor=${state.lastBlock}`);
      }
    } catch (cause) {
      logError(`pons watch failed: ${safeErrorMessage(cause)}`);
    }
    await wait(dependencies.settings.pollMs);
  }
}

export async function runReadOnlyCandidates(events, dependencies) {
  const queue = new CandidateQueue({
    maxSize: dependencies.maxQueueSize,
    hasSeen: () => false,
    keyOf: candidateKey,
  });
  const reports = [];
  const failures = [];
  const observedAt = dependencies.now();
  const runDrain = async () => {
    return drainQueue(
      queue,
      dependencies.analysisConcurrency ?? DEFAULT_ANALYSIS_CONCURRENCY,
       async (event) => {
       try {
        const classified = dependencies.classifyCandidate
          ? await dependencies.classifyCandidate(event)
          : event;
        if (classified.identity === "pons-v2") return;
        if (classified.identity === "unknown") {
          throw new Error(`Pons identity unknown for ${event.token}: ${classified.error || "Factory read failed"}`);
        }
        const report = await handleCandidate(
          classified,
          { persistSeen: false },
          {
            now: dependencies.now,
            maxAgeMinutes: dependencies.maxAgeMinutes,
            minScore: dependencies.minScore,
            analyze: dependencies.analyze,
            markSeen: () => {},
            alertReport: dependencies.consoleAlert,
            log: dependencies.log,
          }
        );
        if (report) reports.push(report);
      } catch (error) {
        failures.push({ event, error });
        dependencies.log(`handle failed ${event.token} ${safeErrorMessage(error)}`);
        throw error;
      }
      }
    );
  };
  await processEvents(
    events.map((event) => ({ ...event, observedAt: event.observedAt ?? observedAt })),
    queue,
    runDrain
  );
  if (failures.length) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `candidate analysis failed: ${failures.map(({ event, error }) =>
        `${event.token}: ${safeErrorMessage(error)}`).join(", ")}`
    );
  }
  return reports;
}

export async function runWatchStartupChecks({
  provider,
  store,
  retryMs = Math.max(SETTINGS.pollMs, 5_000),
  verify = verifyPonsDeployment,
  reconcile = reconcilePonsWatchlist,
  wait = sleep,
  isRecoverable = isDiscoveryFallbackError,
  logError = console.error,
}) {
  while (true) {
    try {
      await verify(provider);
      await reconcile({ provider, store });
      return;
    } catch (cause) {
      if (!isRecoverable(currentFailoverError(cause))) throw cause;
      logError(`watch startup RPC check failed: ${safeErrorMessage(cause)}; retrying`);
      await wait(retryMs);
    }
  }
}

function currentFailoverError(error) {
  const pending = [error];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    if (typeof current === "object") visited.add(current);
    if (current instanceof AggregateError && current.errors.length) {
      return currentFailoverError(current.errors.at(-1));
    }
    if (typeof current === "object") {
      pending.push(current.cause, current.error, current.info?.error);
    }
  }
  return error;
}

async function watch() {
  const releaseLock = await acquireInstanceLock(DATA_DIR);
  const releaseOnExit = () => releaseLock();
  process.once("exit", releaseOnExit);
  try {
    banner();
    const discoveryProvider = getDiscoveryProvider();
    const analysisProvider = getAnalysisProvider();
    const getDiscoveryBlockNumber = () => getBlockNumber(discoveryProvider);
    const findDiscoveryStart = (target, head) =>
      findFirstBlockAtOrAfter(target, head, discoveryProvider);
    const scanDiscovery = (from, to) =>
      scanOnchain(from, to, { provider: discoveryProvider });
    const analyzeCandidate = (event) => analyze(event, { provider: analysisProvider });
    const store = getDefaultStore();
    if (SETTINGS.onchainScan) {
      await runWatchStartupChecks({ provider: discoveryProvider, store });
    }
    if (SETTINGS.telegramToken) {
      await sendTelegram(
        `🤖 Robinhood 扫链机器人已启动\n仅扫描和报警，不包含交易功能\n年龄 &lt; ${SETTINGS.maxAgeMinutes} 分钟 · 最低分 ${SETTINGS.minScore}`
      ).catch((error) => console.error("startup telegram:", safeErrorMessage(error)));
    }

    const state = { lastBlock: null, lastGecko: 0 };
    const ponsState = { lastBlock: null };
    const claimed = new Set();
    const executeCandidate = createSerialExecutor();
    const scheduleCandidateRecheck = createCandidateRetryScheduler({ store, now: Date.now });
    const pendingHandlers = {
      ...createInspectionCheckHandlers({ provider: analysisProvider, store }),
      candidate_recheck: createCandidateRecheckHandler({
        executeCandidate,
        now: Date.now,
        maxAgeMinutes: SETTINGS.maxAgeMinutes,
        minScore: SETTINGS.minScore,
        analyze: analyzeCandidate,
        alertReport,
        log: console.log,
      }),
    };
    const createSourceProcessor = () => {
      const inner = new CandidateQueue({
        maxSize: SETTINGS.maxQueueSize,
        hasSeen: (key) => hasSeen(key) || claimed.has(key),
        keyOf: candidateKey,
      });
      const queue = {
        get size() { return inner.size; },
        get isFull() { return inner.isFull; },
        enqueue(event) {
          const accepted = inner.enqueue(event);
          if (accepted) claimed.add(candidateKey(event));
          return accepted;
        },
        take: () => inner.take(),
        finish(event) {
          inner.finish(event);
          claimed.delete(candidateKey(event));
        },
      };
      return (events) => processEvents(events, queue, () => drainQueue(
        queue,
        DEFAULT_ANALYSIS_CONCURRENCY,
        async (event) => executeCandidate(async () => {
          try {
            const classified = await classifyAuxiliaryCandidate(event, { provider: discoveryProvider });
            if (classified.identity === "pons-v2") return;
            if (classified.identity === "unknown") {
              throw new Error(`Pons identity unknown for ${event.token}: ${classified.error}`);
            }
            await handleCandidate(
              classified,
              { persistSeen: true },
              {
                now: Date.now,
                maxAgeMinutes: SETTINGS.maxAgeMinutes,
                minScore: SETTINGS.minScore,
                analyze: analyzeCandidate,
                markSeen,
                alertReport,
                log: console.log,
                onAnalyzed: scheduleCandidateRecheck,
              }
            );
          } catch (error) {
            console.error("handle failed", event.token, safeErrorMessage(error));
            throw error;
          }
        })
      ));
    };
    const common = {
        now: Date.now,
        getBlockNumber: getDiscoveryBlockNumber,
        getOnchainCursor,
        findFirstBlockAtOrAfter: findDiscoveryStart,
        scanOnchain: scanDiscovery,
        setOnchainCursor,
        geckoNewPools,
        log: console.log,
    };
    const loops = [];
    if (SETTINGS.onchainScan) {
      loops.push(runPonsWatchLoop(ponsState, {
        provider: discoveryProvider,
        store,
        settings: SETTINGS,
        getBlockNumber: getDiscoveryBlockNumber,
        findFirstBlockAtOrAfter: findDiscoveryStart,
        scanRange: scanPonsRange,
        readLaunch: readPonsLaunch,
        now: Date.now,
        sleep,
        log: console.log,
        logError: console.error,
      }));
      const handleEvents = createSourceProcessor();
      loops.push((async () => {
        while (true) {
          await runWatchIteration(state, {
            ...common,
            settings: { ...SETTINGS, geckoScan: false },
            handleEvents,
          });
          await sleep(SETTINGS.pollMs);
        }
      })());
    }
    loops.push((async () => {
      while (true) {
        const result = await drainOutbox({
          store,
          send: (text) => sendTelegram(text),
        });
        if (result.failed) console.error(`outbox: ${result.failed} notifications exhausted retries`);
        await sleep(SETTINGS.outboxPollMs);
      }
    })());
    loops.push((async () => {
      while (true) {
        const result = await runPendingChecks({ store, handlers: pendingHandlers });
        if (result.failed) console.error(`pending checks: ${result.failed} checks exhausted retries`);
        await sleep(SETTINGS.outboxPollMs);
      }
    })());
    if (SETTINGS.dexPaprikaScan) {
      loops.push((async () => {
        while (true) {
          const heat = await refreshMarketHeat({ provider: discoveryProvider, store });
          console.log(`market heat: ${heat.decision} level=${heat.level} launches24h=${heat.launches24h ?? "unknown"} cap=${heat.admissionCap}`);
          const hour = Math.floor(Date.now() / 3_600_000);
          await sleep(Math.max(1, (hour + 1) * 3_600_000 - Date.now()));
        }
      })());
    }
    if (SETTINGS.geckoScan) {
      const handleEvents = createSourceProcessor();
      loops.push((async () => {
        while (true) {
          await runWatchIteration(state, {
            ...common,
            settings: { ...SETTINGS, onchainScan: false },
            handleEvents,
          });
          const nextPoll = state.lastGecko + SETTINGS.geckoPollMs;
          await sleep(Math.max(1, nextPoll - Date.now()));
        }
      })());
    }
    await Promise.all(loops);
  } finally {
    process.removeListener("exit", releaseOnExit);
    await releaseLock();
  }
}

async function scanOnceCore(supplied = null) {
  const dependencies = supplied || {
    settings: SETTINGS,
    discoveryProvider: getDiscoveryProvider(),
    analysisProvider: getAnalysisProvider(),
    getBlockNumber,
    findFirstBlockAtOrAfter,
    scanOnchain,
    geckoNewPools,
    previewPonsRange,
    verifyPonsDeployment,
    analyze,
    classifyCandidate: classifyAuxiliaryCandidate,
    consoleAlert: async (report) => {
      console.log(formatAlert(report).replace(/<[^>]+>/g, ""));
    },
    consolePons: async (report) => {
      console.log(`Pons ${report.nextToken.protocolPhase} ${report.nextToken.token} ID ${report.eventId}`);
    },
    log: console.log,
  };
  const discoveryProvider = dependencies.discoveryProvider || dependencies.provider;
  const analysisProvider = dependencies.analysisProvider || dependencies.provider || getAnalysisProvider();
  const settings = dependencies.settings;
  banner();
  const sources = [];
  if (settings.onchainScan) {
    if (dependencies.previewPonsRange) {
      sources.push({
        name: "pons",
        run: async () => {
          if (dependencies.verifyPonsDeployment) await dependencies.verifyPonsDeployment(discoveryProvider);
          const latestHead = await dependencies.getBlockNumber(discoveryProvider);
          const head = latestHead - (settings.ponsConfirmations ?? settings.confirmationBlocks ?? 0);
          if (head < 0) return [];
          const from = await dependencies.findFirstBlockAtOrAfter(
            (dependencies.now || Date.now)() - settings.maxAgeMinutes * 60_000,
            head,
            discoveryProvider
          );
          const preview = await dependencies.previewPonsRange({
            provider: discoveryProvider,
            fromBlock: from,
            toBlock: head,
            now: dependencies.now || Date.now,
          });
          return preview.transitions.map((transition) => ({ kind: "pons-lifecycle", ...transition }));
        },
      });
    }
    sources.push({
      name: "onchain",
      run: async () => {
        const latestHead = await dependencies.getBlockNumber(discoveryProvider);
        const head = latestHead - (settings.confirmationBlocks ?? 0);
        if (head < 0) return [];
        const from = await dependencies.findFirstBlockAtOrAfter(
          (dependencies.now || Date.now)() - settings.maxAgeMinutes * 60_000,
          head,
          discoveryProvider
        );
        dependencies.log(`one-shot read-only scan blocks ${from}-${head}`);
        return dependencies.scanOnchain(from, head, { provider: discoveryProvider });
      },
    });
  }
  if (settings.geckoScan) {
    sources.push({ name: "gecko", run: () => dependencies.geckoNewPools(3) });
  }

  const results = await Promise.allSettled(sources.map(({ run }) => run()));
  const sourceFailures = [];
  const discovered = { pons: [], onchain: [], gecko: [] };
  results.forEach((result, index) => {
    const source = sources[index].name;
    if (result.status === "fulfilled") {
      discovered[source] = result.value;
    } else {
      const wrapped = new Error(
        `${source} discovery failed: ${safeErrorMessage(result.reason)}`,
        { cause: result.reason }
      );
      sourceFailures.push(wrapped);
      dependencies.log(wrapped.message);
    }
  });
  const onchain = discovered.onchain;
  const gecko = discovered.gecko;
  const pons = discovered.pons;
  dependencies.log(`candidates: pons=${pons.length} onchain=${onchain.length} gecko=${gecko.length}`);
  for (const report of pons) await (dependencies.consolePons || dependencies.consoleAlert)(report);
  let reports = [];
  let candidateFailure = null;
  try {
    reports = await runReadOnlyCandidates([...onchain, ...gecko], {
      maxQueueSize: settings.maxQueueSize,
      maxAgeMinutes: settings.maxAgeMinutes,
      minScore: settings.minScore,
      now: dependencies.now || Date.now,
      analyze: (event) => dependencies.analyze(event, { provider: analysisProvider }),
      classifyCandidate: dependencies.classifyCandidate
        ? (event) => dependencies.classifyCandidate(event, { provider: discoveryProvider })
        : undefined,
      consoleAlert: dependencies.consoleAlert,
      log: dependencies.log,
    });
  } catch (error) {
    candidateFailure = error;
  }
  if (sourceFailures.length || candidateFailure) {
    const errors = [...sourceFailures];
    if (candidateFailure instanceof AggregateError) errors.push(...candidateFailure.errors);
    else if (candidateFailure) errors.push(candidateFailure);
    throw new AggregateError(errors, [
      ...sourceFailures.map((error) => error.message),
      candidateFailure?.message,
    ].filter(Boolean).join("; "));
  }
  return [...pons, ...reports];
}

async function scanOnce(supplied = null) {
  const timeoutMs = supplied?.timeoutMs ?? 120_000;
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`scan timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([scanOnceCore(supplied), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkOne(token, supplied = null) {
  if (!token) throw new Error("usage: node src/index.js check 0xToken");
  const dependencies = supplied || {};
  const report = await inspectToken(token, dependencies, { timeoutMs: dependencies.timeoutMs ?? 90_000 });
  (dependencies.log || console.log)(formatInspectionReport(report));
  return report;
}

function normalizedRpcEndpoint(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function banner() {
  console.log("====================================================");
  console.log(" Robinhood Chain scanner");
  console.log(` ${CHAIN.name}  chainId=${CHAIN.id}`);
  const sharedRpc = normalizedRpcEndpoint(CHAIN.discoveryRpc)
    === normalizedRpcEndpoint(CHAIN.analysisRpc);
  console.log(` Discovery RPC ${sharedRpc ? "shared endpoint" : "official primary + analysis fallback"}`);
  console.log(` Analysis RPC configured${sharedRpc ? " (same endpoint; no CU separation)" : ""}`);
  console.log(" mode=push-only");
  console.log(` maxAge=${SETTINGS.maxAgeMinutes}m  minScore=${SETTINGS.minScore}`);
  console.log(" Scanner and alerts only. Transaction functionality is not included.");
  console.log(" This is not financial advice. Most memecoins go to zero.");
  console.log("====================================================");
}

export async function runCommand(command, argument) {
  if (command === "watch") {
    await watch();
  } else if (command === "scan") {
    await scanOnce();
  } else if (command === "check") {
    await checkOne(argument);
  }
}

export { banner, checkOne, drain, enqueue, scanOnce, watch };

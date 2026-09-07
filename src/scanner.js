import { SETTINGS, CHAIN, DATA_DIR } from "./config.js";
import { getDefaultStore, getOnchainCursor, hasSeen, markSeen, setOnchainCursor } from "./store.js";
import { findFirstBlockAtOrAfter, getBlockNumber, getProvider, scanOnchain, sleep } from "./chain.js";
import { geckoNewPools } from "./market.js";
import { analyze } from "./analyze.js";
import { alertReport, formatAlert, sendTelegram } from "./notify.js";
import { CandidateQueue } from "./queue.js";
import { candidateKey, handleCandidate } from "./runtime.js";
import { safeErrorMessage, sanitizeRpcUrl } from "./safety.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { createPonsTokenState, reducePonsEvent } from "./lifecycle.js";
import { readPonsLaunch, scanPonsRange, verifyPonsDeployment } from "./pons.js";
import { drainOutbox, nextRetryAt } from "./outbox.js";

const DEFAULT_ANALYSIS_CONCURRENCY = 2;
const candidates = new CandidateQueue({
  maxSize: SETTINGS.maxQueueSize,
  hasSeen,
  keyOf: candidateKey,
});
let draining = false;

function lifecycleNotification(event, state) {
  const transitionType = {
    token_launched: "new_launch",
    launch_swept: "swept",
    pool_graduated: "graduated",
  }[event.kind];
  if (!transitionType) return null;
  const label = {
    new_launch: "Pons V2 新币",
    swept: "Pons V2 已 Sweep，正式池未确认",
    graduated: "Pons V2 已链上毕业",
  }[transitionType];
  const id = `${event.eventId}:${transitionType}`;
  return {
    id,
    eventId: event.eventId,
    transitionType,
    token: state.token,
    text: `${label}\nCA ${state.token}\nID ${id}`,
  };
}

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
    const notification = lifecycleNotification(event, nextToken);
    transitions.push({
      eventId: event.eventId,
      blockNumber: event.blockNumber,
      token: event.token,
      nextToken,
      notifications: notification ? [notification] : [],
      checks: lifecycleChecks(event, nextToken, now()),
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
}) {
  const events = await scanRange(provider, fromBlock, toBlock);
  const transitions = await buildPonsTransitions(events, {
    provider,
    readLaunch,
    now,
    initialTokens,
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
      if (update?.nextToken && update?.token) {
        store.applyCheckResult(check.id, { ...update, completedAt: now() });
      } else {
        store.completeCheck(check.id, now());
      }
      result.completed += 1;
    } catch (cause) {
      const attempts = Number(check.attempts || 0) + 1;
      const exhausted = attempts >= maxAttempts;
      store.rescheduleCheck(check.id, {
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
    const transitionType = phase === "rescued" ? "rescued" : phase === "pool_created" ? "graduated" : "phase_changed";
    const notification = {
      id: `${event.eventId}:${transitionType}`,
      eventId: event.eventId,
      transitionType,
      token: address,
      text: `Pons V2 ${phase}\nCA ${address}\nID ${event.eventId}`,
    };
    store.commitTokenUpdate({ token: address, nextToken, notification });
    updated += 1;
  }
  return { updated };
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
  if (complete) dependencies.setOnchainCursor(head);
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
      const latestHead = await dependencies.getBlockNumber();
      const safeHead = latestHead - (settings.confirmationBlocks ?? 0);
      if (safeHead >= 0 && state.lastBlock == null) {
        state.lastBlock = await initialOnchainCursor({
          head: safeHead,
          savedCursor: dependencies.getOnchainCursor(),
          maxAgeMinutes: settings.maxAgeMinutes,
          now: dependencies.now,
          findFirstBlockAtOrAfter: dependencies.findFirstBlockAtOrAfter,
        });
      }
      if (safeHead >= 0 && safeHead > state.lastBlock) {
        const from = state.lastBlock + 1;
        const result = await processOnchainRange(
          { from, head: safeHead },
          {
            scanOnchain: dependencies.scanOnchain,
            handleEvents: (events) => dependencies.handleEvents(
              events.map((event) => ({ ...event, observedAt: event.observedAt ?? observedAt })),
              "onchain"
            ),
            setOnchainCursor: dependencies.setOnchainCursor,
          }
        );
        if (result.events.length) {
          dependencies.log(
            `onchain ${from}-${safeHead}: ${result.events.length} pools, ${result.accepted} new`
          );
        }
        if (result.complete) state.lastBlock = safeHead;
        else dependencies.log(`onchain ${from}-${safeHead}: ${result.failed} failed; cursor not advanced`);
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
  const safeHead = (await dependencies.getBlockNumber()) - (dependencies.settings.ponsConfirmations ?? 0);
  if (safeHead < 0) return { complete: true, events: [], transitions: [] };
  if (state.lastBlock == null) {
    const savedCursor = dependencies.store.getPonsCursor();
    const boundary = await dependencies.findFirstBlockAtOrAfter(
      dependencies.now() - dependencies.settings.lineAMaxAgeMinutes * 60_000,
      safeHead
    );
    state.lastBlock = Math.min(safeHead, Math.max(savedCursor ?? -1, boundary - 1));
  }
  if (safeHead <= state.lastBlock) return { complete: true, events: [], transitions: [] };
  const fromBlock = state.lastBlock + 1;
  const result = await watchPonsRange({
    provider: dependencies.provider,
    store: dependencies.store,
    fromBlock,
    toBlock: safeHead,
    now: dependencies.now,
    scanRange: dependencies.scanRange,
    readLaunch: dependencies.readLaunch,
  });
  state.lastBlock = safeHead;
  return { ...result, complete: true };
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
        const report = await handleCandidate(
          event,
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
      `candidate analysis failed: ${failures.map(({ event }) => event.token).join(", ")}`
    );
  }
  return reports;
}

async function watch() {
  const releaseLock = await acquireInstanceLock(DATA_DIR);
  const releaseOnExit = () => releaseLock();
  process.once("exit", releaseOnExit);
  try {
    banner();
    const provider = getProvider();
    const store = getDefaultStore();
    if (SETTINGS.onchainScan) {
      await verifyPonsDeployment(provider);
      await reconcilePonsWatchlist({ provider, store });
    }
    if (SETTINGS.telegramToken) {
      await sendTelegram(
        `🤖 Robinhood 扫链机器人已启动\n仅扫描和报警，不包含交易功能\n年龄 &lt; ${SETTINGS.maxAgeMinutes} 分钟 · 最低分 ${SETTINGS.minScore}`
      ).catch((error) => console.error("startup telegram:", safeErrorMessage(error)));
    }

    const state = { lastBlock: null, lastGecko: 0 };
    const ponsState = { lastBlock: null };
    const claimed = new Set();
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
        async (event) => {
          try {
            await handleCandidate(
              event,
              { persistSeen: true },
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
        }
      ));
    };
    const common = {
        now: Date.now,
        getBlockNumber,
        getOnchainCursor,
        findFirstBlockAtOrAfter,
        scanOnchain,
        setOnchainCursor,
        geckoNewPools,
        log: console.log,
    };
    const loops = [];
    if (SETTINGS.onchainScan) {
      loops.push((async () => {
        while (true) {
          const result = await runPonsWatchIteration(ponsState, {
            provider,
            store,
            settings: SETTINGS,
            getBlockNumber,
            findFirstBlockAtOrAfter,
            scanRange: scanPonsRange,
            readLaunch: readPonsLaunch,
            now: Date.now,
          });
          if (result.events.length) {
            console.log(`pons ${result.events.length} lifecycle events; cursor=${ponsState.lastBlock}`);
          }
          await sleep(SETTINGS.pollMs);
        }
      })());
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

async function scanOnce(supplied = null) {
  const dependencies = supplied || {
    settings: SETTINGS,
    getBlockNumber,
    findFirstBlockAtOrAfter,
    scanOnchain,
    geckoNewPools,
    analyze,
    consoleAlert: async (report) => {
      console.log(formatAlert(report).replace(/<[^>]+>/g, ""));
    },
    log: console.log,
  };
  const settings = dependencies.settings;
  banner();
  const sources = [];
  if (settings.onchainScan) {
    sources.push({
      name: "onchain",
      run: async () => {
        const latestHead = await dependencies.getBlockNumber();
        const head = latestHead - (settings.confirmationBlocks ?? 0);
        if (head < 0) return [];
        const from = await dependencies.findFirstBlockAtOrAfter(
          (dependencies.now || Date.now)() - settings.maxAgeMinutes * 60_000,
          head
        );
        dependencies.log(`one-shot read-only scan blocks ${from}-${head}`);
        return dependencies.scanOnchain(from, head);
      },
    });
  }
  if (settings.geckoScan) {
    sources.push({ name: "gecko", run: () => dependencies.geckoNewPools(3) });
  }

  const results = await Promise.allSettled(sources.map(({ run }) => run()));
  const sourceFailures = [];
  const discovered = { onchain: [], gecko: [] };
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
  dependencies.log(`candidates: onchain=${onchain.length} gecko=${gecko.length}`);
  let reports = [];
  let candidateFailure = null;
  try {
    reports = await runReadOnlyCandidates([...onchain, ...gecko], {
      maxQueueSize: settings.maxQueueSize,
      maxAgeMinutes: settings.maxAgeMinutes,
      minScore: settings.minScore,
      now: dependencies.now || Date.now,
      analyze: dependencies.analyze,
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
  return reports;
}

async function checkOne(token) {
  if (!token) throw new Error("usage: node src/index.js check 0xToken");
  const report = await analyze({
    source: "manual",
    venue: "unknown",
    pool: null,
    token,
    quote: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    createdAt: null,
  });
  const { formatAlert } = await import("./notify.js");
  console.log(formatAlert(report).replace(/<[^>]+>/g, ""));
  console.log(
    JSON.stringify(
      { score: report.score, verdict: report.verdict, red: report.red, facts: report.facts, meta: report.meta },
      null,
      2
    )
  );
}

function banner() {
  console.log("====================================================");
  console.log(" Robinhood Chain scanner");
  console.log(` ${CHAIN.name}  chainId=${CHAIN.id}`);
  console.log(` RPC ${sanitizeRpcUrl(CHAIN.rpc)}`);
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

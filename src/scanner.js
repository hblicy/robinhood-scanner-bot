import { SETTINGS, CHAIN, DATA_DIR } from "./config.js";
import { getOnchainCursor, hasSeen, markSeen, setOnchainCursor } from "./store.js";
import { findFirstBlockAtOrAfter, getBlockNumber, scanOnchain, sleep } from "./chain.js";
import { geckoNewPools } from "./market.js";
import { analyze } from "./analyze.js";
import { alertReport, formatAlert, sendTelegram } from "./notify.js";
import { CandidateQueue } from "./queue.js";
import { candidateKey, handleCandidate } from "./runtime.js";
import { safeErrorMessage, sanitizeRpcUrl } from "./safety.js";
import { acquireInstanceLock } from "./instance-lock.js";

const candidates = new CandidateQueue({
  maxSize: SETTINGS.maxQueueSize,
  hasSeen,
  keyOf: candidateKey,
});
let draining = false;

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
  let handled = 0;
  let failed = 0;
  try {
    while (candidates.size > 0) {
      const event = candidates.take();
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
        handled += 1;
      } catch (error) {
        failed += 1;
        console.error("handle failed", event.token, safeErrorMessage(error));
      } finally {
        candidates.finish(event);
      }
    }
  } finally {
    draining = false;
  }
  return { handled, failed };
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
  if (settings.onchainScan) {
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
            handleEvents: dependencies.handleEvents,
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
  }

  const currentTime = dependencies.now();
  if (settings.geckoScan && currentTime - state.lastGecko >= settings.geckoPollMs) {
    state.lastGecko = currentTime;
    try {
      const events = await dependencies.geckoNewPools(1);
      const result = await dependencies.handleEvents(events);
      if (result.accepted) {
        dependencies.log(`gecko: ${events.length} pools, ${result.accepted} new`);
      }
      if (result.failed) dependencies.log(`gecko: ${result.failed} candidates failed`);
    } catch (cause) {
      const error = new Error(`gecko watch failed: ${safeErrorMessage(cause)}`, { cause });
      errors.push(error);
      dependencies.log(error.message);
    }
  }
  return { state, errors };
}

export async function runReadOnlyCandidates(events, dependencies) {
  const queue = new CandidateQueue({
    maxSize: dependencies.maxQueueSize,
    hasSeen: () => false,
    keyOf: candidateKey,
  });
  const reports = [];
  const failures = [];
  const runDrain = async () => {
    let handled = 0;
    let failed = 0;
    while (queue.size > 0) {
      const event = queue.take();
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
        handled += 1;
      } catch (error) {
        failed += 1;
        failures.push({ event, error });
        dependencies.log(`handle failed ${event.token} ${safeErrorMessage(error)}`);
      } finally {
        queue.finish(event);
      }
    }
    return { handled, failed };
  };
  await processEvents(events, queue, runDrain);
  if (failures.length) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `candidate analysis failed: ${failures.map(({ event }) => event.token).join(", ")}`
    );
  }
  return reports;
}

async function watch() {
  const releaseLock = acquireInstanceLock(DATA_DIR);
  const releaseOnExit = () => releaseLock();
  process.once("exit", releaseOnExit);
  try {
    banner();
    if (SETTINGS.telegramToken) {
      await sendTelegram(
        `🤖 Robinhood 扫链机器人已启动\n仅扫描和报警，不包含交易功能\n年龄 &lt; ${SETTINGS.maxAgeMinutes} 分钟 · 最低分 ${SETTINGS.minScore}`
      ).catch((error) => console.error("startup telegram:", safeErrorMessage(error)));
    }

    const state = { lastBlock: null, lastGecko: 0 };

    while (true) {
      await runWatchIteration(state, {
        settings: SETTINGS,
        now: Date.now,
        getBlockNumber,
        getOnchainCursor,
        findFirstBlockAtOrAfter,
        scanOnchain,
        setOnchainCursor,
        geckoNewPools,
        handleEvents: (events) => processEvents(
          events,
          candidates,
          () => drain({ persistSeen: true })
        ),
        log: console.log,
      });
      await sleep(SETTINGS.pollMs);
    }
  } finally {
    process.removeListener("exit", releaseOnExit);
    releaseLock();
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

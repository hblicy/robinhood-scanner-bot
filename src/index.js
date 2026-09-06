import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS, CHAIN } from "./config.js";
import { getOnchainCursor, hasSeen, markSeen, setOnchainCursor } from "./store.js";
import { findFirstBlockAtOrAfter, getBlockNumber, scanOnchain, sleep } from "./chain.js";
import { geckoNewPools } from "./market.js";
import { analyze } from "./analyze.js";
import { alertReport, formatAlert, sendTelegram } from "./notify.js";
import { CandidateQueue } from "./queue.js";
import { candidateKey, handleCandidate } from "./runtime.js";
import { safeErrorMessage, sanitizeRpcUrl } from "./safety.js";

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

export async function runReadOnlyCandidates(events, dependencies) {
  const queue = new CandidateQueue({
    maxSize: dependencies.maxQueueSize,
    hasSeen: () => false,
    keyOf: candidateKey,
  });
  const reports = [];
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
        dependencies.log(`handle failed ${event.token} ${safeErrorMessage(error)}`);
      } finally {
        queue.finish(event);
      }
    }
    return { handled, failed };
  };
  await processEvents(events, queue, runDrain);
  return reports;
}

async function watch() {
  banner();
  if (SETTINGS.telegramToken) {
    await sendTelegram(
      `🤖 Robinhood 扫链机器人已启动\n仅扫描和报警，不包含交易功能\n年龄 &lt; ${SETTINGS.maxAgeMinutes} 分钟 · 最低分 ${SETTINGS.minScore}`
    ).catch((error) => console.error("startup telegram:", safeErrorMessage(error)));
  }

  const initialHead = await getBlockNumber();
  let lastBlock = await initialOnchainCursor({
    head: initialHead,
    savedCursor: getOnchainCursor(),
    maxAgeMinutes: SETTINGS.maxAgeMinutes,
    now: Date.now,
    findFirstBlockAtOrAfter,
  });
  let lastGecko = 0;

  while (true) {
    try {
      const head = await getBlockNumber();
      if (SETTINGS.onchainScan && head > lastBlock) {
        const from = lastBlock + 1;
        const result = await processOnchainRange(
          { from, head },
          {
            scanOnchain,
            handleEvents: (events) => processEvents(
              events,
              candidates,
              () => drain({ persistSeen: true })
            ),
            setOnchainCursor,
          }
        );
        if (result.events.length) {
          console.log(
            `onchain ${from}-${head}: ${result.events.length} pools, ${result.accepted} new`
          );
        }
        if (result.complete) lastBlock = head;
        else console.warn(`onchain ${from}-${head}: ${result.failed} failed; cursor not advanced`);
      }
      if (SETTINGS.geckoScan && Date.now() - lastGecko >= SETTINGS.geckoPollMs) {
        lastGecko = Date.now();
        const events = await geckoNewPools(1).catch((error) => {
          console.error("gecko", safeErrorMessage(error));
          return [];
        });
        const result = await processEvents(events, candidates, () => drain({ persistSeen: true }));
        if (result.accepted) {
          console.log(`gecko: ${events.length} pools, ${result.accepted} new`);
        }
      }
      await drain({ persistSeen: true });
    } catch (error) {
      console.error("watch loop", safeErrorMessage(error));
    }
    await sleep(SETTINGS.pollMs);
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
  const head = await dependencies.getBlockNumber();
  const from = settings.onchainScan
    ? await dependencies.findFirstBlockAtOrAfter(
        (dependencies.now || Date.now)() - settings.maxAgeMinutes * 60_000,
        head
      )
    : head;
  dependencies.log(`one-shot read-only scan blocks ${from}-${head} + gecko new_pools`);
  const [onchain, gecko] = await Promise.all([
    settings.onchainScan
      ? dependencies.scanOnchain(from, head).catch((error) => {
          dependencies.log(safeErrorMessage(error));
          return [];
        })
      : [],
    settings.geckoScan
      ? dependencies.geckoNewPools(3).catch((error) => {
          dependencies.log(safeErrorMessage(error));
          return [];
        })
      : [],
  ]);
  dependencies.log(`candidates: onchain=${onchain.length} gecko=${gecko.length}`);
  return runReadOnlyCandidates([...onchain, ...gecko], {
    maxQueueSize: settings.maxQueueSize,
    maxAgeMinutes: settings.maxAgeMinutes,
    minScore: settings.minScore,
    now: dependencies.now || Date.now,
    analyze: dependencies.analyze,
    consoleAlert: dependencies.consoleAlert,
    log: dependencies.log,
  });
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

export function assertSupportedCommand(command) {
  if (!["watch", "scan", "check"].includes(command)) {
    throw new Error("commands: watch | scan | check <token>");
  }
  return command;
}

async function main() {
  const command = assertSupportedCommand(process.argv[2] || "watch");
  const argument = process.argv[3];
  if (command === "watch") {
    await watch();
  } else if (command === "scan") {
    await scanOnce();
  } else if (command === "check") {
    await checkOne(argument);
  }
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}

export { banner, checkOne, drain, enqueue, main, scanOnce, watch };

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS, CHAIN } from "./config.js";
import { hasSeen, markSeen } from "./store.js";
import { getBlockNumber, scanOnchain, sleep } from "./chain.js";
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
  if (draining) return;
  draining = true;
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
      } catch (error) {
        console.error("handle failed", event.token, safeErrorMessage(error));
      } finally {
        candidates.finish(event);
      }
    }
  } finally {
    draining = false;
  }
}

export async function processEvents(events, queue, runDrain) {
  let accepted = 0;
  for (const event of events) {
    if (queue.isFull) await runDrain();
    if (queue.enqueue(event)) accepted += 1;
  }
  await runDrain();
  return accepted;
}

export async function runReadOnlyCandidates(events, dependencies) {
  const queue = new CandidateQueue({
    maxSize: dependencies.maxQueueSize,
    hasSeen: () => false,
    keyOf: candidateKey,
  });
  const reports = [];
  const runDrain = async () => {
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
      } catch (error) {
        dependencies.log(`handle failed ${event.token} ${safeErrorMessage(error)}`);
      } finally {
        queue.finish(event);
      }
    }
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

  let lastBlock = Math.max(0, (await getBlockNumber()) - SETTINGS.lookbackBlocks);
  let lastGecko = 0;

  while (true) {
    try {
      const head = await getBlockNumber();
      if (SETTINGS.onchainScan && head > lastBlock) {
        const from = lastBlock + 1;
        const events = await scanOnchain(from, head);
        const accepted = await processEvents(events, candidates, () => drain({ persistSeen: true }));
        if (events.length) console.log(`onchain ${from}-${head}: ${events.length} pools, ${accepted} new`);
        lastBlock = head;
      }
      if (SETTINGS.geckoScan && Date.now() - lastGecko >= SETTINGS.geckoPollMs) {
        lastGecko = Date.now();
        const events = await geckoNewPools(1).catch((error) => {
          console.error("gecko", safeErrorMessage(error));
          return [];
        });
        const accepted = await processEvents(events, candidates, () => drain({ persistSeen: true }));
        if (accepted) console.log(`gecko: ${events.length} pools, ${accepted} new`);
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
  const from = Math.max(0, head - Math.max(settings.lookbackBlocks, 800));
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

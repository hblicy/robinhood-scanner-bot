import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS, CHAIN, liveTradingAllowed } from "./config.js";
import { hasSeen, listPositions, markSeen } from "./store.js";
import { getBlockNumber, scanOnchain, sleep } from "./chain.js";
import { geckoNewPools } from "./market.js";
import { analyze } from "./analyze.js";
import { alertReport, sendTelegram } from "./notify.js";
import { createSingleFlightTick, maybeTrade, tickPositions } from "./trade.js";
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

async function drain({ allowTrading, persistSeen = true }) {
  if (draining) return;
  draining = true;
  try {
    while (candidates.size > 0) {
      const event = candidates.take();
      try {
        await handleCandidate(
          event,
          { allowTrading, persistSeen, tradeMode: SETTINGS.mode },
          {
            now: Date.now,
            maxAgeMinutes: SETTINGS.maxAgeMinutes,
            minScore: SETTINGS.minScore,
            analyze,
            markSeen,
            alertReport,
            maybeTrade,
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

async function reportReviewPositions() {
  const review = listPositions().filter((position) =>
    ["needs_review", "buy_pending", "exit_pending"].includes(position.state)
  );
  if (!review.length) return;
  const tokens = review.map((position) => position.token).join(", ");
  console.warn(`${review.length} position(s) require manual review: ${tokens}`);
  await sendTelegram(
    `⚠️ ${review.length} 个旧仓位缺少可验证数量/路径，已禁止自动处理：\n${tokens}`
  ).catch((error) => console.error("position review telegram", safeErrorMessage(error)));
}

async function watch({ allowTrading }) {
  banner({ allowTrading });
  await reportReviewPositions();
  if (SETTINGS.telegramToken) {
    await sendTelegram(
      `🤖 Robinhood 扫链机器人已启动\n模式 <b>${SETTINGS.mode}</b>\n自动买入: ${liveTradingAllowed() && allowTrading ? "ON（高风险）" : "OFF"}\n年龄 &lt; ${SETTINGS.maxAgeMinutes} 分钟 · 最低分 ${SETTINGS.minScore}`
    ).catch((error) => console.error("startup telegram:", safeErrorMessage(error)));
  }

  let lastBlock = Math.max(0, (await getBlockNumber()) - SETTINGS.lookbackBlocks);
  let lastGecko = 0;

  if (SETTINGS.mode === "paper" || SETTINGS.mode === "live") {
    const runPositionTick = createSingleFlightTick(tickPositions);
    setInterval(() => {
      runPositionTick().catch((error) => console.error("positions", safeErrorMessage(error)));
    }, SETTINGS.positionPollMs);
  }

  while (true) {
    try {
      const head = await getBlockNumber();
      if (SETTINGS.onchainScan && head > lastBlock) {
        const from = lastBlock + 1;
        const events = await scanOnchain(from, head);
        let accepted = 0;
        for (const event of events) if (enqueue(event)) accepted += 1;
        if (events.length) console.log(`onchain ${from}-${head}: ${events.length} pools, ${accepted} new`);
        lastBlock = head;
      }
      if (SETTINGS.geckoScan && Date.now() - lastGecko >= SETTINGS.geckoPollMs) {
        lastGecko = Date.now();
        const events = await geckoNewPools(1).catch((error) => {
          console.error("gecko", safeErrorMessage(error));
          return [];
        });
        let accepted = 0;
        for (const event of events) if (enqueue(event)) accepted += 1;
        if (accepted) console.log(`gecko: ${events.length} pools, ${accepted} new`);
      }
      await drain({ allowTrading, persistSeen: true });
    } catch (error) {
      console.error("watch loop", safeErrorMessage(error));
    }
    await sleep(SETTINGS.pollMs);
  }
}

async function scanOnce() {
  banner({ allowTrading: false });
  const head = await getBlockNumber();
  const from = Math.max(0, head - Math.max(SETTINGS.lookbackBlocks, 800));
  console.log(`one-shot read-only scan blocks ${from}-${head} + gecko new_pools`);
  const [onchain, gecko] = await Promise.all([
    SETTINGS.onchainScan
      ? scanOnchain(from, head).catch((error) => {
          console.error(safeErrorMessage(error));
          return [];
        })
      : [],
    SETTINGS.geckoScan
      ? geckoNewPools(3).catch((error) => {
          console.error(safeErrorMessage(error));
          return [];
        })
      : [],
  ]);
  console.log(`candidates: onchain=${onchain.length} gecko=${gecko.length}`);
  for (const event of [...onchain, ...gecko]) enqueue(event);
  await drain({ allowTrading: false, persistSeen: false });
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

function banner({ allowTrading }) {
  console.log("====================================================");
  console.log(" Robinhood Chain scanner");
  console.log(` ${CHAIN.name}  chainId=${CHAIN.id}`);
  console.log(` RPC ${sanitizeRpcUrl(CHAIN.rpc)}`);
  console.log(` mode=${SETTINGS.mode}  liveTrading=${allowTrading && liveTradingAllowed()}`);
  console.log(` maxAge=${SETTINGS.maxAgeMinutes}m  minScore=${SETTINGS.minScore}`);
  console.log(" Real swaps require the explicit live command and complete security checks.");
  console.log(" This is not financial advice. Most memecoins go to zero.");
  console.log("====================================================");
}

async function main() {
  const command = process.argv[2] || "watch";
  const argument = process.argv[3];
  if (command === "watch") {
    SETTINGS.mode = "watch";
    await watch({ allowTrading: false });
  } else if (command === "paper") {
    SETTINGS.mode = "paper";
    await watch({ allowTrading: true });
  } else if (command === "live") {
    SETTINGS.mode = "live";
    await watch({ allowTrading: true });
  } else if (command === "scan") {
    SETTINGS.mode = "watch";
    await scanOnce();
  } else if (command === "check") {
    SETTINGS.mode = "watch";
    await checkOne(argument);
  } else {
    throw new Error("commands: watch | scan | check <token> | paper | live");
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

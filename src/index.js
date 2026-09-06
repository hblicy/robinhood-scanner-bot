import { SETTINGS, CHAIN, liveTradingAllowed } from "./config.js";
import { hasSeen, markSeen } from "./store.js";
import { getBlockNumber, scanOnchain, sleep } from "./chain.js";
import { geckoNewPools } from "./market.js";
import { analyze } from "./analyze.js";
import { alertReport, sendTelegram } from "./notify.js";
import { maybeTrade, tickPositions } from "./trade.js";

const queue = [];
const queued = new Set();
let busy = false;

function enqueue(event) {
  const key = event.token.toLowerCase();
  if (queued.has(key) || hasSeen(key)) return false;
  queued.add(key);
  queue.push(event);
  return true;
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const event = queue.shift();
      try {
        await handle(event);
      } catch (err) {
        console.error("handle failed", event.token, err.message);
      }
    }
  } finally {
    busy = false;
  }
}

async function handle(event) {
  const ageMin = event.createdAt ? (Date.now() - event.createdAt) / 60000 : 0;
  if (ageMin > SETTINGS.maxAgeMinutes * 2) {
    markSeen(event.token, { skipped: "too-old", ageMin });
    return;
  }
  console.log(`analyzing ${event.token} via ${event.source}/${event.venue}`);
  const report = await analyze(event);
  markSeen(event.token, {
    symbol: report.meta.symbol,
    score: report.score,
    verdict: report.verdict,
    venue: report.venue,
  });
  const shouldAlert =
    report.verdict === "green" ||
    report.verdict === "review" ||
    report.honeypot?.honeypot === true ||
    report.score >= SETTINGS.minScore;
  if (shouldAlert) await alertReport(report);
  else {
    console.log(`quiet skip ${report.meta.symbol} ${report.score}/100 ${report.verdict}`);
  }
  if (report.verdict === "green") await maybeTrade(report);
}

async function watch() {
  banner();
  if (SETTINGS.telegramToken) {
    await sendTelegram(
      `🤖 Robinhood 扫链机器人已启动\n模式 <b>${SETTINGS.mode}</b>\n自动买入: ${liveTradingAllowed() ? "ON（高风险）" : "OFF"}\n年龄 &lt; ${SETTINGS.maxAgeMinutes} 分钟 · 最低分 ${SETTINGS.minScore}`
    ).catch((err) => console.error("startup telegram:", err.message));
  }

  let lastBlock = Math.max(0, (await getBlockNumber()) - SETTINGS.lookbackBlocks);
  let lastGecko = 0;

  if (SETTINGS.mode === "paper" || SETTINGS.mode === "live") {
    setInterval(() => {
      tickPositions().catch((err) => console.error("positions", err.message));
    }, SETTINGS.positionPollMs);
  }

  while (true) {
    try {
      const head = await getBlockNumber();
      if (SETTINGS.onchainScan && head > lastBlock) {
        const from = lastBlock + 1;
        const to = head;
        const events = await scanOnchain(from, to);
        let n = 0;
        for (const e of events) if (enqueue(e)) n += 1;
        if (events.length) console.log(`onchain ${from}-${to}: ${events.length} pools, ${n} new`);
        lastBlock = to;
      }
      if (SETTINGS.geckoScan && Date.now() - lastGecko >= SETTINGS.geckoPollMs) {
        lastGecko = Date.now();
        const events = await geckoNewPools(1).catch((err) => {
          console.error("gecko", err.message);
          return [];
        });
        let n = 0;
        for (const e of events) if (enqueue(e)) n += 1;
        if (n) console.log(`gecko: ${events.length} pools, ${n} new`);
      }
      await drain();
    } catch (err) {
      console.error("watch loop", err.message);
    }
    await sleep(SETTINGS.pollMs);
  }
}

async function scanOnce() {
  banner();
  const head = await getBlockNumber();
  const from = Math.max(0, head - Math.max(SETTINGS.lookbackBlocks, 800));
  console.log(`one-shot scan blocks ${from}-${head} + gecko new_pools`);
  const [onchain, gecko] = await Promise.all([
    SETTINGS.onchainScan ? scanOnchain(from, head).catch((e) => {
      console.error(e.message);
      return [];
    }) : [],
    SETTINGS.geckoScan ? geckoNewPools(3).catch((e) => {
      console.error(e.message);
      return [];
    }) : [],
  ]);
  const all = [...onchain, ...gecko];
  console.log(`candidates: onchain=${onchain.length} gecko=${gecko.length}`);
  for (const e of all) enqueue(e);
  await drain();
}

async function checkOne(token) {
  if (!token) {
    console.error("usage: node src/index.js check 0xToken");
    process.exit(1);
  }
  const report = await analyze({
    source: "manual",
    venue: "unknown",
    pool: null,
    token,
    quote: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    createdAt: Date.now(),
  });
  const { formatAlert } = await import("./notify.js");
  console.log(formatAlert(report).replace(/<[^>]+>/g, ""));
  console.log(JSON.stringify({ score: report.score, verdict: report.verdict, red: report.red, facts: report.facts, meta: report.meta }, null, 2));
}

function banner() {
  console.log("====================================================");
  console.log(" Robinhood Chain scanner");
  console.log(` ${CHAIN.name}  chainId=${CHAIN.id}`);
  console.log(` RPC ${CHAIN.rpc}`);
  console.log(` mode=${SETTINGS.mode}  liveTrading=${liveTradingAllowed()}`);
  console.log(` maxAge=${SETTINGS.maxAgeMinutes}m  minScore=${SETTINGS.minScore}`);
  console.log(" Auto-buy is OFF unless MODE=live AND ENABLE_LIVE_TRADING=true");
  console.log(" This is not financial advice. Most memecoins go to zero.");
  console.log("====================================================");
}

const cmd = process.argv[2] || "watch";
const arg = process.argv[3];

if (cmd === "watch" || cmd === "paper" || cmd === "live") {
  if (cmd !== "watch") SETTINGS.mode = cmd;
  watch().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === "scan") {
  scanOnce().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (cmd === "check") {
  checkOne(arg).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.log("commands: watch | scan | check <token> | paper");
  process.exit(1);
}

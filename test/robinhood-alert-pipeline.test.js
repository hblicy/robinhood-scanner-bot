import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Interface } from "ethers";
import { createApp } from "../src/app.js";
import { V2_FACTORY_ABI } from "../src/abis.js";
import { EVM_PROFILES } from "../src/chains/evm-profiles.js";
import { geckoNewPools } from "../src/market.js";
import {
  buildWatchCandidateDependencies,
  createScanRuntime,
  createWatchRuntime,
  createWatchSourceProcessor,
  createCandidateRecoveryHandler,
  createCandidateRecoveryScheduler,
  createCandidateRecheckHandler,
  processWatchCandidate,
  runPendingChecks,
  runWatchIteration,
} from "../src/scanner.js";
import { createSerialExecutor } from "../src/queue.js";
import { formatAlert, sendTelegramWith } from "../src/notify.js";
import { candidateKey } from "../src/core/candidate.js";
import { createCandidateRecovery } from "../src/candidate-recovery.js";

const roots = [];
const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = "0x3333333333333333333333333333333333333333";
const profile = EVM_PROFILES.robinhood;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(logs = []) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-pipeline-"));
  roots.push(projectRoot);
  const now = Math.floor(Date.now() / 1000) * 1000;
  const filters = [];
  const analyzed = [];
  const sent = [];
  const provider = {
    getBlock: async () => ({ timestamp: now / 1000 - 30 }),
    getLogs: async (filter) => {
      filters.push(filter);
      const addresses = [].concat(filter.address).map((address) => address.toLowerCase());
      const topics = [].concat(filter.topics[0]).map((topic) => topic.toLowerCase());
      return logs.filter((log) => addresses.includes(log.address.toLowerCase())
        && topics.includes(log.topics[0].toLowerCase())
        && log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock);
    },
  };
  const app = createApp({
    chainKey: "robinhood",
    env: {},
    dependencies: {
      projectRoot,
      createRpcContext: () => ({
        analysisProvider: provider,
        discoveryPrimary: provider,
        discoverySessions: { run: (work) => work(provider) },
      }),
      services: {
        analyze: async (event) => {
          analyzed.push(event);
          return {
            ...event,
            meta: { symbol: "TEST" },
            score: 80,
            verdict: "green",
            honeypot: { honeypot: false },
            sellability: { status: "confirmed", buyerSamples: 1, ladderSamples: 1, meaningfulSellers: 3 },
          };
        },
        alertReport: async (report) => { sent.push(report); return true; },
      },
    },
  });
  const runtime = createWatchRuntime({ config: app.config });
  const candidateDependencies = buildWatchCandidateDependencies({
    ...runtime,
    now: () => now,
    log: () => {},
    supportsSellability: runtime.supportsSellability,
  });
  const process = (event) => processWatchCandidate(event, {
    classifyCandidate: async (value) => ({ ...value, identity: "not_pons" }),
    candidateDependencies,
  });
  return { app, runtime, candidateDependencies, process, analyzed, sent, filters, provider, now };
}

function v2Log() {
  const encoded = new Interface(V2_FACTORY_ABI).encodeEventLog("PairCreated", [
    TOKEN, profile.wrappedNative, POOL, 1n,
  ]);
  return {
    ...encoded,
    address: profile.venues[0].contracts.factory,
    blockNumber: 100,
    transactionHash: `0x${"ab".repeat(32)}`,
    index: 1,
  };
}

test("configured Robinhood V2 discovery reaches analysis and Telegram admission in watch and scan", async () => {
  const setupResult = setup([v2Log()]);
  const { app, runtime, provider, process, analyzed, sent } = setupResult;
  const events = await runtime.rpc.onchain.scanOnchain(100, 100, provider);
  assert.equal(events.length, 1);
  assert.equal(events[0].chain, "robinhood");
  assert.equal(events[0].venue, "uniswap-v2-robinhood");
  assert.equal(events[0].quote, profile.wrappedNative);
  await process(events[0]);
  assert.equal(analyzed.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(Object.values(app.config.store.snapshot().seen)[0].skipped, undefined);
  const scan = createScanRuntime({ config: app.config });
  const scanEvents = await scan.scanOnchain(100, 100, { provider });
  assert.equal(scanEvents[0].venue, events[0].venue);
  assert.equal(scan.supportsSellability(scanEvents[0]), true);
});

test("configured Robinhood watch queries and analyzes the verified O1 Launched fixture", async () => {
  const log = JSON.parse(fs.readFileSync(new URL("./fixtures/evm/o1-token-launched.json", import.meta.url), "utf8"));
  log.blockNumber = 100;
  const { runtime, provider, process, analyzed, sent, filters } = setup([log]);
  const events = await runtime.rpc.onchain.scanOnchain(100, 100, provider);
  assert.equal(events.length, 1);
  assert.equal(events[0].venue, "o1-v4-robinhood");
  assert.equal(events[0].metadata.poolResolved, true);
  assert.equal(events[0].referenceAssetKind, "stock");
  assert.equal(events[0].blockNumber, 100);
  assert.equal(events[0].txHash, log.transactionHash);
  assert.ok(filters.some((filter) => [].concat(filter.address).includes(profile.venues[1].contracts.factory)));
  await process(events[0]);
  assert.equal(analyzed.length, 1);
  assert.equal(sent.length, 1);
});

for (const venue of ["uniswap-v2", "uniswap-v2-robinhood"]) {
  test(`Gecko ${venue} uses the same canonical Robinhood security route`, async () => {
    const { app, runtime, process, analyzed, sent, now } = setup();
    const events = await geckoNewPools(1, {
      ...runtime.geckoOptions,
      now: () => now,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ data: [{
          attributes: { address: POOL, pool_created_at: new Date(now - 30_000).toISOString() },
          relationships: {
            base_token: { data: { id: `robinhood_${TOKEN}` } },
            quote_token: { data: { id: `robinhood_${profile.wrappedNative}` } },
            dex: { data: { id: venue } },
          },
        }] }),
      }),
    });
    assert.equal(events[0].chain, "robinhood");
    assert.equal(app.config.securityRegistry.supports(events[0]), true);
    await process(events[0]);
    assert.equal(analyzed.length, 1);
    assert.equal(sent.length, 1);
  });
}

test("disabled Robinhood venues remain silent after discovery wiring changes", async () => {
  const { process, analyzed, sent } = setup();
  await process({ chain: "robinhood", venue: "long-robinhood", token: TOKEN, pool: POOL, source: "gecko" });
  assert.equal(analyzed.length, 0);
  assert.equal(sent.length, 0);
});

test("an undelivered alert is durably deferred without stalling discovery, then delivered on recovery", async () => {
  const { app, runtime, candidateDependencies, now } = setup([v2Log()]);
  const store = app.config.store;
  let currentTime = now;
  let delivered = 0;
  let requests = 0;
  const errors = [];
  candidateDependencies.now = () => currentTime;
  candidateDependencies.alertReport = () => sendTelegramWith("test alert", {
    settings: { telegramToken: "", telegramChat: "" },
    log: () => {},
    fetchImpl: async () => { requests += 1; throw new Error("must not send without credentials"); },
  });
  const classifyCandidate = async (event) => ({ ...event, identity: "not_pons" });
  const executeCandidate = createSerialExecutor();
  const recoveryKeys = new Set();
  const handleEvents = createWatchSourceProcessor({
    maxQueueSize: 10,
    hasSeen: store.hasSeen,
    claimed: new Set(),
    recoveryKeys,
    executeCandidate,
    classifyCandidate,
    candidateDependencies,
    scheduleRecovery: createCandidateRecoveryScheduler({ store, recoveryKeys, now: () => currentTime }),
    logError: (message) => errors.push(message),
  });
  store.setOnchainCursor(99);
  await runWatchIteration({ lastBlock: 99, lastGecko: 0 }, {
    ...runtime.rpc.onchain,
    settings: { ...runtime.settings, onchainScan: true, geckoScan: false, confirmationBlocks: 2 },
    now: () => currentTime,
    getBlockNumber: async () => 102,
    getOnchainCursor: store.getOnchainCursor,
    setOnchainCursor: store.setOnchainCursor,
    handleEvents,
    log: () => {},
  });
  assert.equal(requests, 0);
  assert.equal(store.getOnchainCursor(), 100);
  assert.equal(Object.keys(store.snapshot().seen).length, 0);
  const check = Object.values(store.snapshot().pendingChecks)[0];
  assert.equal(check.type, "candidate_recovery");
  assert.equal(check.status, "pending");
  assert.match(check.lastError, /not delivered/);
  assert.ok(errors.some((message) => message.includes("candidate deferred")));
  candidateDependencies.alertReport = async () => { delivered += 1; return true; };
  currentTime = check.nextAttemptAt;
  const result = await runPendingChecks({
    store,
    now: () => currentTime,
    handlers: {
      candidate_recovery: createCandidateRecoveryHandler({ executeCandidate, classifyCandidate, candidateDependencies }),
    },
  });
  assert.equal(result.completed, 1);
  assert.equal(delivered, 1);
  assert.equal(store.hasSeen(candidateKey(check.event)), true);
});

for (const status of [429, 500]) {
  test(`Telegram HTTP ${status} reschedules Robinhood recovery and stays bounded`, async () => {
    const { app, runtime, provider, candidateDependencies, now } = setup([v2Log()]);
    const [event] = await runtime.rpc.onchain.scanOnchain(100, 100, provider);
    const store = app.config.store;
    const check = store.scheduleCheck(createCandidateRecovery(event, now, new Error("initial failure")));
    let currentTime = check.nextAttemptAt;
    let requests = 0;
    candidateDependencies.now = () => currentTime;
    candidateDependencies.alertReport = () => sendTelegramWith("test alert", {
      settings: { telegramToken: "dummy", telegramChat: "dummy" },
      fetchImpl: async () => { requests++; return { ok: false, status }; },
      sleep: async () => {}, log: () => {},
    });
    const handler = createCandidateRecoveryHandler({
      executeCandidate: (work) => work(),
      classifyCandidate: async (value) => ({ ...value, identity: "not_pons" }),
      candidateDependencies,
    });
    for (let attempt = 1; attempt <= check.maxAttempts; attempt++) {
      const result = await runPendingChecks({ store, now: () => currentTime, handlers: { candidate_recovery: handler } });
      const saved = store.snapshot().pendingChecks[check.id];
      assert.equal(saved.attempts, attempt);
      assert.equal(saved.status, attempt === check.maxAttempts ? "failed" : "pending");
      assert.equal(result.completed, 0);
      assert.match(saved.lastError, new RegExp(`telegram ${status}`));
      currentTime = saved.nextAttemptAt;
    }
    assert.equal(requests, 3 * check.maxAttempts);
    assert.equal(store.hasSeen(candidateKey(event)), false);
  });
}

for (const pathKind of ["discovery", "recovery"]) {
  test(`a long token name is delivered without blocking Robinhood ${pathKind}`, async () => {
    const { app, runtime, provider, candidateDependencies, now } = setup([v2Log()]);
    const store = app.config.store;
    const [event] = await runtime.rpc.onchain.scanOnchain(100, 100, provider);
    const analyze = candidateDependencies.analyze;
    candidateDependencies.analyze = async (candidate) => ({
      ...await analyze(candidate),
      meta: { name: "A".repeat(5000), symbol: "😀<&>".repeat(5000) },
      facts: { ageMinutes: 1 }, red: [], checks: [], links: {},
    });
    let requests = 0;
    let delivered = 0;
    candidateDependencies.alertReport = (report) => sendTelegramWith(formatAlert(report), {
      settings: { telegramToken: "dummy", telegramChat: "dummy" },
      fetchImpl: async (_url, { body }) => {
        requests++;
        const { text } = JSON.parse(body);
        const tooLong = text.replace(/<[^>]+>/g, "")
          .replace(/&(?:amp|lt|gt|quot|#39);/g, "x").length > 4096;
        if (!tooLong) delivered++;
        return { ok: !tooLong, status: tooLong ? 400 : 200 };
      }, sleep: async () => {}, log: () => {},
    });
    const classifyCandidate = async (value) => ({ ...value, identity: "not_pons" });
    const executeCandidate = createSerialExecutor();
    if (pathKind === "recovery") {
      const check = store.scheduleCheck(createCandidateRecovery(event, now, new Error("initial failure")));
      candidateDependencies.now = () => check.nextAttemptAt;
      const result = await runPendingChecks({
        store, now: () => check.nextAttemptAt,
        handlers: { candidate_recovery: createCandidateRecoveryHandler({
          executeCandidate, classifyCandidate, candidateDependencies,
        }) },
      });
      assert.equal(result.completed, 1);
      assert.equal(result.retried, 0);
      assert.equal(store.snapshot().pendingChecks[check.id].status, "completed");
    } else {
      const recoveryKeys = new Set();
      const handleEvents = createWatchSourceProcessor({
        maxQueueSize: 10, hasSeen: store.hasSeen, claimed: new Set(), recoveryKeys,
        executeCandidate, classifyCandidate, candidateDependencies,
        scheduleRecovery: createCandidateRecoveryScheduler({ store, recoveryKeys, now: () => now }),
        logError: () => {},
      });
      store.setOnchainCursor(99);
      await runWatchIteration({ lastBlock: 99, lastGecko: 0 }, {
        ...runtime.rpc.onchain,
        settings: { ...runtime.settings, onchainScan: true, geckoScan: false, confirmationBlocks: 2 },
        now: () => now, getBlockNumber: async () => 102,
        getOnchainCursor: store.getOnchainCursor, setOnchainCursor: store.setOnchainCursor,
        handleEvents, log: () => {},
      });
      assert.equal(store.getOnchainCursor(), 100);
      assert.equal(Object.keys(store.snapshot().pendingChecks).length, 0);
    }
    assert.equal(requests, 1);
    assert.equal(delivered, 1);
    assert.equal(store.hasSeen(candidateKey(event)), true);
  });
}

test("an undelivered Robinhood recheck does not complete as a successful alert", async () => {
  const { candidateDependencies, now } = setup();
  const handler = createCandidateRecheckHandler({
    executeCandidate: (work) => work(), now: () => now,
    analyze: candidateDependencies.analyze,
    alertReport: async () => false,
  });
  await assert.rejects(() => handler({ id: "recheck", event: {
    token: TOKEN, venue: "uniswap-v2-robinhood", pool: POOL, source: "onchain", createdAt: now,
  } }), (error) => error.code === "RETRYABLE_CANDIDATE");
});

test("Telegram request deadlines reschedule Robinhood recovery until bounded exhaustion", async () => {
  const { app, runtime, provider, candidateDependencies, now } = setup([v2Log()]);
  const [event] = await runtime.rpc.onchain.scanOnchain(100, 100, provider);
  const store = app.config.store;
  const check = store.scheduleCheck(createCandidateRecovery(event, now, new Error("initial failure")));
  let currentTime = check.nextAttemptAt;
  let requests = 0;
  candidateDependencies.now = () => currentTime;
  candidateDependencies.alertReport = () => sendTelegramWith("test alert", {
    settings: { telegramToken: "dummy", telegramChat: "dummy" }, timeoutMs: 1,
    fetchImpl: async (_url, { signal }) => {
      requests++;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }, sleep: async () => {}, log: () => {},
  });
  const handler = createCandidateRecoveryHandler({
    executeCandidate: (work) => work(),
    classifyCandidate: async (value) => ({ ...value, identity: "not_pons" }), candidateDependencies,
  });
  for (let attempt = 1; attempt <= check.maxAttempts; attempt++) {
    const result = await runPendingChecks({ store, now: () => currentTime, handlers: { candidate_recovery: handler } });
    const saved = store.snapshot().pendingChecks[check.id];
    assert.equal(saved.attempts, attempt);
    assert.equal(saved.status, attempt === check.maxAttempts ? "failed" : "pending");
    assert.equal(result.completed, 0);
    assert.match(saved.lastError, /timed out/);
    currentTime = saved.nextAttemptAt;
  }
  assert.equal(requests, 3 * check.maxAttempts);
  assert.equal(store.hasSeen(candidateKey(event)), false);
});

for (const scenario of ["unknown", "low-score", "shadow", "recovery", "too-old"]) {
  test(`the configured Robinhood pipeline still keeps ${scenario} candidates silent`, async () => {
    const { runtime, provider, process, candidateDependencies, sent, now } = setup([v2Log()]);
    const [event] = await runtime.rpc.onchain.scanOnchain(100, 100, provider);
    if (scenario === "shadow" || scenario === "recovery") candidateDependencies.mode = scenario;
    const analyze = candidateDependencies.analyze;
    candidateDependencies.analyze = async (candidate) => {
      const report = await analyze(candidate);
      if (scenario === "unknown") report.sellability = { status: "unknown", reason: "insufficient-meaningful-sells" };
      if (scenario === "low-score") report.score = candidateDependencies.minScore - 1;
      return report;
    };
    await process(scenario === "too-old" ? { ...event, createdAt: now - 31 * 60_000 } : event);
    assert.equal(sent.length, 0);
  });
}

test("a canonical Robinhood venue does not authorize another chain's security evidence", async () => {
  const { runtime, provider, process, analyzed } = setup([v2Log()]);
  const [event] = await runtime.rpc.onchain.scanOnchain(100, 100, provider);
  await process({ ...event, chain: "base" });
  assert.equal(analyzed.length, 0);
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCandidateRecheckHandler,
  createCandidateRetryScheduler,
  createWatchRpcBindings,
  initialOnchainCursor,
  processEvents,
  processOnchainRange,
  runReadOnlyCandidates,
  runWatchIteration,
  scanOnce,
} from "../src/scanner.js";
import { CandidateQueue, createSerialExecutor } from "../src/queue.js";
import { candidateKey } from "../src/runtime.js";

const CONFIRMED_SELLABILITY = {
  status: "confirmed",
  reason: "sellable",
  buyerSamples: 1,
  ladderSamples: 1,
  meaningfulSellers: 3,
};

function watchCandidateEvent(overrides = {}) {
  return {
    chain: "robinhood",
    token: "0x1000000000000000000000000000000000000001",
    pool: "0x2000000000000000000000000000000000000002",
    source: "onchain",
    venue: "uniswap-v2",
    createdAt: 1_000,
    observedAt: 2_000,
    ...overrides,
  };
}

function watchCandidateReport(event, overrides = {}) {
  return {
    ...event,
    score: 80,
    verdict: "review",
    meta: { symbol: "TEST" },
    honeypot: { honeypot: false },
    sellability: CONFIRMED_SELLABILITY,
    ...overrides,
  };
}

function watchCandidateDependencies(overrides = {}) {
  return {
    now: () => 2_000,
    maxAgeMinutes: 30,
    minScore: 70,
    mode: "live",
    analyze: async (event) => watchCandidateReport(event),
    markSeen: () => {},
    alertReport: async () => {},
    log: () => {},
    ...overrides,
  };
}

describe("scanner orchestration", () => {
  it("executes classify, analyze and markSeen through the live candidate path", async () => {
    const scanner = await import("../src/scanner.js");
    assert.equal(typeof scanner.processWatchCandidate, "function");
    const calls = [];
    const event = {
      chain: "robinhood",
      token: "0x1000000000000000000000000000000000000001",
      pool: "0x2000000000000000000000000000000000000002",
      source: "gecko",
      venue: "uniswap-v2",
      createdAt: 1_000,
      observedAt: 2_000,
    };

    await scanner.processWatchCandidate(event, {
      classifyCandidate: async (value) => {
        calls.push("classify");
        return { ...value, identity: "not_pons" };
      },
      candidateDependencies: {
        now: () => 2_000,
        maxAgeMinutes: 30,
        minScore: 70,
        mode: "live",
        analyze: async (value) => {
          calls.push("analyze");
          return {
            ...value,
            score: 80,
            verdict: "review",
            meta: { symbol: "TEST" },
            honeypot: { honeypot: false },
            sellability: CONFIRMED_SELLABILITY,
          };
        },
        markSeen: () => calls.push("seen"),
        alertReport: async () => calls.push("alert"),
        log: () => {},
      },
    });

    assert.deepEqual(calls, ["classify", "analyze", "alert", "seen"]);
  });

  it("persists one retryable failure, advances the cursor, and suppresses the duplicate", async () => {
    const scanner = await import("../src/scanner.js");
    const recovery = await import("../src/candidate-recovery.js");
    assert.equal(typeof scanner.createWatchSourceProcessor, "function");
    const event = watchCandidateEvent();
    const scheduled = [];
    const recoveryKeys = new Set();
    let classifications = 0;
    const process = scanner.createWatchSourceProcessor({
      maxQueueSize: 10,
      hasSeen: () => false,
      claimed: new Set(),
      recoveryKeys,
      executeCandidate: (work) => work(),
      classifyCandidate: async () => {
        classifications += 1;
        throw Object.assign(new Error("Too Many Requests"), { status: 429 });
      },
      candidateDependencies: watchCandidateDependencies(),
      scheduleRecovery: async (value, error) => {
        scheduled.push(recovery.createCandidateRecovery(value, 10_000, error));
        recoveryKeys.add(candidateKey(value));
      },
      logError: () => {},
    });
    let cursor = null;

    await runWatchIteration({ lastBlock: 9, lastGecko: 0 }, {
      settings: { onchainScan: true, geckoScan: false, confirmationBlocks: 0, maxAgeMinutes: 30 },
      now: () => 2_000,
      runDiscoverySession: (work) => work({}),
      getBlockNumber: async () => 10,
      getOnchainCursor: () => 9,
      findFirstBlockAtOrAfter: async () => 9,
      scanOnchain: async () => [event],
      setOnchainCursor: (value) => { cursor = value; },
      handleEvents: process,
      geckoNewPools: async () => [],
      log: () => {},
    });
    const duplicate = await process([event]);

    assert.equal(cursor, 10);
    assert.equal(classifications, 1);
    assert.equal(scheduled.length, 1);
    assert.deepEqual(duplicate, { accepted: 0, handled: 0, failed: 0 });
  });

  it("adds the recovery key only after the pending check is durable", async () => {
    const scanner = await import("../src/scanner.js");
    assert.equal(typeof scanner.createCandidateRecoveryScheduler, "function");
    const event = watchCandidateEvent();
    const recoveryKeys = new Set();
    let saved = null;
    const schedule = scanner.createCandidateRecoveryScheduler({
      store: {
        scheduleCheck(check) {
          saved = check;
          return check;
        },
      },
      recoveryKeys,
      now: () => 10_000,
    });

    await schedule(event, Object.assign(new Error("Too Many Requests"), { status: 429 }));

    assert.equal(saved.type, "candidate_recovery");
    assert.match(saved.lastError, /Too Many Requests/);
    assert.equal(recoveryKeys.has(candidateKey(event)), true);

    const failedKeys = new Set();
    const failedSchedule = scanner.createCandidateRecoveryScheduler({
      store: { scheduleCheck() { throw new Error("state write failed"); } },
      recoveryKeys: failedKeys,
      now: () => 10_000,
    });
    await assert.rejects(() => failedSchedule(event, new Error("rate limited")), /state write failed/);
    assert.equal(failedKeys.size, 0);
  });

  it("does not persist or hide an unexpected candidate error", async () => {
    const scanner = await import("../src/scanner.js");
    assert.equal(typeof scanner.createWatchSourceProcessor, "function");
    let scheduled = 0;
    const process = scanner.createWatchSourceProcessor({
      maxQueueSize: 10,
      hasSeen: () => false,
      claimed: new Set(),
      recoveryKeys: new Set(),
      executeCandidate: (work) => work(),
      classifyCandidate: async () => { throw new ReferenceError("programming fault"); },
      candidateDependencies: watchCandidateDependencies(),
      scheduleRecovery: async () => { scheduled += 1; },
      logError: () => {},
    });

    assert.deepEqual(await process([watchCandidateEvent()]), { accepted: 1, handled: 0, failed: 1 });
    assert.equal(scheduled, 0);
  });

  it("keeps the cursor when recovery persistence fails", async () => {
    const scanner = await import("../src/scanner.js");
    assert.equal(typeof scanner.createWatchSourceProcessor, "function");
    const event = watchCandidateEvent();
    const process = scanner.createWatchSourceProcessor({
      maxQueueSize: 10,
      hasSeen: () => false,
      claimed: new Set(),
      recoveryKeys: new Set(),
      executeCandidate: (work) => work(),
      classifyCandidate: async () => {
        throw Object.assign(new Error("Too Many Requests"), { status: 429 });
      },
      candidateDependencies: watchCandidateDependencies(),
      scheduleRecovery: async () => { throw new Error("state write failed"); },
      logError: () => {},
    });
    let cursor = null;

    await runWatchIteration({ lastBlock: 9, lastGecko: 0 }, {
      settings: { onchainScan: true, geckoScan: false, confirmationBlocks: 0, maxAgeMinutes: 30 },
      now: () => 2_000,
      runDiscoverySession: (work) => work({}),
      getBlockNumber: async () => 10,
      getOnchainCursor: () => 9,
      findFirstBlockAtOrAfter: async () => 9,
      scanOnchain: async () => [event],
      setOnchainCursor: (value) => { cursor = value; },
      handleEvents: process,
      geckoNewPools: async () => [],
      log: () => {},
    });

    assert.equal(cursor, null);
  });

  it("recovery retries the complete candidate path", async () => {
    const scanner = await import("../src/scanner.js");
    assert.equal(typeof scanner.createCandidateRecoveryHandler, "function");
    const calls = [];
    const event = watchCandidateEvent();
    const handler = scanner.createCandidateRecoveryHandler({
      executeCandidate: (work) => work(),
      classifyCandidate: async (value) => {
        assert.equal(value.observedAt, 5_000);
        calls.push("classify");
        return { ...value, identity: "not_pons" };
      },
      candidateDependencies: watchCandidateDependencies({
        now: () => 5_000,
        analyze: async (value) => {
          calls.push("analyze");
          return watchCandidateReport(value);
        },
        alertReport: async () => calls.push("alert"),
        onAnalyzed: async () => calls.push("sellability-recheck"),
        markSeen: () => calls.push("seen"),
      }),
    });

    await handler({ id: "candidate-recovery:test", event });
    assert.deepEqual(calls, ["classify", "analyze", "alert", "sellability-recheck", "seen"]);
  });

  it("records Pons candidates as seen without generic analysis", async () => {
    const scanner = await import("../src/scanner.js");
    let analyzed = 0;
    const seen = [];
    const event = watchCandidateEvent();

    const report = await scanner.processWatchCandidate(event, {
      classifyCandidate: async (value) => ({ ...value, identity: "pons-v2" }),
      candidateDependencies: watchCandidateDependencies({
        analyze: async () => { analyzed += 1; },
        markSeen: (key, payload) => seen.push([key, payload]),
      }),
    });

    assert.equal(report, null);
    assert.equal(analyzed, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][1].skipped, "pons-v2");
  });

  it("shares one discovery session runner across watch loops and keeps candidate calls on analysis RPC", async () => {
    const discoveryProvider = { role: "discovery" };
    const analysisProvider = { role: "analysis" };
    const calls = [];
    const bindings = createWatchRpcBindings({
      analysisProvider,
      discoverySessions: {
        run: async (work) => work(discoveryProvider),
      },
      getBlockNumberImpl: async (provider) => {
        calls.push(["head", provider]);
        return 100;
      },
      findFirstBlockAtOrAfterImpl: async (_target, _head, provider) => {
        calls.push(["boundary", provider]);
        return 90;
      },
      scanOnchainImpl: async (_from, _to, { provider }) => {
        calls.push(["logs", provider]);
        return [];
      },
      analyzeImpl: async (_event, { provider }) => {
        calls.push(["analyze", provider]);
        return {};
      },
      classifyCandidateImpl: async (_event, { provider }) => {
        calls.push(["classify", provider]);
        return {};
      },
    });

    assert.equal(bindings.onchain.runDiscoverySession, bindings.pons.runDiscoverySession);
    assert.equal(bindings.onchain.runDiscoverySession, bindings.startup.runDiscoverySession);
    await bindings.onchain.runDiscoverySession(async (provider) => {
      await bindings.onchain.getBlockNumber(provider);
      await bindings.onchain.findFirstBlockAtOrAfter(0, 100, provider);
      await bindings.onchain.scanOnchain(90, 100, provider);
    });
    await bindings.analyzeCandidate({});
    await bindings.classifyCandidate({});

    assert.deepEqual(calls, [
      ["head", discoveryProvider],
      ["boundary", discoveryProvider],
      ["logs", discoveryProvider],
      ["analyze", analysisProvider],
      ["classify", analysisProvider],
    ]);
  });

  it("retries recoverable startup RPC checks without exiting watch", async () => {
    const scanner = await import("../src/scanner.js");
    assert.equal(typeof scanner.runWatchStartupChecks, "function");
    const transient = new AggregateError([
      Object.assign(new Error("official timeout"), { code: "TIMEOUT" }),
      Object.assign(new Error("analysis unavailable"), { code: "NETWORK_ERROR" }),
    ]);
    let verifyCalls = 0;
    let reconcileCalls = 0;
    const waits = [];
    const logs = [];
    await scanner.runWatchStartupChecks({
      provider: {},
      store: {},
      retryMs: 5_000,
      verify: async () => {
        verifyCalls += 1;
        if (verifyCalls === 1) throw transient;
      },
      reconcile: async () => { reconcileCalls += 1; },
      wait: async (ms) => waits.push(ms),
      logError: (message) => logs.push(message),
    });
    assert.equal(verifyCalls, 2);
    assert.equal(reconcileCalls, 1);
    assert.deepEqual(waits, [5_000]);
    assert.equal(logs.length, 1);
  });

  it("propagates non-recoverable startup validation failures", async () => {
    const scanner = await import("../src/scanner.js");
    assert.equal(typeof scanner.runWatchStartupChecks, "function");
    const permanent = new Error("Pons factory deployment mismatch");
    const waits = [];
    await assert.rejects(
      () => scanner.runWatchStartupChecks({
        provider: {},
        store: {},
        verify: async () => { throw permanent; },
        reconcile: async () => {},
        wait: async (ms) => waits.push(ms),
        logError: () => {},
      }),
      (error) => error === permanent
    );
    assert.deepEqual(waits, []);
  });

  it("does not let a stale primary 503 hide the fallback validation failure", async () => {
    const scanner = await import("../src/scanner.js");
    const primary = Object.assign(new Error("official unavailable"), {
      code: "SERVER_ERROR",
      status: 503,
    });
    const fallback = Object.assign(new Error("execution reverted"), {
      code: "CALL_EXCEPTION",
    });
    const permanent = new Error("cannot read Pons factory deployment links", {
      cause: new AggregateError([primary, fallback]),
    });
    const waits = [];

    await assert.rejects(
      () => scanner.runWatchStartupChecks({
        provider: {},
        store: {},
        verify: async () => { throw permanent; },
        reconcile: async () => {},
        wait: async (ms) => {
          waits.push(ms);
          throw new Error("unexpected startup retry");
        },
        logError: () => {},
      }),
      (error) => error === permanent
    );
    assert.deepEqual(waits, []);
  });

  it("schedules eligible initial reports idempotently", async () => {
    const checks = new Map();
    const store = {
      scheduleCheck(check) {
        if (!checks.has(check.id)) checks.set(check.id, structuredClone(check));
        return checks.get(check.id);
      },
    };
    const event = {
      source: "gecko",
      venue: "uniswap-v2",
      pool: "0x2222222222222222222222222222222222222222",
      token: "0x1111111111111111111111111111111111111111",
      createdAt: 1_000,
    };
    const report = {
      honeypot: { honeypot: null },
      sellability: { status: "unknown", reason: "insufficient-meaningful-sells" },
    };
    const schedule = createCandidateRetryScheduler({ store, now: () => 1_000 });

    await schedule(report, event);
    await schedule(report, event);
    await schedule({ ...report, sellability: { status: "unknown", reason: "prefilter-score" } }, event);

    assert.equal(checks.size, 1);
    assert.equal([...checks.values()][0].nextAttemptAt, 121_000);
  });

  it("rechecks through a shared serial executor and returns the next absolute retry", async () => {
    let active = 0;
    let maxActive = 0;
    const observed = [];
    const executeCandidate = createSerialExecutor();
    const handler = createCandidateRecheckHandler({
      executeCandidate,
      now: () => 121_000,
      maxAgeMinutes: 30,
      minScore: 70,
      analyze: async (candidate) => {
        observed.push(candidate.observedAt);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return {
          ...candidate,
          score: 65,
          verdict: "skip",
          meta: { symbol: "PENDING" },
          honeypot: { honeypot: null },
          sellability: { status: "unknown", reason: "insufficient-meaningful-sells" },
        };
      },
      alertReport: async () => {},
      log: () => {},
    });
    const event = {
      source: "gecko",
      venue: "uniswap-v2",
      pool: "0x2222222222222222222222222222222222222222",
      token: "0x1111111111111111111111111111111111111111",
      createdAt: 1_000,
    };
    const check = {
      id: "candidate-recheck:test",
      type: "candidate_recheck",
      event,
      firstAnalyzedAt: 1_000,
      attempts: 0,
    };

    const results = await Promise.all([handler(check), handler({ ...check, id: `${check.id}:2` })]);

    assert.equal(maxActive, 1);
    assert.deepEqual(observed, [121_000, 121_000]);
    assert.deepEqual(results, [
      { retryAt: 301_000, lastError: "insufficient-meaningful-sells" },
      { retryAt: 301_000, lastError: "insufficient-meaningful-sells" },
    ]);
  });

  it("completes terminal and expired rechecks while preserving alert rules", async () => {
    const alerts = [];
    const reports = [
      {
        score: 10,
        verdict: "skip",
        meta: { symbol: "BLOCKED" },
        honeypot: { honeypot: true },
        sellability: { status: "blocked", reason: "sell-transfer-blocked" },
      },
      {
        score: 69,
        verdict: "skip",
        meta: { symbol: "LOW" },
        honeypot: { honeypot: false },
        sellability: CONFIRMED_SELLABILITY,
      },
    ];
    let analyzed = 0;
    const handler = createCandidateRecheckHandler({
      executeCandidate: createSerialExecutor(),
      now: () => 121_000,
      maxAgeMinutes: 30,
      minScore: 70,
      analyze: async (candidate) => ({ ...candidate, ...reports[analyzed++] }),
      alertReport: async (report) => { alerts.push(report.meta.symbol); },
      log: () => {},
    });
    const event = {
      source: "gecko",
      venue: "uniswap-v2",
      pool: "0x2222222222222222222222222222222222222222",
      token: "0x1111111111111111111111111111111111111111",
      createdAt: 1_000,
    };
    const check = { event, firstAnalyzedAt: 1_000, attempts: 0 };

    assert.equal(await handler(check), undefined);
    assert.equal(await handler(check), undefined);
    assert.deepEqual(alerts, ["BLOCKED"]);

    let oldAnalyzed = 0;
    const expired = createCandidateRecheckHandler({
      executeCandidate: createSerialExecutor(),
      now: () => 2_000_000,
      maxAgeMinutes: 30,
      minScore: 70,
      analyze: async () => { oldAnalyzed += 1; },
      alertReport: async () => {},
      log: () => {},
    });
    assert.equal(await expired({ ...check, event: { ...event, createdAt: 1_000 } }), undefined);
    assert.equal(oldAnalyzed, 0);
  });

  it("starts at the newer of the saved cursor and age-window boundary", async () => {
    const findFirstBlockAtOrAfter = async () => 40;
    assert.equal(
      await initialOnchainCursor({
        head: 100,
        savedCursor: null,
        maxAgeMinutes: 30,
        now: () => 2_000_000,
        findFirstBlockAtOrAfter,
      }),
      39
    );
    assert.equal(
      await initialOnchainCursor({
        head: 100,
        savedCursor: 70,
        maxAgeMinutes: 30,
        now: () => 2_000_000,
        findFirstBlockAtOrAfter,
      }),
      70
    );
  });

  it("drains a full queue and retries the current event", async () => {
    const queue = new CandidateQueue({ maxSize: 1, hasSeen: () => false });
    const handled = [];
    const drain = async () => {
      while (queue.size) {
        const event = queue.take();
        handled.push(event.token);
        queue.finish(event);
      }
    };

    const result = await processEvents(
      [{ token: "a" }, { token: "b" }, { token: "c" }],
      queue,
      drain
    );

    assert.deepEqual(result, { accepted: 3, handled: 0, failed: 0 });
    assert.deepEqual(handled, ["a", "b", "c"]);
  });

  it("aggregates handler failures across every queue drain", async () => {
    const queue = new CandidateQueue({ maxSize: 1, hasSeen: () => false });
    let drains = 0;
    const result = await processEvents(
      [{ token: "a" }, { token: "b" }],
      queue,
      async () => {
        drains += 1;
        while (queue.size) queue.finish(queue.take());
        return drains === 1 ? { handled: 0, failed: 1 } : { handled: 1, failed: 0 };
      }
    );

    assert.deepEqual(result, { accepted: 2, handled: 1, failed: 1 });
  });

  it("reports range completeness without persisting the cursor itself", async () => {
    const cursorWrites = [];
    const scannedRanges = [];
    const success = await processOnchainRange(
      { from: 10, head: 20 },
      {
        scanOnchain: async (from, head) => {
          scannedRanges.push([from, head]);
          return [{ token: "0x1" }];
        },
        handleEvents: async () => ({ accepted: 1, handled: 1, failed: 0 }),
        setOnchainCursor: (block) => cursorWrites.push(block),
      }
    );
    const failed = await processOnchainRange(
      { from: 21, head: 30 },
      {
        scanOnchain: async (from, head) => {
          scannedRanges.push([from, head]);
          return [{ token: "0x2" }];
        },
        handleEvents: async () => ({ accepted: 1, handled: 0, failed: 1 }),
        setOnchainCursor: (block) => cursorWrites.push(block),
      }
    );
    const retried = await processOnchainRange(
      { from: 21, head: 30 },
      {
        scanOnchain: async (from, head) => {
          scannedRanges.push([from, head]);
          return [{ token: "0x2" }];
        },
        handleEvents: async () => ({ accepted: 1, handled: 1, failed: 0 }),
        setOnchainCursor: (block) => cursorWrites.push(block),
      }
    );

    assert.equal(success.complete, true);
    assert.equal(failed.complete, false);
    assert.equal(retried.complete, true);
    assert.deepEqual(scannedRanges, [[10, 20], [21, 30], [21, 30]]);
    assert.deepEqual(cursorWrites, []);
  });

  it("processes one-shot candidates without persistent or Telegram dependencies", async () => {
    const alerted = [];
    const reports = await runReadOnlyCandidates(
      [
        { token: "0x1", venue: "uniswap-v2", pool: "0xa", source: "test" },
        { token: "0x2", venue: "uniswap-v2", pool: "0xb", source: "test" },
      ],
      {
        maxQueueSize: 1,
        maxAgeMinutes: 30,
        minScore: 55,
        now: () => 1,
        analyze: async (event) => ({
          ...event,
          score: 90,
          verdict: "green",
          meta: { symbol: event.token },
          red: [],
          honeypot: { honeypot: false },
          sellability: CONFIRMED_SELLABILITY,
        }),
        consoleAlert: async (report) => { alerted.push(report.token); },
        log: () => {},
      }
    );

    assert.deepEqual(reports.map((report) => report.token), ["0x1", "0x2"]);
    assert.deepEqual(alerted, ["0x1", "0x2"]);
  });

  it("routes auxiliary candidates through Pons identity before generic analysis", async () => {
    const analyzed = [];
    const reports = await runReadOnlyCandidates(
      [{ token: "pons" }, { token: "long" }],
      {
        maxQueueSize: 2,
        maxAgeMinutes: 30,
        minScore: 55,
        now: () => 1,
        classifyCandidate: async (event) => event.token === "pons"
          ? { ...event, identity: "pons-v2", pad: "pons-v2" }
          : { ...event, identity: "not_pons", pad: "long" },
        analyze: async (event) => {
          analyzed.push(event.token);
          return {
            ...event,
            score: 90,
            verdict: "green",
            meta: { symbol: event.token },
            red: [],
            honeypot: { honeypot: false },
            sellability: CONFIRMED_SELLABILITY,
          };
        },
        consoleAlert: async () => {},
        log: () => {},
      }
    );
    assert.deepEqual(analyzed, ["long"]);
    assert.equal(reports.length, 1);
  });

  it("does not treat an unknown Pons identity as a generic candidate", async () => {
    let analyzed = 0;
    await assert.rejects(() => runReadOnlyCandidates([{ token: "unknown" }], {
      maxQueueSize: 1,
      maxAgeMinutes: 30,
      minScore: 55,
      now: () => 1,
      classifyCandidate: async (event) => ({ ...event, identity: "unknown", pad: "unknown", error: "RPC timeout" }),
      analyze: async () => { analyzed += 1; },
      consoleAlert: async () => {},
      log: () => {},
    }), /Pons identity unknown.*RPC timeout/);
    assert.equal(analyzed, 0);
  });

  it("routes one-shot discovery to discovery RPC and analysis to analysis RPC", async () => {
    const discoveryProvider = { role: "discovery" };
    const analysisProvider = { role: "analysis" };
    const token = "0x1000000000000000000000000000000000000001";
    const event = {
      source: "onchain",
      venue: "uniswap-v2",
      token,
      pool: "0x2000000000000000000000000000000000000002",
      createdAt: Date.now(),
    };
    let analyzedWith;

    await scanOnce({
      timeoutMs: 2_000,
      now: () => Date.now(),
      settings: {
        onchainScan: true,
        geckoScan: false,
        confirmationBlocks: 0,
        ponsConfirmations: 0,
        maxAgeMinutes: 30,
        maxQueueSize: 10,
        minScore: 70,
      },
      discoveryProvider,
      analysisProvider,
      verifyPonsDeployment: async (provider) => assert.equal(provider, discoveryProvider),
      previewPonsRange: async ({ provider }) => {
        assert.equal(provider, discoveryProvider);
        return { transitions: [] };
      },
      getBlockNumber: async (provider) => {
        assert.equal(provider, discoveryProvider);
        return 100;
      },
      findFirstBlockAtOrAfter: async (_target, _head, provider) => {
        assert.equal(provider, discoveryProvider);
        return 90;
      },
      scanOnchain: async (_from, _to, { provider }) => {
        assert.equal(provider, discoveryProvider);
        return [event];
      },
      geckoNewPools: async () => [],
      classifyCandidate: async (candidate, { provider }) => {
        assert.equal(provider, discoveryProvider);
        return { ...candidate, identity: "not_pons", pad: "ordinary" };
      },
      analyze: async (_candidate, { provider }) => {
        analyzedWith = provider;
        return {
          token,
          pool: event.pool,
          poolId: null,
          venue: event.venue,
          meta: { symbol: "TEST" },
          score: 60,
          verdict: "skip",
          honeypot: { honeypot: null },
          sellability: { status: "unknown", reason: "unsupported-venue" },
          errorSources: [],
        };
      },
      consoleAlert: async () => {},
      consolePons: async () => {},
      log: () => {},
    });

    assert.equal(analyzedWith, analysisProvider);
  });

  it("keeps scanOnce free of persistent and Telegram calls", async () => {
    const calls = { seen: 0, telegram: 0, console: 0 };
    const ranges = [];
    const reports = await scanOnce({
      settings: {
        maxQueueSize: 1,
        onchainScan: true,
        geckoScan: false,
        minScore: 55,
        maxAgeMinutes: 30,
      },
      getBlockNumber: async () => 10,
      findFirstBlockAtOrAfter: async () => 3,
      scanOnchain: async (from, head) => {
        ranges.push([from, head]);
        return [{ token: "0x1", venue: "uniswap-v2", pool: "0xa", source: "test" }];
      },
      geckoNewPools: async () => [],
      analyze: async (event) => ({
        ...event,
        score: 90,
        verdict: "green",
        meta: { symbol: "SAFE" },
        red: [],
        honeypot: { honeypot: false },
        sellability: CONFIRMED_SELLABILITY,
      }),
      consoleAlert: async () => { calls.console += 1; },
      markSeen: () => { calls.seen += 1; },
      alertReport: async () => { calls.telegram += 1; },
      log: () => {},
      now: () => 1,
    });

    assert.equal(reports.length, 1);
    assert.deepEqual(ranges, [[3, 10]]);
    assert.deepEqual(calls, { seen: 0, telegram: 0, console: 1 });
  });

  it("previews Pons lifecycle events in scan without persistent or Telegram calls", async () => {
    const calls = { preview: 0, store: 0, telegram: 0, console: 0 };
    const reports = await scanOnce({
      settings: {
        maxQueueSize: 1,
        onchainScan: true,
        geckoScan: false,
        minScore: 55,
        maxAgeMinutes: 30,
        confirmationBlocks: 2,
        ponsConfirmations: 2,
      },
      provider: {},
      getBlockNumber: async () => 10,
      findFirstBlockAtOrAfter: async () => 3,
      scanOnchain: async () => [],
      previewPonsRange: async ({ fromBlock, toBlock }) => {
        calls.preview += 1;
        assert.deepEqual([fromBlock, toBlock], [3, 8]);
        return {
          events: [{ token: "0x1" }],
          transitions: [{
            eventId: "4663:0xevent:1",
            nextToken: { token: "0x1", identity: "pons-v2", protocolPhase: "not_graduated" },
          }],
        };
      },
      verifyPonsDeployment: async () => ({ ok: true }),
      geckoNewPools: async () => [],
      analyze: async () => { throw new Error("unexpected analysis"); },
      consoleAlert: async () => { calls.console += 1; },
      markSeen: () => { calls.store += 1; },
      alertReport: async () => { calls.telegram += 1; },
      log: () => {},
      now: () => 1,
    });
    assert.equal(calls.preview, 1);
    assert.equal(calls.store, 0);
    assert.equal(calls.telegram, 0);
    assert.equal(calls.console, 1);
    assert.equal(reports[0].kind, "pons-lifecycle");
  });

  it("processes every one-shot candidate before aggregating failures", async () => {
    const alerted = [];
    await assert.rejects(
      () => runReadOnlyCandidates(
        [
          { token: "0x1", venue: "uniswap-v2", pool: "0xa", source: "test" },
          { token: "0x2", venue: "uniswap-v2", pool: "0xb", source: "test" },
          { token: "0x3", venue: "uniswap-v2", pool: "0xc", source: "test" },
        ],
        {
          maxQueueSize: 1,
          maxAgeMinutes: 30,
          minScore: 55,
          now: () => 1,
          analyze: async (candidate) => {
            if (candidate.token === "0x2") throw new Error("core data unavailable for 0x2");
            return {
              ...candidate,
              score: 90,
              verdict: "green",
              meta: { symbol: candidate.token },
              red: [],
              honeypot: { honeypot: false },
              sellability: CONFIRMED_SELLABILITY,
            };
          },
          consoleAlert: async (report) => { alerted.push(report.token); },
          log: () => {},
        }
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /0x2/);
        return true;
      }
    );
    assert.deepEqual(alerted, ["0x1", "0x3"]);
  });

  it("does not touch RPC when one-shot onchain discovery is disabled", async () => {
    let rpcCalls = 0;
    const reports = await scanOnce({
      settings: {
        maxQueueSize: 2,
        onchainScan: false,
        geckoScan: true,
        minScore: 55,
        maxAgeMinutes: 30,
        confirmationBlocks: 2,
      },
      getBlockNumber: async () => { rpcCalls += 1; throw new Error("RPC_CALLED"); },
      findFirstBlockAtOrAfter: async () => { rpcCalls += 1; throw new Error("RPC_CALLED"); },
      scanOnchain: async () => { rpcCalls += 1; throw new Error("RPC_CALLED"); },
      geckoNewPools: async () => [
        { token: "0x1", venue: "uniswap-v2", pool: "0xa", source: "gecko" },
      ],
      analyze: async (candidate) => ({
        ...candidate,
        score: 90,
        verdict: "green",
        meta: { symbol: "GECKO" },
        red: [],
        honeypot: {},
      }),
      consoleAlert: async () => {},
      log: () => {},
      now: () => 1,
    });
    assert.equal(rpcCalls, 0);
    assert.equal(reports.length, 1);
  });

  it("fails a stuck one-shot scan with an explicit global timeout", async () => {
    await assert.rejects(() => scanOnce({
      timeoutMs: 5,
      settings: {
        maxQueueSize: 1,
        onchainScan: true,
        geckoScan: false,
        minScore: 55,
        maxAgeMinutes: 30,
        confirmationBlocks: 2,
      },
      getBlockNumber: async () => new Promise(() => {}),
      findFirstBlockAtOrAfter: async () => 3,
      scanOnchain: async () => [],
      geckoNewPools: async () => [],
      analyze: async () => null,
      consoleAlert: async () => {},
      log: () => {},
      now: () => 1,
    }), /scan timed out after 5ms/);
  });

  it("processes a healthy source before reporting another source failure", async () => {
    const alerted = [];
    await assert.rejects(
      () => scanOnce({
        settings: {
          maxQueueSize: 2,
          onchainScan: true,
          geckoScan: true,
          minScore: 55,
          maxAgeMinutes: 30,
          confirmationBlocks: 2,
        },
        getBlockNumber: async () => 10,
        findFirstBlockAtOrAfter: async () => 3,
        scanOnchain: async () => { throw new Error("rpc unavailable"); },
        geckoNewPools: async () => [
          { token: "0x1", venue: "uniswap-v2", pool: "0xa", source: "gecko" },
        ],
        analyze: async (candidate) => ({
          ...candidate,
          score: 90,
          verdict: "green",
          meta: { symbol: "GECKO" },
          red: [],
          honeypot: { honeypot: false },
          sellability: CONFIRMED_SELLABILITY,
        }),
        consoleAlert: async (report) => { alerted.push(report.token); },
        log: () => {},
        now: () => 1,
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /onchain/i);
        return true;
      }
    );
    assert.deepEqual(alerted, ["0x1"]);
  });

  it("keeps Gecko running when the watch RPC source fails", async () => {
    let geckoCalls = 0;
    const result = await runWatchIteration(
      { lastBlock: null, lastGecko: 0 },
      {
        settings: {
          onchainScan: true,
          geckoScan: true,
          confirmationBlocks: 2,
          maxAgeMinutes: 30,
          geckoPollMs: 10,
        },
        now: () => 100,
        getBlockNumber: async () => { throw new Error("rpc unavailable"); },
        getOnchainCursor: () => null,
        findFirstBlockAtOrAfter: async () => 1,
        scanOnchain: async () => [],
        setOnchainCursor: () => {},
        geckoNewPools: async () => { geckoCalls += 1; return []; },
        handleEvents: async () => ({ accepted: 0, handled: 0, failed: 0 }),
        log: () => {},
      }
    );
    assert.equal(geckoCalls, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /onchain.*rpc unavailable/i);
  });

  it("starts Gecko without waiting for a slow onchain source", async () => {
    const order = [];
    let releaseOnchain;
    const onchainGate = new Promise((resolve) => { releaseOnchain = resolve; });
    const iteration = runWatchIteration(
      { lastBlock: 5, lastGecko: 0 },
      {
        settings: {
          onchainScan: true,
          geckoScan: true,
          confirmationBlocks: 2,
          maxAgeMinutes: 30,
          geckoPollMs: 10,
        },
        now: () => 100,
        getBlockNumber: async () => 10,
        getOnchainCursor: () => 5,
        findFirstBlockAtOrAfter: async () => 1,
        scanOnchain: async () => {
          order.push("onchain");
          await onchainGate;
          return [];
        },
        setOnchainCursor: () => {},
        geckoNewPools: async () => { order.push("gecko"); return []; },
        handleEvents: async () => ({ accepted: 0, handled: 0, failed: 0 }),
        log: () => {},
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    const startedTogether = order.includes("gecko");
    releaseOnchain();
    await iteration;
    assert.equal(startedTogether, true);
  });

  it("analyzes candidates with bounded parallelism", async () => {
    let active = 0;
    let maxActive = 0;
    const events = Array.from({ length: 5 }, (_, index) => ({
      token: `0x${index}`,
      venue: "uniswap-v2",
      pool: `0xpool${index}`,
      source: "test",
      createdAt: null,
    }));
    await runReadOnlyCandidates(events, {
      maxQueueSize: 10,
      maxAgeMinutes: 30,
      minScore: 55,
      analysisConcurrency: 2,
      now: () => 1,
      analyze: async (candidate) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { ...candidate, score: 0, verdict: "skip", meta: { symbol: "TEST" }, honeypot: {} };
      },
      consoleAlert: async () => {},
      log: () => {},
    });
    assert.equal(maxActive, 2);
  });

  it("analyzes candidates serially by default", async () => {
    let active = 0;
    let maxActive = 0;
    const events = Array.from({ length: 3 }, (_, index) => ({
      token: `0xserial${index}`,
      venue: "uniswap-v2",
      pool: `0xpool${index}`,
      source: "test",
      createdAt: null,
    }));
    await runReadOnlyCandidates(events, {
      maxQueueSize: 10,
      maxAgeMinutes: 30,
      minScore: 55,
      now: () => 1,
      analyze: async (candidate) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { ...candidate, score: 0, verdict: "skip", meta: { symbol: "TEST" }, honeypot: {} };
      },
      consoleAlert: async () => {},
      log: () => {},
    });
    assert.equal(maxActive, 1);
  });

  it("commits a confirmed chain range even when Gecko fails", async () => {
    const ranges = [];
    const cursors = [];
    const state = { lastBlock: null, lastGecko: 0 };
    const result = await runWatchIteration(state, {
      settings: {
        onchainScan: true,
        geckoScan: true,
        confirmationBlocks: 2,
        maxAgeMinutes: 30,
        geckoPollMs: 10,
      },
      now: () => 100,
      getBlockNumber: async () => 10,
      getOnchainCursor: () => 5,
      findFirstBlockAtOrAfter: async () => 1,
      scanOnchain: async (from, head) => { ranges.push([from, head]); return []; },
      setOnchainCursor: (block) => { cursors.push(block); },
      geckoNewPools: async () => { throw new Error("gecko unavailable"); },
      handleEvents: async () => ({ accepted: 0, handled: 0, failed: 0 }),
      log: () => {},
    });
    assert.deepEqual(ranges, [[6, 8]]);
    assert.deepEqual(cursors, [8]);
    assert.equal(state.lastBlock, 8);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /gecko unavailable/i);
  });

  it("restarts onchain discovery from the committed cursor at the fallback head", async () => {
    const official = { name: "official", head: 102 };
    const analysis = { name: "analysis", head: 98 };
    const scans = [];
    let cursor = 90;
    const state = { lastBlock: 90, lastGecko: 0 };
    await runWatchIteration(state, {
      settings: {
        onchainScan: true,
        geckoScan: false,
        confirmationBlocks: 0,
        maxAgeMinutes: 30,
      },
      runDiscoverySession: async (work) => {
        await assert.rejects(() => work(official), /official logs failed/);
        return work(analysis);
      },
      now: () => 1_000,
      getBlockNumber: async (provider) => provider.head,
      getOnchainCursor: () => cursor,
      findFirstBlockAtOrAfter: async () => 0,
      scanOnchain: async (from, to, provider) => {
        scans.push([provider.name, from, to]);
        if (provider === official) throw new Error("official logs failed");
        return [];
      },
      handleEvents: async () => ({ accepted: 0, handled: 0, failed: 0 }),
      setOnchainCursor: (value) => { cursor = value; },
      geckoNewPools: async () => [],
      log: () => {},
    });
    assert.deepEqual(scans, [["official", 91, 102], ["analysis", 91, 98]]);
    assert.equal(cursor, 98);
    assert.equal(state.lastBlock, 98);
  });

  it("keeps both onchain cursors unchanged when candidate handling fails", async () => {
    let cursor = 90;
    const state = { lastBlock: 90, lastGecko: 0 };
    await runWatchIteration(state, {
      settings: {
        onchainScan: true,
        geckoScan: false,
        confirmationBlocks: 0,
        maxAgeMinutes: 30,
      },
      runDiscoverySession: (work) => work({ name: "official", head: 92 }),
      now: () => 1_000,
      getBlockNumber: async (provider) => provider.head,
      getOnchainCursor: () => cursor,
      findFirstBlockAtOrAfter: async () => 0,
      scanOnchain: async () => [{ token: "0x1" }],
      handleEvents: async () => ({ accepted: 1, handled: 0, failed: 1 }),
      setOnchainCursor: (value) => { cursor = value; },
      geckoNewPools: async () => [],
      log: () => {},
    });
    assert.equal(cursor, 90);
    assert.equal(state.lastBlock, 90);
  });

  it("does not use RPC in watch iterations when onchain discovery is disabled", async () => {
    let rpcCalls = 0;
    await runWatchIteration(
      { lastBlock: null, lastGecko: 0 },
      {
        settings: {
          onchainScan: false,
          geckoScan: true,
          confirmationBlocks: 2,
          maxAgeMinutes: 30,
          geckoPollMs: 10,
        },
        now: () => 100,
        getBlockNumber: async () => { rpcCalls += 1; },
        getOnchainCursor: () => { rpcCalls += 1; },
        findFirstBlockAtOrAfter: async () => { rpcCalls += 1; },
        scanOnchain: async () => { rpcCalls += 1; },
        setOnchainCursor: () => { rpcCalls += 1; },
        geckoNewPools: async () => [],
        handleEvents: async () => ({ accepted: 0, handled: 0, failed: 0 }),
        log: () => {},
      }
    );
    assert.equal(rpcCalls, 0);
  });
});

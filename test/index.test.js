import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initialOnchainCursor,
  processEvents,
  processOnchainRange,
  runReadOnlyCandidates,
  runWatchIteration,
  scanOnce,
} from "../src/scanner.js";
import { CandidateQueue } from "../src/queue.js";

const CONFIRMED_SELLABILITY = {
  status: "confirmed",
  reason: "sellable",
  buyerSamples: 1,
  ladderSamples: 1,
  meaningfulSellers: 3,
};

describe("scanner orchestration", () => {
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

  it("advances the persisted onchain cursor only after a fully successful range", async () => {
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
    assert.deepEqual(cursorWrites, [20, 30]);
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

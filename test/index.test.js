import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initialOnchainCursor,
  processEvents,
  processOnchainRange,
  runReadOnlyCandidates,
  scanOnce,
} from "../src/scanner.js";
import { CandidateQueue } from "../src/queue.js";

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
          honeypot: {},
        }),
        consoleAlert: async (report) => { alerted.push(report.token); },
        log: () => {},
      }
    );

    assert.deepEqual(reports.map((report) => report.token), ["0x1", "0x2"]);
    assert.deepEqual(alerted, ["0x1", "0x2"]);
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
        honeypot: {},
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
              honeypot: {},
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
});

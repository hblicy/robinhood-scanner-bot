import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processEvents, runReadOnlyCandidates, scanOnce } from "../src/index.js";
import { CandidateQueue } from "../src/queue.js";

describe("scanner orchestration", () => {
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

    const accepted = await processEvents(
      [{ token: "a" }, { token: "b" }, { token: "c" }],
      queue,
      drain
    );

    assert.equal(accepted, 3);
    assert.deepEqual(handled, ["a", "b", "c"]);
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
    const reports = await scanOnce({
      settings: {
        lookbackBlocks: 1,
        maxQueueSize: 1,
        onchainScan: true,
        geckoScan: false,
        minScore: 55,
        maxAgeMinutes: 30,
      },
      getBlockNumber: async () => 10,
      scanOnchain: async () => [
        { token: "0x1", venue: "uniswap-v2", pool: "0xa", source: "test" },
      ],
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
    assert.deepEqual(calls, { seen: 0, telegram: 0, console: 1 });
  });
});

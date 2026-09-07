import test from "node:test";
import assert from "node:assert/strict";
import { ADDR } from "../src/config.js";
import {
  buildDecayWindows,
  evaluateDecay,
  evaluateHeat,
  summarizeDecayWindow,
} from "../src/decay.js";

const HOUR = 3_600_000;
const START = Date.parse("2026-09-06T00:00:00Z");

test("builds twelve exact two-hour windows from pool registration", () => {
  const windows = buildDecayWindows(START);
  assert.equal(windows.length, 12);
  assert.deepEqual(windows[0], { index: 0, label: "0h-2h", startAt: START, endAt: START + 2 * HOUR });
  assert.deepEqual(windows[11], { index: 11, label: "22h-24h", startAt: START + 22 * HOUR, endAt: START + 24 * HOUR });
});

test("summarizes raw and protocol-adjusted top-ten concentration", () => {
  const holders = [
    { address: ADDR.PONS_LOCKER, balance: 400n },
    { address: ADDR.V4_POOL_MANAGER, balance: 300n },
    { address: "0x1111111111111111111111111111111111111111", balance: 200n },
    { address: "0x2222222222222222222222222222222222222222", balance: 100n },
  ];
  const summary = summarizeDecayWindow({
    label: "0h-2h",
    startAt: START,
    endAt: START + 2 * HOUR,
    now: START + 3 * HOUR,
    totalSupply: 1_000n,
    holders,
    volumeUsd: 1_000,
    holderNet: 3,
    netBuyUsd: 200,
  }, { excludedAddresses: [ADDR.PONS_LOCKER, ADDR.V4_POOL_MANAGER] });
  assert.equal(summary.complete, true);
  assert.equal(summary.rawTop10Pct, 100);
  assert.equal(summary.adjustedTop10Pct, 30);
});

test("does not hard-kill incomplete or unknown windows", () => {
  for (const current of [
    { complete: false },
    { complete: true, volumeUsd: null, holderNet: 0, netBuyUsd: -1 },
  ]) {
    const result = evaluateDecay({
      baseline: { complete: true, volumeUsd: 100 },
      previous: { complete: true, volumeUsd: 100 },
      current,
    });
    assert.equal(result.decision, "pending");
    assert.equal(result.killed, false);
  }
});

test("kills a three-factor consecutive-window collapse", () => {
  const result = evaluateDecay({
    baseline: { complete: true, volumeUsd: 1_000, adjustedTop10Pct: 40 },
    previous: { complete: true, volumeUsd: 400, adjustedTop10Pct: 45 },
    current: {
      complete: true,
      label: "10h-12h",
      volumeUsd: 200,
      holderNet: 0,
      netBuyUsd: -1,
      adjustedTop10Pct: 45,
    },
  });
  assert.equal(result.killed, true);
  assert.equal(result.reason, "two-hour-decay-collapse");
});

test("kills a 22h-24h window below twenty percent of baseline", () => {
  const result = evaluateDecay({
    baseline: { complete: true, volumeUsd: 1_000, adjustedTop10Pct: 40 },
    previous: { complete: true, volumeUsd: 500, adjustedTop10Pct: 42 },
    current: {
      complete: true,
      label: "22h-24h",
      volumeUsd: 199,
      holderNet: 2,
      netBuyUsd: 10,
      adjustedTop10Pct: 42,
    },
  });
  assert.equal(result.killed, true);
  assert.equal(result.reason, "day-one-volume-dead");
});

test("marks growing holders with rising concentration as controlled", () => {
  const result = evaluateDecay({
    baseline: { complete: true, volumeUsd: 1_000, adjustedTop10Pct: 40 },
    previous: { complete: true, volumeUsd: 500, adjustedTop10Pct: 42 },
    current: {
      complete: true,
      label: "4h-6h",
      volumeUsd: 400,
      holderNet: 5,
      netBuyUsd: 20,
      adjustedTop10Pct: 50,
    },
  });
  assert.equal(result.killed, false);
  assert.equal(result.greenAllowed, false);
  assert.ok(result.risks.includes("holders-up-concentration-up"));
});

test("requires proven creator selling and kills shadow coins", () => {
  const creator = evaluateDecay({
    baseline: { complete: true, volumeUsd: 100, adjustedTop10Pct: 30 },
    previous: { complete: true, volumeUsd: 100, adjustedTop10Pct: 30 },
    current: {
      complete: true,
      label: "2h-4h",
      volumeUsd: 100,
      holderNet: 1,
      netBuyUsd: 1,
      adjustedTop10Pct: 30,
      creatorBalanceChangePct: -20,
      creatorSellEvidence: false,
    },
  });
  assert.ok(creator.risks.includes("creator-balance-change-unverified"));
  assert.ok(!creator.risks.includes("creator-selling"));

  const shadow = evaluateDecay({
    baseline: { complete: true, volumeUsd: 100, adjustedTop10Pct: 30 },
    previous: { complete: true, volumeUsd: 100, adjustedTop10Pct: 30 },
    current: {
      complete: true,
      label: "2h-4h",
      volumeUsd: 100,
      holderNet: 1,
      netBuyUsd: 1,
      adjustedTop10Pct: 30,
      shadowCoin: true,
    },
  });
  assert.equal(shadow.reason, "shadow-coin");
  assert.equal(shadow.killed, true);
});

test("heat decision is deterministic and only changes new admission capacity", () => {
  const input = {
    launches24h: 100,
    topPools: [{ category: "new-memecoin" }, { category: "infrastructure" }],
    ponsPopularPct: 20,
    fetchedAt: START,
    now: START,
  };
  const normal = evaluateHeat(input, {
    highHeatLaunches24h: 20_000, normalCap: 3, highHeatCap: 1, ttlMs: HOUR,
  });
  assert.equal(normal.decision, "打");
  assert.equal(normal.admissionCap, 3);

  const high = evaluateHeat({ ...input, launches24h: 20_000 }, {
    highHeatLaunches24h: 20_000, normalCap: 3, highHeatCap: 1, ttlMs: HOUR,
  });
  assert.equal(high.decision, "打");
  assert.equal(high.admissionCap, 1);

  const noDogMoney = evaluateHeat({
    launches24h: 100,
    topPools: [{ category: "infrastructure" }, { category: "stock" }, { category: "pons" }],
    ponsPopularPct: 90,
    fetchedAt: START,
    now: START,
  }, { highHeatLaunches24h: 20_000, normalCap: 3, highHeatCap: 1, ttlMs: HOUR });
  assert.equal(noDogMoney.decision, "不打");
  assert.equal(noDogMoney.admissionCap, 1);

  const stale = evaluateHeat({
    launches24h: 100,
    topPools: [{ category: "new-memecoin" }],
    ponsPopularPct: 0,
    fetchedAt: START,
    now: START + HOUR + 1,
  }, { highHeatLaunches24h: 20_000, normalCap: 3, highHeatCap: 1, ttlMs: HOUR });
  assert.equal(stale.decision, "不打");
  assert.equal(stale.stale, true);
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectToken, formatInspectionReport } from "../src/check.js";

const TOKEN = "0x1111111111111111111111111111111111111111";
const CURVE = "0x2222222222222222222222222222222222222222";
const DEPLOYER = "0x3333333333333333333333333333333333333333";
const QUOTE = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

function dependencies(overrides = {}) {
  return {
    provider: {},
    now: () => 10_000,
    getBlockNumber: async () => 100,
    findFirstBlockAtOrAfter: async () => 1,
    readLaunch: async () => ({
      token: TOKEN,
      curve: CURVE,
      deployer: DEPLOYER,
      pairToken: QUOTE,
      poolFee: 3_000,
      tickSpacing: 60,
      phase: 0,
      exists: true,
    }),
    loadCurveTrades: async () => [{ direction: "buy", trader: DEPLOYER, createdAt: 9_000 }],
    hydrateTraderAddresses: async (_provider, trades) => trades,
    summarizeCurveFlow: () => ({ sampleStatus: "insufficient", tradeCount: 1, uniqueTraders: 1 }),
    readToken: async () => ({ name: "Test", symbol: "TEST", holders: 5 }),
    readHolders: async () => Array.from({ length: 5 }, (_, index) => ({ address: `${index}`, value: 1n })),
    countLaunches: async () => 1,
    findPoolRegistration: async () => null,
    getMarketPool: async () => null,
    getMarketTransactions: async () => [],
    normalizeMarketEvidence: () => ({ marketReady: false }),
    ...overrides,
  };
}

describe("read-only token inspection", () => {
  it("does not mutate store bytes or invoke Telegram and reports every status axis", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pons-check-"));
    const stateFile = path.join(dir, "state.json");
    fs.writeFileSync(stateFile, "{\"sentinel\":true}\n");
    const before = fs.readFileSync(stateFile);
    let telegramCalls = 0;

    const report = await inspectToken(TOKEN, dependencies({
      sendTelegram: async () => { telegramCalls += 1; },
      stateFile,
    }), { timeoutMs: 100 });
    const text = formatInspectionReport(report);

    assert.deepEqual(fs.readFileSync(stateFile), before);
    assert.equal(telegramCalls, 0);
    assert.match(text, /Factory 身份.*pons-v2/);
    assert.match(text, /Protocol phase.*not_graduated/);
    assert.match(text, /Monitor state.*observed/);
    assert.match(text, /Curve 样本.*1/);
    assert.match(text, /Hook\/毕业.*not_applicable/);
    assert.match(text, /marketReady.*false/);
    assert.match(text, /风险数据.*unknown/);
    assert.match(text, /未通过原因.*flow sample insufficient/);
  });

  it("returns an explicit unknown report with unfinished sources on global timeout", async () => {
    const never = new Promise(() => {});
    const report = await inspectToken(TOKEN, dependencies({ readLaunch: async () => never }), { timeoutMs: 5 });
    const text = formatInspectionReport(report);
    assert.equal(report.timedOut, true);
    assert.equal(report.identity, "unknown");
    assert.ok(report.unfinishedSources.includes("factory"));
    assert.match(text, /全局超时/);
    assert.match(text, /factory/);
    assert.doesNotMatch(text, /安全/);
  });

  it("keeps a failed source unknown with its error context", async () => {
    const report = await inspectToken(TOKEN, dependencies({
      readToken: async () => { throw new Error("blockscout rate limited"); },
    }), { timeoutMs: 100 });
    assert.equal(report.riskDataStatus, "unknown");
    assert.ok(report.errors.some((entry) => entry.source === "token_metadata"));
    assert.match(formatInspectionReport(report), /blockscout rate limited/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAlert, formatLifecycleNotification, sendTelegramWith } from "../src/notify.js";
import { isDiscoveryFallbackError } from "../src/chain.js";

const settings = {
  telegramToken: "DUMMY_SECRET_TOKEN",
  telegramChat: "123",
};

function alertFixture() {
  return {
    chain: "robinhood", chainName: "Robinhood Chain", venue: "uniswap-v2-robinhood",
    token: "0x1111111111111111111111111111111111111111",
    meta: { name: "Safe Token", symbol: "SAFE" },
    score: 80, verdict: "green", facts: { ageMinutes: 1 },
    honeypot: { honeypot: false },
    sellability: { status: "confirmed", buyerSamples: 3, ladderSamples: 3, meaningfulSellers: 3 },
    red: [], checks: [], links: {},
  };
}

function plainHtml(text) {
  return text.replace(/<[^>]+>/g, "").replace(/&(?:amp|lt|gt|quot|#39);/g,
    (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[entity]);
}

describe("candidate alert length", () => {
  for (const field of ["name", "symbol"]) {
    it(`bounds a 5000-character token ${field} while keeping alert identity and sellability`, () => {
      const report = alertFixture();
      report.meta[field] = "A".repeat(5000);
      const text = formatAlert(report);
      assert.ok(plainHtml(text).length <= 4096);
      assert.match(text, new RegExp(report.token));
      assert.match(text, /80\/100/);
      assert.match(text, /卖出安全<\/b> 已确认/);
      assert.match(text, /…/);
      assert.doesNotMatch(text, /A{5000}/);
      assert.equal(report.meta[field].length, 5000);
    });
  }

  it("truncates before HTML escaping without splitting emoji or entities", () => {
    const report = alertFixture();
    report.meta.name = "A".repeat(127) + "😀<&>".repeat(5000);
    report.meta.symbol = "B".repeat(63) + "😀<&>".repeat(5000);
    const text = formatAlert(report);
    assert.ok(plainHtml(text).length <= 4096);
    assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
    assert.doesNotMatch(text, /<(?!\/?(?:b|i|code|a)\b)/);
    assert.doesNotMatch(text.replace(/&(?:amp|lt|gt|quot|#39);/g, ""), /&/);
  });

  it("uses a bounded risk summary when other report details exceed the message budget", () => {
    const report = alertFixture();
    report.sellability.status = "blocked";
    report.sellability.reason = "hidden-balance-mutation";
    report.red = ["已确认余额异常", "&<>".repeat(5000)];
    report.checks = [{ key: "security", detail: "&<>".repeat(5000), ok: false, pts: 0 }];
    const text = formatAlert(report);
    assert.ok(plainHtml(text).length <= 4096);
    assert.match(text, new RegExp(report.token));
    assert.match(text, /80\/100/);
    assert.match(text, /卖出安全<\/b> 已阻断/);
    assert.match(text, /hidden-balance-mutation/);
    assert.match(text, /已确认余额异常/);
    assert.match(text, /部分详情已省略/);
    const stack = [];
    for (const match of text.matchAll(/<(\/)?(b|i|code|a)(?:\s[^>]*)?>/g)) {
      if (match[1]) assert.equal(stack.pop(), match[2]);
      else stack.push(match[2]);
    }
    assert.deepEqual(stack, []);
  });

  it("keeps normal reports complete", () => {
    const report = alertFixture();
    report.checks = [{ key: "security", detail: "正常完整详情", ok: true, pts: 10 }];
    const text = formatAlert(report);
    assert.match(text, /<b>SAFE<\/b>/);
    assert.match(text, /Safe Token/);
    assert.match(text, /正常完整详情/);
    assert.match(text, /<b>清单<\/b>/);
    assert.doesNotMatch(text, /部分详情已省略|…/);
  });

  it("counts escaped text after entity parsing instead of dropping valid details", () => {
    const report = alertFixture();
    report.checks = [{ key: "security", detail: "<&>".repeat(800), ok: false, pts: 0 }];
    const text = formatAlert(report);
    assert.ok(text.length > 4096);
    assert.ok(plainHtml(text).length <= 4096);
    assert.ok(text.includes("&lt;&amp;&gt;".repeat(800)));
    assert.doesNotMatch(text, /部分详情已省略/);
  });

  it("retains stock reference identity and restrictions in oversized risk reports", () => {
    const report = alertFixture();
    report.referenceAssetKind = "stock";
    report.referenceAssetStandard = "B20";
    report.referenceAsset = "0x2222222222222222222222222222222222222222";
    report.referenceRestrictions = ["reference-paused", "X".repeat(5000)];
    report.checks = [{ key: "security", detail: "😀".repeat(5000), ok: false, pts: 0 }];
    const text = formatAlert(report);
    assert.ok(plainHtml(text).length <= 4096);
    assert.match(text, /B20/);
    assert.match(text, new RegExp(report.referenceAsset));
    assert.match(text, /reference-paused/);
    assert.match(text, /部分详情已省略/);
  });
});

describe("Telegram delivery", () => {
  it("classifies its own request deadline as retryable and retains the AbortError cause", async () => {
    await assert.rejects(() => sendTelegramWith("hello", {
      settings, timeoutMs: 1,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }), sleep: async () => {}, log: () => {},
    }), (error) => {
      assert.equal(isDiscoveryFallbackError(error), true);
      assert.equal(error.cause.code, "TIMEOUT");
      assert.equal(error.cause.cause.name, "AbortError");
      return true;
    });
  });

  it("does not reclassify an unrelated abort as its own deadline", async () => {
    const cancelled = new DOMException("business request cancelled", "AbortError");
    await assert.rejects(() => sendTelegramWith("hello", {
      settings, fetchImpl: async () => { throw cancelled; },
      sleep: async () => {}, log: () => {},
    }), (error) => {
      assert.equal(error.cause, cancelled);
      assert.equal(isDiscoveryFallbackError(error), false);
      return true;
    });
  });

  for (const status of [429, 500, 401]) {
    it(`preserves HTTP ${status} for downstream retry classification`, async () => {
      await assert.rejects(() => sendTelegramWith("hello", {
        settings, fetchImpl: async () => ({ ok: false, status }),
        sleep: async () => {}, log: () => {},
      }), (error) => {
        assert.equal(error.cause.status, status);
        assert.equal(isDiscoveryFallbackError(error), status !== 401);
        return true;
      });
    });
  }

  it("prefixes lifecycle notifications with the active chain name", () => {
    const text = formatLifecycleNotification({
      chainName: "BNB Chain",
      transitionType: "graduated",
      token: "0x1111111111111111111111111111111111111111",
      reason: "pool ready",
      id: "bsc:event",
    });
    assert.match(text, /^🎓 \[BNB Chain\] 链上毕业/);
  });

  it("retries twice and succeeds on the third attempt", async () => {
    let attempts = 0;
    const waits = [];
    const result = await sendTelegramWith("hello", {
      settings,
      fetchImpl: async () => {
        attempts += 1;
        return { ok: attempts === 3, status: 503 };
      },
      sleep: async (ms) => { waits.push(ms); },
      log: () => {},
    });
    assert.equal(result, true);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [200, 400]);
  });

  it("propagates a sanitized error after three failures", async () => {
    let attempts = 0;
    await assert.rejects(
      () => sendTelegramWith("hello", {
        settings,
        fetchImpl: async () => {
          attempts += 1;
          throw new Error("fetch https://api.telegram.org/botDUMMY_SECRET_TOKEN/sendMessage failed");
        },
        sleep: async () => {},
        log: () => {},
      }),
      (error) => {
        assert.match(error.message, /after 3 attempts/);
        assert.doesNotMatch(error.message, /DUMMY_SECRET_TOKEN/);
        return true;
      }
    );
    assert.equal(attempts, 3);
  });

  it("aborts a stuck request and retries with a fresh signal", async () => {
    let attempts = 0;
    const signals = [];
    const delivery = sendTelegramWith("hello", {
      settings,
      timeoutMs: 1,
      fetchImpl: async (_url, { signal }) => {
        attempts += 1;
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
        });
      },
      sleep: async () => {},
      log: () => {},
    });
    await assert.rejects(
      Promise.race([
        delivery,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("test deadline")), 100)),
      ]),
      (error) => {
        assert.doesNotMatch(error.message, /test deadline/);
        assert.match(error.message, /after 3 attempts/);
        return true;
      }
    );
    assert.equal(attempts, 3);
    assert.equal(new Set(signals).size, 3);
    assert.ok(signals.every((signal) => signal.aborted));
  });
});

describe("lifecycle notifications", () => {
  for (const transitionType of ["new_launch", "hard_kill", "graduated", "market_ready", "rescued", "green"]) {
    it(`formats a short stable ${transitionType} notification`, () => {
      const text = formatLifecycleNotification({
        transitionType,
        token: "0x1111111111111111111111111111111111111111",
        id: `4663:0x${"a".repeat(64)}:1:${transitionType}`,
        reason: "direct <reason>",
      });
      assert.match(text, /0x1111111111111111111111111111111111111111/);
      assert.match(text, new RegExp(transitionType));
      assert.match(text, /direct &lt;reason&gt;/);
      assert.ok(text.length < 500);
      assert.doesNotMatch(text, /\/100|加权|评分/);
    });
  }
});

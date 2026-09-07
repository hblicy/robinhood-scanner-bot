import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatLifecycleNotification, sendTelegramWith } from "../src/notify.js";

const settings = {
  telegramToken: "DUMMY_SECRET_TOKEN",
  telegramChat: "123",
};

describe("Telegram delivery", () => {
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

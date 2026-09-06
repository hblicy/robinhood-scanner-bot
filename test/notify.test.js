import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendTelegramWith } from "../src/notify.js";

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
});

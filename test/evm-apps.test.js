import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "evm-apps-"));
  roots.push(value);
  return value;
}

function makeApp(chainKey, env = {}) {
  return createApp({
    chainKey,
    env: {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_CHAT_ID: "common-chat",
      ...env,
    },
    dependencies: {
      projectRoot: root(),
      createRpcContext: () => ({ analysisProvider: {}, discoverySessions: {} }),
      assertChain: async () => {},
      commands: { watch: async () => {}, scan: async () => {}, check: async () => {} },
    },
  });
}

describe("four independent EVM applications", () => {
  it("instantiates only concrete adapters registered by each profile", () => {
    const expected = {
      ethereum: ["uniswap-v2-ethereum", "uniswap-v3-ethereum", "uniswap-v4-ethereum"],
      base: [
        "uniswap-v3-base",
        "aerodrome-classic-base",
        "aerodrome-slipstream-v1-base",
        "aerodrome-slipstream-v2-base",
        "aerodrome-slipstream-v3-base",
        "clanker-v4-base",
      ],
      bsc: [
        "pancakeswap-v2-bsc",
        "pancakeswap-v3-bsc",
        "pancakeswap-infinity-cl-bsc",
        "four-meme-v2-bsc",
        "flap-v5-bsc",
      ],
      robinhood: ["uniswap-v2-robinhood", "o1-v4-robinhood", "pons-v2-robinhood"],
    };
    for (const [chain, ids] of Object.entries(expected)) {
      const app = makeApp(chain);
      assert.deepEqual(app.config.venueIds, ids);
      for (const venue of app.config.venues) {
        if (venue.id === "pons-v2-robinhood") continue;
        assert.ok(Array.isArray(venue.addresses) && venue.addresses.length > 0, venue.id);
        assert.ok(Array.isArray(venue.topics) && venue.topics.length > 0, venue.id);
        assert.equal(typeof venue.parse, "function", venue.id);
      }
    }
  });

  it("isolates state, locks, score, and Telegram routing per selected chain", () => {
    const base = makeApp("base", { BASE_MIN_SCORE: "72", BASE_TELEGRAM_CHAT_ID: "base-chat" });
    const bsc = makeApp("bsc", { BSC_MIN_SCORE: "63" });

    assert.equal(base.config.settings.minScore, 72);
    assert.equal(base.config.telegram.chatId, "base-chat");
    assert.equal(bsc.config.settings.minScore, 63);
    assert.equal(bsc.config.telegram.chatId, "common-chat");
    assert.notEqual(base.config.dataDir, bsc.config.dataDir);
    assert.notEqual(base.config.lockPort, bsc.config.lockPort);
    assert.deepEqual(Object.keys(base).sort(), ["check", "config", "scan", "watch"]);
  });

  it("keeps unverified Robinhood launchpads disabled in the runtime registry", () => {
    const registry = makeApp("robinhood").config.venueRegistry;
    const ponsV1 = registry.get("pons-v1-robinhood");
    const long = registry.get("long-robinhood");

    assert.equal(ponsV1.identityStatus, "disabled-unverified");
    assert.equal(ponsV1.securityCapability, "unsupported");
    assert.match(ponsV1.disabledReason, /verified-abi|event-source/);
    assert.equal(long.identityStatus, "disabled-unverified");
    assert.equal(long.disabledReason, "missing-verified-factory");
  });
});

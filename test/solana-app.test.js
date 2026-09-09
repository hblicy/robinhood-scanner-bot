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

function projectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solana-app-"));
  roots.push(root);
  return root;
}

describe("Solana application", () => {
  it("assembles six adapters with isolated state and a read-only command surface", async () => {
    const calls = [];
    const rpcContext = {
      analysisConnection: {},
      discoverySessions: { run: async (work) => work({}) },
      wsConnection: null,
    };
    const app = createApp({
      chainKey: "solana",
      env: {
        SOLANA_DISCOVERY_RPC_URL: "https://solana.example",
        SOLANA_MIN_SCORE: "74",
        SOLANA_TELEGRAM_CHAT_ID: "sol-chat",
      },
      dependencies: {
        projectRoot: projectRoot(),
        createSolanaRpcContext: () => rpcContext,
        assertSolanaPrograms: async () => {},
        services: { analyze: async () => {}, alertReport: async () => {}, check: async () => {} },
        commands: {
          watch: async () => calls.push("watch"),
          scan: async () => calls.push("scan"),
          check: async () => calls.push("check"),
        },
      },
    });
    assert.equal(app.config.family, "solana");
    assert.equal(app.config.settings.minScore, 74);
    assert.equal(app.config.telegram.chatId, "sol-chat");
    assert.match(app.config.dataDir, /data[\\/]solana$/);
    assert.deepEqual(app.config.venueIds, [
      "pump-bonding-curve", "pumpswap", "raydium-launchlab", "raydium-cpmm", "raydium-clmm", "raydium-amm-v4",
    ]);
    assert.equal("sendTransaction" in app, false);
    assert.equal("sendTransaction" in rpcContext.analysisConnection, false);
    await app.scan();
    assert.deepEqual(calls, ["scan"]);
  });
});

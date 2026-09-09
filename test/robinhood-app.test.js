import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

const roots = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-app-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Robinhood multichain application", () => {
  it("assembles chain-scoped RPC, state, venues and a push-only command surface", async () => {
    const projectRoot = tempRoot();
    const calls = [];
    const rpcContext = { analysisProvider: {}, discoverySessions: {} };
    const app = createApp({
      chainKey: "robinhood",
      env: {
        ROBINHOOD_DISCOVERY_RPC_URL: "https://discovery.example",
        ROBINHOOD_ANALYSIS_RPC_URL: "https://analysis.example",
        ROBINHOOD_ALERT_MODE: "recovery",
      },
      dependencies: {
        projectRoot,
        createRpcContext: (options) => {
          calls.push(["rpc", options.chain.id]);
          return rpcContext;
        },
        assertChain: async (context, chainId) => {
          assert.equal(context, rpcContext);
          calls.push(["chain", chainId]);
        },
        commands: {
          watch: async (context) => calls.push(["watch", context.config.dataDir]),
          scan: async (context) => calls.push(["scan", context.config.profile.id]),
          check: async (token, context) => calls.push(["check", token, context.config.profile.id]),
        },
      },
    });

    assert.equal(app.config.profile.id, 4663);
    assert.equal(app.config.rpcContext, rpcContext);
    assert.equal(app.config.dataDir, path.join(projectRoot, "data", "robinhood"));
    assert.equal(app.config.notificationsEnabled, false);
    assert.match(app.config.telegramTitle, /Robinhood/);
    assert.ok(app.config.venueIds.includes("uniswap-v2-robinhood"));
    assert.ok(app.config.venueIds.includes("pons-v2-robinhood"));
    assert.deepEqual(Object.keys(app).sort(), ["check", "config", "scan", "watch"]);

    await app.watch();
    await app.scan();
    await app.check("0x1111111111111111111111111111111111111111");
    assert.deepEqual(calls, [
      ["rpc", 4663],
      ["chain", 4663],
      ["watch", path.join(projectRoot, "data", "robinhood")],
      ["scan", 4663],
      ["check", "0x1111111111111111111111111111111111111111", 4663],
    ]);
  });

  it("copies legacy Robinhood state once without deleting the source", () => {
    const projectRoot = tempRoot();
    const legacyDir = path.join(projectRoot, "data");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyState = {
      schemaVersion: 4,
      seen: {},
      positions: {},
      trades: [],
      cursors: { onchain: 123, ponsV2: 122 },
      tokens: {},
      watchlist: [],
      heat: null,
      appliedEvents: {},
      outbox: {},
      pendingChecks: {},
    };
    fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify(legacyState));

    const app = createApp({
      chainKey: "robinhood",
      env: {},
      dependencies: {
        projectRoot,
        createRpcContext: () => ({}),
        assertChain: async () => {},
        commands: { watch: async () => {}, scan: async () => {}, check: async () => {} },
      },
    });
    assert.equal(app.config.store.getOnchainCursor(), 123);
    assert.ok(fs.existsSync(path.join(legacyDir, "state.json")));
    assert.ok(fs.existsSync(path.join(legacyDir, "robinhood", "state.json")));
  });

  it("refuses to run a command when the analysis RPC belongs to another chain", async () => {
    const projectRoot = tempRoot();
    let commandCalls = 0;
    const app = createApp({
      chainKey: "robinhood",
      env: {},
      dependencies: {
        projectRoot,
        createRpcContext: () => ({ analysisProvider: {} }),
        assertChain: async () => {
          throw new Error("RPC chain mismatch: expected 4663, actual 1");
        },
        commands: {
          watch: async () => { commandCalls += 1; },
          scan: async () => { commandCalls += 1; },
          check: async () => { commandCalls += 1; },
        },
      },
    });

    await assert.rejects(app.watch(), /expected 4663, actual 1/);
    assert.equal(commandCalls, 0);
  });
});

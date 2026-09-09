import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EVM_PROFILES } from "../src/chains/evm-profiles.js";
import { loadChainConfig } from "../src/chains/load-chain.js";

const expectedIds = {
  ethereum: 1,
  base: 8453,
  bsc: 56,
  robinhood: 4663,
};

describe("EVM chain profiles", () => {
  for (const [key, id] of Object.entries(expectedIds)) {
    it(`defines a complete ${key} profile`, () => {
      const profile = EVM_PROFILES[key];
      assert.equal(profile.key, key);
      assert.equal(profile.family, "evm");
      assert.equal(profile.id, id);
      assert.match(profile.explorer, /^https:\/\//);
      assert.match(profile.publicRpc, /^https:\/\//);
      assert.ok(Object.isFrozen(profile));
      assert.ok(profile.quotes.length > 0);
      assert.ok(profile.venues.length > 0);
      for (const venue of profile.venues) {
        assert.match(venue.sourceUrl, /^https:\/\//);
        assert.ok(Number.isInteger(venue.deploymentBlock));
        assert.ok(venue.deploymentBlock > 0);
        assert.ok(Number.isInteger(venue.verifiedAtBlock));
        assert.ok(venue.verifiedAtBlock >= venue.deploymentBlock);
        for (const address of Object.values(venue.contracts)) {
          assert.match(address, /^0x[0-9a-fA-F]{40}$/);
        }
      }
    });
  }

  it("loads chain-prefixed values without cross-chain leakage", () => {
    const config = loadChainConfig("base", {
      BASE_DISCOVERY_RPC_URL: "https://base-public.example",
      BASE_ANALYSIS_RPC_URL: "https://base-private.example/key",
      BASE_MIN_SCORE: "72",
      BSC_MIN_SCORE: "61",
      TELEGRAM_CHAT_ID: "common",
      BASE_TELEGRAM_CHAT_ID: "base-chat",
    });
    assert.equal(config.rpc.discoveryUrl, "https://base-public.example");
    assert.equal(config.rpc.analysisUrl, "https://base-private.example/key");
    assert.equal(config.settings.minScore, 72);
    assert.equal(config.telegram.chatId, "base-chat");
    assert.equal(config.dataDir, path.resolve("data", "base"));
  });

  it("keeps legacy discovery and analysis RPC compatibility scoped to Robinhood", () => {
    const env = {
      DISCOVERY_RPC_URL: "https://legacy-discovery.example",
      RPC_URL: "https://legacy.example/key",
    };
    assert.equal(loadChainConfig("robinhood", env).rpc.discoveryUrl, env.DISCOVERY_RPC_URL);
    assert.equal(loadChainConfig("robinhood", env).rpc.analysisUrl, env.RPC_URL);
    assert.equal(loadChainConfig("base", env).rpc.discoveryUrl, EVM_PROFILES.base.publicRpc);
    assert.equal(loadChainConfig("base", env).rpc.analysisUrl, EVM_PROFILES.base.publicRpc);
  });

  it("rejects invalid selected-chain overrides", () => {
    assert.throws(() => loadChainConfig("base", { BASE_MIN_SCORE: "101" }), /BASE_MIN_SCORE/);
    assert.throws(() => loadChainConfig("bsc", { BSC_CONFIRMATION_BLOCKS: "-1" }), /BSC_CONFIRMATION_BLOCKS/);
    assert.throws(() => loadChainConfig("ethereum", { ETHEREUM_DISCOVERY_RPC_URL: "ws:\/\/bad" }), /HTTP/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { printStartupSummary, formatHourlyUsage } from "../src/startup-summary.js";

function config() {
  return {
    profile: { key: "base", name: "Base" },
    rpc: {
      discoveryUrl: "https://official.example",
      analysisUrl: "https://paid.example/secret-api-key",
    },
    assetCatalog: {
      assets: [{ address: "asset" }],
      source: { verifiedAt: 123, status: "fresh" },
    },
    assetCatalogCache: { snapshot: () => ({ runtimeHits: 1, shippedHits: 0 }) },
    venueRegistry: {
      list: () => [{
        id: "uniswap-v3-base",
        identityStatus: "verified",
        securityCapability: "discovery-only",
      }],
    },
    rpcUsageBudget: {
      snapshot: () => ({
        month: "2026-09",
        total: 10,
        limit: 100,
        stage: "normal",
        methods: { eth_call: 6, eth_getLogs: 4 },
      }),
    },
  };
}

describe("startup and hourly summaries", () => {
  it("prints asset, venue and RPC usage status without credentials", () => {
    const lines = [];
    printStartupSummary(config(), { log: (line) => lines.push(line) });
    const output = lines.join("\n");
    assert.match(output, /assets=1.*assetSnapshot=123/);
    assert.match(output, /venues .*uniswap-v3-base:verified\/discovery-only/);
    assert.match(output, /rpc-budget 10\/100 stage=normal/);
    assert.doesNotMatch(output, /secret-api-key/);
  });

  it("formats hourly method counts, cache hits and a monthly projection", () => {
    const output = formatHourlyUsage(config(), Date.parse("2026-09-10T00:00:00Z"));
    assert.match(output, /base rpc-usage/);
    assert.match(output, /eth_call=6/);
    assert.match(output, /cacheHits=1/);
    assert.match(output, /projected=/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadConfig(overrides = {}) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import('./src/config.js')"],
    {
      cwd: root,
      env: {
        ...process.env,
        POLL_MS: "2500",
        GECKO_POLL_MS: "15000",
        MAX_AGE_MINUTES: "30",
        ONCHAIN_SCAN: "true",
        GECKO_SCAN: "true",
        QUOTE_TOKENS: "WETH,ETH,USDG",
        ...overrides,
      },
      encoding: "utf8",
    }
  );
}

function readRpcConfig(overrides = {}) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import('./src/config.js').then(({ CHAIN, SETTINGS }) => {
        console.log(JSON.stringify({
          discoveryRpc: CHAIN.discoveryRpc,
          analysisRpc: CHAIN.analysisRpc,
          legacyRpc: CHAIN.rpc,
          discoveryRpcCups: SETTINGS.discoveryRpcCups,
          analysisRpcCups: SETTINGS.analysisRpcCups,
          discoveryRpcCooldownMs: SETTINGS.discoveryRpcCooldownMs,
        }));
      })`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        RPC_URL: "",
        DISCOVERY_RPC_URL: "",
        ANALYSIS_RPC_URL: "",
        DISCOVERY_RPC_CUPS: "",
        ANALYSIS_RPC_CUPS: "",
        DISCOVERY_RPC_COOLDOWN_MS: "",
        POLL_MS: "2500",
        GECKO_POLL_MS: "15000",
        MAX_AGE_MINUTES: "30",
        ONCHAIN_SCAN: "true",
        GECKO_SCAN: "true",
        QUOTE_TOKENS: "WETH,ETH,USDG",
        ...overrides,
      },
      encoding: "utf8",
    }
  );
}

describe("configuration validation", () => {
  it("uses the official endpoint for discovery and the legacy RPC for analysis", () => {
    const result = readRpcConfig({ RPC_URL: "https://legacy.example/v2/key" });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.discoveryRpc, "https://rpc.mainnet.chain.robinhood.com");
    assert.equal(config.analysisRpc, "https://legacy.example/v2/key");
    assert.equal(config.legacyRpc, config.analysisRpc);
  });

  it("prefers explicit discovery and analysis endpoints", () => {
    const result = readRpcConfig({
      RPC_URL: "https://legacy.example/v2/key",
      DISCOVERY_RPC_URL: "https://discovery.example",
      ANALYSIS_RPC_URL: "https://analysis.example/v2/key",
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.discoveryRpc, "https://discovery.example");
    assert.equal(config.analysisRpc, "https://analysis.example/v2/key");
  });

  it("uses positive dual-RPC budget defaults", () => {
    const result = readRpcConfig();
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.deepEqual(
      [config.discoveryRpcCups, config.analysisRpcCups, config.discoveryRpcCooldownMs],
      [150, 250, 60_000]
    );
  });

  for (const [name, value] of [
    ["DISCOVERY_RPC_CUPS", "0"],
    ["ANALYSIS_RPC_CUPS", "1.5"],
    ["DISCOVERY_RPC_COOLDOWN_MS", "-1"],
  ]) {
    it(`rejects invalid ${name}`, () => {
      const result = readRpcConfig({ [name]: value });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(name));
    });
  }

  for (const [name, value] of [
    ["DISCOVERY_RPC_URL", "ftp://discovery.example"],
    ["ANALYSIS_RPC_URL", "not-a-url"],
  ]) {
    it(`rejects invalid ${name}`, () => {
      const result = readRpcConfig({ [name]: value });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(name));
    });
  }

  for (const [name, value] of [
    ["POLL_MS", "0"],
    ["GECKO_POLL_MS", "1.5"],
    ["MAX_AGE_MINUTES", "0"],
    ["MAX_AGE_MINUTES", "NaN"],
  ]) {
    it(`rejects invalid ${name}`, () => {
      const result = loadConfig({ [name]: value });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(name));
    });
  }

  it("accepts valid positive intervals and age windows", () => {
    const result = loadConfig();
    assert.equal(result.status, 0, result.stderr);
  });

  for (const [name, value] of [
    ["ONCHAIN_SCAN", "tru"],
    ["MIN_SCORE", "101"],
    ["MAX_TOP10_PCT", "-1"],
    ["MAX_TAX_BPS", "-1"],
    ["MAX_DEPLOYER_TOKENS", "1.5"],
    ["QUOTE_TOKENS", "UNKNOWN"],
    ["CONFIRMATION_BLOCKS", "-1"],
  ]) {
    it(`rejects out-of-range ${name}`, () => {
      const result = loadConfig({ [name]: value });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(name));
    });
  }

  it("rejects a configuration with every discovery source disabled", () => {
    const result = loadConfig({ ONCHAIN_SCAN: "false", GECKO_SCAN: "false" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ONCHAIN_SCAN|GECKO_SCAN/);
  });
});

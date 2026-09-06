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
        POSITION_POLL_MS: "8000",
        LOOKBACK_BLOCKS: "120",
        GAS_LIMIT: "450000",
        BUY_AMOUNT_ETH: "0.01",
        MAX_BUY_ETH: "0.03",
        ...overrides,
      },
      encoding: "utf8",
    }
  );
}

describe("configuration validation", () => {
  for (const [name, value] of [
    ["POLL_MS", "0"],
    ["POSITION_POLL_MS", "-1"],
    ["LOOKBACK_BLOCKS", "1.5"],
    ["BUY_AMOUNT_ETH", "-1"],
    ["MAX_BUY_ETH", "0"],
  ]) {
    it(`rejects invalid ${name}`, () => {
      const result = loadConfig({ [name]: value });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(name));
    });
  }

  it("accepts valid positive intervals and ETH amounts", () => {
    const result = loadConfig();
    assert.equal(result.status, 0, result.stderr);
  });
});

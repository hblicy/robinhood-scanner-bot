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
        ...overrides,
      },
      encoding: "utf8",
    }
  );
}

describe("configuration validation", () => {
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
});

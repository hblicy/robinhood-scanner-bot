import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as scanner from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceText() {
  return fs.readdirSync(path.join(root, "src"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => fs.readFileSync(path.join(root, "src", entry.name), "utf8"))
    .join("\n");
}

describe("push-only command surface", () => {
  it("exposes only scanner scripts", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.scripts).sort(), ["check", "scan", "start", "test", "watch"]);
  });

  it("contains no transaction-capable source or secret configuration", () => {
    const source = sourceText();
    const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    const forbidden = [
      /\bWallet\b/,
      /PRIVATE_KEY/,
      /ENABLE_LIVE_TRADING/,
      /\bsign(?:Transaction|Message|TypedData)\s*\(/,
      /sendTransaction\s*\(/,
      /sendRawTransaction\s*\(/,
      /\bbroadcast(?:Transaction)?\s*\(/,
      /broadcastTransaction/,
      /eth_send[A-Za-z0-9_]*/,
      /swapExactETHForTokens/,
      /swapExactTokensForETH/,
      /exactInputSingle/,
      /\.approve\(/,
      /paperReady/,
      /tradeReady/,
      /minOutFromQuote/,
      /plannedExitAmount/,
      /validatePositiveEth/,
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(`${source}\n${example}`, pattern);
    }
    assert.equal(fs.existsSync(path.join(root, "src", "trade.js")), false);
  });

  it("keeps src/sellability.js read-only", () => {
    const file = path.join(root, "src", "sellability.js");
    assert.equal(fs.existsSync(file), true);
    const source = fs.readFileSync(file, "utf8");
    const forbidden = [
      /\bWallet\b/,
      /PRIVATE_KEY/,
      /approve/,
      /swapExact/,
      /exactInput/,
      /\bsign(?:Transaction|Message|TypedData)\s*\(/,
      /sendTransaction\s*\(/,
      /sendRawTransaction\s*\(/,
      /\bbroadcast(?:Transaction)?\s*\(/,
      /eth_send[A-Za-z0-9_]*/,
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern);
    }
    assert.match(source, /provider\.call\s*\(/);
  });

  it("rejects paper and live as unsupported commands", () => {
    assert.equal(typeof scanner.assertSupportedCommand, "function");
    assert.throws(() => scanner.assertSupportedCommand("paper"), /Transaction functionality is not included.*commands: watch \| scan \| check <token>/);
    assert.throws(() => scanner.assertSupportedCommand("live"), /Transaction functionality is not included.*commands: watch \| scan \| check <token>/);
  });

  it("rejects removed commands before loading invalid scanner configuration", () => {
    for (const command of ["paper", "live"]) {
      const result = spawnSync(process.execPath, ["src/index.js", command], {
        cwd: root,
        env: { ...process.env, MAX_AGE_MINUTES: "0", MAX_QUEUE_SIZE: "0" },
        encoding: "utf8",
      });
      const output = `${result.stdout}${result.stderr}`;
      assert.notEqual(result.status, 0);
      assert.match(output, /Transaction functionality is not included.*commands: watch \| scan \| check <token>/);
      assert.doesNotMatch(output, /MAX_AGE_MINUTES|MAX_QUEUE_SIZE|Robinhood Chain scanner/);
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
      /signTransaction/,
      /broadcastTransaction/,
      /swapExactETHForTokens/,
      /swapExactTokensForETH/,
      /exactInputSingle/,
      /\.approve\(/,
      /paperReady/,
    ];
    for (const pattern of forbidden) {
      assert.doesNotMatch(`${source}\n${example}`, pattern);
    }
    assert.equal(fs.existsSync(path.join(root, "src", "trade.js")), false);
  });

  it("rejects paper and live as unsupported commands", () => {
    assert.equal(typeof scanner.assertSupportedCommand, "function");
    assert.throws(() => scanner.assertSupportedCommand("paper"), /commands: watch \| scan \| check <token>/);
    assert.throws(() => scanner.assertSupportedCommand("live"), /commands: watch \| scan \| check <token>/);
  });
});

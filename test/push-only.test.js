import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as scanner from "../src/index.js";
import { banner } from "../src/scanner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const DANGEROUS_CALL_PATTERNS = [
  /\bsignTransaction\b/,
  /\bsignMessageSync\b/,
  /\bsignMessage\b/,
  /\bsignTypedData\b/,
  /\bsendTransaction\b/,
  /\bsendRawTransaction\b/,
  /\bsendUncheckedTransaction\b/,
  /\bsendSignedTransaction\b/,
  /\bbroadcastTransaction\b/,
  /\bbroadcast\b/,
  /eth_send[A-Za-z0-9_]*/,
];

function collectSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") return [];
        return collectSourceFiles(fullPath);
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        return [fullPath];
      }
      return [];
    })
    .sort((a, b) => a.localeCompare(b));
}

function sourceText(directory = path.join(root, "src")) {
  return collectSourceFiles(directory).map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

describe("push-only command surface", () => {
  it("exposes only scanner scripts", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.scripts).sort(), [
      "check",
      "import-wallets",
      "scan",
      "start",
      "test",
      "watch",
      "watch:base",
      "watch:bsc",
      "watch:ethereum",
      "watch:robinhood",
    ]);
  });

  it("collects nested source files deterministically", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "push-only-"));
    try {
      const nested = path.join(tempRoot, "nested", "inner");
      const ignored = path.join(tempRoot, "node_modules", "ignored");
      fs.mkdirSync(nested, { recursive: true });
      fs.mkdirSync(ignored, { recursive: true });
      const files = {
        [path.join(tempRoot, "root.js")]: "root-js",
        [path.join(tempRoot, "nested", "feature.mjs")]: "nested-mjs",
        [path.join(tempRoot, "nested", "inner", "more.cjs")]: "inner-cjs",
        [path.join(tempRoot, "nested", "skip.txt")]: "ignored-txt",
        [path.join(tempRoot, "node_modules", "ignored", "skip.js")]: "ignored-node-modules",
      };
      for (const [file, contents] of Object.entries(files)) {
        fs.writeFileSync(file, contents);
      }

      const collected = collectSourceFiles(tempRoot);
      assert.deepEqual(collected, [
        path.join(tempRoot, "nested", "feature.mjs"),
        path.join(tempRoot, "nested", "inner", "more.cjs"),
        path.join(tempRoot, "root.js"),
      ].sort((a, b) => a.localeCompare(b)));

      const text = sourceText(tempRoot);
      assert.match(text, /root-js/);
      assert.match(text, /nested-mjs/);
      assert.match(text, /inner-cjs/);
      assert.doesNotMatch(text, /ignored-txt/);
      assert.doesNotMatch(text, /ignored-node-modules/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("contains no transaction-capable source or secret configuration", () => {
    const source = sourceText();
    const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    const forbidden = [
      /\bWallet\b/,
      /PRIVATE_KEY/,
      /ENABLE_LIVE_TRADING/,
      ...DANGEROUS_CALL_PATTERNS,
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
      ...DANGEROUS_CALL_PATTERNS,
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

  it("prints RPC roles without exposing endpoint URLs", () => {
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      banner();
    } finally {
      console.log = original;
    }
    const output = lines.join("\n");
    assert.match(output, /Discovery RPC|发现 RPC/);
    assert.match(output, /Analysis RPC|分析 RPC/);
    assert.doesNotMatch(output, /https?:\/\//);
  });

  it("recognizes normalized RPC URLs as the same endpoint", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import('./src/scanner.js').then(({ banner }) => banner())",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DISCOVERY_RPC_URL: "https://rpc.example",
          ANALYSIS_RPC_URL: "https://rpc.example/",
          RPC_URL: "",
          POLL_MS: "2500",
          GECKO_POLL_MS: "15000",
          MAX_AGE_MINUTES: "30",
          ONCHAIN_SCAN: "true",
          GECKO_SCAN: "true",
          QUOTE_TOKENS: "WETH,ETH,USDG",
        },
        encoding: "utf8",
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /shared endpoint/);
    assert.match(result.stdout, /no CU separation/);
    assert.doesNotMatch(result.stdout, /official primary \+ analysis fallback/);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Connection } from "@solana/web3.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

test("RPC dependencies reject UUID output buffers that cannot hold the complete value", () => {
  const uuidPackages = Object.keys(lock.packages).filter((name) => name.endsWith("/uuid"));
  for (const name of uuidPackages) {
    const require = createRequire(path.join(root, name, "package.json"));
    const { v3, v5 } = require("uuid");
    for (const generate of [v3, v5]) {
      assert.throws(() => generate("test", generate.DNS, Buffer.alloc(0)), RangeError);
      assert.throws(() => generate("test", generate.DNS, Buffer.alloc(16), -1), RangeError);
      const output = Buffer.alloc(18, 0xff);
      generate("test", generate.DNS, output, 1);
      assert.equal(output[0], 0xff);
      assert.equal(output[17], 0xff);
    }
  }
});

test("Solana JSON-RPC still generates a request ID and reads a normal response", async () => {
  let request;
  const connection = new Connection("https://rpc.example.invalid", {
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 123 }),
      };
    },
  });
  assert.equal(await connection.getBlockHeight("finalized"), 123);
  assert.equal(request.method, "getBlockHeight");
  assert.equal(typeof request.id, "string");
  assert.match(request.id, /^[0-9a-f-]{36}$/i);
});

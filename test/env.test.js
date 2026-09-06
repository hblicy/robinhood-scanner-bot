import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvFile } from "../src/env.js";

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readEnvFile", () => {
  it("parses values without mutating process.env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-env-"));
    dirs.push(dir);
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "RPC_URL=https://example.invalid\nPRIVATE_KEY=secret-fixture\n");

    const original = process.env.PRIVATE_KEY;
    delete process.env.PRIVATE_KEY;
    try {
      const values = readEnvFile(file);
      assert.equal(values.RPC_URL, "https://example.invalid");
      assert.equal(values.PRIVATE_KEY, "secret-fixture");
      assert.equal(Object.hasOwn(process.env, "PRIVATE_KEY"), false);
    } finally {
      if (original === undefined) delete process.env.PRIVATE_KEY;
      else process.env.PRIVATE_KEY = original;
    }
  });

  it("returns an empty object when the file is absent", () => {
    assert.deepEqual(readEnvFile(path.join(os.tmpdir(), "missing-robinhood-env")), {});
  });
});

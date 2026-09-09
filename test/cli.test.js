import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "../src/cli.js";

describe("chain CLI", () => {
  it("keeps Robinhood as the compatibility default", () => {
    assert.deepEqual(parseCli(["watch"]), {
      command: "watch", chain: "robinhood", argument: null,
    });
  });

  it("accepts --chain before or after the command", () => {
    assert.equal(parseCli(["watch", "--chain", "base"]).chain, "base");
    assert.equal(parseCli(["--chain=bsc", "scan"]).chain, "bsc");
  });

  it("preserves the token argument for check", () => {
    assert.deepEqual(parseCli([
      "check",
      "0x1111111111111111111111111111111111111111",
      "--chain",
      "ethereum",
    ]), {
      command: "check",
      chain: "ethereum",
      argument: "0x1111111111111111111111111111111111111111",
    });
  });

  for (const argv of [
    ["watch", "--chain", "unknown"],
    ["check", "--chain", "base"],
    ["watch", "extra"],
  ]) {
    it(`rejects invalid arguments: ${argv.join(" ")}`, () => {
      assert.throws(() => parseCli(argv));
    });
  }
});

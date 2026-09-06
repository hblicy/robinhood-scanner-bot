import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeRpcUrl,
  validatePositiveInteger,
  validatePositiveNumber,
  safeErrorMessage,
} from "../src/safety.js";

describe("safety helpers", () => {
  it("removes RPC userinfo, path, query and fragment", () => {
    assert.equal(
      sanitizeRpcUrl("https://user:pass@rpc.example:8545/v2/SECRET?q=KEY#x"),
      "https://[redacted]:8545"
    );
  });

  it("does not expose API keys embedded in an RPC hostname", () => {
    assert.equal(sanitizeRpcUrl("https://SECRET.rpc-provider.example"), "https://[redacted]");
  });

  it("redacts URLs embedded in provider errors", () => {
    const message = safeErrorMessage(
      new Error("SERVER_ERROR requestUrl=https://user:pass@SECRET.rpc.example/v2/API_KEY?q=TOKEN")
    );
    assert.doesNotMatch(message, /SECRET|API_KEY|TOKEN|user:pass/);
    assert.match(message, /\[redacted URL\]/);
  });

  it("fully redacts bracketed IPv6 RPC URLs", () => {
    const message = safeErrorMessage(
      new Error("SERVER_ERROR requestUrl=https://user:pass@[2001:db8::1]:8545/v2/SECRET?q=TOKEN")
    );
    assert.equal(message, "SERVER_ERROR requestUrl=[redacted URL]");
  });

  it("redacts the complete non-whitespace URL fragment after a right parenthesis", () => {
    const message = safeErrorMessage(
      new Error("requestUrl=https://user:pass@rpc.example/v2/foo)?key=SECRET next")
    );
    assert.doesNotMatch(message, /user:pass|SECRET|\?key=/);
    assert.match(message, /\[redacted URL\]/);
  });

  it("does not echo an invalid RPC URL", () => {
    assert.equal(sanitizeRpcUrl("not-a-url/SECRET"), "invalid RPC URL");
  });

  it("rejects invalid resource limits", () => {
    assert.throws(() => validatePositiveInteger("MAX_QUEUE_SIZE", 0), /MAX_QUEUE_SIZE/);
    assert.throws(() => validatePositiveInteger("MAX_QUEUE_SIZE", 1.5), /MAX_QUEUE_SIZE/);
    assert.equal(validatePositiveInteger("MAX_QUEUE_SIZE", 500), 500);
  });

  it("rejects invalid positive numeric limits", () => {
    assert.throws(() => validatePositiveNumber("MAX_AGE_MINUTES", 0), /MAX_AGE_MINUTES/);
    assert.equal(validatePositiveNumber("MAX_AGE_MINUTES", 0.5), 0.5);
  });

});

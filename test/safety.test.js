import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  minOutFromQuote,
  plannedExitAmount,
  sanitizeRpcUrl,
  validateBps,
  validatePositiveInteger,
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
    assert.match(message, /https:\/\/\[redacted\]/);
  });

  it("fully redacts bracketed IPv6 RPC URLs", () => {
    const message = safeErrorMessage(
      new Error("SERVER_ERROR requestUrl=https://user:pass@[2001:db8::1]:8545/v2/SECRET?q=TOKEN")
    );
    assert.equal(message, "SERVER_ERROR requestUrl=https://[redacted]:8545");
  });

  it("does not echo an invalid RPC URL", () => {
    assert.equal(sanitizeRpcUrl("not-a-url/SECRET"), "invalid RPC URL");
  });

  it("rejects invalid basis points", () => {
    assert.throws(() => validateBps("SLIPPAGE_BPS", 10000), /SLIPPAGE_BPS/);
    assert.throws(() => validateBps("SLIPPAGE_BPS", 1.5), /SLIPPAGE_BPS/);
    assert.equal(validateBps("SLIPPAGE_BPS", 1200), 1200);
  });

  it("rejects invalid resource limits", () => {
    assert.throws(() => validatePositiveInteger("MAX_QUEUE_SIZE", 0), /MAX_QUEUE_SIZE/);
    assert.throws(() => validatePositiveInteger("MAX_QUEUE_SIZE", 1.5), /MAX_QUEUE_SIZE/);
    assert.equal(validatePositiveInteger("MAX_QUEUE_SIZE", 500), 500);
  });

  it("computes a non-zero minimum output", () => {
    assert.equal(minOutFromQuote(1000n, 1200), 880n);
    assert.throws(() => minOutFromQuote(0n, 1200), /quote/i);
  });

  it("uses the initial absolute amount for staged exits", () => {
    const position = { initialTokenAmount: "100", remainingTokenAmount: "70" };
    assert.equal(plannedExitAmount(position, 30), 30n);
    assert.equal(plannedExitAmount(position, 100), 70n);
  });
});

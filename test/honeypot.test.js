import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { honeypotCheck } from "../src/analyze.js";

const input = {
  token: "0x1111111111111111111111111111111111111111",
  quote: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  venue: "uniswap-v2",
  pool: "0x3333333333333333333333333333333333333333",
  holders: [],
};

describe("honeypotCheck", () => {
  it("does not mark quotes and direct transfers as a complete safety simulation", async () => {
    const result = await honeypotCheck(input, {
      bytecodeFlags: async () => ({ hasCode: true, blacklist: false, pausable: false }),
      quoteRoundTrip: async () => ({ buyOk: true, sellOk: true }),
      simulateTransferFromPool: async () => true,
      simulateTransfer: async () => ({ ok: true }),
    });
    assert.equal(result.honeypot, null);
    assert.equal(result.complete, false);
    assert.equal(result.buyTaxBps, null);
    assert.equal(result.sellTaxBps, null);
  });

  it("keeps concrete quote failures as negative evidence", async () => {
    const result = await honeypotCheck(input, {
      bytecodeFlags: async () => ({ hasCode: true }),
      quoteRoundTrip: async () => ({ buyOk: false, sellOk: null, reason: "buy quote reverted" }),
    });
    assert.equal(result.honeypot, true);
    assert.match(result.reason, /buy quote reverted/);
  });
});

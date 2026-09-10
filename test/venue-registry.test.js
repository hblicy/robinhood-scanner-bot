import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createVenueRegistry } from "../src/venues/registry.js";
import { verifyVenueDeployments } from "../src/venues/verify.js";

function venue(overrides = {}) {
  return {
    chain: "robinhood",
    family: "evm",
    id: "pons-v2-robinhood",
    identityStatus: "verified",
    securityCapability: "supported",
    verifiedContracts: ["0x1111111111111111111111111111111111111111"],
    disabledReason: null,
    ...overrides,
  };
}

describe("venue capability registry", () => {
  it("exposes analyze, record-only and disabled-unverified routes", () => {
    const registry = createVenueRegistry([
      venue(),
      venue({
        id: "four-meme-v2-bsc",
        chain: "bsc",
        securityCapability: "discovery-only",
      }),
      venue({
        id: "long-robinhood",
        identityStatus: "disabled-unverified",
        securityCapability: "unsupported",
        verifiedContracts: [],
        disabledReason: "missing-factory",
      }),
    ]);
    assert.equal(registry.route("pons-v2-robinhood").action, "analyze");
    assert.equal(registry.route("four-meme-v2-bsc").action, "record-only");
    assert.equal(registry.route("long-robinhood").reason, "venue-disabled-unverified");
    assert.equal(registry.route("unknown").reason, "venue-disabled-unverified");
  });

  it("rejects duplicate venues and invalid capability combinations", () => {
    assert.throws(() => createVenueRegistry([venue(), venue()]), /duplicate venue/i);
    assert.throws(() => createVenueRegistry([venue({ securityCapability: "maybe" })]), /securityCapability/);
    assert.throws(() => createVenueRegistry([venue({
      identityStatus: "disabled-unverified",
      verifiedContracts: [],
    })]), /disabledReason/);
  });

  it("rejects a verified EVM venue whose contract has no bytecode", async () => {
    await assert.rejects(() => verifyVenueDeployments(venue(), {
      getCode: async () => "0x",
    }), /venue-contract-missing.*robinhood.*pons-v2-robinhood.*1111/i);
  });

  it("does not spend RPC calls on disabled venues", async () => {
    let calls = 0;
    await verifyVenueDeployments(venue({
      identityStatus: "disabled-unverified",
      securityCapability: "unsupported",
      verifiedContracts: [],
      disabledReason: "missing-factory",
    }), { getCode: async () => { calls += 1; return "0x"; } });
    assert.equal(calls, 0);
  });
});

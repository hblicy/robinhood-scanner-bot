import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SOLANA_PROFILE } from "../src/chains/solana-profile.js";
import { createVenueRegistry } from "../src/venues/registry.js";

const manifest = JSON.parse(fs.readFileSync(
  new URL("../config/venues/solana.json", import.meta.url),
  "utf8"
));

describe("Stonk Fun capability", () => {
  it("keeps Stonk Fun disabled until an official program and IDL are published", () => {
    const venue = manifest.find(({ id }) => id === "stonk-fun-solana");
    assert.ok(venue);
    assert.equal(venue.identityStatus, "disabled-unverified");
    assert.equal(venue.programId, null);
    assert.equal(venue.idlRevision, null);
    assert.equal(venue.discoveryCapability, "disabled");
    assert.equal(venue.securityCapability, "unsupported");
    assert.equal(venue.disabledReason, "missing-verified-program-or-idl");
    assert.match(venue.evidenceUrl, /^https:\/\/(www\.)?stonksx\.fun\/docs/);
  });

  it("does not subscribe to a disabled Stonk Fun identity", () => {
    assert.equal(SOLANA_PROFILE.programs.some(({ id }) => id === "stonk-fun-solana"), false);
    assert.deepEqual(SOLANA_PROFILE.venueCapabilities, manifest);
    const registry = createVenueRegistry(SOLANA_PROFILE.venueCapabilities);
    assert.equal(registry.route("stonk-fun-solana").reason, "venue-disabled-unverified");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideCandidateAlert, decideLifecycleAlert } from "../src/core/alert-policy.js";

describe("common alert policy", () => {
  it("applies the strict candidate truth table", () => {
    assert.equal(decideCandidateAlert({ mode: "live", sellability: "confirmed", score: 70, minScore: 70 }).type, "candidate");
    assert.equal(decideCandidateAlert({ mode: "live", sellability: "confirmed", score: 69, minScore: 70 }), null);
    assert.equal(decideCandidateAlert({ mode: "live", sellability: "blocked", score: 0, minScore: 70 }).type, "risk");
    assert.equal(decideCandidateAlert({ mode: "live", sellability: "unknown", score: 100, minScore: 70 }), null);
    assert.equal(decideCandidateAlert({ mode: "recovery", sellability: "blocked", score: 0, minScore: 70 }), null);
    assert.equal(decideCandidateAlert({ mode: "shadow", sellability: "confirmed", score: 100, minScore: 70 }), null);
  });

  it("allows hard kills only from confirmed live evidence", () => {
    assert.equal(decideLifecycleAlert({ mode: "live", transitionType: "hard_kill", evidenceConfirmed: true }).type, "hard_kill");
    assert.equal(decideLifecycleAlert({ mode: "live", transitionType: "hard_kill", evidenceConfirmed: false }), null);
    assert.equal(decideLifecycleAlert({ mode: "recovery", transitionType: "hard_kill", evidenceConfirmed: true }), null);
  });

  it("requires watchlist admission for positive lifecycle transitions", () => {
    for (const transitionType of ["rescued", "green", "market_ready", "graduated", "swept"]) {
      assert.equal(decideLifecycleAlert({ mode: "live", transitionType, watchlisted: true }).type, transitionType);
      assert.equal(decideLifecycleAlert({ mode: "live", transitionType, watchlisted: false }), null);
    }
    for (const transitionType of ["new_launch", "new_pool"]) {
      assert.equal(decideLifecycleAlert({ mode: "live", transitionType, watchlisted: true }), null);
    }
  });
});

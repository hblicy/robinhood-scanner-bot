import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advanceProgramCursor,
  createSolanaCursorState,
  planSignaturePage,
} from "../src/solana/cursor.js";

describe("Solana program cursors", () => {
  it("advances each program monotonically", () => {
    const state = createSolanaCursorState();
    assert.deepEqual(state, { programs: {} });
    const next = advanceProgramCursor(state, "pump", {
      signature: "abc",
      slot: 101,
      finalized: false,
      updatedAt: 1_000,
    });
    assert.deepEqual(next.programs.pump, {
      signature: "abc",
      slot: 101,
      finalized: false,
      updatedAt: 1_000,
    });
    assert.throws(
      () => advanceProgramCursor(next, "pump", { signature: "def", slot: 100, updatedAt: 1_001 }),
      /backwards/
    );
  });

  it("keeps the earlier anchor when a same-slot page is not fully applied", () => {
    const state = advanceProgramCursor(createSolanaCursorState(), "pump", {
      signature: "old",
      slot: 101,
      finalized: false,
      updatedAt: 1_000,
    });
    const retained = advanceProgramCursor(state, "pump", {
      signature: "new",
      slot: 101,
      finalized: false,
      updatedAt: 1_001,
    });
    assert.equal(retained.programs.pump.signature, "old");
    const advanced = advanceProgramCursor(state, "pump", {
      signature: "new",
      slot: 101,
      finalized: false,
      updatedAt: 1_001,
      sameSlotApplied: true,
    });
    assert.equal(advanced.programs.pump.signature, "new");
  });

  it("plans newest-first RPC pages for oldest-first processing", () => {
    const page = [
      { signature: "new", slot: 103 },
      { signature: "middle", slot: 102 },
      { signature: "old", slot: 101 },
    ];
    assert.deepEqual(planSignaturePage(page, { signature: "old", slot: 101 }), [page[1], page[0]]);
  });
});

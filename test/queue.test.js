import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CandidateQueue } from "../src/queue.js";

describe("CandidateQueue", () => {
  it("releases in-flight tokens after processing", () => {
    const q = new CandidateQueue({ maxSize: 2, hasSeen: () => false });
    assert.equal(q.enqueue({ token: "0xAbC" }), true);
    assert.equal(q.take().token, "0xAbC");
    assert.equal(q.enqueue({ token: "0xabc" }), false);
    q.finish("0xabc");
    assert.equal(q.enqueue({ token: "0xABC" }), true);
  });

  it("refuses candidates above the hard limit", () => {
    const q = new CandidateQueue({ maxSize: 1, hasSeen: () => false });
    assert.equal(q.isFull, false);
    assert.equal(q.enqueue({ token: "0x1" }), true);
    assert.equal(q.isFull, true);
    assert.equal(q.enqueue({ token: "0x2" }), false);
    assert.equal(q.size, 1);
    const event = q.take();
    assert.equal(q.isFull, false);
    q.finish(event);
  });

  it("refuses already seen candidates", () => {
    const q = new CandidateQueue({ maxSize: 2, hasSeen: (token) => token === "0x1" });
    assert.equal(q.enqueue({ token: "0x1" }), false);
  });

  it("can distinguish the same token in different pools", () => {
    const keyOf = (event) => `${event.token.toLowerCase()}|${event.pool.toLowerCase()}`;
    const q = new CandidateQueue({ maxSize: 2, hasSeen: () => false, keyOf });
    assert.equal(q.enqueue({ token: "0x1", pool: "0xa" }), true);
    assert.equal(q.enqueue({ token: "0x1", pool: "0xb" }), true);
  });
});

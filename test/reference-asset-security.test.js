import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspectReferenceAsset } from "../src/security/evm/reference-asset.js";

const STOCK = Object.freeze({
  chain: "bsc",
  address: "0x5b1910eAaD6450E50f816082Aa078C41F10C292f",
  kind: "stock",
  restrictions: [],
});

describe("reference asset security", () => {
  it("keeps a stock transfer policy separate from meme sellability", async () => {
    const result = await inspectReferenceAsset(STOCK, {
      cache: new Map(),
      readBytecodeHash: async () => "0xabc",
      readPolicies: async () => ({
        restrictions: ["transfer-policy"],
        capabilities: { policy: true, pause: true, multiplier: false },
      }),
    });

    assert.equal(result.status, "known");
    assert.deepEqual(result.restrictions, ["transfer-policy"]);
    assert.equal(result.targetSellability, undefined);
  });

  it("caches policy reads by chain, address, and bytecode hash", async () => {
    let reads = 0;
    const cache = new Map();
    const dependencies = {
      cache,
      readBytecodeHash: async () => "0xdef",
      readPolicies: async () => {
        reads++;
        return { restrictions: [] };
      },
    };

    const first = await inspectReferenceAsset(STOCK, dependencies);
    const second = await inspectReferenceAsset(STOCK, dependencies);

    assert.equal(first, second);
    assert.equal(reads, 1);
    assert.ok(cache.has(`bsc:${STOCK.address.toLowerCase()}:0xdef`));
  });

  it("reports an unavailable reference check without blocking the meme", async () => {
    const result = await inspectReferenceAsset(STOCK, {
      cache: new Map(),
      readBytecodeHash: async () => { throw new Error("RPC unavailable"); },
      readPolicies: async () => ({ restrictions: [] }),
    });

    assert.equal(result.status, "unknown");
    assert.deepEqual(result.restrictions, ["reference-check-unavailable"]);
    assert.equal(result.targetSellability, undefined);
  });
});

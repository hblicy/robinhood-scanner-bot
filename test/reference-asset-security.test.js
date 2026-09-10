import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inspectReferenceAsset,
  readB20ReferencePolicies,
} from "../src/security/evm/reference-asset.js";

const STOCK = Object.freeze({
  chain: "bsc",
  address: "0x5b1910eAaD6450E50f816082Aa078C41F10C292f",
  kind: "stock",
  restrictions: [],
});

const B20 = Object.freeze({
  chain: "base",
  address: "0xb20000000000000000000078ee7ce2fE4908108C",
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

  it("reports B20 multiplier and policy controls without blocking the meme by itself", async () => {
    const result = await inspectReferenceAsset(B20, {
      cache: new Map(),
      readBytecodeHash: async () => "0xb20",
      readB20: async () => ({
        multiplier: 1_020_000_000_000_000_000n,
        paused: false,
        policyIds: [7n],
      }),
    });

    assert.equal(result.status, "complete");
    assert.equal(result.standard, "B20");
    assert.equal(result.multiplier, "1020000000000000000");
    assert.equal(result.paused, false);
    assert.deepEqual(result.policyIds, ["7"]);
    assert.deepEqual(result.restrictions, ["transfer-policy"]);
    assert.equal(result.targetSellability, undefined);
  });

  it("reports a paused B20 reference separately from target sellability", async () => {
    const result = await inspectReferenceAsset(B20, {
      cache: new Map(),
      readBytecodeHash: async () => "0xb21",
      readB20: async () => ({ multiplier: 10n ** 18n, paused: true, policyIds: [0n, 0n, 0n] }),
    });

    assert.deepEqual(result.restrictions, ["reference-asset-restricted"]);
    assert.equal(result.targetSellability, undefined);
  });

  it("keeps a failed B20 policy read unknown", async () => {
    const result = await inspectReferenceAsset(B20, {
      cache: new Map(),
      readBytecodeHash: async () => "0xb22",
      readB20: async () => { throw new Error("rpc down"); },
    });

    assert.equal(result.status, "unknown");
    assert.deepEqual(result.restrictions, ["reference-check-unavailable"]);
    assert.equal(result.targetSellability, undefined);
  });

  it("reads the official B20 transfer pause and all transfer actor policies", async () => {
    const scopes = [];
    const result = await readB20ReferencePolicies(B20, {
      contractFactory: () => ({
        multiplier: async () => 10n ** 18n,
        isPaused: async (feature) => {
          assert.equal(feature, 0);
          return false;
        },
        policyId: async (scope) => {
          scopes.push(scope);
          return scopes.length === 2 ? 9n : 0n;
        },
      }),
    });

    assert.equal(result.multiplier, 10n ** 18n);
    assert.equal(result.paused, false);
    assert.deepEqual(result.policyIds, [0n, 9n, 0n]);
    assert.equal(new Set(scopes).size, 3);
    assert.ok(scopes.every((scope) => /^0x[0-9a-f]{64}$/.test(scope)));
  });
});

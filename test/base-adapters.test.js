import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideLifecycleAlert } from "../src/core/alert-policy.js";
import { EVM_PROFILES } from "../src/chains/evm-profiles.js";
import {
  createAerodromeClassicAdapter,
  createAerodromeSlipstreamAdapter,
} from "../src/venues/evm/aerodrome.js";
import { createClankerAdapter } from "../src/venues/evm/clanker.js";

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/evm/${name}.json`, import.meta.url)), "utf8"));
}

const classicLog = fixture("aerodrome-classic-pool-created");
const slipstreamLog = fixture("aerodrome-slipstream-pool-created");
const clankerLog = fixture("clanker-token-created");
const quotes = EVM_PROFILES.base.quotes.map(({ address }) => address);

describe("Base discovery adapters", () => {
  it("uses the injected pair classifier for Aerodrome direction and stock metadata", () => {
    const adapter = createAerodromeClassicAdapter({
      id: "aerodrome-classic-base",
      address: classicLog.address,
      classifyPair: (_left, _right) => ({
        candidateKind: "meme",
        targetToken: "0x2222222222222222222222222222222222222222",
        referenceAsset: "0x1111111111111111111111111111111111111111",
        targetSide: "token1",
        referenceAssetKind: "stock",
        referenceAssetIssuer: "Coinbase",
      }),
    });
    const event = adapter.parse(classicLog);
    assert.equal(event.token, event.targetToken);
    assert.equal(event.quoteToken, event.referenceAsset);
    assert.equal(event.referenceAssetKind, "stock");
  });

  it("parses a real Aerodrome classic volatile pool", () => {
    const adapter = createAerodromeClassicAdapter({
      id: "aerodrome-classic-base",
      address: classicLog.address,
      quoteAddresses: quotes,
    });
    const event = adapter.parse(classicLog);
    assert.equal(event.token.toLowerCase(), "0x62d144007ace3096f9ba55fd2106a73580ee1cca");
    assert.equal(event.quoteToken, EVM_PROFILES.base.wrappedNative);
    assert.equal(event.pool.toLowerCase(), "0x74fad1d79241bc40c3af7dc28e7320002f9981b2");
    assert.equal(event.lifecyclePhase, "new_pool");
    assert.deepEqual(event.metadata, { stable: false, poolIndex: "29199" });
  });

  it("parses a real Aerodrome Slipstream pool and retains tick spacing", () => {
    const adapter = createAerodromeSlipstreamAdapter({
      id: "aerodrome-slipstream-v3-base",
      address: slipstreamLog.address,
      quoteAddresses: quotes,
    });
    const event = adapter.parse(slipstreamLog);
    assert.equal(event.token.toLowerCase(), "0x356fedc17ab5940fd0188b9117cb0451c2a8ca40");
    assert.equal(event.quoteToken, EVM_PROFILES.base.wrappedNative);
    assert.equal(event.pool.toLowerCase(), "0x33d3b953ca148648228cde88201864be2fe4aef3");
    assert.deepEqual(event.metadata, { tickSpacing: 1 });
  });

  it("parses a real Clanker v4 launch with an exact pool identity", () => {
    const poolManager = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
    const adapter = createClankerAdapter({
      id: "clanker-v4-base",
      address: clankerLog.address,
      poolManagerAddress: poolManager,
      quoteAddresses: quotes,
    });
    const event = adapter.parse(clankerLog);
    assert.equal(event.token.toLowerCase(), "0xa2228c8428ae2add0d5ee484db49b63d5c889e45");
    assert.equal(event.creator.toLowerCase(), "0x55bf048c706a75ec549824a4e77e7d7b24390f96");
    assert.equal(event.quoteToken, EVM_PROFILES.base.wrappedNative);
    assert.equal(event.pool, poolManager);
    assert.equal(event.poolId, "0x8b3eb428ec112bff2d7310d7472bbc3b4f5f248bbc58e72020545b966bf67e92");
    assert.equal(event.lifecyclePhase, "new_launch");
    assert.equal(event.metadata.tokenName, "Cybercab");
    assert.equal(event.metadata.tokenSymbol, "Cybercab");
  });

  it("ignores pools that do not contain a configured quote token", () => {
    const adapter = createAerodromeClassicAdapter({
      id: "aerodrome-classic-base",
      address: classicLog.address,
      quoteAddresses: ["0x1111111111111111111111111111111111111111"],
    });
    assert.equal(adapter.parse(classicLog), null);
  });

  it("never sends a raw Clanker launch lifecycle notification", () => {
    assert.equal(decideLifecycleAlert({ mode: "live", transitionType: "new_launch" }), null);
  });
});

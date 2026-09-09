import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRpcEndpoint,
  createRoleProviders,
} from "../src/rpc-endpoints.js";

describe("RPC role endpoints", () => {
  it("normalizes harmless URL spelling differences", () => {
    assert.equal(
      normalizeRpcEndpoint("HTTPS://RPC.Example:443/v2/key/"),
      normalizeRpcEndpoint("https://rpc.example/v2/key")
    );
  });

  it("preserves path and query values that may contain credentials", () => {
    assert.notEqual(
      normalizeRpcEndpoint("https://rpc.example/v2/Key"),
      normalizeRpcEndpoint("https://rpc.example/v2/key")
    );
    assert.notEqual(
      normalizeRpcEndpoint("https://rpc.example?v=One"),
      normalizeRpcEndpoint("https://rpc.example?v=one")
    );
  });

  it("reuses one provider and the lower budget for identical endpoints", () => {
    const calls = [];
    const bundle = createRoleProviders({
      discoveryUrl: "https://rpc.example/v2/key/",
      analysisUrl: "https://RPC.example:443/v2/key",
      discoveryCups: 150,
      analysisCups: 250,
      createProvider: (url, cups) => {
        const provider = { url, cups };
        calls.push(provider);
        return provider;
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cups, 150);
    assert.equal(bundle.discoveryPrimary, bundle.analysis);
    assert.equal(bundle.discoveryFallback, null);
    assert.equal(bundle.sameEndpoint, true);
  });

  it("creates two providers and exposes analysis as fallback for different endpoints", () => {
    const calls = [];
    const bundle = createRoleProviders({
      discoveryUrl: "https://official.example",
      analysisUrl: "https://analysis.example/v2/key",
      discoveryCups: 150,
      analysisCups: 250,
      createProvider: (url, cups) => {
        const provider = { url, cups };
        calls.push(provider);
        return provider;
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(bundle.discoveryPrimary, calls[0]);
    assert.equal(bundle.analysis, calls[1]);
    assert.equal(bundle.discoveryFallback, calls[1]);
    assert.equal(bundle.sameEndpoint, false);
  });
});

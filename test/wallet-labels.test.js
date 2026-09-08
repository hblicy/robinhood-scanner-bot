import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadWalletLabels,
  normalizeWalletLabels,
  normalizeWalletSignals,
} from "../src/wallet-labels.js";

const A = "0x0000000000000000000000000000000000000011";
const B = "0x0000000000000000000000000000000000000022";

describe("wallet labels", () => {
  it("normalizes the standard array and defaults source to manual", () => {
    const catalog = normalizeWalletLabels([
      { address: A, label: "Alpha", type: "kol" },
      { address: B, label: "Beta", type: "smart_money", source: "okx" },
    ]);
    assert.equal(catalog.status, "known");
    assert.equal(catalog.labels.get(A.toLowerCase()).source, "manual");
    assert.equal(catalog.labels.get(B.toLowerCase()).type, "smart_money");
  });

  it("imports EVM entries from a DeBot nested export", () => {
    const catalog = normalizeWalletLabels({
      sol: { notAnEvmAddress: { mark: "ignored" } },
      eth: { [A]: { mark: "DeBot Alpha" } },
    });
    assert.deepEqual(catalog.labels.get(A.toLowerCase()), {
      label: "DeBot Alpha",
      type: "smart_money",
      source: "debot",
    });
    assert.equal(catalog.labels.size, 1);
  });

  it("returns unconfigured for a missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-labels-"));
    assert.deepEqual(loadWalletLabels(path.join(dir, "missing.json")), {
      status: "unconfigured",
      labels: new Map(),
    });
  });

  it("loads a valid JSON fixture", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-labels-"));
    const file = path.join(dir, "wallet-labels.json");
    fs.writeFileSync(file, JSON.stringify([{ address: A, label: "Alpha", type: "kol" }]));
    assert.equal(loadWalletLabels(file).labels.get(A.toLowerCase()).label, "Alpha");
  });

  it("rejects invalid addresses, labels, types, sources and duplicates", () => {
    assert.throws(() => normalizeWalletLabels([{ address: "bad", label: "x", type: "kol" }]), /address/i);
    assert.throws(() => normalizeWalletLabels([{ address: A, label: " ", type: "kol" }]), /label/i);
    assert.throws(() => normalizeWalletLabels([{ address: A, label: "x", type: "whale" }]), /type/i);
    assert.throws(() => normalizeWalletLabels([{ address: A, label: "x", type: "kol", source: "web" }]), /source/i);
    assert.throws(() => normalizeWalletLabels([
      { address: A, label: "x", type: "kol" },
      { address: A, label: "y", type: "kol" },
    ]), /duplicate/i);
  });

  it("normalizes wallet signals without trusting malformed counts", () => {
    assert.deepEqual(normalizeWalletSignals({
      status: "known",
      count: 2,
      matches: [{ label: "A", type: "kol", source: "manual" }],
    }), {
      status: "known",
      count: 2,
      matches: [{ label: "A", type: "kol", source: "manual" }],
    });
    assert.equal(normalizeWalletSignals({ status: "known", count: -1 }).count, 0);
    assert.equal(normalizeWalletSignals().status, "unconfigured");
  });
});

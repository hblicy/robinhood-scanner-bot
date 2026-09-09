import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZeroAddress } from "ethers";
import { getStoreFor } from "../src/store.js";
import { acquireInstanceLock } from "../src/instance-lock.js";
import { notificationsEnabledForMode, reconcilePonsWatchlist } from "../src/scanner.js";

const roots = [];
const TOKEN = "0x1111111111111111111111111111111111111111";

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "multichain-state-"));
  roots.push(root);
  return root;
}

function settings() {
  return { maxSeenEntries: 10, seenTtlMs: 1_000 };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("chain-scoped runtime state", () => {
  it("isolates cursors, seen keys, watchlists, outbox entries, and locks", async () => {
    const root = tempRoot();
    const baseDir = path.join(root, "base");
    const bscDir = path.join(root, "bsc");
    const base = getStoreFor(baseDir, settings());
    const bsc = getStoreFor(bscDir, settings());
    assert.notEqual(base, bsc);

    base.markSeen("base|venue|pool", { token: TOKEN });
    base.setOnchainCursor(10);
    base.commitPonsRange({
      toBlock: 11,
      transitions: [{
        eventId: "base:event:1",
        token: TOKEN,
        nextToken: { token: TOKEN, watchlist: true },
        notifications: [{ id: "base:notice:1", text: "base only" }],
      }],
    });

    assert.equal(bsc.hasSeen("base|venue|pool"), false);
    assert.equal(bsc.getOnchainCursor(), null);
    assert.deepEqual(bsc.snapshot().watchlist, []);
    assert.deepEqual(bsc.snapshot().outbox, {});

    const releaseBase = await acquireInstanceLock(baseDir, { lockPort: 38_771 });
    const releaseBsc = await acquireInstanceLock(bscDir, { lockPort: 38_772 });
    try {
      assert.ok(fs.existsSync(path.join(baseDir, "watch.lock")));
      assert.ok(fs.existsSync(path.join(bscDir, "watch.lock")));
    } finally {
      await releaseBsc();
      await releaseBase();
    }
  });

  it("enables notifications only in live mode", () => {
    assert.equal(notificationsEnabledForMode("recovery"), false);
    assert.equal(notificationsEnabledForMode("shadow"), false);
    assert.equal(notificationsEnabledForMode("live"), true);
    assert.throws(() => notificationsEnabledForMode("unknown"));
  });

  it("persists a rescued recovery transition without creating an outbox item", async () => {
    const store = getStoreFor(path.join(tempRoot(), "robinhood"), settings());
    store.commitPonsRange({
      toBlock: 10,
      transitions: [{
        eventId: "robinhood:launch:1",
        token: TOKEN,
        nextToken: {
          token: TOKEN,
          protocolPhase: "swept",
          monitorState: "watchlisted",
          watchlist: true,
          facts: { lifecycleEvents: ["robinhood:launch:1"] },
        },
      }],
    });

    await reconcilePonsWatchlist({
      provider: {},
      store,
      notificationsEnabled: notificationsEnabledForMode("recovery"),
      now: () => 2_000,
      readLaunch: async () => ({
        token: TOKEN,
        curve: "0x2222222222222222222222222222222222222222",
        deployer: "0x3333333333333333333333333333333333333333",
        creatorFeeRecipient: "0x3333333333333333333333333333333333333333",
        pairToken: ZeroAddress,
        graduationThreshold: "1000",
        poolFee: 0,
        tickSpacing: 200,
        creatorTaxBps: 100,
        buybackEnabled: true,
        phase: 3,
        sweptQuote: "0",
        sweptTokens: "0",
        sweptAt: 0,
        exists: true,
      }),
    });

    assert.equal(store.snapshot().tokens[TOKEN.toLowerCase()].protocolPhase, "rescued");
    assert.deepEqual(store.snapshot().outbox, {});
  });
});

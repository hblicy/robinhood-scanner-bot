import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireInstanceLock } from "../src/instance-lock.js";

const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("watch instance lock", () => {
  it("allows only one live owner and releases its own lock", async () => {
    const dir = tempDir();
    const options = { lockPort: 38761 };
    const release = await acquireInstanceLock(dir, { ...options, pid: 123, now: () => 1 });
    await assert.rejects(
      () => acquireInstanceLock(dir, { ...options, pid: 456, now: () => 2 }),
      /already running|lock port.*in use/i
    );
    await release();
    const releaseAgain = await acquireInstanceLock(dir, { ...options, pid: 456, now: () => 3 });
    await releaseAgain();
  });

  it("replaces a stale diagnostic lock even when its pid was reused", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "watch.lock"), JSON.stringify({ pid: 123, createdAt: 1 }));
    const release = await acquireInstanceLock(dir, {
      pid: 456,
      lockPort: 38762,
      isPidAlive: () => true,
      now: () => 2,
    });
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "watch.lock"), "utf8"));
    assert.equal(lock.pid, 456);
    await release();
  });

  it("recovers a truncated diagnostic lock after the OS lock was released", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "watch.lock"), "not-json");
    const release = await acquireInstanceLock(dir, {
      pid: 456,
      lockPort: 38763,
      now: () => 2,
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "watch.lock"), "utf8")).pid, 456);
    await release();
  });
});

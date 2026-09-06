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
  it("allows only one live owner and releases its own lock", () => {
    const dir = tempDir();
    const release = acquireInstanceLock(dir, { pid: 123, isPidAlive: () => true, now: () => 1 });
    assert.throws(
      () => acquireInstanceLock(dir, { pid: 456, isPidAlive: () => true, now: () => 2 }),
      /already running.*123/i
    );
    release();
    const releaseAgain = acquireInstanceLock(dir, { pid: 456, isPidAlive: () => true, now: () => 3 });
    releaseAgain();
  });

  it("reclaims a valid lock whose process is gone", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "watch.lock"), JSON.stringify({ pid: 123, createdAt: 1 }));
    const release = acquireInstanceLock(dir, { pid: 456, isPidAlive: () => false, now: () => 2 });
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "watch.lock"), "utf8"));
    assert.equal(lock.pid, 456);
    release();
  });

  it("does not overwrite an invalid lock file", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "watch.lock"), "not-json");
    assert.throws(
      () => acquireInstanceLock(dir, { pid: 456, isPidAlive: () => false, now: () => 2 }),
      /cannot verify existing watch lock/i
    );
    assert.equal(fs.readFileSync(path.join(dir, "watch.lock"), "utf8"), "not-json");
  });
});

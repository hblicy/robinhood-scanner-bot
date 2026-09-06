import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readExistingLock(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(value?.pid) || value.pid <= 0) throw new Error("invalid pid");
    return value;
  } catch (cause) {
    throw new Error(`cannot verify existing watch lock ${lockPath}`, { cause });
  }
}

function releaseOwnedLock(lockPath, pid, owner) {
  if (!fs.existsSync(lockPath)) return;
  let current;
  try {
    current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return;
  }
  if (current.pid === pid && current.owner === owner) fs.rmSync(lockPath, { force: true });
}

export function acquireLockGuard(
  dataDir,
  { pid = process.pid, now = Date.now, owner = randomUUID() } = {}
) {
  fs.mkdirSync(dataDir, { recursive: true });
  const guardPath = path.join(dataDir, "watch.lock.acquire");
  let fd;
  try {
    fd = fs.openSync(guardPath, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid, owner, createdAt: now() }));
  } catch (cause) {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(guardPath, { force: true });
    }
    if (cause?.code !== "EEXIST") throw cause;
    let existing;
    try {
      existing = readExistingLock(guardPath);
    } catch (readError) {
      throw new Error(`cannot verify watch lock acquisition guard ${guardPath}`, { cause: readError });
    }
    throw new Error(`watch lock acquisition already in progress with pid ${existing.pid}`);
  }
  fs.closeSync(fd);
  let released = false;
  return function releaseGuard() {
    if (released) return;
    released = true;
    releaseOwnedLock(guardPath, pid, owner);
  };
}

export function acquireInstanceLock(
  dataDir,
  { pid = process.pid, now = Date.now, isPidAlive = processIsAlive } = {}
) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "watch.lock");
  const owner = randomUUID();
  const releaseGuard = acquireLockGuard(dataDir, { pid, now });

  const create = () => {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid, owner, createdAt: now() }));
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(lockPath, { force: true });
      throw error;
    }
    fs.closeSync(fd);
  };

  try {
    try {
      create();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readExistingLock(lockPath);
      if (isPidAlive(existing.pid)) {
        throw new Error(`watch already running with pid ${existing.pid}`);
      }
      fs.rmSync(lockPath, { force: true });
      create();
    }
  } finally {
    releaseGuard();
  }

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    releaseOwnedLock(lockPath, pid, owner);
  };
}

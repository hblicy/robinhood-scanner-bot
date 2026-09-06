import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";

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

export function instanceLockPort(dataDir) {
  const digest = createHash("sha256")
    .update(path.resolve(dataDir).toLowerCase())
    .digest();
  return 20_000 + (digest.readUInt16BE(0) % 20_000);
}

function listenExclusive(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function acquireInstanceLock(
  dataDir,
  {
    pid = process.pid,
    now = Date.now,
    isPidAlive = processIsAlive,
    lockPort = instanceLockPort(dataDir),
  } = {}
) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "watch.lock");
  const owner = randomUUID();
  const server = net.createServer((socket) => socket.destroy());
  try {
    await listenExclusive(server, lockPort);
  } catch (cause) {
    if (cause?.code === "EADDRINUSE") {
      throw new Error(`watch already running or lock port ${lockPort} is in use`, { cause });
    }
    throw cause;
  }

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
  } catch (error) {
    await closeServer(server).catch(() => {});
    throw error;
  }

  let released = false;
  return async function release() {
    if (released) return;
    released = true;
    releaseOwnedLock(lockPath, pid, owner);
    await closeServer(server);
  };
}

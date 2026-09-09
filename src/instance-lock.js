import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";

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

function replaceDiagnosticLock(lockPath, payload) {
  const tempPath = `${lockPath}.${payload.pid}.${payload.owner}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx");
    fs.writeFileSync(fd, JSON.stringify(payload));
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, lockPath);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function instanceLockPort(dataDir) {
  if (typeof dataDir !== "string" || !dataDir.trim()) {
    throw new Error("instance lock dataDir is required");
  }
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

  try {
    replaceDiagnosticLock(lockPath, { pid, owner, createdAt: now(), lockPort });
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

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDir();
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  const p = path.join(DATA_DIR, file);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

const seen = readJson("seen.json", {});
const positions = readJson("positions.json", {});
const trades = readJson("trades.json", []);

export function hasSeen(token) {
  return Boolean(seen[token.toLowerCase()]);
}

export function markSeen(token, payload) {
  const key = token.toLowerCase();
  seen[key] = {
    ...(seen[key] || {}),
    ...payload,
    token: key,
    updatedAt: Date.now(),
  };
  writeJson("seen.json", seen);
  return seen[key];
}

export function getSeen(token) {
  return seen[token.toLowerCase()] || null;
}

export function listPositions() {
  return Object.values(positions);
}

export function upsertPosition(pos) {
  positions[pos.token.toLowerCase()] = pos;
  writeJson("positions.json", positions);
  return pos;
}

export function removePosition(token) {
  delete positions[token.toLowerCase()];
  writeJson("positions.json", positions);
}

export function addTrade(trade) {
  trades.push({ ...trade, at: Date.now() });
  writeJson("trades.json", trades);
  return trade;
}

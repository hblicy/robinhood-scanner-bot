import fs from "node:fs";
import { getAddress } from "ethers";

const TYPES = new Set(["kol", "smart_money"]);
const SOURCES = new Set(["manual", "debot", "okx"]);

function cleanLabel(value) {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label || [...label].length > 80) {
    throw new Error("wallet label must contain 1-80 characters");
  }
  return label;
}

function addEntry(output, entry) {
  let address;
  try {
    address = getAddress(entry.address).toLowerCase();
  } catch {
    throw new Error(`wallet label address is invalid: ${String(entry.address || "")}`);
  }
  if (output.has(address)) throw new Error(`duplicate wallet label address: ${address}`);

  const type = String(entry.type || "");
  const source = String(entry.source || "manual");
  if (!TYPES.has(type)) throw new Error(`wallet label type is invalid: ${type}`);
  if (!SOURCES.has(source)) throw new Error(`wallet label source is invalid: ${source}`);
  output.set(address, { label: cleanLabel(entry.label), type, source });
}

function collectDebot(node, output) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (/^0x[0-9a-fA-F]{40}$/.test(key)) {
      if (value?.mark == null || String(value.mark).trim() === "") continue;
      addEntry(output, {
        address: key,
        label: value.mark,
        type: "smart_money",
        source: "debot",
      });
    } else {
      collectDebot(value, output);
    }
  }
}

export function normalizeWalletLabels(value) {
  const labels = new Map();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("wallet label entry must be an object");
      }
      addEntry(labels, entry);
    }
  } else if (value && typeof value === "object") {
    collectDebot(value, labels);
  } else {
    throw new Error("wallet labels must contain an array or DeBot object");
  }
  return { status: "known", labels };
}

export function loadWalletLabels(filePath) {
  if (!fs.existsSync(filePath)) return { status: "unconfigured", labels: new Map() };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new Error(`cannot parse wallet labels file ${filePath}`, { cause });
  }
  return normalizeWalletLabels(parsed);
}

export function normalizeWalletSignals(value) {
  const status = ["known", "unconfigured"].includes(value?.status)
    ? value.status
    : "unconfigured";
  const matches = Array.isArray(value?.matches)
    ? value.matches
      .slice(0, 3)
      .filter((item) => item
        && TYPES.has(item.type)
        && SOURCES.has(item.source)
        && typeof item.label === "string")
      .map((item) => ({
        label: item.label.trim().slice(0, 80),
        type: item.type,
        source: item.source,
      }))
      .filter((item) => item.label)
    : [];
  const count = status === "known"
    && Number.isInteger(value?.count)
    && value.count >= matches.length
    ? value.count
    : 0;
  return { status, count, matches: count ? matches : [] };
}

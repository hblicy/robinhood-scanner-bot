import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";

export const REQUIRED_COLUMNS = new Set([
  "address",
  "source",
  "tags",
  "chain",
  "has_detail",
  "has_holdings",
]);

const EVM_CHAINS = new Set(["base", "bsc", "ethereum", "robinhood"]);
const CHAIN_ALIASES = new Map([["eth", "ethereum"], ["sol", "solana"]]);

export function parseCsv(text) {
  const input = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (field.length > 0) throw new Error("CSV quote must start at the beginning of a field");
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function splitTags(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeChain(value) {
  const chain = String(value || "").trim().toLowerCase();
  return CHAIN_ALIASES.get(chain) || chain;
}

function provenanceFor(file, tags) {
  const basename = path.basename(file).toLowerCase();
  if (basename.startsWith("gmgn-wallets-") || tags.includes("gmgn")) return "gmgn";
  return "manual";
}

function compareText(left, right) {
  return left.localeCompare(right, "en");
}

export function importWalletCsvFiles(files, { family } = {}) {
  if (family !== "evm") throw new Error(`unsupported wallet family: ${String(family || "")}`);
  if (!Array.isArray(files) || files.length === 0) throw new Error("at least one wallet CSV file is required");
  const merged = new Map();
  const rejected = [];

  for (const file of files) {
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    if (rows.length === 0) throw new Error(`${path.basename(file)} is empty`);
    const headers = rows[0].map((header) => header.trim().toLowerCase());
    const missing = [...REQUIRED_COLUMNS].filter((column) => !headers.includes(column));
    if (missing.length > 0) throw new Error(`${path.basename(file)} missing required columns: ${missing.join(",")}`);
    const column = Object.fromEntries(headers.map((header, index) => [header, index]));

    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.every((value) => value === "")) continue;
      const sourceTags = splitTags(row[column.source]);
      const tags = [...new Set([...sourceTags, ...splitTags(row[column.tags])])].sort(compareText);
      const chain = normalizeChain(row[column.chain]);
      let address;
      try {
        address = getAddress(String(row[column.address] || "").trim());
      } catch {
        rejected.push({ file: path.basename(file), row: index + 1, reason: "invalid-address" });
        continue;
      }
      if (!EVM_CHAINS.has(chain)) {
        rejected.push({ file: path.basename(file), row: index + 1, reason: "invalid-chain" });
        continue;
      }

      const key = address.toLowerCase();
      const current = merged.get(key) || {
        address,
        tags: new Set(),
        sources: new Set(),
        sourceChains: new Set(),
      };
      for (const tag of tags) current.tags.add(tag);
      current.sources.add(provenanceFor(file, tags));
      current.sourceChains.add(chain);
      merged.set(key, current);
    }
  }

  const wallets = [...merged.values()].map((wallet) => {
    const tags = [...wallet.tags].sort(compareText);
    return {
      address: wallet.address,
      type: tags.includes("kol") ? "kol" : "smart_money",
      tags,
      sources: [...wallet.sources].sort(compareText),
      sourceChains: [...wallet.sourceChains].sort(compareText),
    };
  }).sort((left, right) => compareText(left.address.toLowerCase(), right.address.toLowerCase()));

  rejected.sort((left, right) => compareText(left.file, right.file) || left.row - right.row || compareText(left.reason, right.reason));
  return { schemaVersion: 1, family, wallets, rejected };
}

export function serializeWalletCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
